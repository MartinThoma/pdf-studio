// Redacting a page: what lies under a private mark is taken out of the file and a black box is
// drawn in its place. Runs in the worker and in Node for the tests.
//
// A black box alone would hide the text but leave it in the file, where anyone can select, copy
// or uncover it. So, for every area (`rects`, in PDF user space):
//   - text: the characters that lie in the area are cut out of the string that draws them. The
//     rest of the run stays where it was (the cut characters become a move of the pen),
//   - images: the pixels in the area are set to black in the image data. The image is written
//     anew for this page only, so other pages that show the same image keep it,
//   - forms (groups of content, also drawn as one object): the same is done inside them,
//   - annotations that touch the area (comments, form fields, links) are removed,
//   - marked-content labels that carry a copy of the text (/ActualText, /Alt, /E) are stripped.
// Whatever can't be redacted is not left in silently: an image in a format that can't be edited
// is removed as a whole and reported in `warnings`; content that can't be read at all, and text in
// a font whose letter widths are only guessed (so the cut could miss letters), is an error.
//
// Not found, so not removed, only covered: vector drawings (also text turned into outlines).

import { PDFArray, PDFBool, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, PDFString, decodePDFRawStream } from "../vendor/pdf-lib/pdf-lib.esm.min.js";
import { IDENTITY, apply, contentBytes, interpret, mul, readOperators } from "./content.js";

const name = (text) => PDFName.of(text);
const num = (object, fallback = 0) => (object instanceof PDFNumber ? object.asNumber() : fallback);
const MAX_DEPTH = 8; // forms inside forms

/** The page can't be redacted; nothing should be saved. `code` is "redaction" for the app. */
export class RedactionError extends Error {
  constructor(pageNumber, reason) {
    super(`Page ${pageNumber} can't be redacted: ${reason}`);
    this.code = "redaction";
  }
}

// ---------------------------------------------------------------------------------------------
// Geometry

const boundsOf = (points) => {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};
const overlap = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
const touches = (box, rects) => rects.some((r) => box[0] < r[2] && box[2] > r[0] && box[1] < r[3] && box[3] > r[1]);

// A character is cut when this much of its box lies in an area. Less than half, so that a
// character the mark only just reaches goes too: its other part would not be covered anyway
// (the black box grows to the boxes of the characters that were cut).
const SHARE = 0.2;

function covered(box, rects) {
  const area = (box[2] - box[0]) * (box[3] - box[1]);
  if (area <= 1e-9) {
    const [cx, cy] = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
    return rects.some((r) => cx >= r[0] && cx <= r[2] && cy >= r[1] && cy <= r[3]);
  }
  return rects.some((r) => overlap(box, r) >= SHARE * area);
}

function invert([a, b, c, d, e, f]) {
  const det = a * d - b * c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

// ---------------------------------------------------------------------------------------------
// Text

/**
 * `object` is a text run found by interpret(…, { glyphs: true }). Returns null when no character
 * of it lies in `rects`, otherwise { replacement, boxes }: the operator(s) that draw the run
 * without those characters, and the boxes the cut characters had (PDF space).
 */
export function redactText(object, rects) {
  const { parts, unit, low, high, full, prefix } = object;
  if (!parts) return null;
  // Text at size 0 (or squeezed to no width) can't be seen but can be copied: the whole run goes.
  if (!unit) return { replacement: object.replacement, boxes: [] };
  const items = [];
  const boxes = [];
  let kept = [];
  const flush = () => {
    if (kept.length > 0) items.push(`<${kept.map((byte) => byte.toString(16).padStart(2, "0")).join("")}>`);
    kept = [];
  };
  for (const part of parts) {
    if (part.number !== undefined) {
      flush();
      items.push(String(part.number));
      continue;
    }
    const x1 = part.x0 + part.advance;
    const box = boundsOf([[part.x0, low], [x1, low], [x1, high], [part.x0, high]].map((point) => apply(full, point)));
    if (covered(box, rects)) {
      flush();
      items.push(((-part.advance / unit) * 1000).toFixed(3)); // the pen still moves as far
      boxes.push(box);
    } else {
      kept.push(...part.raw);
    }
  }
  if (boxes.length === 0) return null;
  flush();
  return { replacement: `${prefix}[${items.join(" ")}] TJ`, boxes };
}

// ---------------------------------------------------------------------------------------------
// Images

const filterNames = (dict) => {
  const filter = dict.lookup(name("Filter"));
  const list = filter instanceof PDFArray ? filter.asArray().map((entry) => dict.context.lookup(entry)) : filter ? [filter] : [];
  return list.map((entry) => (entry instanceof PDFName ? entry.decodeText() : ""));
};

/** { n, kind, … } for the colour space of an image: how many samples a pixel has, and how to blank them. */
function describeColors(context, space) {
  if (space instanceof PDFName) {
    switch (space.decodeText()) {
      case "DeviceGray": case "G": case "CalGray": return { n: 1, kind: "gray" };
      case "DeviceRGB": case "RGB": case "CalRGB": return { n: 3, kind: "rgb" };
      case "DeviceCMYK": case "CMYK": return { n: 4, kind: "cmyk" };
      default: return null;
    }
  }
  if (!(space instanceof PDFArray)) return null;
  const family = space.lookup(0);
  switch (family instanceof PDFName ? family.decodeText() : "") {
    case "CalGray": return { n: 1, kind: "gray" };
    case "CalRGB": return { n: 3, kind: "rgb" };
    case "ICCBased": {
      const stream = space.lookup(1);
      const n = stream instanceof PDFStream ? num(stream.dict.lookup(name("N"))) : 0;
      return { 1: { n: 1, kind: "gray" }, 3: { n: 3, kind: "rgb" }, 4: { n: 4, kind: "cmyk" } }[n] ?? null;
    }
    case "Indexed": case "I": return { n: 1, kind: "indexed", base: describeColors(context, space.lookup(1)), table: space.lookup(3) };
    case "Separation": return { n: 1, kind: "ink" };
    case "DeviceN": {
      const names = space.lookup(1);
      return names instanceof PDFArray && names.size() > 0 ? { n: names.size(), kind: "ink" } : null;
    }
    default: return null;
  }
}

/** The sample values (one per component) that draw the darkest thing the colour space has. */
function blackSamples(colors, dict, bits, mask) {
  const top = 2 ** bits - 1;
  const decode = dict.lookup(name("Decode"));
  const range = decode instanceof PDFArray ? decode.asArray().map((entry) => num(dict.context.lookup(entry))) : null;
  if (mask) return [range && range[0] === 1 ? 0 : 1]; // "not painted"
  // The sample that decodes to `target` for component `c`.
  const sample = (c, target) => {
    const [from, to] = range && range.length >= 2 * c + 2 ? [range[2 * c], range[2 * c + 1]] : [0, 1];
    return to === from ? 0 : Math.min(top, Math.max(0, Math.round(((target - from) / (to - from)) * top)));
  };
  switch (colors.kind) {
    case "gray": case "rgb": return Array.from({ length: colors.n }, (_, c) => sample(c, 0));
    case "cmyk": return [sample(0, 0), sample(1, 0), sample(2, 0), sample(3, 1)];
    case "ink": return Array.from({ length: colors.n }, (_, c) => sample(c, 1)); // all ink
    case "indexed": return [darkestEntry(colors, top)];
    default: return Array(colors.n).fill(0);
  }
}

function darkestEntry({ base, table }, top) {
  try {
    const bytes = table instanceof PDFRawStream ? decodePDFRawStream(table).decode() : table instanceof PDFHexString || table instanceof PDFString ? table.asBytes() : null;
    if (!bytes || !base || (base.kind !== "gray" && base.kind !== "rgb")) return 0;
    let best = 0;
    let bestSum = Infinity;
    for (let index = 0; index <= top && (index + 1) * base.n <= bytes.length; index++) {
      let sum = 0;
      for (let c = 0; c < base.n; c++) sum += bytes[index * base.n + c];
      if (sum < bestSum) [best, bestSum] = [index, sum];
    }
    return best;
  } catch {
    return 0;
  }
}

/** The EXIF orientation of a JPEG (1 = as stored, also when there is none). */
export function jpegOrientation(bytes) {
  let at = 2;
  while (at + 4 <= bytes.length && bytes[at] === 0xff) {
    const marker = bytes[at + 1];
    const length = (bytes[at + 2] << 8) | bytes[at + 3];
    if (marker === 0xda || marker === 0xd9) break; // the image data starts: no EXIF before it
    if (marker === 0xe1 && String.fromCharCode(...bytes.subarray(at + 4, at + 8)) === "Exif") {
      const tiff = at + 10;
      const little = bytes[tiff] === 0x49;
      const u16 = (i) => (little ? bytes[i] | (bytes[i + 1] << 8) : (bytes[i] << 8) | bytes[i + 1]);
      const u32 = (i) => (little ? u16(i) + u16(i + 2) * 65536 : u16(i) * 65536 + u16(i + 2));
      const ifd = tiff + u32(tiff + 4);
      for (let k = 0, count = u16(ifd); k < count && ifd + 14 + 12 * k <= bytes.length; k++) {
        const entry = ifd + 2 + 12 * k;
        if (u16(entry) === 0x0112) return u16(entry + 8);
      }
      return 1;
    }
    at += 2 + length;
  }
  return 1;
}

/** For each pixel row, the runs [from, to) of pixels whose middle lies in one of `rects`. */
function pixelRuns(width, height, ctm, rects) {
  const inverse = invert(ctm);
  if (!inverse) return null;
  const rows = new Map();
  for (const rect of rects) {
    const corners = [[rect[0], rect[1]], [rect[2], rect[1]], [rect[2], rect[3]], [rect[0], rect[3]]].map((point) => apply(inverse, point));
    const [u0, v0, u1, v1] = boundsOf(corners); // in the unit square of the image, y up
    const x0 = Math.max(0, Math.floor(u0 * width) - 1);
    const x1 = Math.min(width, Math.ceil(u1 * width) + 1);
    const y0 = Math.max(0, Math.floor((1 - v1) * height) - 1);
    const y1 = Math.min(height, Math.ceil((1 - v0) * height) + 1);
    for (let y = y0; y < y1; y++) {
      let first = -1;
      let last = -1;
      for (let x = x0; x < x1; x++) {
        const [px, py] = apply(ctm, [(x + 0.5) / width, 1 - (y + 0.5) / height]);
        if (px >= rect[0] && px <= rect[2] && py >= rect[1] && py <= rect[3]) {
          if (first < 0) first = x;
          last = x;
        }
      }
      if (first >= 0) {
        if (!rows.has(y)) rows.set(y, []);
        rows.get(y).push([first, last + 1]);
      }
    }
  }
  return rows;
}

function setSample(data, rowStart, index, bits, value) {
  const bit = index * bits;
  const at = rowStart + (bit >> 3);
  if (bits === 8) data[at] = value;
  else if (bits === 16) [data[at], data[at + 1]] = [value >> 8, value & 255];
  else {
    const shift = 8 - bits - (bit & 7);
    const clear = ((1 << bits) - 1) << shift;
    data[at] = (data[at] & ~clear) | (value << shift);
  }
}

const entriesExcept = (dict, skip) => {
  const entries = {};
  for (const [key, value] of dict.entries()) if (!skip.includes(key.decodeText())) entries[key.decodeText()] = value;
  return entries;
};

/**
 * A copy of the image `stream` with the pixels under `rects` blanked, as { ref }, or { keep: true }
 * when no pixel lies under them, or null when this image can't be edited (then it is removed).
 */
async function redactImage(context, stream, object, rects, codec) {
  const dict = stream.dict;
  const width = num(dict.lookup(name("Width")));
  const height = num(dict.lookup(name("Height")));
  if (!(width > 0 && height > 0) || !(stream instanceof PDFRawStream)) return null;
  const runs = pixelRuns(width, height, object.ctm, rects);
  if (!runs) return null;
  if (runs.size === 0) return { keep: true };

  const mask = dict.lookup(name("ImageMask")) === PDFBool.True;
  const colors = mask ? { n: 1, kind: "mask" } : describeColors(context, dict.lookup(name("ColorSpace")));
  if (!colors) return null;
  const filters = filterNames(dict);

  if (filters.length === 1 && (filters[0] === "DCTDecode" || filters[0] === "DCT")) {
    // A JPEG is decoded, blanked and written as a new JPEG, by what the environment offers.
    // PDF viewers ignore the EXIF orientation of a JPEG, a browser applies it: then the pixels it
    // gives back are mirrored or turned, and the wrong ones would be blanked.
    if (!codec || mask || dict.lookup(name("Decode")) || jpegOrientation(stream.contents) !== 1) return null;
    let picture;
    try {
      picture = await codec.decodeJpeg(stream.contents);
    } catch {
      return null; // a damaged JPEG: removed as a whole
    }
    if (picture.width !== width || picture.height !== height) return null;
    for (const [y, list] of runs) {
      for (const [from, to] of list) picture.rgb.fill(0, (y * width + from) * 3, (y * width + to) * 3);
    }
    const jpeg = await codec.encodeJpeg(picture);
    const entries = entriesExcept(dict, ["Filter", "DecodeParms", "Length", "ColorSpace", "BitsPerComponent", "Decode"]);
    return { ref: context.register(context.stream(jpeg, { ...entries, ColorSpace: "DeviceRGB", BitsPerComponent: 8, Filter: "DCTDecode" })) };
  }
  if (filters.some((filter) => /^(DCT|JPX|JBIG2|CCITT|CCF|Crypt)/.test(filter))) return null;

  const bits = mask ? 1 : num(dict.lookup(name("BitsPerComponent")), 8);
  if (![1, 2, 4, 8, 16].includes(bits)) return null;
  const rowBytes = Math.ceil((width * colors.n * bits) / 8);
  let data;
  try {
    data = decodePDFRawStream(stream).decode().slice(); // a copy: for an unfiltered image this is the original's data
  } catch {
    return null;
  }
  if (data.length < rowBytes * height) return null;
  const fill = blackSamples(colors, dict, bits, mask);
  for (const [y, list] of runs) {
    for (const [from, to] of list) {
      for (let x = from; x < to; x++) for (let c = 0; c < colors.n; c++) setSample(data, y * rowBytes, x * colors.n + c, bits, fill[c]);
    }
  }
  const entries = entriesExcept(dict, ["Filter", "DecodeParms", "Length", "DL"]);
  return { ref: context.register(context.flateStream(data, entries)) };
}

// ---------------------------------------------------------------------------------------------
// Content, forms and the page

const latin1 = new TextDecoder("latin1");
const encoder = new TextEncoder();

function concat(parts) {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function streamBytes(stream) {
  if (stream instanceof PDFRawStream) return decodePDFRawStream(stream).decode();
  if (stream instanceof PDFStream && typeof stream.getUnencodedContents === "function") return stream.getUnencodedContents();
  throw new Error("unreadable stream");
}

/**
 * Redacts one content stream (the page's, or a form's). Returns { bytes, resources, changed }:
 * the new content and the resource dictionary it needs (a clone, never the shared original).
 */
async function redactContent({ page, bytes, resources, ctm, rects, depth, state }) {
  const { context } = page.doc;
  const operators = readOperators(bytes);
  const found = interpret(operators, page, { ctm, resources, glyphs: true });
  const xobjects = resources instanceof PDFDict ? resources.lookup(name("XObject")) : null;
  const edits = new Map(); // operator index → what stands in its place
  const added = new Map(); // resource name → reference of a redacted copy
  const replaced = new Set(); // original resource names whose drawing operator was replaced
  const stays = new Set(); // original resource names still drawn by an operator that stays

  for (const object of found) {
    if (object.type === "text" && !object.exact) {
      // Where the letters of this text land is only guessed, so a cut could miss some of them.
      throw new Error(
        "it has text in a font whose letter widths can't be read exactly (vertical writing, an East Asian encoding, or a missing or damaged font), so what lies under a mark can't be found reliably",
      );
    }
    const hit = touches(boundsOf(object.points), rects);
    if (object.type === "text") {
      const result = hit && redactText(object, rects);
      if (result) {
        edits.set(object.index, result.replacement);
        state.boxes.push(...result.boxes);
      }
      continue;
    }
    if (object.xobject === undefined) {
      if (hit) {
        edits.set(object.index, ""); // an inline image: removed as a whole
        state.inline++;
      }
      continue;
    }
    if (!hit) {
      stays.add(object.xobject);
      continue;
    }
    const stream = xobjects instanceof PDFDict ? xobjects.lookup(name(object.xobject)) : null;
    let result = null;
    if (stream instanceof PDFStream) {
      if (object.type === "image") result = await redactImage(context, stream, object, rects, state.codec);
      else if (depth >= MAX_DEPTH) throw new Error("forms nested too deeply");
      else result = await redactForm({ page, stream, object, resources, rects, depth, state });
    }
    if (result?.keep) {
      stays.add(object.xobject);
    } else if (result?.ref) {
      const resource = `PdfStudio${++state.counter}`;
      added.set(resource, result.ref);
      edits.set(object.index, `/${resource} Do`);
      replaced.add(object.xobject);
    } else if (object.type === "image") {
      edits.set(object.index, ""); // can't be edited: removed as a whole
      replaced.add(object.xobject);
      state.removedImages++;
    } else {
      throw new Error("a group of content can't be read");
    }
  }

  // Labels of marked content can carry a copy of the text: /ActualText (what the text says),
  // /Alt (a description) and /E (the expansion of an abbreviation), written inline or kept in the
  // resources' /Properties. Such a label becomes a plain one without them.
  const properties = resources instanceof PDFDict ? resources.lookup(name("Properties")) : null;
  const COPIES = ["ActualText", "Alt", "E"];
  operators.forEach(({ op, operands, start, end }, index) => {
    if (op !== "BDC" || edits.has(index)) return;
    const names = operands.filter((operand) => operand?.name !== undefined).map((operand) => operand.name);
    const inline = /\/(ActualText|Alt|E)[\s(<\/]/.test(latin1.decode(bytes.subarray(start, end)));
    const listed = names[1] !== undefined && properties instanceof PDFDict ? properties.lookup(name(names[1])) : null;
    const inList = listed instanceof PDFDict && COPIES.some((key) => listed.has(name(key)));
    if (inline || inList) edits.set(index, `/${(names[0] ?? "Span").replace(/[^A-Za-z0-9_.-]/g, "")} BMC`);
  });

  if (edits.size === 0) return { bytes, resources, changed: false };

  const parts = [];
  let from = 0;
  for (const [index, replacement] of [...edits].sort((a, b) => a[0] - b[0])) {
    const { start, end } = operators[index];
    parts.push(bytes.subarray(from, start), encoder.encode(` ${replacement} `));
    from = end;
  }
  parts.push(bytes.subarray(from));
  const result = concat(parts);

  let own = resources;
  const unused = [...replaced].filter((resource) => !stays.has(resource));
  if (added.size > 0 || unused.length > 0) {
    own = resources instanceof PDFDict ? resources.clone(context) : context.obj({});
    const originals = xobjects instanceof PDFDict ? xobjects : null;
    const ownXobjects = originals ? originals.clone(context) : context.obj({});
    for (const [resource, ref] of added) ownXobjects.set(name(resource), ref);
    // The original must not stay reachable, or its data stays in the file.
    for (const resource of unused) ownXobjects.delete(name(resource));
    own.set(name("XObject"), ownXobjects);
  }
  return { bytes: result, resources: own, changed: true };
}

/** Redacts the content of a form XObject; a new form stream replaces it for this drawing only. */
async function redactForm({ page, stream, object, resources, rects, depth, state }) {
  const { context } = page.doc;
  const own = stream.dict.lookup(name("Resources"));
  const inner = await redactContent({
    page,
    bytes: streamBytes(stream),
    resources: own instanceof PDFDict ? own : resources, // a form without resources uses the page's
    ctm: mul(object.matrix ?? IDENTITY, object.ctm),
    rects,
    depth: depth + 1,
    state,
  });
  if (!inner.changed) return { keep: true };
  const entries = entriesExcept(stream.dict, ["Filter", "DecodeParms", "Length", "DL"]);
  if (inner.resources !== own) entries.Resources = inner.resources;
  return { ref: context.register(context.flateStream(inner.bytes, entries)) };
}

const fixed = (n) => Number(n.toFixed(3)).toString();

/**
 * Redacts the areas `rects` ([x0, y0, x1, y1] in the page's user space) of a page of the document
 * being written. `options.codec` can read and write JPEG images (see image-codec.js),
 * `options.warnings` collects what the user should know, `options.pageNumber` is for messages.
 * Throws a RedactionError if the page's content can't be read.
 */
export async function redactPage(page, rects, { codec = null, warnings = [], pageNumber = 1 } = {}) {
  const { context } = page.doc;
  rects = rects.filter((r) => r[2] > r[0] && r[3] > r[1]);
  if (rects.length === 0) return;
  const state = { boxes: [], counter: 0, removedImages: 0, inline: 0, codec };

  let result;
  const resources = page.node.Resources?.() ?? page.node.lookup(name("Resources"));
  try {
    result = await redactContent({ page, bytes: contentBytes(page), resources, ctm: IDENTITY, rects, depth: 0, state });
  } catch (error) {
    if (error instanceof RedactionError) throw error;
    throw new RedactionError(pageNumber, error.message);
  }

  // The black boxes: the marked areas and the boxes of the characters that were cut.
  const boxes = [...rects, ...state.boxes];
  const black = `q 0 g\n${boxes.map(([x0, y0, x1, y1]) => `${fixed(x0)} ${fixed(y0)} ${fixed(x1 - x0)} ${fixed(y1 - y0)} re`).join("\n")}\nf Q\n`;
  const content = concat([encoder.encode("q\n"), result.bytes, encoder.encode(`\nQ\n${black}`)]);
  page.node.set(name("Contents"), context.register(context.flateStream(content)));
  if (result.resources !== resources) page.node.set(name("Resources"), result.resources);
  page.node.delete(name("Thumb")); // a small picture of the page as it was

  // Annotations that touch the areas (a form field with the value, a comment, a link) go.
  const annots = page.node.lookup(name("Annots"));
  if (annots instanceof PDFArray) {
    const gone = new Set();
    const popups = new Set();
    for (let i = 0; i < annots.size(); i++) {
      const annot = annots.lookup(i);
      const rect = annot instanceof PDFDict ? annot.lookup(name("Rect")) : null;
      if (!(rect instanceof PDFArray) || rect.size() < 4) continue;
      const [a, b, c, d] = [0, 1, 2, 3].map((k) => num(rect.lookup(k)));
      if (!touches([Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)], rects)) continue;
      gone.add(i);
      const popup = annot.get(name("Popup"));
      if (popup instanceof PDFRef) popups.add(popup.tag);
    }
    if (gone.size > 0) {
      const keep = annots.asArray().filter((entry, i) => !gone.has(i) && !(entry instanceof PDFRef && popups.has(entry.tag)));
      page.node.set(name("Annots"), context.obj(keep));
    }
  }

  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (state.removedImages > 0) {
    warnings.push(`Page ${pageNumber}: ${plural(state.removedImages, "image")} under a mark could not be blacked out in part (format not supported), so ${state.removedImages === 1 ? "it was" : "they were"} removed entirely.`);
  }
  if (state.inline > 0) {
    warnings.push(`Page ${pageNumber}: ${plural(state.inline, "small inline image")} under a mark ${state.inline === 1 ? "was" : "were"} removed entirely.`);
  }
}
