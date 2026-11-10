// Minimal static server for development and the browser test. Serves only the files the app
// needs (never .git/, node_modules/, scripts/ …), also when it listens on the local network.
// Rewrites asset-manifest.js on start and whenever an app file changes, so the service worker
// picks up edits (the page then offers "Reload").
//
// Usage: npm start                 http://localhost:8000/ on this computer only
//        HOST=0.0.0.0 npm start    also reachable from the local network (what `make run` does)
//        PORT=8080 npm start       another port

import { createReadStream, statSync, watch } from "node:fs";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, writeManifest } from "./build-manifest.js";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".wasm": "application/wasm",
  ".icc": "application/vnd.iccprofile",
};

// URL paths that may be served; everything else is 404.
const PUBLIC_FILES = new Set(["/index.html", "/manifest.webmanifest", "/sw.js", "/asset-manifest.js"]);
const PUBLIC_DIRS = ["/icons/", "/src/", "/vendor/"];

function isPublic(path) {
  if (path.split("/").some((part) => part.startsWith("."))) return false;
  return PUBLIC_FILES.has(path) || PUBLIC_DIRS.some((dir) => path.startsWith(dir));
}

export function startServer(port = 0, host = "127.0.0.1") {
  const server = createServer((request, response) => {
    let path;
    try {
      path = normalize(decodeURIComponent(new URL(request.url, "http://localhost").pathname));
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (path === "/") path = "/index.html";
    const file = join(ROOT, path);
    try {
      if (!isPublic(path) || !statSync(file).isFile()) throw new Error("not public");
    } catch {
      response.writeHead(404, { "content-type": "text/plain" }).end("Not found");
      return;
    }
    response.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-cache",
    });
    createReadStream(file).pipe(response);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

/** IPv4 addresses of this computer in the local network. */
function lanAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((net) => net && net.family === "IPv4" && !net.internal)
    .map((net) => net.address);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const host = process.env.HOST ?? "127.0.0.1";
  const port = Number(process.env.PORT ?? 8000);
  writeManifest();
  let timer;
  const rewrite = () => {
    clearTimeout(timer);
    timer = setTimeout(writeManifest, 150);
  };
  for (const dir of ["src", "icons"]) watch(join(ROOT, dir), { recursive: true }, rewrite);
  watch(join(ROOT, "index.html"), rewrite);

  let server;
  try {
    server = await startServer(port, host);
  } catch (error) {
    console.error(error.code === "EADDRINUSE" ? `Port ${port} is in use. Try: PORT=8080 make run` : error.message);
    process.exit(1);
  }
  const actual = server.address().port;
  console.log(`PDF Studio is running (Ctrl+C to stop):\n`);
  console.log(`  This computer:  http://localhost:${actual}/`);
  if (host === "0.0.0.0" || host === "::") {
    for (const address of lanAddresses()) console.log(`  Local network:  http://${address}:${actual}/`);
    console.log(
      `\n  On other devices the app works, but offline mode and installing need HTTPS\n` +
        `  (browsers allow service workers only on https:// and on localhost).`,
    );
  }
}
