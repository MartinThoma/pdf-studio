// Module worker that holds the parsed uploads (pdf-lib) and builds the result, so that parsing
// and saving large files never blocks the page. Protocol: see worker-client.js.

import { assemble, loadSource } from "./assemble.js";

const sources = new Map();

self.addEventListener("message", async ({ data }) => {
  const { callId, type } = data;
  try {
    let result = {};
    const transfer = [];
    if (type === "add") {
      const { doc, pages } = await loadSource(data.bytes);
      sources.set(data.sourceId, doc);
      result = { pages };
    } else if (type === "export") {
      const bytes = await assemble(sources, data.pages);
      result = { bytes };
      transfer.push(bytes.buffer);
    } else if (type === "reset") {
      sources.clear();
    } else {
      throw new Error(`Unknown message type ${type}.`);
    }
    self.postMessage({ callId, ok: true, result }, transfer);
  } catch (error) {
    self.postMessage({ callId, ok: false, error: { message: error.message, code: error.code } });
  }
});
