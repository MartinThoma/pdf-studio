// Service worker: caches every file of the app on install (list and version in
// asset-manifest.js) and serves them cache-first, so PDF Studio starts and works offline.
//
// A new version installs in the background and waits; the page (src/update.js) then sends
// "skip-waiting", right away when no work is open, otherwise when the user says so. It never
// takes over a running page by itself, so a page never mixes files of two versions (pdf.js and
// its worker must match).
//
// The page registers sw.js?v=<build of the latest version>, and every file is fetched with that
// build in its URL. A CDN in front of the site (e.g. Cloudflare in front of GitHub Pages) keeps
// plain URLs for hours after a deploy, and so may the browser's HTTP cache; a URL that has never
// been asked for before can only come from the server itself.

const BUILD = new URL(self.location.href).searchParams.get("v");
importScripts(BUILD ? `./asset-manifest.js?v=${encodeURIComponent(BUILD)}` : "./asset-manifest.js");

const { app, version, urls } = self.ASSET_MANIFEST;
const CACHE = `pdf-studio-${version}`;
const INDEX = new URL("./", self.registration.scope).href;

self.addEventListener("install", (event) => {
  // Stored under the plain URL, which is what the page asks for.
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await Promise.all(
        urls.map(async (url) => {
          const response = await fetch(new Request(`${url}?v=${version}`, { cache: "reload" }));
          if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
          await cache.put(url, response);
        }),
      );
    })(),
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
