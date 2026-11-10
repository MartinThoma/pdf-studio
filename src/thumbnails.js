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
