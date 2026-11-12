// "Install" button: installs PDF Studio as an app that opens in its own window and works offline.
//
// Chromium browsers (Chrome, Edge, Android) fire `beforeinstallprompt`; the button then opens
// their own install prompt. Safari and Firefox have no such prompt, so the button opens a dialog
// with the steps for the browser at hand. The dialog also tells whether offline use is ready.
// The same dialog shows which version runs here and whether it is the latest (update.js), so
// the button stays when the app is installed, as "Version" (or "Update" when there is one).

import { describeVersion } from "./update.js";

/** Which install steps fit this browser: "ios", "mac-safari", "firefox-android", "firefox", "chromium". */
export function detectPlatform(userAgent = navigator.userAgent, touchPoints = navigator.maxTouchPoints ?? 0) {
  const ios = /iPad|iPhone|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && touchPoints > 1);
  if (ios) return "ios";
  if (/Firefox\//.test(userAgent)) return /Android/.test(userAgent) ? "firefox-android" : "firefox";
  if (/Macintosh/.test(userAgent) && /Safari\//.test(userAgent) && !/Chrome\/|Chromium\/|Edg\//.test(userAgent)) {
    return "mac-safari";
  }
  return "chromium";
}

const STEPS = {
  ios: "Tap the <b>Share</b> button <span aria-hidden=\"true\">(□↑)</span>, then <b>Add to Home Screen</b>.",
  "mac-safari": "In the menu bar, choose <b>File → Add to Dock</b>.",
  "firefox-android": "Open the menu <span aria-hidden=\"true\">(⋮)</span> and choose <b>Add to Home screen</b>.",
  firefox:
    "Firefox on the desktop can't install web apps on most systems. PDF Studio still works offline in this " +
    "browser after the first visit; just open this address. To install it, open it in Chrome, Edge or Safari.",
  chromium:
    "Use the install icon at the right end of the address bar, or the browser menu → <b>Install PDF Studio</b> " +
    "(on Android: <b>Add to Home screen</b>). If it is already installed, open it from your apps.",
};

const STATUS_TEXT = {
  checking: "Looking for the latest version…",
  latest: "You have the latest version.",
  unknown: "Can't reach the server to look for a newer version (offline?).",
};

/**
 * `updates` is the object of setupUpdates() (update.js). The button opens a dialog with the
 * version that runs here, the latest one and "Update now", and with the way to install.
 */
export function setupInstall({ button, dialog, toast, updates }) {
  const standalone = matchMedia("(display-mode: standalone)");
  let deferredPrompt = null;
  let wasInstalled = false;
  const installed = () => wasInstalled || standalone.matches || navigator.standalone === true;
  const label = button.querySelector(".label");
  const installNow = dialog.querySelector("[data-install-now]");
  const update = () => {
    // Installed, the button stays as the place to see the version and to update.
    const outdated = updates.status().result === "outdated";
    label.textContent = outdated ? "Update" : installed() ? "Version" : "Install";
    button.dataset.update = String(outdated);
    button.title = outdated
      ? "A newer version of PDF Studio is available"
      : installed()
        ? "Version of PDF Studio"
        : "Install PDF Studio as an app that works offline; version";
    dialog.querySelector("[data-install-section]").hidden = installed();
    installNow.hidden = deferredPrompt === null;
  };

  function showVersion(status = updates.status()) {
    update();
    dialog.querySelector("[data-version-current]").textContent = describeVersion(status.current);
    const line = dialog.querySelector("[data-version-status]");
    line.dataset.state = status.result;
    line.querySelector("span").textContent =
      status.result === "outdated"
        ? status.latest
          ? `A newer version is available: ${describeVersion(status.latest)}.`
          : "A newer version is ready."
        : STATUS_TEXT[status.result];
    dialog.querySelector("[data-update-now]").hidden = status.result !== "outdated";
  }

  addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault(); // show our button instead of the browser's mini-infobar
    deferredPrompt = event;
    update();
  });
  addEventListener("appinstalled", () => {
    deferredPrompt = null;
    wasInstalled = true;
    update();
    dialog.close?.();
    toast("PDF Studio is installed. Open it from your apps; it works without internet.");
  });
  standalone.addEventListener("change", update);

  installNow.addEventListener("click", async () => {
    if (!deferredPrompt) return;
    const prompt = deferredPrompt;
    deferredPrompt = null; // a prompt can only be shown once
    update();
    prompt.prompt();
    const { outcome } = await prompt.userChoice;
    if (outcome !== "accepted") toast("Not installed. You can install PDF Studio later with the same button.");
  });
  dialog.querySelector("[data-update-now]").addEventListener("click", () => updates.apply());
  dialog.querySelector("[data-check-again]").addEventListener("click", () => {
    showVersion({ ...updates.status(), result: "checking" });
    updates.check().then(showVersion);
  });

  button.addEventListener("click", async () => {
    showVersion();
    updates.check().then(showVersion);
    await openDialog(dialog);
  });

  update();
  return {
    /** True if the browser's own install prompt is available right now. */
    get canPrompt() {
      return deferredPrompt !== null;
    },
    /** Call when the answer of updates.status() changed. */
    refresh() {
      if (dialog.open) showVersion();
      else update();
    },
  };
}

async function openDialog(dialog) {
  const steps = dialog.querySelector("[data-install-steps]");
  const status = dialog.querySelector("[data-offline-status]");
  steps.innerHTML = STEPS[detectPlatform()];
  if (!window.isSecureContext || !("serviceWorker" in navigator)) {
    steps.innerHTML =
      "Installing and offline use need a secure connection. Open PDF Studio through an " +
      "<b>https://</b> address, or on this computer through <b>localhost</b>.";
    setStatus(status, "unavailable", "Offline use is not available on this connection.");
  } else {
    setStatus(status, "pending", "Preparing offline use…");
    dialog.showModal();
    await navigator.serviceWorker.ready;
    setStatus(status, "ready", "Ready for offline use on this device.");
    return;
  }
  dialog.showModal();
}

function setStatus(element, state, text) {
  element.dataset.state = state;
  element.querySelector("span").textContent = text;
}
