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
import { PDFArray, PDFDocument, PDFName, PDFRawStream } from "../vendor/pdf-lib/pdf-lib.esm.min.js";
import { describe, makeEncryptedPdf, makePdf } from "../tests/fixtures.js";
import { contentBytes, pageObjects, readOperators } from "../src/content.js";
import { writeManifest } from "./build-manifest.js";
import { startServer } from "./serve.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = join(ROOT, "docs");
const tmp = mkdtempSync(join(tmpdir(), "pdf-studio-"));

const files = {
  report: join(tmp, "report.pdf"),
  appendix: join(tmp, "appendix.pdf"),
  locked: join(tmp, "locked.pdf"),
  protected: join(tmp, "protected.pdf"),
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
/** The text a page's content shows, as plain text (what could be copied from it). */
const shownText = (bytes) =>
  readOperators(bytes)
    .filter((operator) => ["Tj", "TJ", "'", '"'].includes(operator.op))
    .map((operator) => operator.operands.flat().filter((operand) => operand?.bytes).map((operand) => String.fromCharCode(...operand.bytes)).join(""))
    .join("");
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
  assert.match(await page.locator("#pick-mark .note").textContent(), /Blacked out when you download/);
  assert.match(await page.locator("#tool-hint").textContent(), /removed from the PDF and blacked out/);
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

  step("a download blacks out the private mark: the text is gone, a black box is there, only the highlight is an annotation");
  const [redacted] = await Promise.all([page.waitForEvent("download"), page.click("#download")]);
  assert.match(await page.locator(".toast", { hasText: "Saved" }).last().textContent(), /1 private mark blacked out/);
  const redactedPage = (await PDFDocument.load(readFileSync(await redacted.path()))).getPages()[1];
  assert.equal(shownText(contentBytes(redactedPage)), "", "the marked text is cut out of the page");
  assert.ok(readOperators(contentBytes(redactedPage)).some((operator) => operator.op === "re"), "a black box is drawn");
  assert.equal(redactedPage.node.lookup(PDFName.of("Annots"), PDFArray).asArray().length, 1);

  step("keeping private marks readable is a setting, remembered between visits");
  await page.click("#download-options");
  assert.equal(await page.locator("#redact").isChecked(), true, "blacking out is the default");
  await page.uncheck("#redact");
  assert.equal(await page.evaluate(() => localStorage.getItem("pdf-studio:private-marks")), "annotate");
  assert.match(await page.locator("#redact-note").textContent(), /readable/);
  await page.keyboard.press("Escape");
  const [marked] = await Promise.all([page.waitForEvent("download"), page.click("#download")]);
  assert.match(await page.locator(".toast", { hasText: "Saved" }).last().textContent(), /text under 1 private mark is still readable/);
  const markedPdf = await PDFDocument.load(readFileSync(await marked.path()));
  const annots = markedPdf.getPages()[1].node.lookup(PDFName.of("Annots"), PDFArray).asArray();
  assert.equal(annots.length, 2);
  const annot = markedPdf.context.lookup(annots[0]);
  assert.equal(annot.get(PDFName.of("Contents")).decodeText(), "Report 4");
  await page.click("#download-options");
  await page.check("#redact");
  assert.equal(await page.evaluate(() => localStorage.getItem("pdf-studio:private-marks")), null);
  await page.keyboard.press("Escape");
  await page.screenshot({ path: join(DOCS, "screenshot.png") });

  step("a JPEG scan: the pixels under a private mark are blacked out by the browser");
  const jpeg = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 400;
    canvas.height = 300;
    const draw = canvas.getContext("2d");
    draw.fillStyle = "#e02020";
    draw.fillRect(0, 0, 200, 300);
    draw.fillStyle = "#2020e0";
    draw.fillRect(200, 0, 200, 300);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.95));
    return [...new Uint8Array(await blob.arrayBuffer())];
  });
  const scanDoc = await PDFDocument.create();
  scanDoc.addPage([400, 300]).drawImage(await scanDoc.embedJpg(Uint8Array.from(jpeg)), { x: 0, y: 0, width: 400, height: 300 });
  const scanFile = join(tmp, "scan.pdf");
  writeFileSync(scanFile, await scanDoc.save());
  const scan = await context.newPage();
  scan.on("pageerror", (error) => problems.push(`page error (scan): ${error.message}`));
  scan.on("console", (message) => message.type() === "error" && problems.push(`console (scan): ${message.text()}`));
  await scan.goto(base);
  await scan.setInputFiles("#file-input", scanFile);
  await scan.waitForFunction(() => window.pdfStudio.pages().length === 1);
  await scan.click("#view-details");
  await scan.keyboard.press("p");
  await scan.waitForFunction(() => document.querySelector(".stage-item.is-current canvas")?.width > 300);
  const scanSheet = await scan.locator(".stage-item.is-current .sheet").boundingBox();
  const scanAt = (u, v) => [scanSheet.x + u * scanSheet.width, scanSheet.y + v * scanSheet.height];
  await scan.mouse.move(...scanAt(0.05, 0.05));
  await scan.mouse.down();
  await scan.mouse.move(...scanAt(0.35, 0.3), { steps: 6 });
  await scan.mouse.up();
  await scan.waitForSelector("#pick-mark .mark-edit.private");
  const [scanned] = await Promise.all([scan.waitForEvent("download"), scan.click("#download")]);
  assert.equal(await scan.locator(".toast.error").count(), 0, "nothing had to be removed as a whole");
  const scanOut = await PDFDocument.load(readFileSync(await scanned.path()));
  const images = [...scanOut.context.enumerateIndirectObjects()]
    .map(([, object]) => object)
    .filter((object) => object instanceof PDFRawStream && object.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"));
  assert.equal(images.length, 1, "the original scan is not left in the file");
  assert.equal(images[0].dict.get(PDFName.of("Filter")), PDFName.of("DCTDecode"));
  const sampled = await scan.evaluate(async (bytes) => {
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(bytes)], { type: "image/jpeg" }));
    const draw = Object.assign(document.createElement("canvas"), { width: bitmap.width, height: bitmap.height }).getContext("2d");
    draw.drawImage(bitmap, 0, 0);
    return [[80, 45], [80, 250], [300, 45]].map(([x, y]) => [...draw.getImageData(x, y, 1, 1).data.slice(0, 3)]);
  }, [...images[0].contents]);
  const [under, left, right] = sampled;
  assert.ok(Math.max(...under) < 40, `under the mark: black (${under})`);
  assert.ok(left[0] > 180 && left[2] < 80, `left, outside the mark: still red (${left})`);
  assert.ok(right[2] > 180 && right[0] < 80, `right, outside the mark: still blue (${right})`);
  await scan.close();

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

  step("password protection is applied to the download");
  await page.click("#download-options");
  await page.check("#protect");
  await page.fill("#protect-password", "s3cret");
  await page.press("#protect-password", "Enter"); // closes the options, keeps the password
  assert.equal(await page.isHidden("#download-panel"), true);
  assert.equal(await page.getAttribute("#download use", "href"), "#i-lock");
  const [locked] = await Promise.all([page.waitForEvent("download"), page.click("#download")]);
  const lockedBytes = readFileSync(await locked.path());
  assert.match(lockedBytes.toString("latin1"), /\/Encrypt/);
  await assert.rejects(describe(lockedBytes));
  writeFileSync(files.protected, lockedBytes);
  await page.click("#download-options");
  await page.uncheck("#protect");
  await page.keyboard.press("Escape");
  assert.equal(await page.getAttribute("#download use", "href"), "#i-download");

  step("a file name typed in the download options");
  await page.click("#download-options");
  assert.equal(await page.getAttribute("#file-name", "placeholder"), "report-merged.pdf");
  await page.fill("#file-name", "Final: report");
  await page.press("#file-name", "Enter");
  const [named] = await Promise.all([page.waitForEvent("download"), page.click("#download")]);
  assert.equal(named.suggestedFilename(), "Final- report.pdf");
  await page.click("#download-options");
  await page.fill("#file-name", "");
  await page.keyboard.press("Escape");

  step("a protected file asks for its password; skipping it adds nothing");
  await page.setInputFiles("#file-input", files.locked);
  await page.waitForSelector("#password-dialog[open]");
  assert.match(await page.textContent("#password-file"), /locked\.pdf/);
  await page.click("#password-skip");
  await page.waitForSelector("#password-dialog", { state: "hidden" });
  assert.equal((await order()).length, 5, "nothing added");
  assert.equal(await page.locator(".toast.error").count(), 0, "skipping is not an error");

  step("a protected file opens with its password, after a wrong one");
  await page.setInputFiles("#file-input", files.protected);
  await page.waitForSelector("#password-dialog[open]");
  await page.fill("#open-password", "wrong");
  await page.press("#open-password", "Enter");
  await page.waitForSelector("#password-wrong:not([hidden])");
  assert.equal(await page.isVisible("#password-dialog"), true);
  await page.fill("#open-password", "s3cret");
  await page.press("#open-password", "Enter");
  await page.waitForFunction(() => window.pdfStudio.pages().length === 10);
  await waitForPreviews(10);
  await page.keyboard.press("Control+z");
  assert.equal((await order()).length, 5);

  step("non-PDF is rejected with a message");
  await page.setInputFiles("#file-input", files.notes);
  await page.waitForFunction(() => /not a PDF/.test(document.querySelector(".toast.error:last-child")?.textContent));
  assert.equal((await order()).length, 5, "nothing added");

  step("phone width: no horizontal scrolling, toolbar fits");
  await page.setViewportSize({ width: 375, height: 780 });
  await page.waitForTimeout(200);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert.ok(overflow <= 0, `page is ${overflow}px wider than the screen`);
  await page.screenshot({ path: join(DOCS, "screenshot-phone.png") });
  // With a password set, the options open and stay open while the on-screen keyboard shrinks the window.
  await page.click("#download-options");
  await page.check("#protect");
  await page.fill("#protect-password", "s3cret");
  await page.keyboard.press("Escape");
  await page.click("#download-options");
  await page.setViewportSize({ width: 375, height: 420 });
  await page.waitForTimeout(200);
  assert.equal(await page.isVisible("#download-panel"), true, "options stay open when the keyboard appears");
  await page.uncheck("#protect");
  await page.keyboard.press("Escape");
  assert.equal(await page.isHidden("#download-panel"), true);
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
    // Like a CDN right after a deploy: the plain URL still gives the old copy; only URLs with a
    // query string (which the CDN has not cached) reach the new file.
    // One file of the new version comes slowly, so the progress shows before the reload.
    server.override = async (path, search) => {
      if (path === "/asset-manifest.js" && !search) return realManifest;
      if (path === "/index.html" && search === "?v=feedfeedfeed") await new Promise((resolve) => setTimeout(resolve, 1500));
      return undefined;
    };
    await page.click("#install");
    await page.waitForSelector('#install-dialog [data-version-status][data-state="outdated"]');
    assert.match(await page.locator("[data-version-status]").textContent(), /newer version/);
    assert.equal((await page.locator("#install .label").textContent()).trim(), "Update");
    assert.equal((await order()).length, 3, "work is open, so nothing reloads by itself");
    const reloaded = page.waitForEvent("load", { timeout: 30_000 });
    await page.click("[data-update-now]");
    assert.equal((await page.textContent("[data-update-now]")).trim(), "Updating…");
    assert.match(await page.textContent("[data-version-status]"), /Downloading the new version/);
    assert.match(await lastToast().textContent(), /Downloading the new version/);
    await reloaded;
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await page.click("#install");
    await page.waitForSelector('#install-dialog [data-version-status][data-state="latest"]');
    assert.match(await page.locator("[data-version-current]").textContent(), /build feedfee/);
    await page.keyboard.press("Escape");

    step("a new version that cannot be downloaded: a message, the current version keeps running");
    writeFileSync(manifestPath, realManifest.replace(/"version": "[0-9a-f]+"/, '"version": "deadbeefdead"'));
    server.override = (path, search) => (path === "/src/app.js" && search === "?v=deadbeefdead" ? null : undefined);
    await page.setInputFiles("#file-input", files.report); // work is open: no automatic switch
    await page.waitForFunction(() => window.pdfStudio.pages().length === 4);
    await page.click("#install");
    await page.waitForSelector('#install-dialog [data-version-status][data-state="outdated"]');
    let reloadedAgain = false;
    page.once("load", () => (reloadedAgain = true));
    await page.click("[data-update-now]");
    await page.waitForSelector(".toast.error", { timeout: 30_000 });
    assert.match(await page.locator(".toast.error").last().textContent(), /could not be downloaded/);
    assert.equal(reloadedAgain, false, "no reload into the same old version");
    assert.equal((await page.textContent("[data-update-now]")).trim(), "Update now");
    assert.equal(await page.isEnabled("[data-update-now]"), true);
    assert.match(await page.locator("[data-version-current]").textContent(), /build feedfee/);
    assert.equal((await order()).length, 4, "the work is still there");
  } finally {
    server.override = undefined;
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
