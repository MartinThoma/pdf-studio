// Versions and updates: which version runs here, which one is the latest on the server, and
// getting the latest.
//
// The service worker (sw.js) serves the app from a cache, so a new version on the server only
// arrives through a new service worker. This module
//   - looks for one on every start, when the window comes back to the front and once an hour,
//     never through the browser's HTTP cache;
//   - switches to it right away while no work is open, and otherwise tells the user and waits;
//   - answers "what runs here, what is the latest?" for the version dialog;
//   - can always get the latest version on request, as a last resort by dropping every cache.

import { VERSION } from "./version.js";

const MANIFEST_URL = new URL("../asset-manifest.js", import.meta.url).href;
const CHECK_EVERY = 60 * 60 * 1000;
const CHECK_ON_RETURN_AFTER = 10 * 60 * 1000;

/** { app, build } out of the text of asset-manifest.js, or null. */
export function parseManifest(text) {
  const build = /"version":\s*"([^"]+)"/.exec(text)?.[1];
  const app = /"app":\s*"([^"]+)"/.exec(text)?.[1];
  return build ? { app: app ?? "", build } : null;
}

/** "latest" | "outdated" | "unknown": is `current` what the server has? */
export function compareVersions(current, latest) {
  if (!latest) return "unknown";
  if (current.build && latest.build) return current.build === latest.build ? "latest" : "outdated";
  return current.app === latest.app ? "latest" : "outdated";
}

export const describeVersion = ({ app, build }) => (build ? `${app} (build ${build.slice(0, 7)})` : app);

/**
 * `isBusy()` tells if the user has work open (then nothing reloads without asking),
 * `confirmLoss()` asks before a reload that loses work, `onChange()` is called whenever the
 * answer of status() may have changed.
 */
export function setupUpdates({ isBusy, confirmLoss, onChange = () => {}, toast }) {
  const supported = "serviceWorker" in navigator && location.protocol !== "file:";
  const state = { current: { app: VERSION, build: "" }, latest: null, checked: false, waiting: false };
  let registration = null;
  let reloading = false;
  let lastCheck = 0;

  const changed = () => onChange(status());
  const status = () => ({
    current: state.current,
    latest: state.latest,
    // A new version that is already downloaded counts as outdated even when the server can't be reached.
    result: state.waiting ? "outdated" : state.checked ? compareVersions(state.current, state.latest) : "checking",
    ready: state.waiting,
  });

  async function askWorker() {
    const controller = navigator.serviceWorker?.controller;
    if (!controller) return;
    const answer = await new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = (event) => resolve(event.data);
      controller.postMessage("version", [channel.port2]);
      setTimeout(() => resolve(null), 1500); // a worker from before this feature does not answer
    });
    if (answer?.build) state.current = { app: answer.app || VERSION, build: answer.build };
  }

  async function fetchLatest() {
    try {
      if (navigator.onLine === false) throw new Error("offline");
      const response = await fetch(`${MANIFEST_URL}?t=${Date.now()}`, { cache: "no-store" });
      state.latest = response.ok ? parseManifest(await response.text()) : null;
    } catch {
      state.latest = null; // offline
    }
    // Without a service worker the page comes straight from the server: what runs is the latest
    // as of when the page was loaded.
    if (!state.current.build && state.latest && !navigator.serviceWorker?.controller) {
      state.current = { app: VERSION, build: state.latest.build };
    }
  }

  /** Asks the server; resolves with status(). Also makes the browser fetch a new service worker. */
  async function check() {
    lastCheck = Date.now();
    await Promise.all([askWorker(), fetchLatest()]);
    state.checked = true;
    if (navigator.onLine !== false) registration?.update().catch(() => {});
    changed();
    return status();
  }

  function activate(worker) {
    reloading = true;
    worker.postMessage("skip-waiting");
  }

  /** A new version is downloaded and waits: switch now if nothing is lost, otherwise say so. */
  function offer() {
    state.waiting = true;
    changed();
    if (!isBusy() && registration?.waiting) {
      activate(registration.waiting);
      return;
    }
    toast?.("A new version of PDF Studio is ready.", {
      duration: 60_000,
      action: { label: "Update", run: () => apply() },
    });
  }

  /**
   * Gets the latest version and reloads. Resolves false if the user chose to keep working.
   * If the new service worker does not arrive, every cache of the app is dropped: the reload
   * then takes all files from the server.
   */
  async function apply() {
    if (isBusy() && !confirmLoss()) return false;
    if (!supported || !registration) {
      location.reload();
      return true;
    }
    if (!registration.waiting) {
      await registration.update().catch(() => {});
      const started = Date.now();
      while (!registration.waiting && Date.now() - started < 20_000) {
        if (!registration.installing && Date.now() - started > 3000) break; // the server has nothing newer
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    if (registration.waiting) {
      activate(registration.waiting);
      setTimeout(() => location.reload(), 4000); // in case the switch is never announced
      return true;
    }
    for (const key of await caches.keys()) if (key.startsWith("pdf-studio-")) await caches.delete(key);
    await registration.unregister().catch(() => {});
    location.reload();
    return true;
  }

  if (supported) {
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloading) location.reload();
    });
    navigator.serviceWorker
      // updateViaCache "none": neither sw.js nor asset-manifest.js may come from the HTTP cache.
      .register(new URL("../sw.js", import.meta.url), { updateViaCache: "none" })
      .then((result) => {
        registration = result;
        if (registration.waiting && navigator.serviceWorker.controller) offer();
        registration.addEventListener("updatefound", () => {
          const installing = registration.installing;
          installing?.addEventListener("statechange", () => {
            if (installing.state !== "installed") return;
            if (navigator.serviceWorker.controller) offer();
            else toast?.("PDF Studio now works offline.");
          });
        });
        check();
      })
      .catch(() => check());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && Date.now() - lastCheck > CHECK_ON_RETURN_AFTER) check();
    });
    setInterval(check, CHECK_EVERY);
  } else {
    check();
  }

  return { status, check, apply };
}
