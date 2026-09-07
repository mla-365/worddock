/* WordDock service worker.

   Its one job: let the app open with no network. Nothing else. It does not
   sync, does not touch scores, does not run in the background.

   THE TRAP THIS AVOIDS. The obvious way to write a service worker is
   cache-first for everything: fast, and completely offline-capable. It is also
   how apps get frozen — a user keeps being served the version cached on their
   first visit, and every deploy after that is invisible to them. They would
   have no way of knowing, and no obvious way to fix it. That is the same shape
   as the schema landmine: code that silently keeps doing something long after
   it should have stopped.

   So the rule here is:

     • Things that CHANGE (the app itself, the word-list JSONs) → NETWORK FIRST.
       Online, you always get the current deploy. The cache is a fallback that
       only speaks when the network cannot.

     • Things that NEVER change (fonts, icons) → CACHE FIRST. Their content is
       fixed; if one is ever replaced, its filename changes with it.

   The result: offline works, and a deploy still reaches everyone the next time
   they open the app with a connection. */

const VERSION    = "wd-2026-09-07";
const SHELL      = "wd-shell-" + VERSION;   // the app + its data
const IMMUTABLE  = "wd-static-" + VERSION;  // fonts, icons

/* Enough to open and study offline. The corpus is NOT precached — it lives
   under lists/ and may grow to hundreds of files; forcing every visitor to
   download all of them would be absurd. Each list is cached the first time it
   is actually fetched (the network-first rule below), so the pairs a user
   really studies become available offline and the rest cost nothing. */
const PRECACHE = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/poppins-400.woff2",
  "/poppins-600.woff2",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
  "/xlsx.full.min.js"
];

self.addEventListener("install", event => {
  // Precache what we can; a missing file must not abort the whole install
  // (the font weights in particular may not all exist).
  event.waitUntil(
    caches.open(SHELL).then(cache =>
      Promise.all(PRECACHE.map(url =>
        cache.add(url).catch(() => {/* skip what isn't there */})
      ))
    ).then(() => self.skipWaiting())   // don't wait for every tab to close
  );
});

self.addEventListener("activate", event => {
  // Delete every cache from an older VERSION. Scoped by name prefix so this
  // can only ever remove this service worker's own caches.
  event.waitUntil(
    caches.keys()
      .then(names => Promise.all(
        names
          .filter(n => n.startsWith("wd-") && !n.endsWith(VERSION))
          .map(n => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // never touch other origins

  const immutable = /\.(woff2|png|svg|ico)$/.test(url.pathname);

  if (immutable){
    // CACHE FIRST — the content behind these names does not change.
    event.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        const copy = res.clone();
        caches.open(IMMUTABLE).then(c => c.put(req, copy));
        return res;
      }))
    );
    return;
  }

  // NETWORK FIRST — the app and the word lists. Online you get the live
  // version; the cache answers only when the network cannot.
  event.respondWith(
    fetch(req)
      .then(res => {
        const copy = res.clone();
        caches.open(SHELL).then(c => c.put(req, copy));
        return res;
      })
      .catch(() =>
        caches.match(req).then(hit => hit || caches.match("/index.html"))
      )
  );
});
