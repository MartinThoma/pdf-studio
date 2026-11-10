// Test PDFs, built on the fly. Every page gets a unique width (200, 210, 220, …), so the page
// order of a result can be read back from the page sizes without extracting text.

import { PDFDocument, PDFName, PDFString, StandardFonts, degrees, rgb } from "../vendor/pdf-lib/pdf-lib.esm.min.js";

/**
 * A PDF with `count` pages of width `firstWidth + 10·i` and height 300, each labelled with
 * `label` and its number. `rotations` sets the pages' own /Rotate.
 */
export async function makePdf({ count, firstWidth = 200, label = "Page", rotations = [], title } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < count; i++) {
    const page = doc.addPage([firstWidth + 10 * i, 300]);
    page.drawRectangle({ x: 0, y: 260, width: page.getWidth(), height: 40, color: rgb(0.85, 0.3, 0.2) });
    page.drawText(`${label} ${i + 1}`, { x: 20, y: 150, size: 28, font });
    if (rotations[i]) page.setRotation(degrees(rotations[i]));
  }
  if (title) doc.setTitle(title);
  return doc.save();
}

/** A 3-page PDF whose first page has a link annotation that jumps to page 3. */
export async function makePdfWithInternalLink() {
  const doc = await PDFDocument.load(await makePdf({ count: 3 }));
  const [first, , third] = doc.getPages();
  const link = doc.context.obj({
    Type: "Annot",
    Subtype: "Link",
    Rect: [10, 10, 100, 40],
    Border: [0, 0, 0],
    Dest: [third.ref, PDFName.of("Fit")],
    P: first.ref,
  });
  first.node.set(PDFName.of("Annots"), doc.context.obj([doc.context.register(link)]));
  first.node.set(PDFName.of("Secret"), PDFString.of("ok"));
  return doc.save({ useObjectStreams: false });
}

/** A minimal PDF with an /Encrypt entry in the trailer (permissions-only protection). */
export function makeEncryptedPdf() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] >>",
    "<< /Filter /Standard /V 1 /R 2 /O <" + "28".repeat(32) + "> /U <" + "29".repeat(32) + "> /P -44 >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((object, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Encrypt 4 0 R /ID [<00> <00>] >>\n`;
  body += `startxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

/** Widths, rotations and number of /Page objects of a saved PDF. */
export async function describe(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const pages = doc.getPages().map((page) => ({
    width: Math.round(page.getWidth()),
    rotation: page.getRotation().angle,
  }));
  let pageObjects = 0;
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    const dict = object.dict ?? object;
    if (typeof dict.get === "function" && dict.get(PDFName.of("Type")) === PDFName.of("Page")) pageObjects++;
  }
  return { doc, pages, pageObjects };
}
