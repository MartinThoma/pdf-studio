import assert from "node:assert/strict";
import { test } from "node:test";
import { PRODUCER, assemble, loadSource } from "../src/assemble.js";
import { describe, makeEncryptedPdf, makePdf, makePdfWithInternalLink } from "./fixtures.js";

async function sources(entries) {
  const map = new Map();
  for (const [id, bytes] of Object.entries(entries)) map.set(id, (await loadSource(bytes)).doc);
  return map;
}

test("loadSource reports size and own rotation of each page", async () => {
  const { pages } = await loadSource(await makePdf({ count: 3, rotations: [0, 90, 0] }));
  assert.deepEqual(pages, [
    { width: 200, height: 300, rotation: 0 },
    { width: 210, height: 300, rotation: 90 },
    { width: 220, height: 300, rotation: 0 },
  ]);
});

test("loadSource rejects encrypted and broken files with a code", async () => {
  await assert.rejects(loadSource(makeEncryptedPdf()), { code: "encrypted" });
  await assert.rejects(loadSource(new TextEncoder().encode("not a pdf")), { code: "invalid" });
});

test("assemble reorders, rotates and drops pages", async () => {
  const docs = await sources({ a: await makePdf({ count: 4 }) });
  const bytes = await assemble(docs, [
    { sourceId: "a", index: 3, rotation: 0 },
    { sourceId: "a", index: 0, rotation: 90 },
    { sourceId: "a", index: 2, rotation: 270 },
  ]);
  const { pages, pageObjects } = await describe(bytes);
  assert.deepEqual(pages, [
    { width: 230, rotation: 0 },
    { width: 200, rotation: 90 },
    { width: 220, rotation: 270 },
  ]);
  assert.equal(pageObjects, 3, "no page objects left over from dropped pages");
});

test("assemble adds the user's rotation to the page's own rotation", async () => {
  const docs = await sources({ a: await makePdf({ count: 2, rotations: [90, 270] }) });
  const { pages } = await describe(
    await assemble(docs, [
      { sourceId: "a", index: 0, rotation: 90 },
      { sourceId: "a", index: 1, rotation: 180 },
    ]),
  );
  assert.deepEqual(pages.map((page) => page.rotation), [180, 90]);
});

test("assemble merges several files in any order", async () => {
  const docs = await sources({
    a: await makePdf({ count: 2, firstWidth: 200 }),
    b: await makePdf({ count: 2, firstWidth: 400 }),
  });
  const { pages } = await describe(
    await assemble(docs, [
      { sourceId: "b", index: 1, rotation: 0 },
      { sourceId: "a", index: 0, rotation: 0 },
      { sourceId: "b", index: 0, rotation: 0 },
    ]),
  );
  assert.deepEqual(pages.map((page) => page.width), [410, 200, 400]);
});

test("a link to a deleted page does not pull that page into the result", async () => {
  const docs = await sources({ a: await makePdfWithInternalLink() });
  const bytes = await assemble(docs, [{ sourceId: "a", index: 0, rotation: 0 }]);
  const { pages, pageObjects, doc } = await describe(bytes);
  assert.equal(pages.length, 1);
  assert.equal(pageObjects, 1, "pages 2 and 3 must not be in the file at all");
  const annots = doc.getPages()[0].node.Annots();
  assert.equal(annots.size(), 1, "the link annotation itself is kept");
});

test("the result takes the metadata of the first page's file", async () => {
  const docs = await sources({
    a: await makePdf({ count: 1, title: "Report" }),
    b: await makePdf({ count: 1, title: "Appendix" }),
  });
  const { doc } = await describe(
    await assemble(docs, [
      { sourceId: "b", index: 0, rotation: 0 },
      { sourceId: "a", index: 0, rotation: 0 },
    ]),
  );
  assert.equal(doc.getTitle(), "Appendix");
  assert.equal(doc.getProducer(), PRODUCER);
});

test("assemble refuses an empty page list", async () => {
  await assert.rejects(assemble(new Map(), []), /no pages/);
});
