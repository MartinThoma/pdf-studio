// Marks on pages: highlights and privacy marks. Pure functions, shared by the editor, the worker
// that writes the PDF and the tests.
//
// A mark is { id, kind, category, text, rects }:
//   kind      "highlight" | "private"
//   category  for private marks: one of CATEGORIES
//   text      the text under the mark (may be empty on scanned pages; the user can edit it)
//   color     for highlights: one of HIGHLIGHT_COLORS (default: the first)
//   comment   optional note by the user (why it is marked, what to do with it)
//   rects     one or more [u0, v0, u1, v1] boxes, as fractions (0…1) of the page as it is drawn
//             with its own /Rotate applied, origin top left. Fractions keep the marks valid at
//             any zoom and for the thumbnails.
// Pages carry their marks in `page.marks` (see model.js), so undo and redo cover them.

export const KINDS = ["highlight", "private"];

export const CATEGORIES = [
  { id: "name", label: "Name", token: "NAME" },
  { id: "address", label: "Address", token: "ADDRESS" },
  { id: "contact", label: "Email / phone", token: "CONTACT" },
  { id: "number", label: "ID / number", token: "ID" },
  { id: "other", label: "Other", token: "OTHER" },
];

export const categoryOf = (id) => CATEGORIES.find((category) => category.id === id) ?? CATEGORIES[CATEGORIES.length - 1];

export const HIGHLIGHT_COLORS = [
  { id: "yellow", label: "Yellow", rgb: [1, 0.92, 0.25] },
  { id: "green", label: "Green", rgb: [0.55, 0.9, 0.45] },
  { id: "blue", label: "Blue", rgb: [0.5, 0.78, 1] },
  { id: "purple", label: "Purple", rgb: [0.8, 0.66, 1] },
  { id: "orange", label: "Orange", rgb: [1, 0.7, 0.3] },
];

export const colorOf = (id) => HIGHLIGHT_COLORS.find((color) => color.id === id) ?? HIGHLIGHT_COLORS[0];

export const REPORT_FORMAT = "pdf-studio-privacy/1";

// ---------------------------------------------------------------------------------------------
// Text under a rectangle

/**
 * `items` are the text pieces of a page as { str, box: [u0, v0, u1, v1], axis: "x" | "y",
 * reversed } in the same fractions as the rects; `axis` is the direction the text runs in on the
 * screen and `reversed` tells if it runs against the axis (upside-down text).
 * Returns the text inside `rect` and the boxes of the covered characters, one per line, so
 * that a mark hugs the words instead of the dragged rectangle. Without text: { text: "", rects: [rect] }.
 */
export function textInRect(items, rect) {
  const [r0, s0, r1, s1] = normalizeRect(rect);
  const pieces = [];
  for (const item of items) {
    const [u0, v0, u1, v1] = item.box;
    const x = item.axis === "x";
    const [a0, a1, b0, b1] = x ? [u0, u1, v0, v1] : [v0, v1, u0, u1]; // along / across the text
    const [ra0, ra1, rb0, rb1] = x ? [r0, r1, s0, s1] : [s0, s1, r0, r1];
    const length = a1 - a0;
    const thickness = b1 - b0;
    if (length <= 0 || thickness <= 0 || !item.str) continue;
    const across = Math.min(b1, rb1) - Math.max(b0, rb0);
    if (across < thickness * 0.35 || Math.min(a1, ra1) <= Math.max(a0, ra0)) continue;
    let t0 = (Math.max(a0, ra0) - a0) / length;
    let t1 = (Math.min(a1, ra1) - a0) / length;
    if (item.reversed) [t0, t1] = [1 - t1, 1 - t0];
    const chars = [...item.str];
    const from = Math.round(t0 * chars.length);
    const to = Math.round(t1 * chars.length);
    const str = chars.slice(from, to).join("");
    if (!str.trim()) continue;
    // Box of exactly the characters kept.
    let k0 = from / chars.length;
    let k1 = to / chars.length;
    if (item.reversed) [k0, k1] = [1 - k1, 1 - k0];
    const sub = [a0 + k0 * length, a0 + k1 * length];
    pieces.push({ str, box: x ? [sub[0], v0, sub[1], v1] : [u0, sub[0], u1, sub[1]] });
  }
  if (pieces.length === 0) return { text: "", rects: [normalizeRect(rect)] };

  let text = "";
  const rects = [];
  let lastBox = null;
  for (const { str, box } of pieces) {
    const sameLine = lastBox && overlapRatio([lastBox[1], lastBox[3]], [box[1], box[3]]) > 0.5;
    const glue = text === "" ? "" : /\s$/.test(text) || /^\s/.test(str) ? "" : " ";
    text += glue + str;
    if (sameLine) {
      const last = rects[rects.length - 1];
      last[0] = Math.min(last[0], box[0]);
      last[1] = Math.min(last[1], box[1]);
      last[2] = Math.max(last[2], box[2]);
      last[3] = Math.max(last[3], box[3]);
    } else {
      rects.push([...box]);
    }
    lastBox = rects[rects.length - 1];
  }
  return { text: text.replace(/\s+/g, " ").trim(), rects };
}

function overlapRatio([a0, a1], [b0, b1]) {
  const overlap = Math.min(a1, b1) - Math.max(a0, b0);
  return overlap / Math.min(a1 - a0, b1 - b0);
}

export function normalizeRect([x0, y0, x1, y1]) {
  return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
}

// ---------------------------------------------------------------------------------------------
// Fractions → PDF coordinates

/**
 * Turns a rect in page fractions into [x0, y0, x1, y1] in PDF user space (points, origin bottom
 * left). `box` is the page's visible box { x, y, width, height } and `rotation` its own /Rotate.
 */
export function toPdfRect([u0, v0, u1, v1], box, rotation) {
  const point = (u, v) => {
    const { x, y, width: w, height: h } = box;
    switch (((rotation % 360) + 360) % 360) {
      case 90: return [x + v * w, y + u * h];
      case 180: return [x + w - u * w, y + v * h];
      case 270: return [x + w - v * w, y + h - u * h];
      default: return [x + u * w, y + h - v * h];
    }
  };
  const [ax, ay] = point(u0, v0);
  const [bx, by] = point(u1, v1);
  return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
}

/** The other way: the box around points in PDF user space, in page fractions. */
export function fromPdfPoints(points, box, rotation) {
  const { x, y, width: w, height: h } = box;
  const us = [];
  const vs = [];
  for (const [px, py] of points) {
    const s = (px - x) / w;
    const t = (py - y) / h;
    const [u, v] = { 90: [t, s], 180: [1 - s, t], 270: [1 - t, 1 - s] }[((rotation % 360) + 360) % 360] ?? [s, 1 - t];
    us.push(u);
    vs.push(v);
  }
  return [Math.min(...us), Math.min(...vs), Math.max(...us), Math.max(...vs)];
}

// ---------------------------------------------------------------------------------------------
// Placeholders and the privacy list

/**
 * A stable placeholder for every private mark, e.g. "[NAME_1]". The same text in the same
 * category always gets the same placeholder (case and spacing ignored), so a tool that swaps
 * names for placeholders keeps "Jane Doe" on page 1 and page 7 the same person.
 * Returns Map(markId → placeholder) over all pages in order.
 */
export function placeholders(pages) {
  const byKey = new Map();
  const counters = new Map();
  const result = new Map();
  for (const page of pages) {
    for (const mark of page.marks ?? []) {
      if (mark.kind !== "private") continue;
      const category = categoryOf(mark.category);
      const text = mark.text.replace(/\s+/g, " ").trim().toLowerCase();
      const key = `${category.id}|${text || `#${mark.id}`}`;
      if (!byKey.has(key)) {
        const n = (counters.get(category.id) ?? 0) + 1;
        counters.set(category.id, n);
        byKey.set(key, `[${category.token}_${n}]`);
      }
      result.set(mark.id, byKey.get(key));
    }
  }
  return result;
}

/**
 * The privacy list for the current result: every private mark with its page in the result, its
 * text, placeholder and PDF coordinates, plus placeholder → original text. A pseudonymizing
 * tool reads this to replace the texts, and the same map turns the placeholders back.
 * `geometry(page)` returns { box, rotation } of the page in its source file.
 */
export function privacyReport(pages, geometry, { document = "", generated = new Date() } = {}) {
  const names = placeholders(pages);
  const entries = [];
  const replacements = {};
  pages.forEach((page, i) => {
    const { box, rotation } = geometry(page);
    for (const mark of page.marks ?? []) {
      if (mark.kind !== "private") continue;
      const placeholder = names.get(mark.id);
      if (mark.text) replacements[placeholder] ??= mark.text;
      entries.push({
        id: mark.id,
        page: i + 1,
        category: mark.category,
        text: mark.text,
        comment: mark.comment ?? "",
        placeholder,
        rects: mark.rects.map((rect) => toPdfRect(rect, box, rotation).map((n) => Math.round(n * 100) / 100)),
      });
    }
  });
  return {
    format: REPORT_FORMAT,
    note: "Contains the private texts in clear. Keep it as secret as the original PDF.",
    document,
    generated: generated.toISOString(),
    coordinates: "PDF points, [x0, y0, x1, y1], origin bottom left of the page as stored in the file",
    replacements,
    entries,
  };
}

/** Marks that are private, over all pages. */
export const countPrivate = (pages) =>
  pages.reduce((sum, page) => sum + (page.marks ?? []).filter((mark) => mark.kind === "private").length, 0);
