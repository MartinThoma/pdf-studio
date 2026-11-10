// Service worker: caches every file of the app on install (list and version in
// asset-manifest.js) and serves them cache-first, so PDF Studio starts and works offline.
//
// A new version installs in the background and waits; the page offers "Reload" and then sends
// "skip-waiting". It never takes over a running page by itself, so a page never mixes files of
// two versions (pdf.js and its worker must match).

importScripts("./asset-manifest.js");

const { version, urls } = self.ASSET_MANIFEST;
const CACHE = `pdf-studio-${version}`;
const INDEX = new URL("./", self.registration.scope).href;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(urls)));
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
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
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
