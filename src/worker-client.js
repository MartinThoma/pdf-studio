// Promise-based calls into pdf-worker.js.
//
//   add    { sourceId, bytes }   → { pages: [{ width, height, rotation }] }
//   export { pages }             → { bytes }   (pages: [{ sourceId, index, rotation }])
//   reset  {}                    → {}
//
// A failed call rejects with an Error that carries the worker's `code` ("encrypted", "invalid").

export class PdfWorker {
  constructor() {
    this.worker = new Worker(new URL("./pdf-worker.js", import.meta.url), { type: "module" });
    this.pending = new Map();
    this.nextCallId = 1;
    this.worker.addEventListener("message", ({ data }) => {
      const call = this.pending.get(data.callId);
      if (!call) return;
      this.pending.delete(data.callId);
      if (data.ok) {
        call.resolve(data.result);
      } else {
        call.reject(Object.assign(new Error(data.error.message), { code: data.error.code }));
      }
    });
    this.worker.addEventListener("error", (event) => {
      const error = new Error(event.message || "The PDF worker failed to start.");
      for (const call of this.pending.values()) call.reject(error);
      this.pending.clear();
    });
  }

  call(type, payload = {}, transfer = []) {
    const callId = this.nextCallId++;
    return new Promise((resolve, reject) => {
      this.pending.set(callId, { resolve, reject });
      this.worker.postMessage({ callId, type, ...payload }, transfer);
    });
  }
}
