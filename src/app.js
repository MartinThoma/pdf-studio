// The editor: page grid, selection, drag and drop, keyboard, undo, upload and download.

import { History, insert, move, normalizeRotation, pagesOf, remove, rotate } from "./model.js";
import { PreviewRenderer, openPreviewDocument } from "./thumbnails.js";
import { PdfWorker } from "./worker-client.js";

const $ = (id) => document.getElementById(id);
const ui = {
  pages: $("pages"),
  empty: $("empty"),
  main: $("main"),
  contextbar: $("contextbar"),
  summary: $("summary"),
  selectionActions: $("selection-actions"),
  selectionCount: $("selection-count"),
  undo: $("undo"),
  redo: $("redo"),
  add: $("add"),
  choose: $("choose"),
  download: $("download"),
  help: $("help"),
  shortcuts: $("shortcuts"),
  fileInput: $("file-input"),
  thumbSize: $("thumb-size"),
  clearAll: $("clear-all"),
  toasts: $("toasts"),
  announcer: $("announcer"),
};

const SOURCE_COLORS = ["#2847c4", "#c2410c", "#15803d", "#a21caf", "#0e7490", "#b45309", "#be123c", "#4d7c0f"];
const LONG_PRESS_MS = 380;
const DRAG_THRESHOLD = 6;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

const worker = new PdfWorker();
const previews = new PreviewRenderer();

const state = {
  sources: new Map(), // sourceId → { name, color, pages: [{ width, height, rotation }], pdf: Promise }
  history: new History([]),
  selection: new Set(),
  anchor: null, // start of a Shift range
  focusId: null, // the page with tabindex=0
  dirty: false, // changes since the last download
  justDragged: false,
  nextSource: 1,
  drag: null,
  press: null,
};
const cards = new Map(); // page id → <li>

const pages = () => state.history.present;
const indexOf = (id) => pages().findIndex((page) => page.id === id);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// ---------------------------------------------------------------------------------------------
// Rendering

const previewObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        previewObserver.unobserve(entry.target);
        loadPreview(entry.target);
      }
    }
  },
  { rootMargin: "600px 0px" },
);

function render({ animate = true, added = new Set() } = {}) {
  const list = pages();
  const hasPages = list.length > 0;
  ui.empty.hidden = hasPages;
  ui.pages.hidden = !hasPages;
  ui.contextbar.hidden = !hasPages;

  const ids = new Set(list.map((page) => page.id));
  for (const id of state.selection) if (!ids.has(id)) state.selection.delete(id);
  if (!ids.has(state.focusId)) state.focusId = list[0]?.id ?? null;

  const flip = animate && !reducedMotion.matches && cards.size > 0 && cards.size <= 400;
  const before = new Map();
  if (flip) for (const [id, card] of cards) before.set(id, card.getBoundingClientRect());

  for (const [id, card] of cards) {
    if (!ids.has(id)) {
      previewObserver.unobserve(card);
      card.remove();
      cards.delete(id);
    }
  }
  list.forEach((page, i) => {
    let card = cards.get(page.id);
    if (!card) {
      card = createCard(page);
      cards.set(page.id, card);
      if (added.has(page.id) && !reducedMotion.matches) {
        card.classList.add("is-new");
        card.addEventListener("animationend", () => card.classList.remove("is-new"), { once: true });
      }
    }
    updateCard(card, page, i + 1);
    if (ui.pages.children[i] !== card) ui.pages.insertBefore(card, ui.pages.children[i] ?? null);
  });

  if (flip) {
    for (const [id, card] of cards) {
      const old = before.get(id);
      if (!old) continue;
      const now = card.getBoundingClientRect();
      const dx = old.left - now.left;
      const dy = old.top - now.top;
      if (dx || dy) {
        card.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
          duration: 260,
          easing: "cubic-bezier(0.22, 1, 0.36, 1)",
        });
      }
    }
  }
  updateBars();
}

function createCard(page) {
  const source = state.sources.get(page.sourceId);
  const card = document.createElement("li");
  card.className = "page";
  card.id = `page-${page.id}`;
  card.dataset.id = page.id;
  card.setAttribute("role", "option");
  card.innerHTML = `
    <div class="thumb">
      <div class="paper"><img alt="" draggable="false"></div>
      <span class="check" aria-hidden="true"><svg><use href="#i-check"/></svg></span>
      <span class="rotation-badge" aria-hidden="true" hidden></span>
      <div class="page-actions">
        <button type="button" tabindex="-1" data-action="rotate-left" title="Rotate left"><svg aria-hidden="true"><use href="#i-rotate-left"/></svg></button>
        <button type="button" tabindex="-1" data-action="rotate-right" title="Rotate right"><svg aria-hidden="true"><use href="#i-rotate-right"/></svg></button>
        <button type="button" tabindex="-1" data-action="delete" class="delete" title="Delete"><svg aria-hidden="true"><use href="#i-trash"/></svg></button>
      </div>
    </div>
    <div class="caption">
      <span class="number"></span>
      <span class="origin"><i class="dot"></i><span></span></span>
    </div>`;
  for (const button of card.querySelectorAll(".page-actions button")) {
    button.setAttribute("aria-label", button.title);
  }
  const info = source.pages[page.index];
  // Until the preview is there: the size pdf-lib reported, turned by the page's own rotation.
  const turned = info.rotation % 180 !== 0;
  card._size = turned ? [info.height, info.width] : [info.width, info.height];
  card._angle = page.rotation;
  card._page = page;
  card.querySelector(".dot").style.setProperty("--dot", source.color);
  card.querySelector(".origin span").textContent = `${source.name} · p. ${page.index + 1}`;
  card.querySelector(".origin").title = `${source.name}, page ${page.index + 1}`;
  layoutPaper(card, false);
  previewObserver.observe(card);
  return card;
}

function updateCard(card, page, number) {
  const source = state.sources.get(page.sourceId);
  card._page = page;
  card.querySelector(".number").textContent = number;
  const badge = card.querySelector(".rotation-badge");
  badge.hidden = page.rotation === 0;
  badge.textContent = `↻ ${page.rotation}°`;
  card.setAttribute("aria-selected", String(state.selection.has(page.id)));
  card.tabIndex = page.id === state.focusId ? 0 : -1;
  card.setAttribute(
    "aria-label",
    `Page ${number}: ${source.name}, page ${page.index + 1}${page.rotation ? `, rotated ${page.rotation}°` : ""}`,
  );
  // Turn the shortest way, so 270° → 0° animates as a quarter turn and not three back.
  const current = normalizeRotation(card._angle);
  if (current !== page.rotation) {
    let diff = page.rotation - current;
    if (diff > 180) diff -= 360;
    if (diff < -180) diff += 360;
    card._angle += diff;
    layoutPaper(card, true);
  }
}

/**
 * Sizes the paper in % of the square thumbnail box. Scaled by its longer side, the page fits the
 * square in every rotation, so rotating only needs a CSS transform.
 */
function layoutPaper(card, animate) {
  const paper = card.querySelector(".paper");
  const [width, height] = card._size;
  const longest = Math.max(width, height);
  if (!animate) paper.style.transition = "none";
  paper.style.width = `${(width / longest) * 100}%`;
  paper.style.height = `${(height / longest) * 100}%`;
  paper.style.transform = `rotate(${card._angle}deg)`;
  if (!animate) {
    paper.getBoundingClientRect();
    paper.style.transition = "";
  }
}

async function loadPreview(card) {
  const page = card._page;
  const source = state.sources.get(page.sourceId);
  if (!source) return;
  const url = await previews.get(page.sourceId, page.index, source.pdf);
  if (!card.isConnected && !cards.has(page.id)) return;
  const paper = card.querySelector(".paper");
  if (!url) {
    paper.classList.add("failed");
    return;
  }
  const img = paper.querySelector("img");
  img.addEventListener(
    "load",
    () => {
      card._size = [img.naturalWidth, img.naturalHeight];
      layoutPaper(card, false);
      img.classList.add("loaded");
      paper.classList.add("ready");
    },
    { once: true },
  );
  img.src = url;
}

function updateBars() {
  const list = pages();
  const usedSources = new Set(list.map((page) => page.sourceId));
  ui.undo.disabled = !state.history.canUndo;
  ui.redo.disabled = !state.history.canRedo;
  ui.download.disabled = list.length === 0;
  const selected = state.selection.size;
  ui.selectionActions.hidden = selected === 0;
  ui.summary.hidden = selected > 0;
  ui.selectionCount.textContent = `${selected} selected`;
  ui.summary.innerHTML = "";
  const strong = document.createElement("strong");
  strong.textContent = plural(list.length, "page");
  ui.summary.append(strong, usedSources.size > 1 ? ` from ${usedSources.size} files` : "");
  document.title = list.length ? `${state.dirty ? "• " : ""}PDF Studio (${plural(list.length, "page")})` : "PDF Studio";
}

// ---------------------------------------------------------------------------------------------
// Changes

function commit(next, options = {}) {
  if (!state.history.push(next)) return false;
  state.dirty = true;
  render(options);
  return true;
}

/** The pages an action applies to: the selection, or the given/focused page if it is not selected. */
function targets(id = state.focusId) {
  if (id && !state.selection.has(id)) return [id];
  return pages().filter((page) => state.selection.has(page.id)).map((page) => page.id);
}

function rotatePages(ids, degrees) {
  if (ids.length === 0) return;
  commit(rotate(pages(), ids, degrees));
  announce(`Rotated ${plural(ids.length, "page")} ${degrees > 0 ? "right" : "left"}.`);
}

function deletePages(ids) {
  if (ids.length === 0) return;
  const first = Math.min(...ids.map(indexOf));
  const next = remove(pages(), ids);
  commit(next);
  state.focusId = next[Math.min(first, next.length - 1)]?.id ?? null;
  render({ animate: false });
  focusCard(state.focusId);
  toast(`Deleted ${plural(ids.length, "page")}.`, { action: { label: "Undo", run: undo } });
}

function movePages(ids, to) {
  if (ids.length === 0) return;
  if (commit(move(pages(), ids, to))) {
    const position = indexOf(ids[0]) + 1;
    announce(`Moved ${plural(ids.length, "page")} to position ${position}.`);
  }
}

function undo() {
  if (state.history.undo()) {
    state.dirty = true;
    render();
    announce("Undone.");
  }
}

function redo() {
  if (state.history.redo()) {
    state.dirty = true;
    render();
    announce("Redone.");
  }
}

// ---------------------------------------------------------------------------------------------
// Selection and focus

function setSelection(ids, anchor = state.anchor) {
  state.selection = new Set(ids);
  state.anchor = anchor;
  for (const [id, card] of cards) card.setAttribute("aria-selected", String(state.selection.has(id)));
  updateBars();
}

function selectRange(fromId, toId) {
  const a = indexOf(fromId);
  const b = indexOf(toId);
  if (a < 0 || b < 0) return setSelection([toId], toId);
  const [start, end] = a < b ? [a, b] : [b, a];
  setSelection(pages().slice(start, end + 1).map((page) => page.id), fromId);
}

function toggle(id) {
  const next = new Set(state.selection);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  setSelection(next, id);
}

function focusCard(id, { scroll = true } = {}) {
  if (!id) return;
  state.focusId = id;
  for (const [cardId, card] of cards) card.tabIndex = cardId === id ? 0 : -1;
  const card = cards.get(id);
  card?.focus({ preventScroll: true });
  if (scroll) card?.scrollIntoView({ block: "nearest", behavior: reducedMotion.matches ? "auto" : "smooth" });
}

function columns() {
  const children = [...ui.pages.children];
  if (children.length === 0) return 1;
  const top = children[0].offsetTop;
  const count = children.findIndex((child) => child.offsetTop !== top);
  return count === -1 ? children.length : count;
}

// ---------------------------------------------------------------------------------------------
// Pointer: click to select, drag to reorder (long press on touch screens)

ui.pages.addEventListener("pointerdown", (event) => {
  const card = event.target.closest(".page");
  if (!card || event.target.closest(".page-actions") || event.button !== 0 || state.drag) return;
  state.press = {
    id: card.dataset.id,
    x: event.clientX,
    y: event.clientY,
    touch: event.pointerType !== "mouse",
    timer: null,
  };
  if (state.press.touch) {
    const press = state.press;
    press.timer = setTimeout(() => {
      if (state.press === press) startDrag(press, press.x, press.y);
    }, LONG_PRESS_MS);
  }
});

document.addEventListener("pointermove", (event) => {
  const press = state.press;
  if (state.drag) {
    updateDrag(event.clientX, event.clientY);
    return;
  }
  if (!press) return;
  const moved = Math.hypot(event.clientX - press.x, event.clientY - press.y) > DRAG_THRESHOLD;
  if (!moved) return;
  if (press.touch) {
    clearTimeout(press.timer); // the finger is scrolling
    state.press = null;
  } else {
    startDrag(press, event.clientX, event.clientY);
  }
});

document.addEventListener("pointerup", (event) => {
  const press = state.press;
  state.press = null;
  if (press) clearTimeout(press.timer);
  if (state.drag) {
    finishDrag(true);
    return;
  }
  if (press) handleClick(press.id, event, press.touch);
});

document.addEventListener("pointercancel", () => {
  if (state.press) clearTimeout(state.press.timer);
  state.press = null;
  if (state.drag) finishDrag(false);
});

// While dragging on a touch screen, the finger must not scroll the page.
document.addEventListener(
  "touchmove",
  (event) => {
    if (state.drag) event.preventDefault();
  },
  { passive: false },
);
ui.pages.addEventListener("contextmenu", (event) => {
  if (event.target.closest(".page") && (state.drag || state.press?.touch)) event.preventDefault();
});

function handleClick(id, event, touch) {
  if (touch) {
    toggle(id);
  } else if (event.shiftKey && state.anchor) {
    selectRange(state.anchor, id);
  } else if (event.ctrlKey || event.metaKey) {
    toggle(id);
  } else if (!(state.selection.size === 1 && state.selection.has(id))) {
    setSelection([id], id);
  }
  focusCard(id, { scroll: false });
}

ui.main.addEventListener("click", (event) => {
  if (state.justDragged) return;
  if (!event.target.closest(".page") && !event.target.closest(".empty") && state.selection.size) setSelection([]);
});

ui.pages.addEventListener("click", (event) => {
  const button = event.target.closest(".page-actions button");
  if (!button) return;
  event.stopPropagation();
  const id = button.closest(".page").dataset.id;
  const ids = targets(id);
  const action = button.dataset.action;
  if (action === "rotate-left") rotatePages(ids, -90);
  if (action === "rotate-right") rotatePages(ids, 90);
  if (action === "delete") deletePages(ids);
});

function startDrag(press, x, y) {
  if (!state.selection.has(press.id)) setSelection([press.id], press.id);
  const ids = targets(press.id);
  const gap = parseFloat(getComputedStyle(ui.pages).columnGap) || 16;
  const marker = document.createElement("div");
  marker.className = "drop-marker";
  marker.setAttribute("aria-hidden", "true");
  marker.hidden = true;
  ui.pages.append(marker);

  const ghost = document.createElement("div");
  ghost.className = "drag-ghost";
  const firstImg = cards.get(ids[0])?.querySelector("img.loaded");
  ghost.innerHTML = `<div class="ghost-card">${firstImg ? `<img src="${firstImg.src}" alt="">` : ""}</div>`;
  if (ids.length > 1) {
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = ids.length;
    ghost.append(count);
  }
  document.body.append(ghost);

  for (const id of ids) cards.get(id)?.classList.add("is-dragging");
  document.body.classList.add("dragging");
  if (press.touch) navigator.vibrate?.(12);
  state.drag = { ids, marker, ghost, gap, target: null, x, y, scrollSpeed: 0, frame: 0 };
  updateDrag(x, y);
}

function updateDrag(x, y) {
  const drag = state.drag;
  drag.x = x;
  drag.y = y;
  drag.ghost.style.transform = `translate(${x + 14}px, ${y + 10}px)`;

  // The card nearest to the pointer, preferring the row the pointer is in.
  const ordered = pages().map((page) => cards.get(page.id)).filter(Boolean);
  let best = null;
  ordered.forEach((card, index) => {
    const rect = card.getBoundingClientRect();
    const dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
    const dx = Math.abs(x - (rect.left + rect.width / 2));
    const score = dy * 10000 + dx;
    if (!best || score < best.score) best = { score, rect, index, card };
  });
  if (!best) return;
  const after = x > best.rect.left + best.rect.width / 2;
  drag.target = best.index + (after ? 1 : 0);

  const host = ui.pages.getBoundingClientRect();
  const left = after ? best.rect.right + drag.gap / 2 : best.rect.left - drag.gap / 2;
  drag.marker.hidden = false;
  drag.marker.style.left = `${left - host.left - 2}px`;
  drag.marker.style.top = `${best.rect.top - host.top}px`;
  drag.marker.style.height = `${best.rect.height}px`;

  // Scroll when the pointer is near the top (below the bars) or bottom edge.
  const topEdge = ui.contextbar.getBoundingClientRect().bottom;
  const zone = 70;
  let speed = 0;
  if (y < topEdge + zone) speed = -Math.ceil(((topEdge + zone - y) / zone) * 18);
  else if (y > innerHeight - zone) speed = Math.ceil(((y - (innerHeight - zone)) / zone) * 18);
  drag.scrollSpeed = speed;
  if (speed && !drag.frame) {
    const step = () => {
      if (!state.drag || !state.drag.scrollSpeed) {
        if (state.drag) state.drag.frame = 0;
        return;
      }
      scrollBy(0, state.drag.scrollSpeed);
      updateDrag(state.drag.x, state.drag.y);
      state.drag.frame = requestAnimationFrame(step);
    };
    drag.frame = requestAnimationFrame(step);
  }
}

function finishDrag(apply) {
  const drag = state.drag;
  state.drag = null;
  cancelAnimationFrame(drag.frame);
  drag.marker.remove();
  drag.ghost.remove();
  document.body.classList.remove("dragging");
  for (const id of drag.ids) cards.get(id)?.classList.remove("is-dragging");
  if (apply && drag.target !== null) movePages(drag.ids, drag.target);
  // The click that follows pointerup must not count as a click on the empty grid.
  state.justDragged = true;
  setTimeout(() => (state.justDragged = false), 0);
  focusCard(drag.ids[0], { scroll: false });
}

// ---------------------------------------------------------------------------------------------
// Keyboard

document.addEventListener("keydown", (event) => {
  if (ui.shortcuts.open) return;
  const mod = event.ctrlKey || event.metaKey;
  const key = event.key;
  const inField = event.target.closest?.("input, textarea, select");

  if (mod && key.toLowerCase() === "z") {
    event.preventDefault();
    if (event.shiftKey) redo();
    else undo();
    return;
  }
  if (mod && key.toLowerCase() === "y") {
    event.preventDefault();
    redo();
    return;
  }
  if (mod && key.toLowerCase() === "o") {
    event.preventDefault();
    ui.fileInput.click();
    return;
  }
  if (mod && key.toLowerCase() === "s") {
    event.preventDefault();
    download();
    return;
  }
  if (key === "Escape") {
    if (state.drag) finishDrag(false);
    else if (state.selection.size) setSelection([]);
    return;
  }
  if (inField || pages().length === 0) return;
  if (key === "?") {
    ui.shortcuts.showModal();
    return;
  }

  const inGrid = ui.pages.contains(document.activeElement) || document.activeElement === document.body;
  if (!inGrid) return;
  const list = pages();
  const focus = indexOf(state.focusId);

  if (mod && key.toLowerCase() === "a") {
    event.preventDefault();
    setSelection(list.map((page) => page.id), list[0].id);
    return;
  }
  if (key === "Delete" || key === "Backspace") {
    event.preventDefault();
    deletePages(targets());
    return;
  }
  if (key.toLowerCase() === "r" && !mod) {
    event.preventDefault();
    rotatePages(targets(), event.shiftKey ? -90 : 90);
    return;
  }
  if (key === " " || key === "Enter") {
    event.preventDefault();
    if (state.focusId) toggle(state.focusId);
    return;
  }

  const steps = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns(), ArrowDown: columns() };
  if (!(key in steps) && key !== "Home" && key !== "End") return;
  event.preventDefault();

  if (mod || event.altKey) {
    // Move the selection (or the focused page).
    const ids = targets();
    const positions = ids.map(indexOf);
    const first = Math.min(...positions);
    const last = Math.max(...positions);
    let to;
    if (key === "Home") to = 0;
    else if (key === "End") to = list.length;
    else if (steps[key] < 0) to = Math.max(0, first + steps[key]);
    else to = Math.min(list.length, last + 1 + steps[key]);
    movePages(ids, to);
    focusCard(state.focusId);
    return;
  }

  let next = focus;
  if (key === "Home") next = 0;
  else if (key === "End") next = list.length - 1;
  else next = Math.max(0, Math.min(list.length - 1, focus + steps[key]));
  const id = list[next].id;
  if (event.shiftKey) selectRange(state.anchor ?? state.focusId, id);
  focusCard(id);
});

// ---------------------------------------------------------------------------------------------
// Files in

async function addFiles(files) {
  const pdfs = [...files];
  if (pdfs.length === 0) return;
  let addedPages = 0;
  const addedNames = [];
  for (const file of pdfs) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!looksLikePdf(bytes)) throw Object.assign(new Error("not a PDF"), { code: "not-pdf" });
      const sourceId = `s${state.nextSource++}`;
      const copy = bytes.slice();
      const { pages: info } = await worker.call("add", { sourceId, bytes: copy }, [copy.buffer]);
      const pdf = openPreviewDocument(bytes);
      pdf.catch(() => {}); // a preview failure shows "No preview" on the card
      state.sources.set(sourceId, {
        name: file.name,
        color: SOURCE_COLORS[state.sources.size % SOURCE_COLORS.length],
        pages: info,
        pdf,
      });
      const added = pagesOf(sourceId, info.length);
      commit(insert(pages(), added), { added: new Set(added.map((page) => page.id)) });
      addedPages += added.length;
      addedNames.push(file.name);
    } catch (error) {
      toast(fileError(file.name, error), { error: true, duration: 9000 });
    }
  }
  if (addedNames.length > 0) {
    const what = addedNames.length === 1 ? `“${addedNames[0]}”` : `${addedNames.length} files`;
    toast(`Added ${what} (${plural(addedPages, "page")}).`);
  }
}

function looksLikePdf(bytes) {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  return head.includes("%PDF-");
}

function fileError(name, error) {
  if (error.code === "not-pdf") return `“${name}” is not a PDF file.`;
  if (error.code === "encrypted") {
    return `“${name}” is protected with a password or permissions. Remove the protection, then add it again.`;
  }
  return `“${name}” could not be opened. It may be damaged.`;
}

ui.add.addEventListener("click", () => ui.fileInput.click());
ui.choose.addEventListener("click", () => ui.fileInput.click());
ui.fileInput.addEventListener("change", () => {
  addFiles(ui.fileInput.files);
  ui.fileInput.value = "";
});

// Files dragged in from the desktop. (Reordering pages uses pointer events, not this.)
let fileDragDepth = 0;
const carriesFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes("Files");
addEventListener("dragenter", (event) => {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  fileDragDepth++;
  document.body.classList.add("file-over");
});
addEventListener("dragover", (event) => {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
});
addEventListener("dragleave", (event) => {
  if (!carriesFiles(event)) return;
  fileDragDepth = Math.max(0, fileDragDepth - 1);
  if (fileDragDepth === 0) document.body.classList.remove("file-over");
});
addEventListener("drop", (event) => {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  fileDragDepth = 0;
  document.body.classList.remove("file-over");
  addFiles(event.dataTransfer.files);
});

// PDFs opened with the installed app ("Open with PDF Studio", see file_handlers in the manifest).
if ("launchQueue" in window) {
  window.launchQueue.setConsumer(async ({ files }) => {
    if (files?.length) addFiles(await Promise.all(files.map((handle) => handle.getFile())));
  });
}

// ---------------------------------------------------------------------------------------------
// File out

let saving = false;

async function download() {
  const list = pages();
  if (list.length === 0 || saving) return;
  saving = true;
  ui.download.classList.add("busy");
  const label = ui.download.querySelector(".label");
  label.textContent = "Saving…";
  try {
    const { bytes } = await worker.call("export", {
      pages: list.map(({ sourceId, index, rotation }) => ({ sourceId, index, rotation })),
    });
    const name = outputName(list);
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    state.dirty = false;
    updateBars();
    toast(`Saved “${name}” (${plural(list.length, "page")}, ${formatSize(bytes.byteLength)}).`);
  } catch (error) {
    toast(`Saving failed: ${error.message}`, { error: true, duration: 9000 });
  } finally {
    saving = false;
    ui.download.classList.remove("busy");
    label.textContent = "Download";
  }
}

/** Named after the first uploaded file that still has pages in the result. */
function outputName(list) {
  const inResult = new Set(list.map((page) => page.sourceId));
  const used = [...state.sources.keys()].filter((id) => inResult.has(id));
  const base = state.sources.get(used[0]).name.replace(/\.pdf$/i, "");
  return used.length === 1 ? `${base}-edited.pdf` : `${base}-merged.pdf`;
}

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

ui.download.addEventListener("click", download);

// ---------------------------------------------------------------------------------------------
// Toolbar, start over, thumbnail size

ui.undo.addEventListener("click", undo);
ui.redo.addEventListener("click", redo);
ui.help.addEventListener("click", () => ui.shortcuts.showModal());
$("sel-rotate-left").addEventListener("click", () => rotatePages(targets(null), -90));
$("sel-rotate-right").addEventListener("click", () => rotatePages(targets(null), 90));
$("sel-delete").addEventListener("click", () => deletePages(targets(null)));
$("sel-clear").addEventListener("click", () => setSelection([]));

ui.clearAll.addEventListener("click", async () => {
  if (state.dirty && !confirm("Start over? Your changes have not been downloaded and will be lost.")) return;
  for (const source of state.sources.values()) source.pdf.then((pdf) => pdf.destroy(), () => {});
  state.sources.clear();
  state.history.reset([]);
  state.selection.clear();
  state.focusId = null;
  state.anchor = null;
  state.dirty = false;
  previews.clear();
  for (const card of cards.values()) previewObserver.unobserve(card);
  cards.clear();
  ui.pages.replaceChildren();
  render({ animate: false });
  worker.call("reset");
});

const SIZE_KEY = "pdf-studio:thumb-size";
function applyThumbSize(value) {
  document.documentElement.style.setProperty("--thumb", `${value}px`);
}
try {
  const saved = localStorage.getItem(SIZE_KEY);
  if (saved) ui.thumbSize.value = saved;
} catch {}
applyThumbSize(ui.thumbSize.value);
ui.thumbSize.addEventListener("input", () => {
  applyThumbSize(ui.thumbSize.value);
  try {
    localStorage.setItem(SIZE_KEY, ui.thumbSize.value);
  } catch {}
});

addEventListener("beforeunload", (event) => {
  if (state.dirty && pages().length > 0) {
    event.preventDefault();
    event.returnValue = "";
  }
});

// ---------------------------------------------------------------------------------------------
// Toasts and screen reader announcements

function toast(message, { action, error = false, duration = action ? 7000 : 4000 } = {}) {
  const item = document.createElement("div");
  item.className = `toast${error ? " error" : ""}`;
  const text = document.createElement("span");
  text.className = "message";
  text.textContent = message;
  item.append(text);
  const close = () => {
    if (!item.isConnected) return;
    item.classList.add("leaving");
    setTimeout(() => item.remove(), 170);
  };
  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = action.label;
    button.addEventListener("click", () => {
      action.run();
      close();
    });
    item.append(button);
  }
  ui.toasts.append(item);
  while (ui.toasts.children.length > 3) ui.toasts.firstElementChild.remove();
  let timer = setTimeout(close, duration);
  item.addEventListener("pointerenter", () => clearTimeout(timer));
  item.addEventListener("pointerleave", () => (timer = setTimeout(close, 2500)));
  return item;
}

function announce(message) {
  ui.announcer.textContent = "";
  requestAnimationFrame(() => (ui.announcer.textContent = message));
}

// ---------------------------------------------------------------------------------------------
// Offline: service worker

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) location.reload();
  });
  const offerUpdate = (registration) => {
    toast("A new version of PDF Studio is available.", {
      duration: 30_000,
      action: {
        label: "Reload",
        run: () => {
          if (state.dirty && pages().length && !confirm("Reload now? Your changes have not been downloaded.")) return;
          reloading = true;
          state.dirty = false;
          registration.waiting?.postMessage("skip-waiting");
        },
      },
    });
  };
  navigator.serviceWorker
    .register("./sw.js")
    .then((registration) => {
      if (registration.waiting && navigator.serviceWorker.controller) offerUpdate(registration);
      registration.addEventListener("updatefound", () => {
        const installing = registration.installing;
        installing?.addEventListener("statechange", () => {
          if (installing.state !== "installed") return;
          if (navigator.serviceWorker.controller) offerUpdate(registration);
          else toast("PDF Studio now works offline.");
        });
      });
    })
    .catch(() => {});
}

render({ animate: false });
// For the browser test and debugging; not used by the app itself.
window.pdfStudio = { state, pages };
