import assert from "node:assert/strict";
import { test } from "node:test";
import { PDFArray, PDFDocument, PDFName } from "../vendor/pdf-lib/pdf-lib.esm.min.js";
import { placeholders, privacyReport, textInRect, toPdfRect } from "../src/annotations.js";
import { assemble, loadSource } from "../src/assemble.js";
import { addMark, newMarkId, pagesOf, removeMark, updateMark } from "../src/model.js";
import { makePdf } from "./fixtures.js";

const close = (actual, expected) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((n, i) => assert.ok(Math.abs(n - expected[i]) < 1e-6, `${actual} ≠ ${expected}`));
};

// "Jane Doe" runs from x=0.1 to 0.5 on one line, "lives in Ulm" on the next.
const items = [
  { str: "Jane Doe", box: [0.1, 0.1, 0.5, 0.15], axis: "x", reversed: false },
  { str: "lives in Ulm", box: [0.1, 0.2, 0.7, 0.25], axis: "x", reversed: false },
];

test("textInRect takes the characters under the rectangle and hugs them", () => {
  const { text, rects } = textInRect(items, [0.1, 0.09, 0.3, 0.16]);
  assert.equal(text, "Jane");
  close(rects[0], [0.1, 0.1, 0.3, 0.15]);
});

test("textInRect joins lines and gives one box per line", () => {
  const { text, rects } = textInRect(items, [0, 0, 1, 1]);
  assert.equal(text, "Jane Doe lives in Ulm");
  assert.equal(rects.length, 2);
});

test("textInRect without text returns the dragged rectangle", () => {
  assert.deepEqual(textInRect(items, [0.8, 0.8, 0.9, 0.9]), { text: "", rects: [[0.8, 0.8, 0.9, 0.9]] });
  assert.deepEqual(textInRect([], [0.5, 0.5, 0.2, 0.2]).rects, [[0.2, 0.2, 0.5, 0.5]]);
});

test("textInRect handles upside-down text", () => {
  const flipped = [{ str: "ABCD", box: [0.1, 0.1, 0.5, 0.15], axis: "x", reversed: true }];
  assert.equal(textInRect(flipped, [0.1, 0.1, 0.2, 0.15]).text, "D"); // the left end holds the last letter
});

test("toPdfRect maps page fractions to PDF space for every /Rotate", () => {
  const box = { x: 10, y: 20, width: 200, height: 300 };
  close(toPdfRect([0, 0, 0.5, 0.1], box, 0), [10, 290, 110, 320]);
  // Rotated 90°, the page is drawn 300 wide and 200 high; its top-left is the PDF's bottom-left.
  close(toPdfRect([0, 0, 0.5, 0.1], box, 90), [10, 20, 30, 170]);
  close(toPdfRect([0, 0, 0.5, 0.1], box, 180), [110, 20, 210, 50]);
  close(toPdfRect([0, 0, 0.5, 0.1], box, 270), [190, 170, 210, 320]);
});

function markedPages() {
  const pages = pagesOf("a", 2);
  let next = pages;
  const add = (page, kind, text, category = "name") => {
    next = addMark(next, page.id, { id: newMarkId(), kind, category, text, rects: [[0.1, 0.1, 0.4, 0.2]] });
  };
  add(pages[0], "private", "Jane Doe");
  add(pages[0], "highlight", "important");
  next = updateMark(next, pages[0].id, next[0].marks[0].id, { comment: "patient" });
  next = updateMark(next, pages[0].id, next[0].marks[1].id, { comment: "check this" });
  add(pages[1], "private", "jane  doe");
  add(pages[1], "private", "Ulm", "address");
  add(pages[1], "private", "Max", "name");
  return next;
}

test("marks are added, changed and removed without touching the old pages", () => {
  const pages = pagesOf("a", 1);
  const mark = { id: newMarkId(), kind: "private", category: "name", text: "x", rects: [[0, 0, 1, 1]] };
  const one = addMark(pages, pages[0].id, mark);
  assert.equal(pages[0].marks, undefined);
  const two = updateMark(one, pages[0].id, mark.id, { text: "y" });
  assert.equal(one[0].marks[0].text, "x");
  assert.equal(two[0].marks[0].text, "y");
  assert.deepEqual(removeMark(two, pages[0].id, mark.id)[0].marks, []);
});

test("the same text in the same category gets the same placeholder", () => {
  const pages = markedPages();
  const names = placeholders(pages);
  const privateIds = pages.flatMap((page) => page.marks).filter((mark) => mark.kind === "private").map((mark) => mark.id);
  assert.deepEqual(privateIds.map((id) => names.get(id)), ["[NAME_1]", "[NAME_1]", "[ADDRESS_1]", "[NAME_2]"]);
});

test("privacyReport lists private marks with page, PDF coordinates and the way back", () => {
  const pages = markedPages();
  const report = privacyReport(pages, () => ({ box: { x: 0, y: 0, width: 100, height: 100 }, rotation: 0 }), {
    document: "a.pdf",
  });
  assert.equal(report.entries.length, 4);
  assert.deepEqual(report.entries.map((entry) => entry.page), [1, 2, 2, 2]);
  assert.equal(report.entries[0].comment, "patient");
  assert.deepEqual(report.entries[0].rects, [[10, 80, 40, 90]]);
  assert.deepEqual(report.replacements, { "[NAME_1]": "Jane Doe", "[ADDRESS_1]": "Ulm", "[NAME_2]": "Max" });
});

test("assemble writes marks as highlight annotations that tools can read", async () => {
  const source = await loadSource(await makePdf({ count: 2 }));
  const pages = markedPages();
  const bytes = await assemble(
    new Map([["a", source.doc]]),
    pages.map((page) => ({ sourceId: "a", index: page.index, rotation: 0, marks: page.marks })),
  );
  const out = await PDFDocument.load(bytes);
  const read = (page) =>
    page.node.lookup(PDFName.of("Annots"), PDFArray).asArray().map((ref) => out.context.lookup(ref));
  const [first, second] = out.getPages().map(read);
  assert.equal(first.length, 2);
  assert.equal(second.length, 3);
  const annot = first[0];
  assert.equal(annot.get(PDFName.of("Subtype")), PDFName.of("Highlight"));
  assert.equal(annot.get(PDFName.of("Contents")).decodeText(), "Jane Doe");
  assert.equal(annot.get(PDFName.of("Subj")).decodeText(), "Privacy: Name");
  assert.equal(annot.lookup(PDFName.of("PdfStudio")).get(PDFName.of("Placeholder")).decodeText(), "[NAME_1]");
  assert.equal(annot.lookup(PDFName.of("QuadPoints")).size(), 8);
  assert.equal(annot.lookup(PDFName.of("PdfStudio")).get(PDFName.of("Comment")).decodeText(), "patient");
  assert.equal(first[1].get(PDFName.of("Subj")).decodeText(), "Highlight");
  assert.equal(first[1].get(PDFName.of("Contents")).decodeText(), "check this");
  assert.equal(first[1].lookup(PDFName.of("PdfStudio")).get(PDFName.of("Comment")).decodeText(), "check this");
  assert.equal(second[0].lookup(PDFName.of("PdfStudio")).get(PDFName.of("Placeholder")).decodeText(), "[NAME_1]");
});
