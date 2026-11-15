// Versions and updates: which version runs here, which one is the latest on the server, and
// getting the latest.
//
// The service worker (sw.js) serves the app from a cache, so a new version on the server only
// arrives through a new service worker. This module
//   - looks for one on every start, when the window comes back to the front and once an hour,
//     never through the browser's HTTP cache or a CDN's cache (the URL has a fresh query string);
//   - installs the latest version by registering sw.js?v=<its build>: a new script URL always
//     installs a new service worker, which then fetches the files of exactly that build (sw.js);
//   - switches to it right away while no work is open, and otherwise tells the user and waits;
//   - answers "what runs here, what is the latest?" for the version dialog.

import { VERSION } from "./version.js";

const MANIFEST_URL = new URL("../asset-manifest.js", import.meta.url).href;
const WORKER_URL = new URL("../sw.js", import.meta.url).href;
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
  const state = { current: { app: VERSION, build: "" }, latest: null, checked: false, waiting: false, updating: false };
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
    updating: state.updating, // apply() is downloading the new version
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

  /** Asks the server; resolves with status(). Starts installing a newer version if there is one. */
  async function check() {
    lastCheck = Date.now();
    await Promise.all([askWorker(), fetchLatest()]);
    state.checked = true;
    if (supported) await installLatest().catch(() => {});
    changed();
    return status();
  }

  const tracked = new WeakSet();
  function track(installing) {
    if (!installing || tracked.has(installing)) return;
    tracked.add(installing);
    installing.addEventListener("statechange", () => {
      if (installing.state !== "installed") return;
      if (navigator.serviceWorker.controller) offer();
      else toast?.("PDF Studio now works offline.");
    });
  }

  function watch(result) {
    if (registration === result) return;
    registration = result;
    registration.addEventListener("updatefound", () => track(registration.installing));
    track(registration.installing); // register() may resolve after "updatefound"
    if (registration.waiting && navigator.serviceWorker.controller) offer();
  }

  /** Registers the service worker of the latest build, unless it already runs or is on its way. */
  async function installLatest() {
    const build = state.latest?.build;
    if (!build) {
      // Server not reachable: keep what is there; a first visit still gets offline use.
      if (!registration) watch(await navigator.serviceWorker.register(WORKER_URL, { updateViaCache: "none" }));
      return;
    }
    if (registration?.active && state.current.build === build) return;
    const newest = registration?.installing || registration?.waiting || registration?.active;
    if (newest && new URL(newest.scriptURL).searchParams.get("v") === build) return;
    const url = `${WORKER_URL}?v=${encodeURIComponent(build)}`;
    // updateViaCache "none": sw.js never comes from the HTTP cache.
    watch(await navigator.serviceWorker.register(url, { updateViaCache: "none" }));
  }

  function activate(worker) {
    reloading = true;
    worker.postMessage("skip-waiting");
  }

  /** A new version is downloaded and waits: switch now if nothing is lost, otherwise say so. */
  function offer() {
    state.waiting = true;
    changed();
    if (state.updating) return; // apply() takes it from here
    if (!isBusy() && registration?.waiting) {
      activate(registration.waiting);
      return;
    }
    toast?.("A new version of PDF Studio is ready.", {
      duration: 60_000,
      action: { label: "Update", run: () => apply() },
    });
  }

  /** Waits until the new version is installed; gives up when no installation is going on. */
  async function waitForInstall(limit = 120_000) {
    const started = Date.now();
    while (!registration?.waiting && Date.now() - started < limit) {
      if (!registration?.installing && Date.now() - started > 3000) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return registration?.waiting ?? null;
  }

  /**
   * Gets the latest version and reloads. Resolves false if the user chose to keep working or the
   * new version could not be downloaded (then the current one keeps running, and a toast says so).
   */
  async function apply() {
    if (state.updating) return true;
    if (isBusy() && !confirmLoss()) return false;
    if (!supported) {
      location.reload();
      return true;
    }
    state.updating = true;
    changed();
    const notice = toast?.("Downloading the new version of PDF Studio…", { duration: 120_000 });
    try {
      if (!registration?.waiting) await check();
      const waiting = registration?.waiting ?? (await waitForInstall());
      if (waiting) {
        activate(waiting);
        setTimeout(() => location.reload(), 8000); // in case the switch is never announced
        return true;
      }
      if (state.latest && state.current.build === state.latest.build) {
        notice?.remove();
        state.updating = false;
        changed();
        return true; // nothing newer after all
      }
      throw new Error("The new version did not arrive.");
    } catch {
      notice?.remove();
      state.updating = false;
      changed();
      toast?.("The new version could not be downloaded. Check the connection and try again.", {
        error: true,
        duration: 9000,
      });
      return false;
    }
  }

  if (supported) {
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloading) location.reload();
    });
    navigator.serviceWorker
      .getRegistration(new URL("../", import.meta.url).href)
      .then((result) => result && watch(result))
      .catch(() => {})
      .then(() => check());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && Date.now() - lastCheck > CHECK_ON_RETURN_AFTER) check();
    });
    setInterval(check, CHECK_EVERY);
  } else {
    check();
  }

  return { status, check, apply };
}
