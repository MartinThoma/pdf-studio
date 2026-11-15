import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assemble, loadSource } from "../src/assemble.js";
import { makePdf } from "./fixtures.js";

async function protectedPdf(password) {
  const sources = new Map([["a", (await loadSource(await makePdf({ count: 3, title: "Secret" }))).doc]]);
  return assemble(sources, [0, 1, 2].map((index) => ({ sourceId: "a", index, rotation: 0 })), { password });
}

test("a protected PDF cannot be opened without the password, and opens with it", async () => {
  const bytes = await protectedPdf("correct horse");
  assert.match(new TextDecoder("latin1").decode(bytes), /\/Encrypt/);
  await assert.rejects(loadSource(bytes), { code: "password" });
  const { pages } = await loadSource(bytes, { password: "correct horse" });
  assert.equal(pages.length, 3);
});

test("a protected PDF opens with the password (checked with qpdf, when installed)", async (t) => {
  if (spawnSync("qpdf", ["--version"]).error) return t.skip("qpdf is not installed");
  const file = join(mkdtempSync(join(tmpdir(), "pdf-studio-")), "locked.pdf");
  writeFileSync(file, await protectedPdf("pässword"));
  const info = (password) => spawnSync("qpdf", [`--password=${password}`, "--check", file], { encoding: "utf8" });
  assert.equal(info("pässword").status, 0, info("pässword").stdout + info("pässword").stderr);
  assert.notEqual(info("wrong").status, 0);
  const encryption = execFileSync("qpdf", ["--password=pässword", "--show-encryption", file], { encoding: "utf8" });
  assert.match(encryption, /R = 6/);
  assert.match(encryption, /AESv3/);
  const pages = execFileSync("qpdf", ["--password=pässword", "--show-npages", file], { encoding: "utf8" });
  assert.equal(pages.trim(), "3");
});

test("without a password nothing is encrypted", async () => {
  const bytes = await protectedPdf(undefined);
  assert.doesNotMatch(new TextDecoder("latin1").decode(bytes), /\/Encrypt/);
});
