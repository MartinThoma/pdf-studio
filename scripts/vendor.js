// Copies the runtime files of pdf.js and pdf-lib from node_modules/ into vendor/, so the app
// works as plain static files without a bundler and without any CDN.
//
// Usage: npm run vendor   (after `npm install`; also rewrites asset-manifest.js)

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeManifest } from "./build-manifest.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = join(ROOT, "vendor");
const PDFJS = join(ROOT, "node_modules", "pdfjs-dist");
const PDFLIB = join(ROOT, "node_modules", "pdf-lib");

// pdf.js loads these on demand: character maps for CJK text, the 14 standard fonts for PDFs
// that don't embed them, WebAssembly image decoders (JPEG 2000, JBIG2, colour management) and an
// ICC profile. quickjs (JavaScript inside PDFs) is left out: the app never runs PDF scripts.
const PDFJS_WASM = [
  "jbig2.wasm", "jbig2_nowasm_fallback.js", "openjpeg.wasm", "openjpeg_nowasm_fallback.js",
  "qcms_bg.wasm", "LICENSE_JBIG2", "LICENSE_OPENJPEG", "LICENSE_PDFJS_JBIG2",
  "LICENSE_PDFJS_OPENJPEG", "LICENSE_PDFJS_QCMS", "LICENSE_QCMS",
];

function version(dir) {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
}

rmSync(VENDOR, { recursive: true, force: true });
mkdirSync(join(VENDOR, "pdfjs", "wasm"), { recursive: true });
mkdirSync(join(VENDOR, "pdf-lib"), { recursive: true });

for (const file of ["pdf.min.mjs", "pdf.worker.min.mjs"]) {
  cpSync(join(PDFJS, "build", file), join(VENDOR, "pdfjs", file));
}
for (const dir of ["cmaps", "standard_fonts", "iccs"]) {
  cpSync(join(PDFJS, dir), join(VENDOR, "pdfjs", dir), { recursive: true });
}
for (const file of PDFJS_WASM) {
  cpSync(join(PDFJS, "wasm", file), join(VENDOR, "pdfjs", "wasm", file));
}
cpSync(join(PDFJS, "LICENSE"), join(VENDOR, "pdfjs", "LICENSE"));
cpSync(join(PDFLIB, "dist", "pdf-lib.esm.min.js"), join(VENDOR, "pdf-lib", "pdf-lib.esm.min.js"));
cpSync(join(PDFLIB, "LICENSE.md"), join(VENDOR, "pdf-lib", "LICENSE.md"));

writeFileSync(
  join(VENDOR, "VERSIONS.md"),
  `# Vendored libraries\n\nCopied from node_modules/ by \`npm run vendor\`; do not edit by hand.\n\n` +
    `| Library | Version | License |\n|---|---|---|\n` +
    `| pdfjs-dist | ${version(PDFJS)} | Apache-2.0 (\`pdfjs/LICENSE\`; fonts and decoders: \`pdfjs/*/LICENSE*\`) |\n` +
    `| pdf-lib | ${version(PDFLIB)} | MIT (\`pdf-lib/LICENSE.md\`) |\n`,
);

writeManifest();
console.log(`vendor/: pdfjs-dist ${version(PDFJS)}, pdf-lib ${version(PDFLIB)}`);
