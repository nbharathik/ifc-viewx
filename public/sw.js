// Field mode's service worker.
//
// The one place a browser viewer beats a desktop one is the tablet in the
// basement with no signal. The model already survives that: it lives in OPFS.
// This is the other half, the application itself.
//
// Vite replaces these sentinels after it knows every emitted file. Only the
// boot graph is fetched during installation; lazy tools, workers and WASM are
// cached after first use so installing the app does not download every feature.
const VERSION = "__IFCVIEWX_VERSION__";
const PRECACHE = __IFCVIEWX_PRECACHE__;
const RUNTIME = __IFCVIEWX_RUNTIME__;
const MAX_RUNTIME_ENTRIES = 32;

const scope = new URL(self.registration.scope);
const INDEX = new URL("./index.html", scope);
// Cache Storage is shared by every worker on an origin. Include the scope so
// a preview deployment cannot delete the stable application's offline shell.
const CACHE_PREFIX = `ifcviewx:${scope.pathname}:`;
const LEGACY_CACHE_PREFIX = "ifcviewx-";
const SHELL = `${CACHE_PREFIX}shell:${VERSION}`;
// Runtime assets include a few stable filenames (for example the parser WASM),
// so key this cache by the whole build rather than assuming every URL is hashed.
const OPTIONAL = `${CACHE_PREFIX}runtime:${VERSION}`;
const PRECACHE_URLS = new Set(PRECACHE.map((path) => new URL(path, scope).href));
const RUNTIME_URLS = new Set(RUNTIME.map((path) => new URL(path, scope).href));

self.addEventListener("install", (event) => {
  event.waitUntil(installShell());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.map(async (key) => {
        if (key === SHELL || key === OPTIONAL) return false;
        if (key.startsWith(CACHE_PREFIX)) return caches.delete(key);
        // Builds before scoped cache names used the generic prefix. Delete a
        // legacy cache only when its index belongs to this worker's scope.
        if (!key.startsWith(LEGACY_CACHE_PREFIX)) return false;
        const cache = await caches.open(key);
        return (await cache.match(INDEX)) ? caches.delete(key) : false;
      })))
      .then(() => pruneRuntime().catch(() => undefined))
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
    event.respondWith(shellFirst(request, INDEX));
    return;
  }

  // Only files named by this build are cached. In particular, never persist
  // arbitrary same-origin JSON or authenticated API responses.
  if (request.headers.has("authorization")) return;

  if (PRECACHE_URLS.has(url.href)) {
    event.respondWith(shellFirst(request, url.href));
    return;
  }

  if (RUNTIME_URLS.has(url.href)) {
    const result = runtimeFirst(request);
    event.respondWith(result.then(({ response }) => response));
    // Cache writes can stream after the response starts. A quota or Cache API
    // failure must never turn a successful network request into an app error.
    event.waitUntil(result.then(({ cache, copy }) => (
      cache && copy ? storeRuntime(cache, request, copy) : undefined
    )).catch(() => undefined));
  }
});

async function installShell() {
  const cache = await caches.open(SHELL);
  try {
    // Fetch everything before writing anything, then remove the new cache if
    // a storage write fails. Optional resources are deliberately not involved.
    const loaded = await Promise.all(PRECACHE.map(async (path) => {
      const request = new Request(new URL(path, scope), { cache: "reload" });
      const response = await fetch(request);
      if (!response.ok) throw new Error(`Could not precache ${request.url}: ${response.status}`);
      return { request, response };
    }));
    for (const { request, response } of loaded) await cache.put(request, response);
  } catch (error) {
    await caches.delete(SHELL);
    throw error;
  }
}

async function shellFirst(request, key) {
  let cached = null;
  try {
    const cache = await caches.open(SHELL);
    cached = await cache.match(key);
  } catch {
    // An unavailable cache must not make an online application unavailable.
  }
  if (cached) return cached;
  try {
    return await fetch(request);
  } catch {
    return offline();
  }
}

async function runtimeFirst(request) {
  let cache = null;
  try {
    cache = await caches.open(OPTIONAL);
    const cached = await cache.match(request);
    if (cached) return { response: cached };
  } catch {
    // Cache Storage can be unavailable in private or storage-restricted tabs.
  }

  try {
    const response = await fetch(request);
    return response.ok && cache
      ? { response, cache, copy: response.clone() }
      : { response };
  } catch {
    return { response: offline() };
  }
}

async function storeRuntime(cache, request, response) {
  try {
    await cache.put(request, response);
    // Trim after the write so even a burst of concurrent lazy imports ends at
    // the advertised bound when the last cache write settles.
    await trimRuntime(cache);
  } catch {
    // Runtime caching is an optimisation. The fetched response already won.
  }
}

async function trimRuntime(cache, limit = MAX_RUNTIME_ENTRIES) {
  const requests = await cache.keys();
  await Promise.all(requests.slice(0, Math.max(0, requests.length - limit)).map((request) => cache.delete(request)));
}

async function pruneRuntime() {
  const cache = await caches.open(OPTIONAL);
  const requests = await cache.keys();
  await Promise.all(requests.map((request) => (
    RUNTIME_URLS.has(request.url) ? false : cache.delete(request)
  )));
  await trimRuntime(cache);
}

function offline() {
  return new Response("IFCViewX is offline and this response is unavailable.", {
    status: 503,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

self.addEventListener("message", (event) => {
  if (event.data?.type === "skip-waiting") void self.skipWaiting();
});
