import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { MANIFEST, ROOT, buildManifest } from "../scripts/build-manifest.js";

test("asset-manifest.js is up to date (run `npm run manifest`)", () => {
  assert.equal(readFileSync(MANIFEST, "utf8"), buildManifest());
});

test("the offline cache contains everything the page loads", () => {
  const manifest = readFileSync(MANIFEST, "utf8");
  for (const url of [
    "./index.html",
    "./src/app.js",
    "./src/pdf-worker.js",
    "./src/styles.css",
    "./vendor/pdfjs/pdf.min.mjs",
    "./vendor/pdfjs/pdf.worker.min.mjs",
    "./vendor/pdfjs/wasm/openjpeg.wasm",
    "./vendor/pdfjs/standard_fonts/LiberationSans-Regular.ttf",
    "./vendor/pdf-lib/pdf-lib.esm.min.js",
    "./icons/icon-192.png",
  ]) {
    assert.ok(manifest.includes(`"${url}"`), `${url} missing from asset-manifest.js`);
    assert.ok(existsSync(join(ROOT, url)), `${url} does not exist`);
  }
});

test("index.html only references files that exist", () => {
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  const refs = [...html.matchAll(/(?:src|href)="([^"#][^"]*)"/g)].map((m) => m[1]);
  assert.ok(refs.length > 3);
  for (const ref of refs) assert.ok(existsSync(join(ROOT, ref)), `${ref} referenced but missing`);
});
