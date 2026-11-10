// End-to-end test in a real (headless) Chrome: uploads PDFs, rotates, deletes, drags, uses the
// keyboard, undo/redo, downloads and checks the result with pdf-lib; then goes offline, reloads
// and does it again from the service worker cache. Writes the README screenshots to docs/.
//
// Usage: npm run test:browser   (needs Google Chrome; CHROME=/path/to/chrome to override,
//                                HEADED=1 to watch)

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { describe, makeEncryptedPdf, makePdf } from "../tests/fixtures.js";
import { writeManifest } from "./build-manifest.js";
import { startServer } from "./serve.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = join(ROOT, "docs");
const tmp = mkdtempSync(join(tmpdir(), "pdf-studio-"));

const files = {
  report: join(tmp, "report.pdf"),
  appendix: join(tmp, "appendix.pdf"),
  locked: join(tmp, "locked.pdf"),
  notes: join(tmp, "notes.txt"),
};
// report.pdf: widths 200, 210 (own /Rotate 90), 220, 230; appendix.pdf: widths 400, 410.
writeFileSync(files.report, await makePdf({ count: 4, rotations: [0, 90, 0, 0], label: "Report" }));
writeFileSync(files.appendix, await makePdf({ count: 2, firstWidth: 400, label: "Appendix" }));
writeFileSync(files.locked, makeEncryptedPdf());
writeFileSync(files.notes, "just text");

writeManifest();
const server = await startServer(0);
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({
  headless: !process.env.HEADED,
  ...(process.env.CHROME ? { executablePath: process.env.CHROME } : { channel: "chrome" }),
});
const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, acceptDownloads: true });
const page = await context.newPage();
const problems = [];
page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
page.on("console", (message) => {
  if (message.type() === "error" || /Content Security Policy|Refused to/.test(message.text())) {
    problems.push(`console: ${message.text()}`);
  }
});
page.on("dialog", (dialog) => dialog.accept());

const step = (name) => console.log(`• ${name}`);
const order = () =>
  page.evaluate(() => window.pdfStudio.pages().map((p) => `${p.sourceId}:${p.index}:${p.rotation}`));
const card = (n) => page.locator(".page").nth(n - 1);
const lastToast = () => page.locator(".toast").last();

// Cards slide to their new place after a change; measure them only once they are there.
async function settle() {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"));
}

async function waitForPreviews(count) {
  await page.waitForFunction((n) => document.querySelectorAll(".paper.ready").length >= n, count, {
    timeout: 20_000,
  });
}

async function downloadResult() {
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#download")]);
  const bytes = readFileSync(await download.path());
  return { name: download.suggestedFilename(), ...(await describe(bytes)) };
}

try {
  step("start page and service worker");
  await page.goto(base);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 20_000 });
  assert.equal(await page.locator("#empty").isVisible(), true);
  await page.screenshot({ path: join(DOCS, "screenshot-empty.png") });

  step("upload report.pdf");
  await page.setInputFiles("#file-input", files.report);
  await waitForPreviews(4);
  assert.deepEqual(await order(), ["s1:0:0", "s1:1:0", "s1:2:0", "s1:3:0"]);
  assert.match(await lastToast().textContent(), /Added “report\.pdf” \(4 pages\)/);

  step("page with its own /Rotate 90 is shown landscape");
  const paperBox = await card(2).locator(".paper").boundingBox();
  assert.ok(paperBox.width > paperBox.height, "page 2 has /Rotate 90 and must look landscape");

  step("rotate page 1 with the hover button");
  await card(1).hover();
  await card(1).locator('[data-action="rotate-right"]').click();
  assert.deepEqual((await order())[0], "s1:0:90");

  step("select page 3 and delete it with the Delete key");
  await card(3).click();
  await page.keyboard.press("Delete");
  assert.deepEqual(await order(), ["s1:0:90", "s1:1:0", "s1:3:0"]);
  assert.match(await lastToast().textContent(), /Deleted 1 page/);

  step("drag the last page to the front");
  await settle();
  const from = await card(3).boundingBox();
  const to = await card(1).boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    const x = from.x + from.width / 2 + ((to.x + 10 - (from.x + from.width / 2)) * i) / 12;
    const y = from.y + from.height / 2 + ((to.y + to.height / 2 - (from.y + from.height / 2)) * i) / 12;
    await page.mouse.move(x, y);
  }
  assert.equal(await page.locator(".drop-marker").isVisible(), true);
  await page.mouse.up();
  assert.deepEqual(await order(), ["s1:3:0", "s1:0:90", "s1:1:0"]);

  step("undo and redo");
  await page.keyboard.press("Control+z");
  assert.deepEqual(await order(), ["s1:0:90", "s1:1:0", "s1:3:0"]);
  await page.click("#redo");
  assert.deepEqual(await order(), ["s1:3:0", "s1:0:90", "s1:1:0"]);

  step("add appendix.pdf; move its last page to the front and rotate it left with the keyboard");
  await page.setInputFiles("#file-input", files.appendix);
  await waitForPreviews(5);
  await settle();
  await card(5).click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Shift+R");
  assert.deepEqual(await order(), ["s2:1:270", "s1:3:0", "s1:0:90", "s1:1:0", "s2:0:0"]);

  step("multi-select with Ctrl-click and rotate both from the selection bar");
  await settle();
  await card(2).click();
  await card(4).click({ modifiers: ["Control"] });
  assert.equal(await page.locator("#selection-count").textContent(), "2 selected");
  await page.click("#sel-rotate-right");
  await page.click("#sel-rotate-right");
  assert.deepEqual(await order(), ["s2:1:270", "s1:3:180", "s1:0:90", "s1:1:180", "s2:0:0"]);
  await page.click("#sel-rotate-left");
  await page.click("#sel-rotate-left");
  await page.waitForTimeout(400); // let the rotation settle for the screenshot
  await page.screenshot({ path: join(DOCS, "screenshot.png") });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(400); // colour transitions
  await page.screenshot({ path: join(DOCS, "screenshot-dark.png") });
  await page.emulateMedia({ colorScheme: "light" });
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#selection-actions").isVisible(), false);

  step("download and check the result");
  const result = await downloadResult();
  assert.equal(result.name, "report-merged.pdf");
  assert.deepEqual(
    result.pages.map((p) => `${p.width}/${p.rotation}`),
    // 410 and 230 as they are, 200 rotated 90, 210 (own 90) as it is, 400 as it is; 410 turned left
    ["410/270", "230/0", "200/90", "210/90", "400/0"],
  );
  assert.equal(result.pageObjects, 5, "the deleted page must not be in the file");

  step("encrypted file and non-PDF are rejected with a message");
  await page.setInputFiles("#file-input", files.locked);
  await page.waitForSelector(".toast.error");
  assert.match(await page.locator(".toast.error").last().textContent(), /protected/);
  await page.setInputFiles("#file-input", files.notes);
  await page.waitForFunction(() => /not a PDF/.test(document.querySelector(".toast.error:last-child")?.textContent));
  assert.equal((await order()).length, 5, "nothing added");

  step("phone width: no horizontal scrolling, toolbar fits");
  await page.setViewportSize({ width: 375, height: 780 });
  await page.waitForTimeout(200);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert.ok(overflow <= 0, `page is ${overflow}px wider than the screen`);
  await page.screenshot({ path: join(DOCS, "screenshot-phone.png") });
  await page.setViewportSize({ width: 1280, height: 860 });

  step("offline: reload from the cache, open, render and save");
  await context.setOffline(true);
  await page.reload();
  await page.waitForSelector("#empty:not([hidden])");
  await page.setInputFiles("#file-input", files.report);
  await waitForPreviews(4);
  await settle();
  await card(2).click();
  await page.keyboard.press("Backspace");
  const offline = await downloadResult();
  assert.equal(offline.name, "report-edited.pdf");
  assert.deepEqual(offline.pages.map((p) => p.width), [200, 220, 230]);
  await context.setOffline(false);

  assert.deepEqual(problems, [], "no errors in the console");
  console.log("\nBrowser test passed. Screenshots in docs/.");
} catch (error) {
  mkdirSync(join(ROOT, "test-output"), { recursive: true });
  await page.screenshot({ path: join(ROOT, "test-output", "failure.png") }).catch(() => {});
  if (problems.length) console.error("Console problems:\n" + problems.join("\n"));
  throw error;
} finally {
  await browser.close();
  server.close();
  rmSync(tmp, { recursive: true, force: true });
}
