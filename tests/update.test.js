import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MANIFEST } from "../scripts/build-manifest.js";
import { compareVersions, describeVersion, parseManifest } from "../src/update.js";
import { VERSION } from "../src/version.js";

test("parseManifest reads app version and build from asset-manifest.js", () => {
  const manifest = parseManifest(readFileSync(MANIFEST, "utf8"));
  assert.equal(manifest.app, VERSION);
  assert.match(manifest.build, /^[0-9a-f]{12}$/);
  assert.equal(parseManifest("<html>not found</html>"), null);
});

test("compareVersions tells if what runs is what the server has", () => {
  const current = { app: "1.0.0", build: "aaaaaaaaaaaa" };
  assert.equal(compareVersions(current, { app: "1.0.0", build: "aaaaaaaaaaaa" }), "latest");
  assert.equal(compareVersions(current, { app: "1.0.0", build: "bbbbbbbbbbbb" }), "outdated", "same number, other files");
  assert.equal(compareVersions(current, null), "unknown", "offline");
  // A page whose service worker does not report its build is compared by the number.
  assert.equal(compareVersions({ app: "1.0.0", build: "" }, { app: "1.1.0", build: "bbbbbbbbbbbb" }), "outdated");
  assert.equal(compareVersions({ app: "1.0.0", build: "" }, { app: "1.0.0", build: "bbbbbbbbbbbb" }), "latest");
});

test("describeVersion shows number and short build", () => {
  assert.equal(describeVersion({ app: "1.2.3", build: "abcdef123456" }), "1.2.3 (build abcdef1)");
  assert.equal(describeVersion({ app: "1.2.3", build: "" }), "1.2.3");
});
