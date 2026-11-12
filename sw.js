// Service worker: caches every file of the app on install (list and version in
// asset-manifest.js) and serves them cache-first, so PDF Studio starts and works offline.
//
// A new version installs in the background and waits; the page (src/update.js) then sends
// "skip-waiting", right away when no work is open, otherwise when the user says so. It never
// takes over a running page by itself, so a page never mixes files of two versions (pdf.js and
// its worker must match).

importScripts("./asset-manifest.js");

const { app, version, urls } = self.ASSET_MANIFEST;
const CACHE = `pdf-studio-${version}`;
const INDEX = new URL("./", self.registration.scope).href;

self.addEventListener("install", (event) => {
  // "reload" goes past the browser's HTTP cache: a new version must not be built from old files
  // that the web server allowed the browser to keep for a while.
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(urls.map((url) => new Request(url, { cache: "reload" })))),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith("pdf-studio-") && key !== CACHE) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
  // The page asks which version it is being served.
  if (event.data === "version") event.ports[0]?.postMessage({ app, build: version });
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  if (request.cache === "no-store") return; // the page asks the server for the latest version
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached =
        (await cache.match(request, { ignoreSearch: true })) ||
        (request.mode === "navigate" ? await cache.match(INDEX) : undefined);
      return cached || fetch(request);
    })(),
  );
});
