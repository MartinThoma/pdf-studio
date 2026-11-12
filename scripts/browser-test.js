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
import { PDFArray, PDFDocument, PDFName } from "../vendor/pdf-lib/pdf-lib.esm.min.js";
import { describe, makeEncryptedPdf, makePdf } from "../tests/fixtures.js";
import { contentBytes, pageObjects } from "../src/content.js";
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

  step("version and install dialog");
  assert.equal(await page.locator("#install").isVisible(), true);
  await page.evaluate(() => {
    const event = new Event("beforeinstallprompt", { cancelable: true });
    event.prompt = () => (window.prompted = true);
    event.userChoice = Promise.resolve({ outcome: "accepted" });
    dispatchEvent(event);
  });
  await page.click("#install");
  await page.waitForSelector('#install-dialog [data-version-status][data-state="latest"]');
  const appVersion = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  const shownVersion = await page.locator("[data-version-current]").textContent();
  assert.ok(shownVersion.startsWith(`${appVersion} (build `), shownVersion);
  await page.click("[data-install-now]");
  assert.equal(await page.evaluate(() => window.prompted), true, "native prompt shown");
  assert.equal(await page.locator("[data-install-now]").isVisible(), false, "the prompt is used up");
  await page.waitForSelector('#install-dialog [data-offline-status][data-state="ready"]');
  assert.match(await page.locator("[data-install-steps]").textContent(), /Install PDF Studio/);
  await page.click('#install-dialog .dialog-actions button');
  assert.equal(await page.locator("#install-dialog").isVisible(), false);

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

  step("details view: go through the pages");
  await page.keyboard.press("Escape");
  await card(2).dblclick();
  await page.waitForSelector("#details:not([hidden])");
  assert.equal(await page.locator("#d-page").inputValue(), "2");
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.locator("#d-page").inputValue(), "3");
  assert.equal(await page.locator("#d-count").textContent(), "5");
  await page.locator(".film-item").nth(1).click();
  assert.equal(await page.locator("#d-page").inputValue(), "2");
  await page.waitForFunction(() => document.querySelector(".stage-item.is-current canvas").width > 300);

  step("details view: scrolling down reaches the next page");
  const currentTop = await page.locator(".stage-item").nth(2).boundingBox();
  await page.evaluate((y) => scrollBy(0, y), currentTop.y - 150);
  await page.waitForFunction(() => document.getElementById("d-page").value === "3");
  await page.waitForFunction(() => document.querySelector(".stage-item.is-current canvas").width > 300);
  await page.locator(".film-item").nth(1).click();
  assert.equal(await page.locator("#d-page").inputValue(), "2");
  await page.waitForTimeout(300);

  step("details view: type a page number");
  await page.fill("#d-page", "4");
  await page.keyboard.press("Enter");
  assert.equal(await page.locator(".film-item").nth(3).getAttribute("aria-current"), "page");
  await page.fill("#d-page", "2");
  await page.keyboard.press("Enter");
  assert.equal(await page.locator(".film-item").nth(1).getAttribute("aria-current"), "page");
  await page.waitForTimeout(300);

  step("details view: rotate a page from the menu of the strip");
  await page.locator(".film-item").nth(1).click({ button: "right" });
  await page.click('#page-menu [data-action="rotate-right"]');
  assert.equal(await page.locator("#page-menu").isVisible(), false);
  assert.equal((await order())[1], "s1:3:90");
  const turnedBox = await page.locator(".stage-item.is-current").boundingBox();
  assert.ok(turnedBox.width > turnedBox.height, "the rotated page is shown landscape");
  await page.keyboard.press("Shift+R");
  assert.equal((await order())[1], "s1:3:0");
  await settle();
  await page.waitForTimeout(300);

  step("details view: mark a name as private and highlight another text");
  await page.keyboard.press("p");
  assert.equal(await page.locator("#tool-private").getAttribute("aria-pressed"), "true");
  const sheet = await page.locator(".stage-item.is-current .sheet").boundingBox();
  const at = (u, v) => [sheet.x + u * sheet.width, sheet.y + v * sheet.height];
  const drag = async (from, to) => {
    await page.mouse.move(...at(...from));
    await page.mouse.down();
    await page.mouse.move(...at(...to), { steps: 6 });
    await page.mouse.up();
  };
  await drag([0.04, 0.42], [0.8, 0.56]);
  // The new mark is selected: its fields are on the right.
  await page.waitForSelector("#pick-mark .mark-edit.private");
  assert.match(await page.locator("#pick-what").textContent(), /Private mark on page 2/);
  assert.equal(await page.locator('#pick-mark [data-field="text"]').inputValue(), "Report 4");
  assert.match(await page.locator("#pick-mark .token").textContent(), /\[NAME_1\]/);
  await page.locator('#pick-mark [data-field="comment"]').fill("the patient");
  await page.locator('#pick-mark [data-field="comment"]').press("Enter");
  assert.equal(await page.locator("#highlight-colors").isVisible(), false, "colours only show with the highlight tool");
  await page.keyboard.press("h");
  assert.equal(await page.locator("#highlight-colors").isVisible(), true);
  assert.equal(await page.locator("#category-control").isVisible(), false);
  await drag([0.04, 0.05], [0.5, 0.12]); // the coloured band, no text
  await page.waitForSelector("#pick-mark .mark-edit.highlight");
  assert.equal(await page.locator(".mark-row").count(), 2);
  await page.locator('#pick-mark .swatch[data-color="green"]').click();
  assert.equal(await page.evaluate(() => window.pdfStudio.pages()[1].marks[1].color), "green");
  await page.keyboard.press("Control+z");
  assert.equal(await page.evaluate(() => window.pdfStudio.pages()[1].marks[1].color), "yellow");
  assert.match(await page.locator("#shortcuts [data-version]").textContent(), /^Version \d+\.\d+\.\d+( \(build [0-9a-f]{7}\))?$/);
  await page.locator(".mark-row.private").click(); // the list selects a mark
  await page.locator("#pick-mark select").selectOption("address");
  assert.match(await page.locator(".mark-row.private .kind").textContent(), /\[ADDRESS_1\]/);
  await page.locator("#pick-mark select").selectOption("name");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#tool-highlight").getAttribute("aria-pressed"), "false");
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(DOCS, "screenshot-details.png") });

  step("arrange view shows the marks; undo removes the last one");
  await page.click("#view-arrange");
  assert.equal(await card(2).locator(".page-flags span").count(), 2);
  assert.match(await page.locator("#summary").textContent(), /1 private mark/);
  for (let i = 0; i < 3; i++) await page.click("#undo"); // category twice, then the highlight
  assert.equal(await card(2).locator(".page-flags span").count(), 1);
  for (let i = 0; i < 3; i++) await page.click("#redo");

  step("privacy list and PDF contain the mark");
  const [listDownload] = await Promise.all([page.waitForEvent("download"), page.click("#privacy-list")]);
  const list = JSON.parse(readFileSync(await listDownload.path(), "utf8"));
  assert.equal(list.format, "pdf-studio-privacy/1");
  assert.equal(list.entries.length, 1);
  assert.equal(list.entries[0].page, 2);
  assert.equal(list.entries[0].text, "Report 4");
  assert.equal(list.entries[0].comment, "the patient");
  assert.deepEqual(list.replacements, { "[NAME_1]": "Report 4" });
  const [marked] = await Promise.all([page.waitForEvent("download"), page.click("#download")]);
  const markedPdf = await PDFDocument.load(readFileSync(await marked.path()));
  const annots = markedPdf.getPages()[1].node.lookup(PDFName.of("Annots"), PDFArray).asArray();
  assert.equal(annots.length, 2);
  const annot = markedPdf.context.lookup(annots[0]);
  assert.equal(annot.get(PDFName.of("Contents")).decodeText(), "Report 4");
  await page.screenshot({ path: join(DOCS, "screenshot.png") });

  step("details view: select a text and change it");
  await page.click("#view-details");
  await page.locator(".film-item").nth(4).click();
  assert.equal(await page.locator("#d-page").inputValue(), "5");
  await page.waitForFunction(() => document.querySelector(".stage-item.is-current canvas").width > 300);
  const last = await page.locator(".stage-item.is-current .sheet").boundingBox();
  const spot = [last.x + 0.15 * last.width, last.y + 0.47 * last.height];
  await page.mouse.move(spot[0] - 5, spot[1]);
  await page.mouse.move(...spot);
  await page.waitForSelector(".stage-item.is-current .object-hover:not([hidden])");
  await page.mouse.click(...spot);
  await page.waitForSelector("#pick-panel:not([hidden])");
  assert.match(await page.locator("#pick-what").textContent(), /Text on page 5/);
  assert.equal(await page.locator("#pick-source").isVisible(), false, "PDF source is a developer option");
  await page.evaluate(() => document.getElementById("dev-options").click());
  await page.waitForFunction(() => /Tj[^]*% Font \//.test(document.getElementById("pick-source-text").textContent));
  await page.evaluate(() => document.getElementById("dev-options").click());
  assert.equal(await page.locator("#pick-source").isVisible(), false);
  await page.waitForFunction(() => document.getElementById("pick-text").value === "Appendix 1");
  await page.fill("#pick-text", "Changed");
  await page.keyboard.press("Enter");
  assert.deepEqual(await page.evaluate(() => Object.values(window.pdfStudio.pages()[4].edits)), ["Changed"]);
  await page.mouse.click(last.x + 0.9 * last.width, last.y + 0.9 * last.height); // nothing there
  assert.equal(await page.locator("#pick-panel").isVisible(), false);
  await page.waitForTimeout(600); // the page is drawn again with the new text
  await page.screenshot({ path: join(ROOT, "test-output", "edited.png") });

  step("details view: select a text on a rotated page and delete it");
  await page.locator(".film-item").nth(0).click();
  await page.waitForFunction(() => document.querySelector(".stage-item.is-current canvas").width > 300);
  await page.evaluate(() => scrollBy(0, 450)); // the text is in the lower part of the tall page
  await page.waitForTimeout(200);
  const first = await page.locator(".stage-item").nth(0).boundingBox();
  // The page is turned 270°: the point (0.15, 0.47) of the page is at (0.47, 0.85) of what is shown.
  await page.mouse.click(first.x + 0.47 * first.width, first.y + 0.85 * first.height);
  await page.waitForSelector("#pick-panel:not([hidden])");
  await page.keyboard.press("Delete");
  await page.waitForFunction(() => window.pdfStudio.pages()[0].removed?.length === 1);
  assert.match(await lastToast().textContent(), /Deleted 1 object/);

  step("details view: delete a mark with its button; move and delete pages in the strip; undo");
  await page.locator(".film-item").nth(1).click();
  await page.waitForTimeout(200);
  const markBox = await page.locator(".stage-item.is-current .mark.private").boundingBox();
  await page.mouse.click(markBox.x + markBox.width / 2, markBox.y + markBox.height / 2);
  await page.locator(".stage-item.is-current .mark-delete").click();
  assert.equal(await page.evaluate(() => window.pdfStudio.pages()[1].marks.length), 1);
  await page.keyboard.press("Control+z");
  assert.equal(await page.evaluate(() => window.pdfStudio.pages()[1].marks.length), 2);
  const fromItem = await page.locator(".film-item").nth(4).boundingBox();
  const toItem = await page.locator(".film-item").nth(0).boundingBox();
  await page.mouse.move(fromItem.x + fromItem.width / 2, fromItem.y + fromItem.height / 2);
  await page.mouse.down();
  await page.mouse.move(toItem.x + toItem.width / 2, toItem.y + 4, { steps: 8 });
  assert.equal(await page.locator(".film-marker").isVisible(), true);
  await page.mouse.up();
  assert.equal((await order())[0], "s2:0:0");
  await page.keyboard.press("Control+z");
  assert.equal((await order())[4], "s2:0:0");
  await page.locator(".film-item").nth(1).hover();
  await page.locator(".film-item").nth(1).locator(".film-delete").click();
  assert.equal((await order()).length, 4);
  assert.equal(await page.locator("#d-count").textContent(), "4");
  await page.keyboard.press("Control+z");
  assert.equal((await order()).length, 5);

  step("the saved file has the changed text and not the deleted one");
  const [erased] = await Promise.all([page.waitForEvent("download"), page.click("#download")]);
  const erasedPdf = await PDFDocument.load(readFileSync(await erased.path()));
  assert.equal(pageObjects(erasedPdf.getPage(0)).filter((o) => o.type === "text").length, 0);
  assert.equal(pageObjects(erasedPdf.getPage(4)).filter((o) => o.type === "text").length, 1);
  const lastContent = new TextDecoder("latin1").decode(contentBytes(erasedPdf.getPage(4)));
  assert.ok(lastContent.includes("4368616E676564"), "the new text is in the file");
  await page.click("#view-arrange");
  assert.equal(await card(5).locator(".page-flags .rm").count(), 1);

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

  step("after installing, the button stays for the version");
  await page.evaluate(() => dispatchEvent(new Event("appinstalled")));
  assert.match(await lastToast().textContent(), /installed/);
  assert.equal((await page.locator("#install .label").textContent()).trim(), "Version");

  step("a new version on the server: the button says so, Update now loads it");
  const manifestPath = join(ROOT, "asset-manifest.js");
  const realManifest = readFileSync(manifestPath, "utf8");
  try {
    writeFileSync(manifestPath, realManifest.replace(/"version": "[0-9a-f]+"/, '"version": "feedfeedfeed"'));
    await page.click("#install");
    await page.waitForSelector('#install-dialog [data-version-status][data-state="outdated"]');
    assert.match(await page.locator("[data-version-status]").textContent(), /newer version/);
    assert.equal((await page.locator("#install .label").textContent()).trim(), "Update");
    assert.equal((await order()).length, 3, "work is open, so nothing reloads by itself");
    await Promise.all([page.waitForEvent("load"), page.click("[data-update-now]")]);
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await page.click("#install");
    await page.waitForSelector('#install-dialog [data-version-status][data-state="latest"]');
    assert.match(await page.locator("[data-version-current]").textContent(), /build feedfee/);
  } finally {
    writeFileSync(manifestPath, realManifest);
  }

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
