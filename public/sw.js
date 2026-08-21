// Field mode's service worker.
//
// The one place a browser viewer beats a desktop one is the tablet in the
// basement with no signal. The model already survives that: it lives in OPFS.
// This is the other half, the application itself.
//
// Vite replaces these sentinels after it knows every hashed lazy chunk and
// worker. Installation is atomic: this worker cannot activate unless the
// entire application, including web-ifc WASM, is available offline.
const VERSION = "__IFCVIEWX_VERSION__";
const PRECACHE = __IFCVIEWX_PRECACHE__;

const scope = new URL(self.registration.scope);
const INDEX = new URL("./index.html", scope);
// Cache Storage is shared by every worker on an origin. Include the scope so
// a preview deployment cannot delete the stable application's offline shell.
const CACHE_PREFIX = `ifcviewx:${scope.pathname}:`;
const LEGACY_CACHE_PREFIX = "ifcviewx-";
const SHELL = `${CACHE_PREFIX}${VERSION}`;
const PRECACHE_URLS = new Set(PRECACHE.map((path) => new URL(path, scope).href));

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL)
      .then((cache) => cache.addAll(PRECACHE.map((url) => new URL(url, scope)))),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.map(async (key) => {
        if (key === SHELL) return false;
        if (key.startsWith(CACHE_PREFIX)) return caches.delete(key);
        // Builds before scoped cache names used the generic prefix. Delete a
        // legacy cache only when its index belongs to this worker's scope.
        if (!key.startsWith(LEGACY_CACHE_PREFIX)) return false;
        const cache = await caches.open(key);
        return (await cache.match(INDEX)) ? caches.delete(key) : false;
      })))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Range requests are how a video or a partial wasm read is served; a cache
  // hit would answer 200 to a 206 request and the reader would misparse it.
  if (request.headers.has("range")) return;

  if (request.mode === "navigate") {
    // The published documentation lives below the application scope too. Do
    // not turn every docs page (or an actual 404) into the viewer shell.
    if (url.pathname !== scope.pathname && url.pathname !== INDEX.pathname) return;
    event.respondWith(
      caches.open(SHELL)
        .then((cache) => cache.match(INDEX))
        .then((cached) => cached ?? fetch(request).catch(() => offline())),
    );
    return;
  }

  // Only immutable files emitted by this build are cached. In particular,
  // never persist arbitrary same-origin JSON or authenticated API responses.
  if (!PRECACHE_URLS.has(url.href) || request.headers.has("authorization")) return;

  event.respondWith(
    caches.open(SHELL)
      .then((cache) => cache.match(url.href))
      .then((cached) => cached ?? fetch(request).catch(() => offline())),
  );
});

function offline() {
  return new Response("IFCViewX is offline and this response is unavailable.", {
    status: 503,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

self.addEventListener("message", (event) => {
  if (event.data?.type === "skip-waiting") void self.skipWaiting();
});
