import assert from "node:assert/strict";
import { test } from "node:test";
import { PDFArray, PDFDocument, PDFName, StandardFonts, rgb } from "../vendor/pdf-lib/pdf-lib.esm.min.js";
import { assemble, loadSource } from "../src/assemble.js";
import { contentBytes, pageObjects, readOperators } from "../src/content.js";

const latin1 = (bytes) => new TextDecoder("latin1").decode(bytes);

// 1×1 red PNG.
const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

/** Page 1: "Jane Doe" at (50, 700), "keep me" at (50, 600), an image at (300, 400) 100×50, a link. */
async function sample({ rotate = 0 } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const image = await doc.embedPng(PNG);
  const page = doc.addPage([600, 800]);
  page.drawText("Jane Doe", { x: 50, y: 700, size: 20, font });
  page.drawText("keep me", { x: 50, y: 600, size: 20, font });
  page.drawImage(image, { x: 300, y: 400, width: 100, height: 50 });
  page.drawRectangle({ x: 10, y: 10, width: 20, height: 20, color: rgb(0, 0, 1) });
  const link = doc.context.obj({ Type: "Annot", Subtype: "Link", Rect: [50, 500, 150, 520], Border: [0, 0, 0] });
  page.node.set(PDFName.of("Annots"), doc.context.obj([doc.context.register(link)]));
  const second = doc.addPage([600, 800]);
  second.drawImage(image, { x: 0, y: 0, width: 10, height: 10 }); // the same image on another page
  if (rotate) page.setRotation({ type: "degrees", angle: rotate });
  return (await loadSource(await doc.save())).doc;
}

const near = (actual, expected, tolerance = 0.012) =>
  actual.forEach((n, i) => assert.ok(Math.abs(n - expected[i]) < tolerance, `${actual} ≉ ${expected}`));

test("readOperators splits content into operators with their bytes", () => {
  const bytes = new TextEncoder().encode("q 1 0 0 1 5 5 cm BT /F1 12 Tf (a\\)b) Tj [(x) -20 <4142>] TJ ET Q");
  const operators = readOperators(bytes);
  assert.deepEqual(operators.map((o) => o.op), ["q", "cm", "BT", "Tf", "Tj", "TJ", "ET", "Q"]);
  assert.deepEqual(operators[4].operands, [{ bytes: [97, 41, 98] }]);
  assert.deepEqual(operators[5].operands, [[{ bytes: [120] }, -20, { bytes: [65, 66] }]]);
  assert.equal(latin1(bytes.subarray(operators[1].start, operators[1].end)), "1 0 0 1 5 5 cm");
});

test("readOperators steps over inline images", () => {
  const bytes = new TextEncoder().encode("q BI /W 1 /H 1 /BPC 8 /CS /G ID \x01EI Q\nEI Q (x) Tj");
  assert.deepEqual(readOperators(bytes).map((o) => o.op), ["q", "BI", "Q", "Tj"]);
});

test("pageObjects finds text runs, images and annotations where they are drawn", async () => {
  const doc = await sample();
  const objects = pageObjects(doc.getPage(0));
  assert.deepEqual(objects.map((o) => o.type), ["text", "text", "image", "annotation"]);
  const [jane, , image, link] = objects;
  // "Jane Doe" in 20pt Helvetica is 83.4pt wide; the baseline is 700 of 800 from the bottom.
  near(jane.box, [50 / 600, 1 - 718 / 800, 133.4 / 600, 1 - 695 / 800]);
  near(image.box, [300 / 600, 1 - 450 / 800, 400 / 600, 1 - 400 / 800], 0.001);
  near(link.box, [50 / 600, 1 - 520 / 800, 150 / 600, 1 - 500 / 800], 0.001);
});

test("pageObjects follows the page's own rotation", async () => {
  const doc = await sample({ rotate: 90 });
  const image = pageObjects(doc.getPage(0)).find((o) => o.type === "image");
  // Rotated 90°: drawn 800 wide and 600 high; PDF (x, y) lands at (y, x) from the top left.
  near(image.box, [400 / 800, 300 / 600, 450 / 800, 400 / 600], 0.001);
});

test("deleted text and images are gone from the file, the rest stays", async () => {
  const doc = await sample();
  const [jane, , image, link] = pageObjects(doc.getPage(0));
  const sources = new Map([["a", doc]]);
  const bytes = await assemble(sources, [
    { sourceId: "a", index: 0, rotation: 0, removed: [jane.id, image.id, link.id] },
  ]);
  const out = await PDFDocument.load(bytes);
  const page = out.getPage(0);
  const types = pageObjects(page).map((o) => o.type);
  assert.deepEqual(types, ["text"]);
  const content = latin1(contentBytes(page));
  assert.ok(!content.includes("4A616E6520446F65") && !content.includes("Jane"), "the text is not in the content");
  assert.ok(content.includes("6B656570206D65") || content.includes("keep me"), "other text stays");
  assert.equal(page.node.lookup(PDFName.of("Annots"), PDFArray).size(), 0);
  // The image was only on this page of the result, so its data is not in the file any more.
  const images = out.context.enumerateIndirectObjects().filter(([, o]) => o.dict?.get(PDFName.of("Subtype")) === PDFName.of("Image"));
  assert.equal(images.length, 0);
  // The source is untouched: the same page can still be saved with everything on it.
  assert.equal(pageObjects(doc.getPage(0)).length, 4);
});

test("the text of a run can be changed; it stays where it was", async () => {
  const doc = await sample();
  const [jane] = pageObjects(doc.getPage(0));
  const bytes = await assemble(new Map([["a", doc]]), [
    { sourceId: "a", index: 0, rotation: 0, edits: { [jane.id]: "Max M\u00fcller \u4e2d" } },
  ]);
  const out = await PDFDocument.load(bytes);
  const objects = pageObjects(out.getPage(0));
  assert.deepEqual(objects.map((o) => o.type), ["text", "image", "text", "annotation"]);
  const changed = objects[2];
  near([changed.box[0], changed.box[1], changed.box[3]], [jane.box[0], jane.box[1], jane.box[3]], 0.003);
  const content = latin1(contentBytes(out.getPage(0)));
  assert.ok(!content.includes("4A616E6520446F65"), "the old text is gone");
  assert.ok(content.includes("4D6178204DFC6C6C6572203F"), "the new text is there, the unknown character as ?");
});

test("an image that another page still shows stays in the file", async () => {
  const doc = await sample();
  const image = pageObjects(doc.getPage(0)).find((o) => o.type === "image");
  const bytes = await assemble(new Map([["a", doc]]), [
    { sourceId: "a", index: 0, rotation: 0, removed: [image.id] },
    { sourceId: "a", index: 1, rotation: 0 },
  ]);
  const out = await PDFDocument.load(bytes);
  assert.equal(pageObjects(out.getPage(0)).filter((o) => o.type === "image").length, 0);
  assert.equal(pageObjects(out.getPage(1)).filter((o) => o.type === "image").length, 1);
});

test("text after a deleted run keeps its place", async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([600, 800]);
  page.drawText("x", { x: 0, y: 0, size: 1, font }); // registers the font
  const fontName = Object.keys(Object.fromEntries(page.node.Resources().lookup(PDFName.of("Font")).entries().map(([k]) => [k.decodeText(), 1])))[0];
  const stream = doc.context.flateStream(`BT /${fontName} 20 Tf 50 700 Td (Jane ) Tj (Doe) Tj ET`);
  page.node.set(PDFName.of("Contents"), doc.context.register(stream));
  const source = (await loadSource(await doc.save())).doc;
  const [first, second] = pageObjects(source.getPage(0));
  const bytes = await assemble(new Map([["a", source]]), [{ sourceId: "a", index: 0, rotation: 0, removed: [first.id] }]);
  const [left] = pageObjects((await PDFDocument.load(bytes)).getPage(0));
  near(left.box, second.box, 0.0005);
});
