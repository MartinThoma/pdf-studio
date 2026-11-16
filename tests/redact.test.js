import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PDFArray,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  StandardFonts,
  decodePDFRawStream,
} from "../vendor/pdf-lib/pdf-lib.esm.min.js";
import { fromPdfPoints } from "../src/annotations.js";
import { assemble, loadSource } from "../src/assemble.js";
import { contentBytes, interpret, readOperators } from "../src/content.js";
import { RedactionError, jpegOrientation } from "../src/redact.js";

const latin1 = (bytes) => new TextDecoder("latin1").decode(bytes);
const BOX = { x: 0, y: 0, width: 200, height: 200 };

/** A private mark over a PDF-space rectangle of a page of `BOX` size, as the editor stores it. */
const privateMark = (rect, text = "secret", extra = {}) => ({
  id: `m${Math.random().toString(36).slice(2, 8)}`,
  kind: "private",
  category: "name",
  text,
  comment: "the patient",
  rects: [fromPdfPoints([[rect[0], rect[1]], [rect[2], rect[3]]], BOX, 0)],
  ...extra,
});

async function build(draw) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([200, 200]);
  await draw({ doc, page, font, context: doc.context });
  return (await loadSource(await doc.save())).doc;
}

async function save(source, marks, options = {}) {
  return assemble(new Map([["a", source]]), [{ sourceId: "a", index: 0, rotation: 0, marks }], options);
}

/** Every string (and number of TJ) the page's text operators show, in order, as plain text. */
function shownText(bytes) {
  return readOperators(bytes)
    .filter((operator) => ["Tj", "TJ", "'", '"'].includes(operator.op))
    .map((operator) => operator.operands.flat().filter((operand) => operand?.bytes).map((operand) => String.fromCharCode(...operand.bytes)).join(""))
    .join("|");
}

/** Everything in the file that could hold text: decoded streams and the printed form of other objects. */
function everything(doc) {
  let all = "";
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (object instanceof PDFRawStream) {
      all += `${object.dict.toString()}\n`;
      try {
        all += `${latin1(decodePDFRawStream(object).decode())}\n`;
      } catch {
        all += `${latin1(object.contents)}\n`;
      }
    } else all += `${object.toString()}\n`;
  }
  return all;
}

const glyphsOf = (page) => {
  const found = interpret(readOperators(contentBytes(page)), page, { glyphs: true }).find((object) => object.type === "text");
  return found.parts.filter((part) => part.raw).map((part) => ({ char: String.fromCharCode(...part.raw), x: part.x0 }));
};

test("text under a mark is cut out of the string, the rest stays where it was", async () => {
  const text = "Patient Jane Doe was born";
  let font;
  const source = await build(async ({ page, font: f }) => {
    font = f;
    page.drawText(text, { x: 20, y: 100, size: 12, font });
  });
  const before = glyphsOf(source.getPage(0));
  const x0 = 20 + font.widthOfTextAtSize("Patient ", 12);
  const x1 = x0 + font.widthOfTextAtSize("Jane Doe", 12);
  const out = await PDFDocument.load(await save(source, [privateMark([x0, 96, x1, 112], "Jane Doe")]));

  const shown = shownText(contentBytes(out.getPage(0)));
  assert.ok(!/Jane|Doe/.test(shown), shown);
  assert.match(shown, /Patient/);
  assert.match(shown, /was born/);
  assert.ok(!/Jane|Doe|the patient/.test(everything(out)), "no trace anywhere in the file");

  // "was" starts exactly where it did.
  const after = glyphsOf(out.getPage(0));
  const where = (glyphs) => glyphs.find((glyph, i) => glyph.char === "w" && glyphs[i + 1]?.char === "a").x;
  assert.ok(Math.abs(where(after) - where(before)) < 1e-6);
});

test("a black box is drawn over the marked area and the characters that were cut", async () => {
  const source = await build(async ({ page, font }) => page.drawText("Jane Doe", { x: 20, y: 100, size: 12, font }));
  const out = await PDFDocument.load(await save(source, [privateMark([20, 98, 40, 112])])); // about "Jane"
  const boxes = readOperators(contentBytes(out.getPage(0))).filter((operator) => operator.op === "re");
  assert.ok(boxes.length >= 2, "the marked area and at least one cut character");
  const [x, y, w, h] = boxes[0].operands;
  assert.deepEqual([x, y, w, h].map(Math.round), [20, 98, 20, 14]);
  assert.ok(readOperators(contentBytes(out.getPage(0))).some((operator) => operator.op === "f"));
});

test("text that is not under a mark is not touched", async () => {
  const source = await build(async ({ page, font }) => {
    page.drawText("Jane Doe", { x: 20, y: 100, size: 12, font });
    page.drawText("keep me", { x: 20, y: 50, size: 12, font });
  });
  const out = await PDFDocument.load(await save(source, [privateMark([20, 96, 60, 112])]));
  const shown = shownText(contentBytes(out.getPage(0)));
  assert.match(shown, /keep me/);
});

test("a private mark is not written as an annotation, and its text and comment are not in the file", async () => {
  const source = await build(async ({ page, font }) => page.drawText("Jane Doe", { x: 20, y: 100, size: 12, font }));
  const out = await PDFDocument.load(await save(source, [privateMark([20, 96, 80, 112], "Jane Doe")]));
  const annots = out.getPage(0).node.lookup(PDFName.of("Annots"));
  assert.equal(annots?.size() ?? 0, 0, "no annotation");
  assert.ok(!/Jane|the patient|PdfStudio/.test(everything(out)));
});

test("a highlight over a redacted area does not keep the covered text in its note", async () => {
  const source = await build(async ({ page, font }) => {
    page.drawText("Jane Doe", { x: 20, y: 100, size: 12, font });
    page.drawText("elsewhere", { x: 20, y: 50, size: 12, font });
  });
  const highlight = (rect, text) => ({ id: `h${text}`, kind: "highlight", color: "yellow", text, comment: "", rects: [fromPdfPoints([[rect[0], rect[1]], [rect[2], rect[3]]], BOX, 0)] });
  const out = await PDFDocument.load(
    await save(source, [privateMark([20, 96, 80, 112], "Jane Doe"), highlight([20, 96, 80, 112], "Jane Doe"), highlight([20, 46, 80, 62], "elsewhere")]),
  );
  const annots = out.getPage(0).node.lookup(PDFName.of("Annots"), PDFArray).asArray().map((ref) => out.context.lookup(ref));
  assert.equal(annots.length, 2);
  assert.equal(annots[0].get(PDFName.of("Contents")), undefined);
  assert.equal(annots[1].get(PDFName.of("Contents")).decodeText(), "elsewhere");
  assert.ok(!/Jane/.test(everything(out)));
});

test("asking for readable marks keeps the old behaviour", async () => {
  const source = await build(async ({ page, font }) => page.drawText("Jane Doe", { x: 20, y: 100, size: 12, font }));
  const out = await PDFDocument.load(await save(source, [privateMark([20, 96, 80, 112], "Jane Doe")], { privateMarks: "annotate" }));
  assert.match(shownText(contentBytes(out.getPage(0))), /Jane Doe/);
  const annots = out.getPage(0).node.lookup(PDFName.of("Annots"), PDFArray).asArray();
  assert.equal(annots.length, 1);
});

test("a page without private marks is written as before, whatever the mode", async () => {
  const source = await build(async ({ page, font }) => page.drawText("Jane Doe", { x: 20, y: 100, size: 12, font }));
  const out = await PDFDocument.load(await save(source, []));
  assert.match(shownText(contentBytes(out.getPage(0))), /Jane Doe/);
});

test("text on a page with its own rotation is found where it is shown", async () => {
  const source = await build(async ({ page, font, context }) => {
    page.node.set(PDFName.of("Rotate"), context.obj(90));
    page.drawText("Jane Doe", { x: 20, y: 100, size: 12, font, rotate: { type: "degrees", angle: 0 } });
  });
  const box = source.getPage(0).getCropBox();
  // The page is shown turned by 90°: take the mark from the page as drawn.
  const rect = fromPdfPoints([[20, 96], [80, 112]], box, 90);
  const out = await PDFDocument.load(
    await save(source, [{ id: "m1", kind: "private", category: "name", text: "Jane Doe", rects: [rect] }]),
  );
  assert.ok(!/Jane|Doe/.test(shownText(contentBytes(out.getPage(0)))));
});

// ---------------------------------------------------------------------------------------------
// Images

const IMAGE = 10;

/** A 10×10 RGB image (R = 255, G = column × 10, B = row × 10) drawn 100×100 at (50, 50). */
function addImage({ context, page }, { filter, data, name = "Im1", at = [50, 50], size = 100, ref } = {}) {
  const rgb = new Uint8Array(IMAGE * IMAGE * 3);
  for (let y = 0; y < IMAGE; y++) {
    for (let x = 0; x < IMAGE; x++) rgb.set([255, x * 10, y * 10], (y * IMAGE + x) * 3);
  }
  const entries = { Type: "XObject", Subtype: "Image", Width: IMAGE, Height: IMAGE, ColorSpace: "DeviceRGB", BitsPerComponent: 8 };
  const image = ref ?? context.register(filter ? context.stream(data, { ...entries, Filter: filter }) : context.flateStream(rgb, entries));
  page.node.setXObject(PDFName.of(name), image);
  page.node.addContentStream(context.register(context.flateStream(`q ${size} 0 0 ${size} ${at[0]} ${at[1]} cm /${name} Do Q`)));
  return image;
}

const imagesOf = (doc) =>
  [...doc.context.enumerateIndirectObjects()]
    .map(([, object]) => object)
    .filter((object) => object instanceof PDFRawStream && object.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"));

const pixel = (stream, x, y) => [...decodePDFRawStream(stream).decode().subarray((y * IMAGE + x) * 3, (y * IMAGE + x) * 3 + 3)];

test("pixels under a mark are blanked in the image data, the others stay", async () => {
  const source = await build((env) => addImage(env));
  const area = [50, 50, 100, 150]; // the left half of the image, all rows
  const out = await PDFDocument.load(await save(source, [privateMark(area)]));
  const [image, ...more] = imagesOf(out);
  assert.equal(more.length, 0, "the original image is not left in the file");
  assert.deepEqual(pixel(image, 0, 0), [0, 0, 0]);
  assert.deepEqual(pixel(image, 4, 9), [0, 0, 0]);
  assert.deepEqual(pixel(image, 5, 0), [255, 50, 0]);
  assert.deepEqual(pixel(image, 9, 9), [255, 90, 90]);
});

test("the uploaded file is not changed by redacting, so the next download starts from the original", async () => {
  const source = await build((env) => addImage(env));
  await save(source, [privateMark([50, 50, 100, 150])]);
  const again = await PDFDocument.load(await save(source, []));
  assert.deepEqual(pixel(imagesOf(again)[0], 0, 0), [255, 0, 0]);
});

test("an image another page shows is not changed there", async () => {
  const doc = await PDFDocument.create();
  const first = doc.addPage([200, 200]);
  const second = doc.addPage([200, 200]);
  const ref = addImage({ context: doc.context, page: first });
  addImage({ context: doc.context, page: second, ref });
  const source = (await loadSource(await doc.save())).doc;
  const out = await PDFDocument.load(
    await assemble(new Map([["a", source]]), [
      { sourceId: "a", index: 0, rotation: 0, marks: [privateMark([50, 50, 100, 150])] },
      { sourceId: "a", index: 1, rotation: 0 },
    ]),
  );
  const [redacted, whole] = out.getPages().map((page) => {
    const xobjects = page.node.Resources().lookup(PDFName.of("XObject"));
    return out.context.lookup(xobjects.entries()[0][1]);
  });
  assert.deepEqual(pixel(redacted, 0, 0), [0, 0, 0]);
  assert.deepEqual(pixel(whole, 0, 0), [255, 0, 0]);
});

test("an image the mark does not reach is left as it is", async () => {
  const source = await build((env) => addImage(env));
  const out = await PDFDocument.load(await save(source, [privateMark([150, 150, 190, 190])]));
  assert.deepEqual(pixel(imagesOf(out)[0], 0, 0), [255, 0, 0]);
});

test("the same image drawn twice is redacted only where it is under the mark", async () => {
  const source = await build((env) => {
    addImage(env, { name: "Im1", at: [0, 0], size: 50 });
    const ref = env.page.node.Resources().lookup(PDFName.of("XObject")).get(PDFName.of("Im1"));
    addImage(env, { name: "Im1", at: [100, 100], size: 50, ref }); // Do again, further up
  });
  const out = await PDFDocument.load(await save(source, [privateMark([0, 0, 50, 50])]));
  const colours = imagesOf(out).map((image) => pixel(image, 0, 0)[0]);
  assert.deepEqual(colours.sort(), [0, 255], "one copy blanked, one still whole");
});

test("a JPEG is blanked through the codec; without one it is removed and reported", async () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
  const source = await build((env) => addImage(env, { filter: "DCTDecode", data: jpeg }));

  const given = [];
  const codec = {
    async decodeJpeg(bytes) {
      given.push([...bytes]);
      const rgb = new Uint8Array(IMAGE * IMAGE * 3).fill(200);
      return { width: IMAGE, height: IMAGE, rgb };
    },
    async encodeJpeg({ rgb }) {
      given.push(rgb.slice());
      return new Uint8Array([0xff, 0xd8, 9, 9, 9, 0xff, 0xd9]);
    },
  };
  const out = await PDFDocument.load(await save(source, [privateMark([50, 50, 100, 150])], { codec }));
  const [image] = imagesOf(out);
  assert.deepEqual([...image.contents], [0xff, 0xd8, 9, 9, 9, 0xff, 0xd9]);
  assert.equal(image.dict.get(PDFName.of("Filter")), PDFName.of("DCTDecode"));
  assert.deepEqual(given[0], [...jpeg]);
  const rgb = given[1];
  assert.deepEqual([...rgb.subarray(0, 3)], [0, 0, 0], "left half blanked");
  assert.deepEqual([...rgb.subarray(5 * 3, 5 * 3 + 3)], [200, 200, 200], "right half kept");

  const warnings = [];
  const plain = await PDFDocument.load(await save(source, [privateMark([50, 50, 100, 150])], { warnings }));
  assert.equal(imagesOf(plain).length, 0, "the unedited JPEG is not left in the file");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Page 1: 1 image .*removed entirely/);
});

test("a 1-bit stencil image under a mark is set to unpainted", async () => {
  const source = await build(({ context, page }) => {
    const bits = new Uint8Array(IMAGE * 2).fill(0x00); // 10×10 at 1 bit: two bytes per row, all painted
    const mask = context.register(context.flateStream(bits, { Type: "XObject", Subtype: "Image", Width: IMAGE, Height: IMAGE, ImageMask: true, BitsPerComponent: 1 }));
    page.node.setXObject(PDFName.of("Im1"), mask);
    page.node.addContentStream(context.register(context.flateStream("q 100 0 0 100 50 50 cm /Im1 Do Q")));
  });
  const out = await PDFDocument.load(await save(source, [privateMark([50, 50, 100, 150])]));
  const data = decodePDFRawStream(imagesOf(out)[0]).decode();
  assert.equal(data[0], 0xf8, "columns 0–4 are unpainted (1), the rest stay painted (0)");
  assert.equal(data[1], 0x00);
});

// ---------------------------------------------------------------------------------------------
// Forms, annotations, labels and what can't be read

test("text inside a form is redacted too, and the form stays the same for other uses", async () => {
  const source = await build(({ page, font, context }) => {
    const form = context.register(
      context.flateStream("BT /F1 12 Tf 20 20 Td (Secret Name) Tj ET", {
        Type: "XObject", Subtype: "Form", BBox: [0, 0, 200, 200],
        Resources: { Font: { F1: font.ref } },
      }),
    );
    page.node.setXObject(PDFName.of("Fm1"), form);
    page.node.addContentStream(context.register(context.flateStream("q 1 0 0 1 10 70 cm /Fm1 Do Q")));
  });
  // The text sits at (30, 90) on the page.
  const out = await PDFDocument.load(await save(source, [privateMark([28, 86, 100, 104], "Secret Name")]));
  assert.ok(!/Secret|Name/.test(everything(out)), "gone from the whole file");
  assert.match(everything(await PDFDocument.load(await save(source, []))), /Secret Name/, "the uploaded form is untouched");
});

test("annotations under a mark are removed, the others stay", async () => {
  const source = await build(({ page, font, context }) => {
    page.drawText("Jane Doe", { x: 20, y: 100, size: 12, font });
    const note = context.register(context.obj({ Type: "Annot", Subtype: "Text", Rect: [22, 98, 40, 110], Contents: "Jane Doe is the patient" }));
    const link = context.register(context.obj({ Type: "Annot", Subtype: "Link", Rect: [20, 10, 80, 30], Border: [0, 0, 0] }));
    page.node.set(PDFName.of("Annots"), context.obj([note, link]));
  });
  const out = await PDFDocument.load(await save(source, [privateMark([20, 96, 80, 112])]));
  const annots = out.getPage(0).node.lookup(PDFName.of("Annots"), PDFArray);
  assert.equal(annots.size(), 1);
  assert.equal(annots.lookup(0).get(PDFName.of("Subtype")), PDFName.of("Link"));
  assert.ok(!/patient/.test(everything(out)));
});

test("a copy of the text in a marked-content label (/ActualText) is removed", async () => {
  const source = await build(({ page, font, context }) => {
    page.node.setFontDictionary(PDFName.of("F1"), font.ref);
    page.node.addContentStream(context.register(context.flateStream("/Span <</ActualText (Jane Doe)>> BDC BT /F1 12 Tf 20 100 Td (Jane Doe) Tj ET EMC")));
  });
  const out = await PDFDocument.load(await save(source, [privateMark([20, 96, 80, 112])]));
  assert.ok(!/ActualText|Jane/.test(everything(out)));
  assert.match(latin1(contentBytes(out.getPage(0))), /\/Span BMC/);
});

test("content that can't be read is an error, never a file with the text still in it", async () => {
  const source = await build(({ page, context }) => {
    page.node.addContentStream(context.register(context.stream(new Uint8Array([1, 2, 3]), { Filter: "DCTDecode" })));
  });
  await assert.rejects(save(source, [privateMark([20, 96, 80, 112])]), (error) => {
    assert.ok(error instanceof RedactionError);
    assert.equal(error.code, "redaction");
    assert.match(error.message, /^Page 1 can't be redacted/);
    return true;
  });
  // Nothing is read when nothing is to be redacted, or when marks are kept as annotations.
  await save(source, []);
  await save(source, [privateMark([20, 96, 80, 112])], { privateMarks: "annotate" });
});

// ---------------------------------------------------------------------------------------------
// Ways text hides

/** A page whose content is `content`, with Helvetica as /F1. */
const withContent = (content, extra = () => {}) =>
  build(({ page, font, context }) => {
    page.node.setFontDictionary(PDFName.of("F1"), font.ref);
    extra({ page, font, context });
    page.node.addContentStream(context.register(context.flateStream(content)));
  });

test("text at size 0 or squeezed to no width is removed: invisible, but it could be copied", async () => {
  for (const content of ["BT /F1 0 Tf 30 100 Td (SECRET) Tj ET", "BT /F1 12 Tf 0 Tz 30 100 Td (SECRET) Tj ET"]) {
    const out = await PDFDocument.load(await save(await withContent(content), [privateMark([20, 90, 120, 120])]));
    assert.equal(shownText(contentBytes(out.getPage(0))), "", content);
  }
});

test("text in a font whose widths are only guessed is an error, not a cut that may miss letters", async () => {
  const source = await withContent("BT /F9 12 Tf 30 100 Td (SECRET) Tj ET"); // /F9 is not in the resources
  await assert.rejects(save(source, [privateMark([20, 90, 120, 120])]), { code: "redaction", message: /letter widths/ });
  await save(source, [privateMark([20, 90, 120, 120])], { privateMarks: "annotate" }); // nothing to measure
});

test("a form without a /BBox (viewers draw it anyway) is redacted too", async () => {
  const source = await build(({ page, font, context }) => {
    const form = context.register(context.flateStream("BT /F1 12 Tf 30 100 Td (Secret Name) Tj ET", { Type: "XObject", Subtype: "Form", Resources: { Font: { F1: font.ref } } }));
    page.node.setXObject(PDFName.of("Fm1"), form);
    page.node.addContentStream(context.register(context.flateStream("q /Fm1 Do Q")));
  });
  const out = await PDFDocument.load(await save(source, [privateMark([20, 90, 140, 120])]));
  assert.ok(!/Secret/.test(everything(out)));
});

test("labels that keep a copy of the text in the property list, or as /Alt, are made plain", async () => {
  const source = await withContent(
    "/Span /MC0 BDC BT /F1 12 Tf 30 100 Td (Jane) Tj ET EMC /Figure <</Alt (Photo of Jane Doe)>> BDC EMC",
    ({ page, context }) => {
      const resources = page.node.Resources();
      resources.set(PDFName.of("Properties"), context.obj({ MC0: { ActualText: PDFHexString.fromText("Jane Doe") } }));
    },
  );
  const out = await PDFDocument.load(await save(source, [privateMark([20, 90, 140, 120])]));
  const content = latin1(contentBytes(out.getPage(0)));
  assert.match(content, /\/Span BMC/);
  assert.match(content, /\/Figure BMC/);
  assert.ok(!/Photo of Jane/.test(content));
});

test("a JPEG turned by its EXIF tag, or one that can't be decoded, is removed rather than blanked in the wrong place", async () => {
  const exif = [0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 3, 0, 0, 0, 0, 0, 0];
  const payload = [..."Exif\0\0"].map((c) => c.charCodeAt(0)).concat(exif);
  const turned = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0, payload.length + 2, ...payload, 0xff, 0xd9]);
  assert.equal(jpegOrientation(turned), 3);
  assert.equal(jpegOrientation(new Uint8Array([0xff, 0xd8, 0xff, 0xd9])), 1);

  const codec = { decodeJpeg: async () => assert.fail("not decoded"), encodeJpeg: async () => assert.fail("not encoded") };
  const warnings = [];
  const out = await PDFDocument.load(await save(await build((env) => addImage(env, { filter: "DCTDecode", data: turned })), [privateMark([50, 50, 100, 150])], { codec, warnings }));
  assert.equal(imagesOf(out).length, 0);
  assert.equal(warnings.length, 1);

  const broken = { decodeJpeg: async () => { throw new Error("bad JPEG"); }, encodeJpeg: async () => new Uint8Array() };
  const plain = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const again = await PDFDocument.load(await save(await build((env) => addImage(env, { filter: "DCTDecode", data: plain })), [privateMark([50, 50, 100, 150])], { codec: broken }));
  assert.equal(imagesOf(again).length, 0);
});
