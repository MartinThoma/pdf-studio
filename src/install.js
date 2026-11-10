// "Install" button: installs PDF Studio as an app that opens in its own window and works offline.
//
// Chromium browsers (Chrome, Edge, Android) fire `beforeinstallprompt`; the button then opens
// their own install prompt. Safari and Firefox have no such prompt, so the button opens a dialog
// with the steps for the browser at hand. The dialog also tells whether offline use is ready.
// When the app already runs installed, the button is hidden.

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

export function setupInstall({ button, dialog, toast }) {
  const standalone = matchMedia("(display-mode: standalone)");
  let deferredPrompt = null;
  const installed = () => standalone.matches || navigator.standalone === true;
  const update = () => {
    button.hidden = installed();
  };

  addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault(); // show our button instead of the browser's mini-infobar
    deferredPrompt = event;
    update();
  });
  addEventListener("appinstalled", () => {
    deferredPrompt = null;
    button.hidden = true;
    dialog.close?.();
    toast("PDF Studio is installed. Open it from your apps; it works without internet.");
  });
  standalone.addEventListener("change", update);

  button.addEventListener("click", async () => {
    if (deferredPrompt) {
      const prompt = deferredPrompt;
      deferredPrompt = null; // a prompt can only be shown once
      prompt.prompt();
      const { outcome } = await prompt.userChoice;
      if (outcome !== "accepted") toast("Not installed. You can install PDF Studio later with the same button.");
      return;
    }
    await openDialog(dialog);
  });

  update();
  return {
    /** True if the browser's own install prompt is available right now. */
    get canPrompt() {
      return deferredPrompt !== null;
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
