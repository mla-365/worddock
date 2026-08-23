/* WordDock sync Worker — the entire server side.

   v2 (2026-08-23): lastList removed from the protocol. Each browser keeps its
   own last-studied list locally; sync carries progress, never place. The
   last_list column still exists in the table but is no longer read or written.

   It is deliberately stupid. It stores a blob under a key and gives it back.
   It never merges, never computes, never interprets a score. All the thinking
   (the max-merge) happens in the browser. That is what keeps this cheap at any
   scale: the server does almost no work per request, so a million users cost
   about as much as a thousand.

   WHAT IT KNOWS ABOUT A PERSON: nothing. There is no email, no name, no
   password, no IP log, no analytics. A row is an opaque 8-character key and a
   JSON object of integers. If this database were stolen whole, the thief would
   learn that somebody, somewhere, knows some Russian words.

   ENDPOINTS
     POST /claim   { key }            -> { ok } | { taken: true }
     GET  /pull?key=XXXXXXXX          -> { progress } | { empty: true }
     POST /push    { key, progress }  -> { ok }
*/

const KEY_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const KEY_LEN      = 8;

/* Payload ceiling. Not a security control — an attacker who guessed a key
   could stay under any limit we set — but a guard against a runaway client
   writing something absurd and against a single row costing real storage.
   A very heavy user across many domains is far below this. */
const MAX_BYTES = 512 * 1024;

function validKey(k){
  return typeof k === "string"
      && k.length === KEY_LEN
      && [...k].every(c => KEY_ALPHABET.includes(c));
}

/* ── Throttle ───────────────────────────────────────────────────────────────
   What this protects: the free plan's daily quota (100,000 requests). Not a
   bill — there is no card on the account — but the sync of every real user,
   which stops for the rest of the day once the quota is gone. So the job is to
   make a flood cheap: a throttled request is answered and forgotten WITHOUT
   touching the database.

   How it counts: one tally per visitor address, in this Worker's own memory.
   No database, no extra service, nothing to configure. That is also its
   weakness, stated plainly: the tally lives in one Cloudflare location and
   starts again when the Worker goes idle. It stops one machine hammering the
   endpoint. It would not stop a thousand machines each sending one request.

   The ceiling is unreachable by honest use. A real session is a pull when the
   app opens and a push when it closes — a handful a day, not a handful a
   second. */
const RATE_MAX     = 30;          // requests allowed per visitor
const RATE_WINDOW  = 60 * 1000;   // ...within this many milliseconds
const RATE_MAX_IPS = 10000;       // tallies kept before the table is cleared

const tallies = new Map();

/* True when this visitor has already used up the window.

   The table can only grow, so it is swept when it gets big: expired tallies go
   first, and if that is not enough the whole table is dropped. Dropping is
   safe — it forgives everyone, which is the harmless direction to fail. */
function overLimit(ip){
  const now = Date.now();

  if (tallies.size >= RATE_MAX_IPS){
    for (const [k, t] of tallies) if (now - t.start > RATE_WINDOW) tallies.delete(k);
    if (tallies.size >= RATE_MAX_IPS) tallies.clear();
  }

  const t = tallies.get(ip);
  if (!t || now - t.start > RATE_WINDOW){
    tallies.set(ip, { start: now, count: 1 });
    return false;
  }

  t.count++;
  return t.count > RATE_MAX;
}

function json(body, status = 200, extraHeaders = {}){
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type",
      "cache-control": "no-store",
      ...extraHeaders
    }
  });
}

export default {
  async fetch(request, env){
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return json({ ok: true });

    /* The gate stands before everything, so a throttled request costs one
       cheap reply and no database work at all. */
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (overLimit(ip)){
      return json({ error: "too many requests" }, 429, { "retry-after": "60" });
    }

    try {
      /* ── claim ────────────────────────────────────────────────────────────
         Called once, when a user turns sync on. The client generates the key
         offline, so two users could in principle generate the same one. This
         makes that impossible rather than merely improbable: if the key exists,
         the client is told to generate another. Same move as the reserved
         "Full-List" name — collisions are prevented structurally, not handled
         after the fact. */
      if (url.pathname === "/claim" && request.method === "POST"){
        const { key } = await request.json();
        if (!validKey(key)) return json({ error: "bad key" }, 400);

        const row = await env.DB
          .prepare("SELECT key FROM progress WHERE key = ?")
          .bind(key).first();
        if (row) return json({ taken: true });

        await env.DB
          .prepare("INSERT INTO progress (key, blob, updated_at) VALUES (?, ?, ?)")
          .bind(key, "{}", Date.now()).run();
        return json({ ok: true });
      }

      /* ── pull ─────────────────────────────────────────────────────────────
         Read this key's row. Nothing else is reachable: the key IS the scope,
         and there is no endpoint that returns more than one row. */
      if (url.pathname === "/pull" && request.method === "GET"){
        const key = url.searchParams.get("key");
        if (!validKey(key)) return json({ error: "bad key" }, 400);

        const row = await env.DB
          .prepare("SELECT blob FROM progress WHERE key = ?")
          .bind(key).first();
        if (!row) return json({ empty: true });

        return json({ progress: JSON.parse(row.blob || "{}") });
      }

      /* ── push ─────────────────────────────────────────────────────────────
         Replace this key's row. REPLACE, not merge — the client has already
         merged (pull -> max -> write), so a server-side merge would make stored
         RS a max-over-history and no decrement could ever persist. The one
         write per session is also the only operation that costs real money,
         which is why the client pushes on backgrounding rather than per deck. */
      if (url.pathname === "/push" && request.method === "POST"){
        const body = await request.text();
        if (body.length > MAX_BYTES) return json({ error: "too large" }, 413);

        const { key, progress } = JSON.parse(body);
        if (!validKey(key)) return json({ error: "bad key" }, 400);
        if (!progress || typeof progress !== "object")
          return json({ error: "bad payload" }, 400);

        await env.DB
          .prepare(
            "INSERT INTO progress (key, blob, updated_at) VALUES (?, ?, ?) " +
            "ON CONFLICT(key) DO UPDATE SET blob = excluded.blob, " +
            "updated_at = excluded.updated_at"
          )
          .bind(key, JSON.stringify(progress), Date.now())
          .run();

        return json({ ok: true });
      }

      return json({ error: "not found" }, 404);

    } catch (err){
      // Never leak internals. The client treats any failure the same way:
      // stay local-first and try again next time.
      return json({ error: "server error" }, 500);
    }
  }
};
