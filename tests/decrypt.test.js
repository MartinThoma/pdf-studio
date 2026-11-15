// Opening protected PDFs. The files are encrypted by qpdf, in every variant the standard security
// handler has; the tests are skipped when qpdf is not installed.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PDFArray, PDFDocument, PDFName, decodePDFRawStream } from "../vendor/pdf-lib/pdf-lib.esm.min.js";
import { assemble, loadSource } from "../src/assemble.js";
import { describe, makePdf } from "./fixtures.js";

const hasQpdf = !spawnSync("qpdf", ["--version"]).error;
const dir = mkdtempSync(join(tmpdir(), "pdf-studio-decrypt-"));
const plain = await makePdf({ count: 3, title: "Secret – Geheim" });
writeFileSync(join(dir, "plain.pdf"), plain);

/** `plain`, encrypted by qpdf with the given key length and options ("--object-streams=…" apart). */
function encrypted(name, user, owner, bits, ...options) {
  const out = join(dir, `${name}.pdf`);
  const general = options.filter((option) => option.startsWith("--object-streams"));
  const encryption = options.filter((option) => !general.includes(option));
  execFileSync("qpdf", ["--allow-weak-crypto", ...general, "--encrypt", user, owner, String(bits), ...encryption, "--", join(dir, "plain.pdf"), out]);
  return new Uint8Array(readFileSync(out));
}

/** The decoded content stream of every page, to compare with the unprotected original. */
function contents(doc) {
  return doc.getPages().map((page) => {
    const value = page.node.lookup(PDFName.of("Contents"));
    const streams = value instanceof PDFArray ? value.asArray().map((ref) => page.doc.context.lookup(ref)) : [value];
    return streams.map((stream) => Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1")).join("\n");
  });
}

const original = await PDFDocument.load(plain);
const VARIANTS = [
  ["RC4 40 bit (R2)", 40, []],
  ["RC4 128 bit (R3)", 128, ["--use-aes=n"]],
  ["AES-128 (R4)", 128, ["--use-aes=y"]],
  ["AES-128 with object streams", 128, ["--use-aes=y", "--object-streams=generate"]],
  ["AES-256 (R6)", 256, []],
  ["AES-256 (R6) with object streams", 256, ["--object-streams=generate"]],
  ["AES-256 (R5, deprecated)", 256, ["--force-R5"]],
];

for (const [label, bits, options] of VARIANTS) {
  test(`opens ${label} with the user or the owner password, not with a wrong one`, { skip: !hasQpdf && "qpdf is not installed" }, async () => {
    const bytes = encrypted(label.replace(/\W+/g, "-"), "üser pw", "owner", bits, ...options);
    for (const password of ["üser pw", "owner"]) {
      const { doc, pages } = await loadSource(bytes, { password });
      assert.equal(pages.length, 3);
      assert.equal(doc.getTitle(), "Secret – Geheim", `strings are decrypted (${password})`);
      assert.deepEqual(contents(doc), contents(original), `streams are decrypted (${password})`);
      assert.equal(doc.context.trailerInfo.Encrypt, undefined);
    }
    await assert.rejects(loadSource(bytes), { code: "password", wrong: false });
    await assert.rejects(loadSource(bytes, { password: "nope" }), { code: "password", wrong: true });
  });
}

test("a file that only restricts permissions opens without a password", { skip: !hasQpdf && "qpdf is not installed" }, async () => {
  const bytes = encrypted("owner-only", "", "owner", 256, "--print=none", "--modify=none");
  const { doc } = await loadSource(bytes);
  assert.deepEqual(contents(doc), contents(original));
});

test("a decrypted file can be rearranged and saved, with or without a new password", { skip: !hasQpdf && "qpdf is not installed" }, async () => {
  const bytes = encrypted("save", "pw", "pw", 128, "--use-aes=y", "--object-streams=generate");
  const sources = new Map([["a", (await loadSource(bytes, { password: "pw" })).doc]]);
  const order = [2, 0].map((index) => ({ sourceId: "a", index, rotation: 0 }));
  const { pages } = await describe(await assemble(sources, order));
  assert.deepEqual(pages.map((page) => page.width), [220, 200]);
  const relocked = await assemble(sources, order, { password: "new" });
  const { doc } = await loadSource(relocked, { password: "new" });
  assert.equal(doc.getTitle(), "Secret – Geheim");
});
