// Reading uploaded PDFs and writing the result with pdf-lib. Runs in a worker (pdf-worker.js) in
// the browser and directly in Node for the tests.
//
// The result is a new document that only gets the pages that are kept. Deleted pages must not
// survive in the file, not even as unused objects: the user may delete a page precisely because
// of what is on it. Two things make sure of that:
//   1. sanitize() cuts references from one page to another before copying (links, the /P entry
//      of annotations, form field trees, article beads). pdf-lib copies everything a page refers
//      to, so a link to a deleted page would otherwise pull that page (and through its /Parent
//      the whole page tree) into the result.
//   2. collectGarbage() drops every object the finished file no longer reaches.

import {
  EncryptedPDFError,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRef,
  PDFStream,
  degrees,
} from "../vendor/pdf-lib/pdf-lib.esm.min.js";
import { categoryOf, colorOf, placeholders, toPdfRect } from "./annotations.js";
import { rewritePage } from "./content.js";

export const PRODUCER = "PDF Studio (pdf-lib)";

/** An error the user can act on; `code` is "encrypted" or "invalid". */
export class SourceError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Parses an uploaded file. Returns the pdf-lib document and the size and own rotation of every
 * page; throws a SourceError for encrypted or unreadable files.
 */
export async function loadSource(bytes) {
  let doc;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (error) {
    // The minified build breaks `instanceof EncryptedPDFError`, so match the message as well.
    if (error instanceof EncryptedPDFError || /is encrypted/.test(error?.message)) {
      throw new SourceError("encrypted", "The file is encrypted (password or permission protection).");
    }
    throw new SourceError("invalid", `The file could not be read as a PDF (${error.message}).`);
  }
  const pages = doc.getPages().map((page) => {
    const { width, height } = page.getSize();
    const box = page.getCropBox();
    return { width, height, rotation: page.getRotation().angle, box: { x: box.x, y: box.y, width: box.width, height: box.height } };
  });
  if (pages.length === 0) throw new SourceError("invalid", "The file has no pages.");
  sanitize(doc);
  return { doc, pages };
}

/**
 * Builds the result: `pages` is a list of { sourceId, index, rotation, marks } in output order,
 * where `rotation` is added clockwise to the page's own rotation and `marks` (optional) are the
 * highlights and privacy marks, written as PDF annotations, `removed` (optional) the ids of
 * objects to delete from the page and `edits` (optional) new text for text runs, { id: text }
 * (see content.js); `sources` maps sourceId to the doc
 * returned by loadSource(). Returns the bytes of the new PDF.
 */
export async function assemble(sources, pages) {
  if (pages.length === 0) throw new Error("Nothing to save: no pages left.");
  const out = await PDFDocument.create();

  // One copyPages() call per source, so fonts and images shared by several pages are copied once.
  const wanted = new Map();
  for (const page of pages) {
    if (!sources.has(page.sourceId)) throw new Error(`Unknown source ${page.sourceId}.`);
    if (!wanted.has(page.sourceId)) wanted.set(page.sourceId, new Set());
    wanted.get(page.sourceId).add(page.index);
  }
  const copied = new Map();
  for (const [sourceId, indices] of wanted) {
    const list = [...indices];
    const copies = await out.copyPages(sources.get(sourceId), list);
    list.forEach((index, i) => copied.set(`${sourceId}:${index}`, copies[i]));
  }

  const names = placeholders(pages);
  const used = new Set();
  const fonts = new Map();
  const embed = (fontName) => {
    if (!fonts.has(fontName)) fonts.set(fontName, out.embedFont(fontName));
    return fonts.get(fontName);
  };
  for (const { sourceId, index, rotation, marks, removed, edits } of pages) {
    const key = `${sourceId}:${index}`;
    // The same page twice needs its own copy: a page object can only be in the tree once.
    const page = used.has(key) ? (await out.copyPages(sources.get(sourceId), [index]))[0] : copied.get(key);
    used.add(key);
    const angle = (((page.getRotation().angle + rotation) % 360) + 360) % 360;
    page.setRotation(degrees(angle));
    if (removed?.length || (edits && Object.keys(edits).length)) await rewritePage(page, { removed, edits }, embed);
    if (marks?.length) addMarks(out, page, marks, names, sources.get(sourceId).getPage(index));
    out.addPage(page);
  }

  copyMetadata(sources.get(pages[0].sourceId), out);
  collectGarbage(out);
  return out.save();
}

const PRIVATE_COLOR = [0.96, 0.3, 0.45];

/**
 * Writes marks as standard /Highlight annotations: any viewer shows them, and tools read the
 * covered text from /Contents and the boxes from /QuadPoints. Private marks also carry a
 * /PdfStudio dictionary with category, placeholder and id for pseudonymizing tools.
 */
function addMarks(out, page, marks, names, sourcePage) {
  const { context } = out;
  const box = sourcePage.getCropBox();
  const rotation = sourcePage.getRotation().angle;
  let annots = page.node.lookup(PDFName.of("Annots"));
  if (!(annots instanceof PDFArray)) {
    annots = context.obj([]);
    page.node.set(PDFName.of("Annots"), annots);
  }
  for (const mark of marks) {
    const rects = mark.rects.map((rect) => toPdfRect(rect, box, rotation));
    const union = [
      Math.min(...rects.map((r) => r[0])),
      Math.min(...rects.map((r) => r[1])),
      Math.max(...rects.map((r) => r[2])),
      Math.max(...rects.map((r) => r[3])),
    ];
    const isPrivate = mark.kind === "private";
    const dict = context.obj({
      Type: "Annot",
      Subtype: "Highlight",
      Rect: union,
      // Top-left, top-right, bottom-left, bottom-right: the order viewers actually read.
      QuadPoints: rects.flatMap(([x0, y0, x1, y1]) => [x0, y1, x1, y1, x0, y0, x1, y0]),
      C: mark.kind === "private" ? PRIVATE_COLOR : colorOf(mark.color).rgb,
      CA: isPrivate ? 0.55 : 0.5,
      F: 4,
    });
    dict.set(PDFName.of("NM"), PDFHexString.fromText(mark.id));
    dict.set(PDFName.of("T"), PDFHexString.fromText("PDF Studio"));
    dict.set(PDFName.of("Subj"), PDFHexString.fromText(isPrivate ? `Privacy: ${categoryOf(mark.category).label}` : "Highlight"));
    // Viewers show /Contents as the note: for a highlight that is the comment, for a private mark
    // it stays the marked text, which is what tools look for.
    const contents = isPrivate ? mark.text : mark.comment || mark.text;
    if (contents) dict.set(PDFName.of("Contents"), PDFHexString.fromText(contents));
    if (isPrivate || mark.comment) {
      const info = context.obj({ Kind: isPrivate ? "Privacy" : "Highlight" });
      if (mark.comment) info.set(PDFName.of("Comment"), PDFHexString.fromText(mark.comment));
      if (isPrivate) {
        info.set(PDFName.of("Category"), PDFHexString.fromText(mark.category));
        info.set(PDFName.of("Placeholder"), PDFHexString.fromText(names.get(mark.id)));
        info.set(PDFName.of("Id"), PDFHexString.fromText(mark.id));
      }
      dict.set(PDFName.of("PdfStudio"), info);
    }
    annots.push(context.register(dict));
  }
}

/** Removes references between pages of a source document (see the comment on top). */
export function sanitize(doc) {
  const { context } = doc;
  for (const page of doc.getPages()) {
    page.node.delete(PDFName.of("B")); // article beads, point into threads across pages
    const annots = page.node.lookup(PDFName.of("Annots"));
    if (!(annots instanceof PDFArray)) continue;
    for (let i = 0; i < annots.size(); i++) {
      const annot = annots.lookup(i);
      if (!(annot instanceof PDFDict)) continue;
      annot.delete(PDFName.of("P"));
      const subtype = annot.lookup(PDFName.of("Subtype"));
      if (subtype === PDFName.of("Widget")) {
        // The field tree links the widgets of all pages; the widget keeps its own appearance.
        annot.delete(PDFName.of("Parent"));
      }
      if (context.lookup(annot.get(PDFName.of("Dest"))) instanceof PDFArray) {
        annot.delete(PDFName.of("Dest"));
      }
      const action = annot.lookup(PDFName.of("A"));
      if (action instanceof PDFDict && action.lookup(PDFName.of("D")) instanceof PDFArray) {
        annot.delete(PDFName.of("A")); // GoTo to a page of this file
      }
    }
  }
}

/** Deletes every indirect object that the trailer (catalog and info) no longer reaches. */
export function collectGarbage(doc) {
  const { context } = doc;
  const reached = new Set();
  const stack = [context.trailerInfo.Root, context.trailerInfo.Info].filter(Boolean);
  while (stack.length > 0) {
    let object = stack.pop();
    if (object instanceof PDFRef) {
      if (reached.has(object.tag)) continue;
      reached.add(object.tag);
      object = context.lookup(object);
    }
    if (object instanceof PDFStream) object = object.dict;
    if (object instanceof PDFDict) {
      for (const [, value] of object.entries()) stack.push(value);
    } else if (object instanceof PDFArray) {
      for (let i = 0; i < object.size(); i++) stack.push(object.get(i));
    }
  }
  let removed = 0;
  for (const [ref] of context.enumerateIndirectObjects()) {
    if (!reached.has(ref.tag)) {
      context.delete(ref);
      removed++;
    }
  }
  return removed;
}

function copyMetadata(source, out) {
  const title = source.getTitle();
  const author = source.getAuthor();
  const subject = source.getSubject();
  const keywords = source.getKeywords();
  if (title) out.setTitle(title);
  if (author) out.setAuthor(author);
  if (subject) out.setSubject(subject);
  if (keywords) out.setKeywords([keywords]);
  out.setCreator(source.getCreator() || PRODUCER);
  out.setProducer(PRODUCER);
}
