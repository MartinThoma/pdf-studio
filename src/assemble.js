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
  PDFName,
  PDFRef,
  PDFStream,
  degrees,
} from "../vendor/pdf-lib/pdf-lib.esm.min.js";

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
    return { width, height, rotation: page.getRotation().angle };
  });
  if (pages.length === 0) throw new SourceError("invalid", "The file has no pages.");
  sanitize(doc);
  return { doc, pages };
}

/**
 * Builds the result: `pages` is a list of { sourceId, index, rotation } in output order, where
 * `rotation` is added clockwise to the page's own rotation; `sources` maps sourceId to the doc
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

  const used = new Set();
  for (const { sourceId, index, rotation } of pages) {
    const key = `${sourceId}:${index}`;
    // The same page twice needs its own copy: a page object can only be in the tree once.
    const page = used.has(key) ? (await out.copyPages(sources.get(sourceId), [index]))[0] : copied.get(key);
    used.add(key);
    const angle = (((page.getRotation().angle + rotation) % 360) + 360) % 360;
    page.setRotation(degrees(angle));
    out.addPage(page);
  }

  copyMetadata(sources.get(pages[0].sourceId), out);
  collectGarbage(out);
  return out.save();
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
