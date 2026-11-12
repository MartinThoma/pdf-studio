// Page previews with pdf.js. Each preview is rendered once, kept as a small JPEG (an object URL)
// and shown in an <img>; the user's rotation is a CSS transform on top, so rotating never
// re-renders. Rendering is lazy: only pages near the viewport are drawn, two at a time.

import { GlobalWorkerOptions, getDocument } from "../vendor/pdfjs/pdf.min.mjs";

const PDFJS = new URL("../vendor/pdfjs/", import.meta.url).href;
GlobalWorkerOptions.workerSrc = `${PDFJS}pdf.worker.min.mjs`;

// Longest side of a preview in pixels: sharp up to the largest thumbnail size on a 2× screen.
const PREVIEW_SIZE = 520;
const CONCURRENCY = 2;

/** Opens a PDF for previews. Takes its own copy of `bytes` (pdf.js hands the buffer to its worker). */
export function openPreviewDocument(bytes) {
  return getDocument({
    data: bytes.slice(),
    cMapUrl: `${PDFJS}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${PDFJS}standard_fonts/`,
    wasmUrl: `${PDFJS}wasm/`,
    iccUrl: `${PDFJS}iccs/`,
    enableXfa: false,
  }).promise;
}

export class PreviewRenderer {
  constructor() {
    this.cache = new Map(); // "sourceId:index" → Promise<string | null> (object URL)
    this.queue = [];
    this.running = 0;
  }

  /**
   * Resolves with an object URL of the preview of page `index` (0-based) of the given pdf.js
   * document promise, or null if the page can't be drawn. `urgent` jumps the queue.
   */
  get(sourceId, index, documentPromise, urgent = false) {
    const key = `${sourceId}:${index}`;
    if (!this.cache.has(key)) {
      const promise = new Promise((resolve) => {
        const job = { run: () => this.render(documentPromise, index).then(resolve, () => resolve(null)) };
        if (urgent) this.queue.unshift(job);
        else this.queue.push(job);
      });
      this.cache.set(key, promise);
      // A failed preview is not kept, so that it is tried again when the page is shown again.
      promise.then((url) => {
        if (!url && this.cache.get(key) === promise) this.cache.delete(key);
      });
      this.pump();
    }
    return this.cache.get(key);
  }

  pump() {
    while (this.running < CONCURRENCY && this.queue.length > 0) {
      const job = this.queue.shift();
      this.running++;
      job.run().finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  async render(documentPromise, index) {
    const pdf = await documentPromise;
    const page = await pdf.getPage(index + 1);
    const natural = page.getViewport({ scale: 1 });
    const scale = PREVIEW_SIZE / Math.max(natural.width, natural.height);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    const context = canvas.getContext("2d", { alpha: false });
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport }).promise;
    page.cleanup();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.86));
    canvas.width = canvas.height = 0; // free the pixels right away
    return blob ? URL.createObjectURL(blob) : null;
  }

  /** Forgets all previews (after "Start over"). Queued ones are dropped and never resolve. */
  clear() {
    for (const promise of this.cache.values()) promise.then((url) => url && URL.revokeObjectURL(url));
    this.cache.clear();
    this.queue = [];
  }
}

/**
 * Draws a page large into `canvas` (width in CSS pixels, sharp on dense screens). Resolves with
 * { cancel } right away; `done` resolves when the drawing is finished (or was cancelled).
 */
export function drawPage(documentPromise, index, canvas, cssWidth) {
  let task = null;
  let cancelled = false;
  const done = (async () => {
    const pdf = await documentPromise;
    const page = await pdf.getPage(index + 1);
    if (cancelled) return false;
    const natural = page.getViewport({ scale: 1 });
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const viewport = page.getViewport({ scale: (cssWidth * ratio) / natural.width });
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const context = canvas.getContext("2d", { alpha: false });
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    task = page.render({ canvasContext: context, viewport });
    try {
      await task.promise;
    } catch (error) {
      if (error?.name === "RenderingCancelledException") return false;
      throw error;
    }
    page.cleanup();
    return true;
  })();
  return {
    done,
    cancel() {
      cancelled = true;
      task?.cancel();
    },
  };
}

/**
 * The text of a page as pieces with their boxes in fractions of the page as drawn (see
 * annotations.js: textInRect). Empty for scanned pages.
 */
export async function pageText(documentPromise, index) {
  const pdf = await documentPromise;
  const page = await pdf.getPage(index + 1);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const items = [];
  for (const item of content.items) {
    if (!item.str || !item.transform) continue;
    const [a, b, c, d, e, f] = item.transform;
    const along = Math.hypot(a, b) || 1;
    const up = Math.hypot(c, d) || 1;
    const height = item.height || up;
    // Corners in PDF space: along the baseline, and up from slightly below it.
    const ux = a / along, uy = b / along, vx = c / up, vy = d / up;
    const corners = [[0, -0.2], [item.width, -0.2], [0, 1], [item.width, 1]].map(([s, t]) => {
      const x = e + ux * s + vx * t * height;
      const y = f + uy * s + vy * t * height;
      return viewport.convertToViewportPoint(x, y);
    });
    const xs = corners.map(([x]) => x / viewport.width);
    const ys = corners.map(([, y]) => y / viewport.height);
    const start = viewport.convertToViewportPoint(e, f);
    const end = viewport.convertToViewportPoint(e + ux * item.width, f + uy * item.width);
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const axis = Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
    items.push({
      str: item.str,
      box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
      axis,
      reversed: axis === "x" ? dx < 0 : dy < 0,
    });
  }
  page.cleanup();
  return items;
}
