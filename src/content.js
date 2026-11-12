// Objects on a page (text runs, images, groups, annotations): finding them and deleting them
// for real. Runs in the worker and in Node for the tests.
//
// pdf-lib does not read page content, so this file has its own small reader for content
// streams. It follows the graphics and text state far enough to know where every text run and
// image lands on the page, and remembers which bytes of the stream draw it. Deleting an object
// cuts those bytes out: the text or image is gone from the file, not covered.
//
// An object is { id, type, box }:
//   id    "c<n>": the n-th operator of the page's content; "a<n>": the n-th entry of /Annots
//   type  "text" | "image" | "group" (a form XObject, deleted as a whole) | "annotation"
//   box   [u0, v0, u1, v1] in fractions of the page as drawn (see annotations.js)
// Not found, so not deletable: vector drawings (lines, shapes), and the single parts of a group.

import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  StandardFontEmbedder,
  decodePDFRawStream,
} from "../vendor/pdf-lib/pdf-lib.esm.min.js";
import { fromPdfPoints } from "./annotations.js";

const name = (text) => PDFName.of(text);
const num = (object, fallback = 0) => (object instanceof PDFNumber ? object.asNumber() : fallback);

// ---------------------------------------------------------------------------------------------
// Reading the content stream

/** The page's content as one byte array (several streams count as one, joined by a space). */
export function contentBytes(page) {
  const { context } = page.doc;
  const contents = page.node.lookup(name("Contents"));
  const streams = contents instanceof PDFArray ? contents.asArray().map((ref) => context.lookup(ref)) : [contents];
  const parts = [];
  for (const stream of streams) {
    if (stream instanceof PDFRawStream) parts.push(decodePDFRawStream(stream).decode());
    else if (stream instanceof PDFStream && typeof stream.getUnencodedContents === "function") {
      parts.push(stream.getUnencodedContents());
    }
  }
  const total = parts.reduce((sum, part) => sum + part.length + 1, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
    bytes[offset++] = 0x0a;
  }
  return bytes;
}

const WHITE = new Set([0, 9, 10, 12, 13, 32]);
const DELIMITER = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]); // ( ) < > [ ] { } / %

/**
 * Splits content into operators: [{ op, operands, start, end }], where start…end are the bytes
 * of the operator with its operands. Operands are numbers, { name }, { bytes } (strings),
 * arrays of these, or null for what the reader does not need (dictionaries).
 */
export function readOperators(bytes) {
  const operators = [];
  let i = 0;
  let operands = [];
  let start = -1;
  const length = bytes.length;

  const skipWhite = () => {
    while (i < length) {
      if (WHITE.has(bytes[i])) i++;
      else if (bytes[i] === 37) while (i < length && bytes[i] !== 10 && bytes[i] !== 13) i++; // % comment
      else break;
    }
  };
  const word = () => {
    const from = i;
    while (i < length && !WHITE.has(bytes[i]) && !DELIMITER.has(bytes[i])) i++;
    return String.fromCharCode(...bytes.subarray(from, i));
  };
  const literalString = () => {
    const out = [];
    let depth = 1;
    i++;
    while (i < length && depth > 0) {
      const c = bytes[i++];
      if (c === 92) {
        const e = bytes[i++];
        if (e >= 48 && e <= 55) {
          let code = e - 48;
          for (let k = 0; k < 2 && bytes[i] >= 48 && bytes[i] <= 55; k++) code = code * 8 + bytes[i++] - 48;
          out.push(code & 255);
        } else if (e === 13) {
          if (bytes[i] === 10) i++;
        } else if (e !== 10) {
          out.push({ 110: 10, 114: 13, 116: 9, 98: 8, 102: 12 }[e] ?? e);
        }
      } else if (c === 40) {
        depth++;
        out.push(c);
      } else if (c === 41) {
        if (--depth > 0) out.push(c);
      } else out.push(c);
    }
    return { bytes: out };
  };
  const hexString = () => {
    const out = [];
    let digits = "";
    i++;
    while (i < length && bytes[i] !== 62) {
      const c = String.fromCharCode(bytes[i++]);
      if (/[0-9a-fA-F]/.test(c)) digits += c;
    }
    i++;
    if (digits.length % 2) digits += "0";
    for (let k = 0; k < digits.length; k += 2) out.push(parseInt(digits.slice(k, k + 2), 16));
    return { bytes: out };
  };
  const skipDict = () => {
    let depth = 0;
    while (i < length) {
      if (bytes[i] === 60 && bytes[i + 1] === 60) { depth++; i += 2; }
      else if (bytes[i] === 62 && bytes[i + 1] === 62) { i += 2; if (--depth === 0) return; }
      else if (bytes[i] === 40) literalString();
      else i++;
    }
  };
  // Returns an operand, or { op } for an operator, or undefined at the end.
  const next = () => {
    skipWhite();
    if (i >= length) return undefined;
    const c = bytes[i];
    if (c === 40) return literalString();
    if (c === 60) {
      if (bytes[i + 1] === 60) { skipDict(); return null; }
      return hexString();
    }
    if (c === 91) {
      i++;
      const items = [];
      for (;;) {
        skipWhite();
        if (i >= length) break;
        if (bytes[i] === 93) { i++; break; }
        const item = next();
        if (item === undefined) break;
        if (item && item.op !== undefined) continue; // stray word inside an array
        items.push(item);
      }
      return items;
    }
    if (c === 47) {
      i++;
      return { name: word().replace(/#([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))) };
    }
    if (c === 93 || c === 62 || c === 41 || c === 123 || c === 125) { i++; return null; }
    const text = word();
    if (text === "") { i++; return null; }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(text)) return Number(text);
    return { op: text };
  };

  for (;;) {
    skipWhite();
    if (i >= length) break;
    const at = i;
    const token = next();
    if (token === undefined) break;
    if (token === null || token.op === undefined) {
      if (start < 0) start = at;
      operands.push(token);
      continue;
    }
    if (start < 0) start = at;
    if (token.op === "BI") {
      // Inline image: skip to the EI that follows the data.
      let k = i;
      while (k < length && !(bytes[k] === 73 && bytes[k + 1] === 68 && WHITE.has(bytes[k - 1]) && WHITE.has(bytes[k + 2]))) k++;
      k += 3;
      while (k < length && !(bytes[k] === 69 && bytes[k + 1] === 73 && WHITE.has(bytes[k - 1]) && (k + 2 >= length || WHITE.has(bytes[k + 2])))) k++;
      i = Math.min(length, k + 2);
    }
    operators.push({ op: token.op, operands, start, end: i });
    operands = [];
    start = -1;
  }
  return operators;
}

// ---------------------------------------------------------------------------------------------
// Fonts: how far each character moves the pen

const STANDARD = [
  [/courier/i, "Courier"],
  [/times/i, "Times"],
  [/symbol/i, "Symbol"],
  [/zapf|dingbat/i, "ZapfDingbats"],
  [/helvetica|arial/i, "Helvetica"],
];

/** The standard font closest to a font name ("ABCDEF+Arial-BoldMT" → "Helvetica-Bold"), or null. */
export function standardFontName(baseFont, fallback = null) {
  const family = STANDARD.find(([pattern]) => pattern.test(baseFont))?.[1] ?? fallback;
  if (!family) return null;
  const bold = /bold/i.test(baseFont);
  const italic = /italic|oblique/i.test(baseFont);
  let fontName = family;
  if (family === "Times") fontName = bold ? (italic ? "Times-BoldItalic" : "Times-Bold") : italic ? "Times-Italic" : "Times-Roman";
  else if (family === "Courier" || family === "Helvetica") {
    fontName += bold ? (italic ? "-BoldOblique" : "-Bold") : italic ? "-Oblique" : "";
  }
  return fontName;
}

function standardWidths(baseFont) {
  const fontName = standardFontName(baseFont);
  if (!fontName) return null;
  try {
    const embedder = StandardFontEmbedder.for(fontName);
    return (code) => {
      try {
        return embedder.widthOfTextAtSize(String.fromCharCode(code), 1000);
      } catch {
        return 500;
      }
    };
  } catch {
    return null;
  }
}

/** { bytesPerCode, width(code) in 1/1000 of the font size, ascent, descent } for a font dictionary. */
function readFont(dict, context) {
  const font = readFontMetrics(dict, context);
  const baseFont = dict instanceof PDFDict ? dict.lookup(name("BaseFont")) : null;
  return { ...font, baseFont: baseFont instanceof PDFName ? baseFont.decodeText() : "" };
}

function readFontMetrics(dict, context) {
  const fallback = { bytesPerCode: 1, width: () => 500, ascent: 0.9, descent: -0.25 };
  if (!(dict instanceof PDFDict)) return fallback;
  const subtype = dict.lookup(name("Subtype"));
  const metrics = (descriptor) => {
    if (!(descriptor instanceof PDFDict)) return { ascent: 0.9, descent: -0.25 };
    const ascent = num(descriptor.lookup(name("Ascent")), 900) / 1000;
    const descent = num(descriptor.lookup(name("Descent")), -250) / 1000;
    return { ascent: Math.min(1.2, Math.max(0.5, ascent)), descent: Math.max(-0.5, Math.min(0, descent)) };
  };

  if (subtype === name("Type0")) {
    const descendants = dict.lookup(name("DescendantFonts"));
    const cid = descendants instanceof PDFArray ? descendants.lookup(0) : null;
    if (!(cid instanceof PDFDict)) return { ...fallback, bytesPerCode: 2, width: () => 1000 };
    const defaultWidth = num(cid.lookup(name("DW")), 1000);
    const widths = new Map();
    const w = cid.lookup(name("W"));
    if (w instanceof PDFArray) {
      for (let k = 0; k < w.size(); ) {
        const first = num(w.lookup(k));
        const second = w.lookup(k + 1);
        if (second instanceof PDFArray) {
          for (let j = 0; j < second.size(); j++) widths.set(first + j, num(second.lookup(j)));
          k += 2;
        } else {
          const last = num(second);
          const width = num(w.lookup(k + 2));
          for (let code = first; code <= last && code - first < 70000; code++) widths.set(code, width);
          k += 3;
        }
      }
    }
    return {
      bytesPerCode: 2,
      width: (code) => widths.get(code) ?? defaultWidth,
      ...metrics(cid.lookup(name("FontDescriptor"))),
    };
  }

  const descriptor = dict.lookup(name("FontDescriptor"));
  const widthsArray = dict.lookup(name("Widths"));
  const firstChar = num(dict.lookup(name("FirstChar")), 0);
  let scale = 1;
  if (subtype === name("Type3")) {
    const matrix = dict.lookup(name("FontMatrix"));
    if (matrix instanceof PDFArray) scale = num(matrix.lookup(0), 0.001) * 1000;
  }
  if (widthsArray instanceof PDFArray) {
    const list = widthsArray.asArray().map((entry) => num(context.lookup(entry)));
    const missing = descriptor instanceof PDFDict ? num(descriptor.lookup(name("MissingWidth")), 0) : 0;
    return {
      bytesPerCode: 1,
      width: (code) => (list[code - firstChar] ?? missing) * scale,
      ...metrics(descriptor),
    };
  }
  const baseFont = dict.lookup(name("BaseFont"));
  const standard = baseFont instanceof PDFName ? standardWidths(baseFont.decodeText()) : null;
  return { ...fallback, ...(standard ? { width: standard } : {}), ...metrics(descriptor) };
}

// ---------------------------------------------------------------------------------------------
// Following the state: where does each run and image land?

// A matrix is [a, b, c, d, e, f]; mul(m, n) applies m first, then n.
const IDENTITY = [1, 0, 0, 1, 0, 0];
const mul = (m, n) => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
];
const apply = (m, [x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const numbers = (operands, count) => {
  const list = operands.filter((operand) => typeof operand === "number");
  return list.length >= count ? list.slice(-count) : null;
};

/**
 * Walks the operators and returns the drawn objects as
 * { index, type, points: four corners in PDF space, xobject?: name, replacement: string },
 * where `replacement` is what must stand in for the operator when it is deleted (for text: a
 * move of the pen by the same distance, so that what follows stays where it was). Text runs
 * also carry what is needed to write other text in their place: `matrix` (one unit = the font
 * size, origin at the start of the run), `paint` (colour and render mode) and `baseFont`.
 */
export function interpret(operators, page) {
  const { context } = page.doc;
  const resources = page.node.Resources?.() ?? page.node.lookup(name("Resources"));
  const dictOf = (kind) => {
    const dict = resources instanceof PDFDict ? resources.lookup(name(kind)) : null;
    return dict instanceof PDFDict ? dict : null;
  };
  const xobjects = dictOf("XObject");
  const fontDicts = dictOf("Font");
  const fonts = new Map();
  const fontOf = (fontName) => {
    if (!fonts.has(fontName)) fonts.set(fontName, readFont(fontDicts?.lookup(name(fontName)), context));
    return fonts.get(fontName);
  };

  const found = [];
  const stack = [];
  let ctm = IDENTITY;
  let text = { font: null, size: 0, charSpace: 0, wordSpace: 0, scale: 1, leading: 0, rise: 0, mode: 0 };
  let fill = "0 g";
  let tm = IDENTITY;
  let lineMatrix = IDENTITY;
  const nextLine = (tx, ty) => {
    lineMatrix = mul([1, 0, 0, 1, tx, ty], lineMatrix);
    tm = lineMatrix;
  };

  // Shows strings (and the numbers of TJ), returns the distance the pen moved.
  const show = (items) => {
    const font = text.font ?? { bytesPerCode: 1, width: () => 500, ascent: 0.9, descent: -0.25 };
    let advance = 0;
    for (const item of items) {
      if (typeof item === "number") {
        advance -= (item / 1000) * text.size * text.scale;
      } else if (item?.bytes) {
        const codes = item.bytes;
        for (let k = 0; k + font.bytesPerCode <= codes.length; k += font.bytesPerCode) {
          const code = font.bytesPerCode === 2 ? codes[k] * 256 + codes[k + 1] : codes[k];
          const space = font.bytesPerCode === 1 && code === 32 ? text.wordSpace : 0;
          advance += ((font.width(code) / 1000) * text.size + text.charSpace + space) * text.scale;
        }
      }
    }
    return { advance, font };
  };
  const textRun = (index, items, prefix) => {
    const { advance, font } = show(items);
    const matrix = mul(tm, ctm);
    const low = font.descent * text.size + text.rise;
    const high = font.ascent * text.size + text.rise;
    const points = [[0, low], [advance, low], [advance, high], [0, high]].map((point) => apply(matrix, point));
    const unit = text.size * text.scale;
    const move = unit ? `[${(-(advance / unit) * 1000).toFixed(3)}] TJ` : "";
    // A run without characters only moves the pen (also what a deleted run leaves behind).
    if (items.some((item) => item?.bytes?.length > 0)) {
      found.push({
        index, type: "text", points, replacement: `${prefix}${move}`.trim(),
        matrix: mul([text.size * text.scale, 0, 0, text.size, 0, text.rise], matrix),
        paint: `${fill}${text.mode ? ` ${text.mode} Tr` : ""}`,
        baseFont: font.baseFont ?? "",
        fontResource: text.fontResource ?? "",
        size: text.size,
      });
    }
    tm = mul([1, 0, 0, 1, advance, 0], tm);
  };

  operators.forEach(({ op, operands }, index) => {
    switch (op) {
      case "q": stack.push({ ctm, text: { ...text }, fill }); break;
      case "Q": {
        const saved = stack.pop();
        if (saved) ({ ctm, text, fill } = saved);
        break;
      }
      case "g": case "rg": case "k": case "sc": case "scn": {
        // The fill colour, as far as it is plain numbers (patterns and named inks fall back to black).
        const parts = operands.filter((operand) => typeof operand === "number");
        const colorOp = { 1: "g", 3: "rg", 4: "k" }[parts.length];
        fill = colorOp && parts.length === operands.length ? `${parts.join(" ")} ${colorOp}` : "0 g";
        break;
      }
      case "Tr": text.mode = numbers(operands, 1)?.[0] ?? 0; break;
      case "cm": {
        const m = numbers(operands, 6);
        if (m) ctm = mul(m, ctm);
        break;
      }
      case "BT": tm = lineMatrix = IDENTITY; break;
      case "Tf": {
        const fontName = operands.find((operand) => operand?.name !== undefined)?.name;
        text.font = fontName === undefined ? null : fontOf(fontName);
        text.fontResource = fontName ?? "";
        text.size = numbers(operands, 1)?.[0] ?? 0;
        break;
      }
      case "Tc": text.charSpace = numbers(operands, 1)?.[0] ?? 0; break;
      case "Tw": text.wordSpace = numbers(operands, 1)?.[0] ?? 0; break;
      case "Tz": text.scale = (numbers(operands, 1)?.[0] ?? 100) / 100; break;
      case "TL": text.leading = numbers(operands, 1)?.[0] ?? 0; break;
      case "Ts": text.rise = numbers(operands, 1)?.[0] ?? 0; break;
      case "Td": {
        const t = numbers(operands, 2);
        if (t) nextLine(t[0], t[1]);
        break;
      }
      case "TD": {
        const t = numbers(operands, 2);
        if (t) {
          text.leading = -t[1];
          nextLine(t[0], t[1]);
        }
        break;
      }
      case "Tm": {
        const m = numbers(operands, 6);
        if (m) tm = lineMatrix = m;
        break;
      }
      case "T*": nextLine(0, -text.leading); break;
      case "Tj": textRun(index, operands, ""); break;
      case "TJ": textRun(index, operands.flat(), ""); break;
      case "'":
        nextLine(0, -text.leading);
        textRun(index, operands, "T* ");
        break;
      case '"': {
        const spacing = numbers(operands, 2);
        if (spacing) [text.wordSpace, text.charSpace] = spacing;
        nextLine(0, -text.leading);
        textRun(index, operands.filter((operand) => operand?.bytes), spacing ? `${spacing[0]} Tw ${spacing[1]} Tc T* ` : "T* ");
        break;
      }
      case "BI":
        found.push({ index, type: "image", points: [[0, 0], [1, 0], [1, 1], [0, 1]].map((p) => apply(ctm, p)), replacement: "" });
        break;
      case "Do": {
        const xName = operands.find((operand) => operand?.name !== undefined)?.name;
        const xobject = xName === undefined ? null : xobjects?.lookup(name(xName));
        const dict = xobject instanceof PDFStream ? xobject.dict : null;
        if (!dict) break;
        if (dict.lookup(name("Subtype")) === name("Form")) {
          const bbox = dict.lookup(name("BBox"));
          const matrixArray = dict.lookup(name("Matrix"));
          if (!(bbox instanceof PDFArray) || bbox.size() < 4) break;
          const [x0, y0, x1, y1] = [0, 1, 2, 3].map((k) => num(bbox.lookup(k)));
          const own = matrixArray instanceof PDFArray && matrixArray.size() === 6
            ? [0, 1, 2, 3, 4, 5].map((k) => num(matrixArray.lookup(k)))
            : IDENTITY;
          const matrix = mul(own, ctm);
          found.push({
            index, type: "group", xobject: xName, replacement: "",
            points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map((p) => apply(matrix, p)),
          });
        } else {
          found.push({
            index, type: "image", xobject: xName, replacement: "",
            points: [[0, 0], [1, 0], [1, 1], [0, 1]].map((p) => apply(ctm, p)),
          });
        }
        break;
      }
      default:
    }
  });
  return found;
}

// ---------------------------------------------------------------------------------------------
// The two things the app asks for

const visibleBox = (page) => {
  const box = page.getCropBox();
  return { x: box.x, y: box.y, width: box.width, height: box.height };
};

const clip = ([u0, v0, u1, v1]) => [Math.max(0, u0), Math.max(0, v0), Math.min(1, u1), Math.min(1, v1)];

/** Everything on the page that can be deleted, with its place on the page as drawn. */
export function pageObjects(page) {
  const box = visibleBox(page);
  const rotation = page.getRotation().angle;
  const objects = [];
  let operators = [];
  try {
    operators = readOperators(contentBytes(page));
  } catch {
    // Unreadable content (an unknown filter): nothing on the page can be picked.
  }
  for (const { index, type, points } of interpret(operators, page)) {
    const rect = clip(fromPdfPoints(points, box, rotation));
    if (rect[2] - rect[0] <= 0 || rect[3] - rect[1] <= 0) continue; // off the page
    objects.push({ id: `c${index}`, type, box: rect });
  }
  const annots = page.node.lookup(name("Annots"));
  if (annots instanceof PDFArray) {
    for (let i = 0; i < annots.size(); i++) {
      const annot = annots.lookup(i);
      if (!(annot instanceof PDFDict) || annot.lookup(name("Subtype")) === name("Popup")) continue;
      const rect = annot.lookup(name("Rect"));
      if (!(rect instanceof PDFArray) || rect.size() < 4) continue;
      const [x0, y0, x1, y1] = [0, 1, 2, 3].map((k) => num(rect.lookup(k)));
      const area = clip(fromPdfPoints([[x0, y0], [x1, y1]], box, rotation));
      if (area[2] - area[0] <= 0 || area[3] - area[1] <= 0) continue;
      objects.push({ id: `a${i}`, type: "annotation", box: area });
    }
  }
  return objects;
}

/**
 * Deletes the objects with the given ids from a page of the document being written, and writes
 * new text in place of the text runs in `edits` ({ id: text }). The page gets a new content
 * stream and its own resource list, so nothing shared with other pages changes; collectGarbage()
 * then drops the data of deleted images.
 *
 * New text is set in the standard font closest to the old one (`embed(fontName)` resolves with
 * the pdf-lib font), at the old place, size, direction and colour. Characters the standard
 * fonts do not have become "?".
 */
export async function rewritePage(page, { removed = [], edits = {} }, embed) {
  const { context } = page.doc;
  const contentIndices = new Set();
  const annotIndices = new Set();
  const newText = new Map();
  for (const id of removed) {
    const n = Number(id.slice(1));
    if (!Number.isInteger(n)) continue;
    if (id[0] === "c") contentIndices.add(n);
    if (id[0] === "a") annotIndices.add(n);
  }
  for (const [id, text] of Object.entries(edits)) {
    const n = Number(id.slice(1));
    if (id[0] !== "c" || !Number.isInteger(n) || contentIndices.has(n)) continue;
    contentIndices.add(n);
    newText.set(n, text);
  }

  if (contentIndices.size > 0) {
    const bytes = contentBytes(page);
    const operators = readOperators(bytes);
    const found = new Map(interpret(operators, page).map((object) => [object.index, object]));
    const encoder = new TextEncoder();
    const parts = [encoder.encode("q\n")];
    const added = [];
    const fonts = new Map(); // resource name → font ref
    let from = 0;
    const gone = new Set();
    const kept = new Set();
    for (const [index, object] of found) {
      if (!contentIndices.has(index)) {
        if (object.xobject !== undefined) kept.add(object.xobject);
        continue;
      }
      const { start, end } = operators[index];
      parts.push(bytes.subarray(from, start), encoder.encode(` ${object.replacement} `));
      from = end;
      if (object.xobject !== undefined) gone.add(object.xobject);
      const text = newText.get(index);
      if (object.type === "text" && text) {
        const fontName = standardFontName(object.baseFont, "Helvetica");
        const font = await embed(fontName);
        const resource = `PdfStudio-${fontName}`;
        fonts.set(resource, font.ref);
        const encodable = [...text].map((char) => {
          try {
            font.encodeText(char);
            return char;
          } catch {
            return "?";
          }
        }).join("");
        const matrix = object.matrix.map((n) => Number(n.toFixed(4))).join(" ");
        added.push(`q ${object.paint} BT /${resource} 1 Tf ${matrix} Tm ${font.encodeText(encodable).toString()} Tj ET Q`);
      }
    }
    parts.push(bytes.subarray(from), encoder.encode(`\nQ\n${added.join("\n")}\n`));
    const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) {
      result.set(part, offset);
      offset += part.length;
    }
    page.node.set(name("Contents"), context.register(context.flateStream(result)));

    const unused = [...gone].filter((xName) => !kept.has(xName));
    const resources = page.node.lookup(name("Resources"));
    if ((unused.length > 0 || fonts.size > 0) && resources instanceof PDFDict) {
      const ownResources = resources.clone(context);
      const xobjects = resources.lookup(name("XObject"));
      if (unused.length > 0 && xobjects instanceof PDFDict) {
        const ownXobjects = xobjects.clone(context);
        for (const xName of unused) ownXobjects.delete(name(xName));
        ownResources.set(name("XObject"), ownXobjects);
      }
      if (fonts.size > 0) {
        const fontDict = resources.lookup(name("Font"));
        const ownFonts = fontDict instanceof PDFDict ? fontDict.clone(context) : context.obj({});
        for (const [resource, ref] of fonts) ownFonts.set(name(resource), ref);
        ownResources.set(name("Font"), ownFonts);
      }
      page.node.set(name("Resources"), ownResources);
    }
  }

  const annots = page.node.lookup(name("Annots"));
  if (annotIndices.size > 0 && annots instanceof PDFArray) {
    // A deleted comment takes its popup window with it.
    const popups = new Set();
    for (const i of annotIndices) {
      const annot = annots.lookup(i);
      const popup = annot instanceof PDFDict ? annot.get(name("Popup")) : null;
      if (popup instanceof PDFRef) popups.add(popup.tag);
    }
    const keep = annots.asArray().filter((entry, i) => !annotIndices.has(i) && !(entry instanceof PDFRef && popups.has(entry.tag)));
    page.node.set(name("Annots"), context.obj(keep));
  }
}

// ---------------------------------------------------------------------------------------------
// For developers: how an object is written in the file

const LIMIT = 6000;
const shorten = (text) => (text.length > LIMIT ? `${text.slice(0, LIMIT)}\n% … ${text.length - LIMIT} more characters` : text);

/** Bytes of a content stream as text; what is not printable becomes an octal escape. */
function printable(bytes) {
  let out = "";
  for (const byte of bytes) {
    out += byte === 10 || byte === 13 || (byte >= 32 && byte < 127) ? String.fromCharCode(byte) : `\\${byte.toString(8).padStart(3, "0")}`;
  }
  return out;
}

/** An object of the file as PDF source: "12 0 obj … endobj" for indirect objects. */
function objectSource(entry, context) {
  const object = entry instanceof PDFRef ? context.lookup(entry) : entry;
  if (!object) return "% (missing)";
  let body;
  if (object instanceof PDFStream) {
    const length = object.contents?.length ?? object.getContentsSize?.() ?? 0;
    body = `${object.dict.toString()}\nstream\n% … ${length} bytes\nendstream`;
  } else body = object.toString();
  body = shorten(body);
  return entry instanceof PDFRef ? `${entry.objectNumber} ${entry.generationNumber} obj\n${body}\nendobj` : body;
}

/**
 * The PDF source of an object of the page (ids as in pageObjects): the operator in the content
 * stream with the state it is drawn in and the font or image it uses, or the annotation.
 */
export function inspectObject(page, id) {
  const { context } = page.doc;
  const n = Number(id.slice(1));
  if (id[0] === "a") {
    const annots = page.node.lookup(name("Annots"));
    const entry = annots instanceof PDFArray ? annots.get(n) : null;
    if (!entry) return "% Not found.";
    return `% Entry ${n} of the page's /Annots\n${objectSource(entry, context)}`;
  }
  const bytes = contentBytes(page);
  const operators = readOperators(bytes);
  const operator = operators[n];
  if (id[0] !== "c" || !operator) return "% Not found.";
  const object = interpret(operators, page).find((found) => found.index === n);
  const resources = page.node.lookup(name("Resources"));
  const resource = (kind, key) => {
    const dict = resources instanceof PDFDict ? resources.lookup(name(kind)) : null;
    return dict instanceof PDFDict ? dict.get(name(key)) : null;
  };
  const lines = [
    `% Content stream of the page: operator ${n + 1} of ${operators.length}, bytes ${operator.start}–${operator.end}`,
    shorten(printable(bytes.subarray(operator.start, operator.end))),
  ];
  if (object?.type === "text") {
    lines.push(
      "",
      `% Text state: /${object.fontResource} ${object.size} Tf, colour and mode: ${object.paint}`,
      `% Matrix from text space (1 = font size) to the page: [${object.matrix.map((m) => Number(m.toFixed(4))).join(" ")}]`,
    );
    const font = resource("Font", object.fontResource);
    if (font) lines.push("", `% Font /${object.fontResource}`, objectSource(font, context));
  } else if (object?.xobject !== undefined) {
    const xobject = resource("XObject", object.xobject);
    const corners = object.points.map(([x, y]) => `(${x.toFixed(1)}, ${y.toFixed(1)})`).join(" ");
    lines.push("", `% Drawn with the corners ${corners}`);
    if (xobject) lines.push("", `% XObject /${object.xobject}`, objectSource(xobject, context));
  }
  return lines.join("\n");
}
