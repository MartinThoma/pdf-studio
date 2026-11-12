// The editor: page grid, selection, drag and drop, keyboard, undo, upload and download.

import { CATEGORIES, HIGHLIGHT_COLORS, categoryOf, colorOf, countPrivate, placeholders, privacyReport, textInRect } from "./annotations.js";
import {
  History, addMark, editText, erase, insert, move, newMarkId, normalizeRotation, pagesOf, remove, removeMark, rotate, updateMark,
} from "./model.js";
import { setupInstall } from "./install.js";
import { describeVersion, setupUpdates } from "./update.js";
import { VERSION } from "./version.js";
import { PreviewRenderer, drawPage, openPreviewDocument, pageText } from "./thumbnails.js";
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
  privacyList: $("privacy-list"),
  details: $("details"),
  filmstrip: $("filmstrip"),
  stage: $("stage"),
  stageWrap: $("stage-wrap"),
  pageInput: $("d-page"),
  pageCount: $("d-count"),
  pageMenu: $("page-menu"),
  pickPanel: $("pick-panel"),
  pickWhat: $("pick-what"),
  pickTextRow: $("pick-text-row"),
  pickText: $("pick-text"),
  pickMark: $("pick-mark"),
  pickSource: $("pick-source"),
  pickSourceText: $("pick-source-text"),
  devOptions: $("dev-options"),
  markItems: $("mark-items"),
  markNone: $("mark-none"),
  category: $("private-category"),
  toolHint: $("tool-hint"),
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
  view: "arrange", // "arrange" | "details"
  detailId: null, // the page shown in the details view
  tool: "select", // "select" | "highlight" | "private"
  highlightColor: HIGHLIGHT_COLORS[0].id, // for the next highlight
  picked: null,
  developer: false, // developer options (in the shortcuts dialog) // objects picked with the select tool: { pageId, ids }
  markId: null, // the mark picked in the details view
};
const cards = new Map(); // page id → <li>

const pages = () => state.history.present;
const indexOf = (id) => pages().findIndex((page) => page.id === id);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// ---------------------------------------------------------------------------------------------
// What to draw for a page: the uploaded file, or, once objects were deleted from the page, that
// page written anew by the worker. So the editor shows what the download will contain.

const edited = new Map(); // docKey → Promise<pdf.js document with that one page>
const EDITED_KEPT = 16;

const isEdited = (page) => Boolean(page.removed?.length || (page.edits && Object.keys(page.edits).length));
const docKey = (page) =>
  isEdited(page)
    ? `${page.sourceId}:${page.index}:${[...(page.removed ?? [])].sort().join(",")}:${JSON.stringify(Object.entries(page.edits ?? {}).sort())}`
    : `${page.sourceId}:${page.index}`;

function docFor(page) {
  const key = docKey(page);
  if (!isEdited(page)) return { key, pdf: state.sources.get(page.sourceId).pdf, index: page.index };
  let pdf = edited.get(key);
  edited.delete(key);
  if (!pdf) {
    pdf = worker
      .call("preview", { sourceId: page.sourceId, index: page.index, removed: page.removed, edits: page.edits })
      .then(({ bytes }) => openPreviewDocument(bytes));
    pdf.catch(() => {});
  }
  edited.set(key, pdf); // most recently used last
  while (edited.size > EDITED_KEPT) {
    const [oldKey, old] = edited.entries().next().value;
    edited.delete(oldKey);
    old.then((doc) => doc.destroy(), () => {});
  }
  return { key, pdf, index: 0 };
}

function previewOf(page) {
  const { key, pdf, index } = docFor(page);
  return isEdited(page) ? previews.get(key, index, pdf) : previews.get(page.sourceId, page.index, pdf);
}

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
  if (!hasPages) state.view = "arrange";
  document.body.dataset.view = state.view;
  ui.details.hidden = !(hasPages && state.view === "details");

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
  if (state.view === "details") renderDetails();
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
      <div class="paper"><img alt="" draggable="false"><div class="marks"></div></div>
      <div class="page-flags" aria-hidden="true"></div>
      <span class="check" aria-hidden="true"><svg><use href="#i-check"/></svg></span>
      <span class="rotation-badge" aria-hidden="true" hidden></span>
      <div class="page-actions">
        <button type="button" tabindex="-1" data-action="open" title="Open in Details view"><svg aria-hidden="true"><use href="#i-open"/></svg></button>
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
  if (card._marks !== page.marks || card._removed !== page.removed || card._edits !== page.edits) {
    card._marks = page.marks;
    card._removed = page.removed;
    card._edits = page.edits;
    renderMarks(card.querySelector(".marks"), page.marks);
    renderFlags(card.querySelector(".page-flags"), page.marks, (page.removed?.length ?? 0) + Object.keys(page.edits ?? {}).length);
  }
  // Objects were deleted or brought back: show the page as it is now.
  if (card._previewKey !== undefined && card._previewKey !== docKey(page)) loadPreview(card);
  card.querySelector(".number").textContent = number;
  const badge = card.querySelector(".rotation-badge");
  badge.hidden = page.rotation === 0;
  badge.textContent = `↻ ${page.rotation}°`;
  card.setAttribute("aria-selected", String(state.selection.has(page.id)));
  card.tabIndex = page.id === state.focusId ? 0 : -1;
  card.setAttribute(
    "aria-label",
    `Page ${number}: ${source.name}, page ${page.index + 1}${page.rotation ? `, rotated ${page.rotation}°` : ""}${markSummary(page.marks)}`,
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
  const key = docKey(page);
  card._previewKey = key;
  const url = await previewOf(page);
  if ((!card.isConnected && !cards.has(page.id)) || card._previewKey !== key) return;
  const paper = card.querySelector(".paper");
  paper.classList.toggle("failed", !url);
  if (!url) return;
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

// ---------------------------------------------------------------------------------------------
// Marks on thumbnails

const cssColor = (id) => `rgb(${colorOf(id).rgb.map((n) => Math.round(n * 255)).join(" ")})`;

/** A row of colour buttons; `current` is pressed, `choose(id)` is called on a click. */
function swatches(current, choose, label) {
  const group = document.createElement("div");
  group.className = "swatches";
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", label);
  for (const color of HIGHLIGHT_COLORS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "swatch";
    button.title = color.label;
    button.setAttribute("aria-label", color.label);
    button.setAttribute("aria-pressed", String(color.id === colorOf(current).id));
    button.dataset.color = color.id;
    button.style.setProperty("--mark", cssColor(color.id));
    button.addEventListener("click", () => choose(color.id));
    group.append(button);
  }
  return group;
}

function renderMarks(container, marks = [], currentId = null, withDelete = false) {
  const current = withDelete ? marks.find((mark) => mark.id === currentId) : null;
  const extras = [];
  if (current) {
    // A delete button at the top right corner of the picked mark.
    const [, v0, u1] = current.rects[0];
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mark-delete";
    button.dataset.mark = current.id;
    button.title = "Remove this mark (Del)";
    button.setAttribute("aria-label", "Remove this mark");
    button.innerHTML = '<svg aria-hidden="true"><use href="#i-close"/></svg>';
    button.style.cssText = `left:${u1 * 100}%;top:${v0 * 100}%`;
    extras.push(button);
  }
  container.replaceChildren(
    ...marks.flatMap((mark) =>
      mark.rects.map(([u0, v0, u1, v1]) => {
        const box = document.createElement("div");
        box.className = `mark ${mark.kind}${mark.id === currentId ? " is-current" : ""}`;
        if (mark.kind === "highlight") box.style.setProperty("--mark", cssColor(mark.color));
        box.dataset.mark = mark.id;
        box.style.cssText = `left:${u0 * 100}%;top:${v0 * 100}%;width:${(u1 - u0) * 100}%;height:${(v1 - v0) * 100}%`;
        return box;
      }),
    ),
    ...extras,
  );
}

function countMarks(marks = []) {
  const privateCount = marks.filter((mark) => mark.kind === "private").length;
  return { privateCount, highlightCount: marks.length - privateCount };
}

function markSummary(marks) {
  const { privateCount, highlightCount } = countMarks(marks);
  const parts = [];
  if (privateCount) parts.push(`${plural(privateCount, "private mark")}`);
  if (highlightCount) parts.push(`${plural(highlightCount, "highlight")}`);
  return parts.length ? `, ${parts.join(", ")}` : "";
}

function renderFlags(container, marks, changed = 0) {
  const { privateCount, highlightCount } = countMarks(marks);
  container.replaceChildren();
  const add = (count, className, icon, label) => {
    if (!count) return;
    const flag = document.createElement("span");
    flag.className = className;
    flag.title = `${plural(count, label)}`;
    flag.innerHTML = `<svg><use href="#${icon}"/></svg>${count}`;
    container.append(flag);
  };
  add(highlightCount, "hl", "i-highlight", "highlight");
  add(privateCount, "pv", "i-shield", "private mark");
  add(changed, "rm", "i-select", "changed or deleted object");
}

function updateBars() {
  const list = pages();
  const usedSources = new Set(list.map((page) => page.sourceId));
  ui.undo.disabled = !state.history.canUndo;
  ui.redo.disabled = !state.history.canRedo;
  ui.download.disabled = list.length === 0;
  const selected = state.selection.size;
  const inGridView = state.view === "arrange";
  ui.selectionActions.hidden = selected === 0 || !inGridView;
  ui.summary.hidden = selected > 0 && inGridView;
  const privateTotal = countPrivate(list);
  ui.privacyList.hidden = privateTotal === 0;
  $("view-arrange").setAttribute("aria-pressed", String(inGridView));
  $("view-details").setAttribute("aria-pressed", String(!inGridView));
  ui.selectionCount.textContent = `${selected} selected`;
  ui.summary.innerHTML = "";
  const strong = document.createElement("strong");
  strong.textContent = plural(list.length, "page");
  ui.summary.append(strong, usedSources.size > 1 ? ` from ${usedSources.size} files` : "");
  if (privateTotal) ui.summary.append(` · ${plural(privateTotal, "private mark")}`);
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
  if (action === "open") showDetails(id);
});

ui.pages.addEventListener("dblclick", (event) => {
  const card = event.target.closest(".page");
  if (card && !event.target.closest(".page-actions")) showDetails(card.dataset.id);
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
  if (document.querySelector("dialog[open]")) return;
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
    else if (state.view === "details" && !ui.pageMenu.hidden) closePageMenu();
    else if (state.view === "details" && state.tool !== "select") setTool("select");
    else if (state.view === "details" && state.picked) pick(null);
    else if (state.selection.size) setSelection([]);
    return;
  }
  if (inField || pages().length === 0) return;
  if (key === "?") {
    ui.shortcuts.showModal();
    return;
  }

  if (!mod && !event.altKey && key.toLowerCase() === "d" && state.view === "arrange") {
    event.preventDefault();
    showDetails(state.focusId);
    return;
  }
  if (!mod && !event.altKey && key.toLowerCase() === "g" && state.view === "details") {
    event.preventDefault();
    showArrange();
    return;
  }
  if (state.view === "details") {
    detailKey(event);
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
      pages: list.map(({ sourceId, index, rotation, marks, removed, edits }) => ({ sourceId, index, rotation, marks, removed, edits })),
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

ui.privacyList.addEventListener("click", () => {
  const list = pages();
  if (countPrivate(list) === 0) return;
  const report = privacyReport(
    list,
    (page) => {
      const info = state.sources.get(page.sourceId).pages[page.index];
      return { box: info.box, rotation: info.rotation };
    },
    { document: outputName(list) },
  );
  const name = outputName(list).replace(/\.pdf$/i, "-privacy.json");
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  toast(`Saved “${name}”. It contains the private texts in clear: keep it as safe as the PDF.`, { duration: 8000 });
});


// ---------------------------------------------------------------------------------------------
// Details view: one page large, with highlight and privacy marks

const detail = {
  sheets: new Map(), // page id → .stage-item
  sheetKey: "", // page ids that have a sheet
  observer: null, // draws the sheets near the viewport, releases the far ones
  scrollTo: null, // page to scroll to after the next render
  frame: 0,
  items: new Map(), // "sourceId:index" → Promise<text pieces>
  filmKey: "", // page ids in the filmstrip
  filmObserver: null,
  objects: new Map(), // "sourceId:index" → objects found on that page
  objectPromises: new Map(),
  paint: 0,
};

for (const category of CATEGORIES) {
  ui.category.append(new Option(category.label, category.id));
}
ui.category.value = "name";

function showDetails(id = state.focusId) {
  if (pages().length === 0) return;
  state.view = "details";
  state.detailId = pages().some((page) => page.id === id) ? id : pages()[0].id;
  state.focusId = state.detailId;
  state.markId = null;
  detail.scrollTo = state.detailId;
  render({ animate: false });
  announce(`Details view, page ${indexOf(state.detailId) + 1} of ${pages().length}.`);
}

function showArrange() {
  if (state.view === "arrange") return;
  state.view = "arrange";
  setTool(null);
  state.focusId = state.detailId ?? state.focusId;
  render({ animate: false });
  focusCard(state.focusId);
}

/** Scrolls to a page of the details view. */
function goDetail(to) {
  const list = pages();
  const next = Math.max(0, Math.min(list.length - 1, to));
  const id = list[next].id;
  state.detailId = id;
  state.focusId = id;
  state.markId = null;
  detail.scrollTo = id;
  renderDetails();
}

function setTool(tool) {
  state.tool = !tool || state.tool === tool ? "select" : tool;
  for (const name of ["select", "highlight", "private"]) {
    $(`tool-${name}`).setAttribute("aria-pressed", String(state.tool === name));
  }
  ui.stage.classList.toggle("tooling", state.tool !== "select");
  // The options of a tool show while that tool is in use.
  $("highlight-colors").hidden = state.tool !== "highlight";
  $("category-control").hidden = state.tool !== "private";
  hideObjectHover();
  if (state.tool === "select") for (const item of detail.sheets.values()) if (item._visible && item._page) objectsOf(item._page);
  ui.toolHint.textContent =
    state.tool === "highlight"
      ? "Drag over text to highlight it."
      : state.tool === "private"
        ? "Drag over a name or other personal data to mark it as private."
        : "Click a text, an image or a mark to select it, then change or delete it on the right.";
}

function renderDetails() {
  const list = pages();
  if (list.length === 0) return;
  let index = indexOf(state.detailId);
  if (index < 0) {
    index = Math.min(list.length - 1, Math.max(0, detail.lastIndex ?? 0));
    state.detailId = list[index].id;
    state.focusId = state.detailId;
  }
  detail.lastIndex = index;
  const page = list[index];
  if (document.activeElement !== ui.pageInput) ui.pageInput.value = index + 1;
  ui.pageInput.max = list.length;
  ui.pageCount.textContent = list.length;
  // Picked objects that are gone (deleted, undone) are no longer picked.
  if (state.picked) {
    const pickedPage = list.find((p) => p.id === state.picked.pageId);
    const there = new Set(pickedPage ? deletable(pickedPage).map((object) => object.id) : []);
    const ids = state.picked.ids.filter((id) => there.has(id));
    state.picked = ids.length ? { pageId: state.picked.pageId, ids } : null;
  }
  renderSheets(list);
  renderPickPanel();
  renderMarkList(page);
  renderFilmstrip(list);
  if (detail.scrollTo) {
    const target = detail.sheets.get(detail.scrollTo);
    detail.scrollTo = null;
    target?.scrollIntoView({ block: "start", behavior: "instant" });
  }
}

/** One sheet per page, in a column; the page being read is the one in the middle of the screen. */
function renderSheets(list) {
  const key = list.map((page) => page.id).join(",");
  if (key !== detail.sheetKey) {
    detail.sheetKey = key;
    detail.observer?.disconnect();
    detail.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const item = entry.target;
          item._visible = entry.isIntersecting;
          if (entry.isIntersecting) drawSheet(item);
          else releaseSheet(item);
        }
      },
      { rootMargin: "1200px 0px" },
    );
    const old = detail.sheets;
    detail.sheets = new Map();
    for (const item of old.values()) if (!list.some((page) => page.id === item.dataset.id)) releaseSheet(item);
    ui.stage.replaceChildren(
      ...list.map((page) => {
        const item = old.get(page.id) ?? createSheet(page);
        detail.sheets.set(page.id, item);
        item._visible = false;
        detail.observer.observe(item);
        return item;
      }),
    );
  }
  for (const page of list) {
    const item = detail.sheets.get(page.id);
    item._page = page;
    layoutSheet(item, page);
    if (item._marks !== page.marks || item._current !== state.markId) {
      item._marks = page.marks;
      item._current = state.markId;
      renderMarks(item.querySelector(".marks"), page.marks, state.markId, true);
    }
    item.classList.toggle("is-current", page.id === state.detailId);
    const picks = state.picked?.pageId === page.id ? new Set(state.picked.ids) : null;
    item.querySelector(".picks").replaceChildren(
      ...(picks ? deletable(page).filter((object) => picks.has(object.id)) : []).map((object) => {
        const box = document.createElement("div");
        box.className = "pick";
        box.style.cssText = boxStyle(object.box);
        return box;
      }),
    );
  }
}

const boxStyle = ([u0, v0, u1, v1]) =>
  `left:${u0 * 100}%;top:${v0 * 100}%;width:${(u1 - u0) * 100}%;height:${(v1 - v0) * 100}%`;

function createSheet(page) {
  const item = document.createElement("div");
  item.className = "stage-item";
  item.dataset.id = page.id;
  item.innerHTML = '<div class="sheet"><canvas></canvas><div class="marks"></div><div class="picks"></div><div class="draft" hidden></div><div class="object-hover" hidden></div></div>';
  return item;
}

/** Sizes the page to the available width; the user's rotation is a CSS turn of the sheet. */
function layoutSheet(item, page) {
  const info = state.sources.get(page.sourceId).pages[page.index];
  const [w, h] = info.rotation % 180 ? [info.height, info.width] : [info.width, info.height];
  const turned = page.rotation % 180 !== 0;
  const [rw] = turned ? [h, w] : [w, h];
  const available = Math.max(200, ui.stageWrap.clientWidth - 32);
  const scale = Math.min(available / rw, 900 / rw, 2.4); // up to 2.4 × the page's size in points
  const baseW = w * scale;
  const baseH = h * scale;
  const [stageW, stageH] = turned ? [baseH, baseW] : [baseW, baseH];
  const sheet = item.querySelector(".sheet");
  item.style.width = `${stageW}px`;
  item.style.height = `${stageH}px`;
  sheet.style.width = `${baseW}px`;
  sheet.style.height = `${baseH}px`;
  sheet.style.left = `${(stageW - baseW) / 2}px`;
  sheet.style.top = `${(stageH - baseH) / 2}px`;
  sheet.style.transform = `rotate(${page.rotation}deg)`;
  sheet.dataset.angle = page.rotation;
  item._baseW = baseW;
  if (item._visible) drawSheet(item);
}

function drawSheet(item) {
  const page = item._page;
  const width = Math.round(item._baseW / 40);
  if (!page || (item._drawnKey === docKey(page) && item._drawnWidth === width)) return;
  item._drawing?.cancel();
  const { key, pdf, index } = docFor(page);
  item._drawnKey = key;
  item._drawnWidth = width;
  const drawing = drawPage(pdf, index, item.querySelector("canvas"), item._baseW);
  item._drawing = drawing;
  drawing.done.catch(() => {
    if (item._drawing === drawing) item._drawnKey = null;
  });
}

/** Frees the pixels of a sheet that is far from the screen. */
function releaseSheet(item) {
  item._drawing?.cancel();
  item._drawing = null;
  item._drawnKey = null;
  item._drawnWidth = null;
  const canvas = item.querySelector("canvas");
  canvas.width = canvas.height = 0;
}

/** The page in the reading zone (a bit below the sticky bars) becomes the current page. */
function updateCurrentFromScroll() {
  detail.frame = 0;
  if (state.view !== "details" || marking) return;
  const bars = ui.stageWrap.getBoundingClientRect().top;
  const line = Math.max(bars, 120) + (innerHeight - Math.max(bars, 120)) * 0.3;
  let best = null;
  for (const item of detail.sheets.values()) {
    const rect = item.getBoundingClientRect();
    const distance = line < rect.top ? rect.top - line : line > rect.bottom ? line - rect.bottom : 0;
    if (!best || distance < best.distance) best = { item, distance };
    if (distance === 0) break;
  }
  const id = best?.item.dataset.id;
  if (!id || id === state.detailId) return;
  state.detailId = id;
  state.focusId = id;
  state.markId = null;
  renderDetails();
}

addEventListener(
  "scroll",
  () => {
    if (state.view === "details" && !detail.frame) detail.frame = requestAnimationFrame(updateCurrentFromScroll);
  },
  { passive: true },
);

/** The marks of the page as a short list; a click selects a mark, which opens its editor above. */
function renderMarkList(page) {
  const marks = page.marks ?? [];
  ui.markNone.hidden = marks.length > 0;
  const names = placeholders(pages());
  ui.markItems.replaceChildren(
    ...marks.map((mark) => {
      const row = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = `mark-row ${mark.kind}${mark.id === state.markId ? " is-current" : ""}`;
      button.dataset.mark = mark.id;
      if (mark.kind === "highlight") button.style.setProperty("--mark", cssColor(mark.color));
      const kind = document.createElement("span");
      kind.className = "kind";
      kind.textContent = mark.kind === "private" ? (names.get(mark.id) ?? "Private") : "Highlight";
      const text = document.createElement("span");
      text.className = "text";
      text.textContent = mark.text || mark.comment || "(no text)";
      button.append(kind, text);
      if (mark.comment && mark.text) {
        const comment = document.createElement("span");
        comment.className = "comment";
        comment.textContent = mark.comment;
        button.append(comment);
      }
      button.addEventListener("click", () => pick({ pageId: page.id, ids: [`m:${mark.id}`] }));
      row.append(button);
      return row;
    }),
  );
}

/** The fields of one mark, shown on the right while that mark is selected. */
function markEditor(page, mark) {
  const editor = document.createElement("div");
  editor.className = `mark-edit ${mark.kind}`;
  const change = (changes) => commit(updateMark(pages(), page.id, mark.id, changes), { animate: false });
  const field = (labelText, control) => {
    const label = document.createElement("label");
    const caption = document.createElement("span");
    caption.textContent = labelText;
    label.append(caption, control);
    return label;
  };
  if (mark.kind === "highlight") {
    const row = document.createElement("div");
    row.className = "field";
    const caption = document.createElement("span");
    caption.textContent = "Colour";
    row.append(caption, swatches(mark.color, (color) => change({ color }), "Colour of this highlight"));
    editor.append(row);
  } else {
    const select = document.createElement("select");
    for (const category of CATEGORIES) select.append(new Option(category.label, category.id));
    select.value = categoryOf(mark.category).id;
    select.addEventListener("change", () => change({ category: select.value }));
    const token = document.createElement("span");
    token.className = "token";
    token.textContent = placeholders(pages()).get(mark.id) ?? "";
    token.title = "The placeholder pseudonymizing tools get for this text";
    const label = field("Category", select);
    label.append(token);
    editor.append(label);
  }
  const input = document.createElement("input");
  input.type = "text";
  input.value = mark.text;
  input.placeholder = "No text found: type it here";
  input.addEventListener("change", () => change({ text: input.value.trim() }));
  input.dataset.field = "text";
  const comment = document.createElement("input");
  comment.type = "text";
  comment.value = mark.comment ?? "";
  comment.placeholder = "Add a comment";
  comment.addEventListener("change", () => change({ comment: comment.value.trim() }));
  comment.dataset.field = "comment";
  editor.append(field("Text under the mark", input), field("Comment", comment));
  return editor;
}

function deleteMark(pageId, markId) {
  commit(removeMark(pages(), pageId, markId), { animate: false });
  if (state.markId === markId) state.markId = null;
  renderDetails();
  toast("Removed the mark.", { action: { label: "Undo", run: undo } });
}

function loadFilm(item, page) {
  const key = docKey(page);
  item._previewKey = key;
  previewOf(page).then((url) => {
    if (url && item._previewKey === key) item.querySelector("img").src = url;
  });
}

function renderFilmstrip(list) {
  const key = list.map((page) => page.id).join(",");
  if (key !== detail.filmKey) {
    detail.filmKey = key;
    detail.filmObserver?.disconnect();
    detail.filmObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          detail.filmObserver.unobserve(entry.target);
          const item = entry.target;
          const page = pages().find((p) => p.id === item.dataset.id);
          const source = page && state.sources.get(page.sourceId);
          if (!source) continue;
          loadFilm(item, page);
        }
      },
      { root: ui.filmstrip, rootMargin: "300px 0px" },
    );
    ui.filmstrip.replaceChildren(
      ...list.map((page, i) => {
        const item = document.createElement("div");
        item.className = "film-item";
        item.dataset.id = page.id;
        item.tabIndex = 0;
        item.setAttribute("role", "button");
        item.innerHTML =
          '<span class="film-thumb"><span class="film-paper"><img alt="" draggable="false"></span></span><span class="n"></span>' +
          '<button type="button" class="film-delete" tabindex="-1" title="Delete this page"><svg aria-hidden="true"><use href="#i-trash"/></svg></button>';
        item.querySelector(".n").textContent = i + 1;
        item.setAttribute("aria-label", `Page ${i + 1}. Drag to move it, right-click for more.`);
        item.querySelector(".film-delete").setAttribute("aria-label", `Delete page ${i + 1}`);
        detail.filmObserver.observe(item);
        return item;
      }),
    );
  }
  const items = ui.filmstrip.querySelectorAll(".film-item");
  list.forEach((page, i) => {
    const item = items[i];
    if (!item) return;
    const info = state.sources.get(page.sourceId).pages[page.index];
    const [w, h] = info.rotation % 180 ? [info.height, info.width] : [info.width, info.height];
    const longest = Math.max(w, h);
    const paper = item.querySelector(".film-paper");
    paper.style.width = `${(w / longest) * 72}px`;
    paper.style.height = `${(h / longest) * 72}px`;
    paper.style.transform = `rotate(${page.rotation}deg)`;
    if (item._previewKey !== undefined && item._previewKey !== docKey(page)) loadFilm(item, page);
    const { privateCount, highlightCount } = countMarks(page.marks);
    item.querySelectorAll(".dotmark").forEach((dot) => dot.remove());
    const thumb = item.querySelector(".film-thumb");
    if (privateCount) thumb.insertAdjacentHTML("beforeend", '<i class="dotmark"></i>');
    if (highlightCount) thumb.insertAdjacentHTML("beforeend", '<i class="dotmark hl"></i>');
    const current = page.id === state.detailId;
    if (current) {
      item.setAttribute("aria-current", "page");
      if (detail.scrolledTo !== page.id) item.scrollIntoView({ block: "nearest" });
    } else item.removeAttribute("aria-current");
  });
  detail.scrolledTo = state.detailId;
}

// Page operations live in the strip: click to go there, drag to move the page, the bin or a
// right-click to delete, right-click to rotate.

/** Rotating changes the height of a page, so keep the page being read in view. */
function rotateInDetails(id, degrees) {
  detail.scrollTo = state.detailId;
  rotatePages([id], degrees);
}

function deleteInDetails(id) {
  const index = indexOf(id);
  if (index < 0) return;
  const wasCurrent = id === state.detailId;
  const current = state.detailId;
  deletePages([id]);
  const list = pages();
  if (list.length === 0) return;
  state.detailId = wasCurrent ? list[Math.min(index, list.length - 1)].id : current;
  state.focusId = state.detailId;
  detail.scrollTo = state.detailId;
  renderDetails();
}

let filmDrag = null; // { id, y, active, marker, target }

ui.filmstrip.addEventListener("pointerdown", (event) => {
  const item = event.target.closest(".film-item");
  if (!item || event.button !== 0 || event.pointerType !== "mouse" || event.target.closest(".film-delete")) return;
  filmDrag = { id: item.dataset.id, y: event.clientY, active: false, marker: null, target: null };
});

document.addEventListener("pointermove", (event) => {
  if (!filmDrag) return;
  if (!filmDrag.active) {
    if (Math.abs(event.clientY - filmDrag.y) < DRAG_THRESHOLD) return;
    filmDrag.active = true;
    filmDrag.marker = document.createElement("div");
    filmDrag.marker.className = "film-marker";
    ui.filmstrip.append(filmDrag.marker);
    ui.filmstrip.querySelector(`.film-item[data-id="${filmDrag.id}"]`)?.classList.add("is-dragging");
    document.body.classList.add("dragging");
  }
  const strip = ui.filmstrip.getBoundingClientRect();
  if (event.clientY < strip.top + 36) ui.filmstrip.scrollTop -= 14;
  if (event.clientY > strip.bottom - 36) ui.filmstrip.scrollTop += 14;
  const items = [...ui.filmstrip.querySelectorAll(".film-item")];
  let target = items.length;
  for (let i = 0; i < items.length; i++) {
    const rect = items[i].getBoundingClientRect();
    if (event.clientY < rect.top + rect.height / 2) {
      target = i;
      break;
    }
  }
  filmDrag.target = target;
  const before = items[target];
  const last = items[items.length - 1];
  filmDrag.marker.style.top = `${(before ? before.offsetTop : last.offsetTop + last.offsetHeight) - 6}px`;
});

function endFilmDrag(apply) {
  const drag = filmDrag;
  filmDrag = null;
  if (!drag?.active) return;
  drag.marker.remove();
  document.body.classList.remove("dragging");
  ui.filmstrip.querySelector(".is-dragging")?.classList.remove("is-dragging");
  detail.filmDragged = true; // the click that follows is not a click on the page
  setTimeout(() => (detail.filmDragged = false), 0);
  if (apply && drag.target !== null) {
    detail.scrollTo = state.detailId;
    movePages([drag.id], drag.target);
  }
}
document.addEventListener("pointerup", () => endFilmDrag(true));
document.addEventListener("pointercancel", () => endFilmDrag(false));

ui.filmstrip.addEventListener("click", (event) => {
  const item = event.target.closest(".film-item");
  if (!item || detail.filmDragged) return;
  if (event.target.closest(".film-delete")) deleteInDetails(item.dataset.id);
  else goDetail(indexOf(item.dataset.id));
});

ui.filmstrip.addEventListener("keydown", (event) => {
  const item = event.target.closest(".film-item");
  if (!item || event.target !== item) return;
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    goDetail(indexOf(item.dataset.id));
  } else if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
    event.preventDefault();
    const rect = item.getBoundingClientRect();
    openPageMenu(item.dataset.id, rect.right - 8, rect.top + 20);
  }
});

ui.filmstrip.addEventListener("contextmenu", (event) => {
  const item = event.target.closest(".film-item");
  if (!item) return;
  event.preventDefault();
  openPageMenu(item.dataset.id, event.clientX, event.clientY);
});

function openPageMenu(id, x, y) {
  ui.pageMenu.dataset.id = id;
  ui.pageMenu.hidden = false;
  const { width, height } = ui.pageMenu.getBoundingClientRect();
  ui.pageMenu.style.left = `${Math.max(8, Math.min(x, innerWidth - width - 8))}px`;
  ui.pageMenu.style.top = `${Math.max(8, Math.min(y, innerHeight - height - 8))}px`;
  ui.pageMenu.querySelector("button").focus();
}

function closePageMenu() {
  ui.pageMenu.hidden = true;
}

ui.pageMenu.addEventListener("click", (event) => {
  const action = event.target.closest("button")?.dataset.action;
  const id = ui.pageMenu.dataset.id;
  closePageMenu();
  if (action === "rotate-left") rotateInDetails(id, -90);
  if (action === "rotate-right") rotateInDetails(id, 90);
  if (action === "delete") deleteInDetails(id);
});
ui.pageMenu.addEventListener("keydown", (event) => {
  const buttons = [...ui.pageMenu.querySelectorAll("button")];
  const at = buttons.indexOf(document.activeElement);
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    event.stopPropagation();
    buttons[(at + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length].focus();
  }
});
document.addEventListener("pointerdown", (event) => {
  if (!ui.pageMenu.hidden && !ui.pageMenu.contains(event.target)) closePageMenu();
});
addEventListener("scroll", () => !ui.pageMenu.hidden && closePageMenu(), { passive: true, capture: true });
addEventListener("blur", closePageMenu);

// Text of the pages, read once per page (scanned pages have none).
function textOf(page) {
  const { key, pdf, index } = docFor(page);
  if (!detail.items.has(key)) detail.items.set(key, pageText(pdf, index).catch(() => []));
  return detail.items.get(key);
}

/** Pointer position on a sheet as fractions, undoing the sheet's CSS rotation. */
function sheetPoint(event, sheet) {
  const box = sheet.getBoundingClientRect();
  const angle = (-Number(sheet.dataset.angle || 0) * Math.PI) / 180;
  const dx = event.clientX - (box.left + box.width / 2);
  const dy = event.clientY - (box.top + box.height / 2);
  const x = dx * Math.cos(angle) - dy * Math.sin(angle);
  const y = dx * Math.sin(angle) + dy * Math.cos(angle);
  const clamp = (n) => Math.max(0, Math.min(1, n));
  return [clamp(x / sheet.offsetWidth + 0.5), clamp(y / sheet.offsetHeight + 0.5)];
}

let marking = null;

ui.stage.addEventListener("pointerdown", (event) => {
  const sheet = event.target.closest(".sheet");
  if (!sheet || event.target.closest(".mark-delete") || event.button !== 0) return;
  const pageId = sheet.parentElement.dataset.id;
  // With the select tool a finger still scrolls the page; only the mouse drags a rectangle.
  const touch = state.tool === "select" && event.pointerType !== "mouse";
  if (!touch) {
    event.preventDefault();
    sheet.setPointerCapture(event.pointerId);
  }
  marking = {
    sheet,
    pageId,
    touch,
    start: sheetPoint(event, sheet),
    end: sheetPoint(event, sheet),
    pointerId: event.pointerId,
  };
  if (!touch) drawDraft();
});

ui.stage.addEventListener("click", (event) => {
  const button = event.target.closest(".mark-delete");
  if (button) deleteMark(button.closest(".stage-item").dataset.id, button.dataset.mark);
});

ui.stage.addEventListener("pointermove", (event) => {
  if (!marking && state.tool === "select" && event.pointerType === "mouse") showObjectHover(event);
  if (!marking || event.pointerId !== marking.pointerId) return;
  marking.end = sheetPoint(event, marking.sheet);
  if (!marking.touch) drawDraft();
});

ui.stage.addEventListener("pointerup", (event) => {
  if (!marking || event.pointerId !== marking.pointerId) return;
  const { start, sheet, pageId, touch } = marking;
  marking.end = sheetPoint(event, sheet);
  const rect = [start[0], start[1], marking.end[0], marking.end[1]];
  stopMarking();
  const widthPx = Math.abs(rect[2] - rect[0]) * sheet.offsetWidth;
  const heightPx = Math.abs(rect[3] - rect[1]) * sheet.offsetHeight;
  const dragged = widthPx >= 6 && heightPx >= 4;
  if (state.tool === "select") {
    if (!(touch && dragged)) pickAt(pageId, rect, dragged, event.shiftKey || event.ctrlKey || event.metaKey);
  } else if (dragged) addMarkFromRect(pageId, rect);
});

ui.stage.addEventListener("pointerleave", hideObjectHover);
ui.stage.addEventListener("pointercancel", stopMarking);

function stopMarking() {
  if (marking) marking.sheet.querySelector(".draft").hidden = true;
  marking = null;
}

function drawDraft() {
  const [x0, y0, x1, y1] = [marking.start[0], marking.start[1], marking.end[0], marking.end[1]];
  const draft = marking.sheet.querySelector(".draft");
  draft.hidden = false;
  draft.className = `draft ${state.tool}`;
  draft.style.cssText = boxStyle([Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)]);
}

// Objects: texts, images and annotations of the PDF, and marks made here. The select tool picks
// them; picked objects are changed or deleted in the panel on the right.

/** What the worker found on the page (see content.js), read once per page of an upload. */
function objectsOf(page) {
  const key = `${page.sourceId}:${page.index}`;
  if (!detail.objectPromises.has(key)) {
    const promise = worker
      .call("objects", { sourceId: page.sourceId, index: page.index })
      .then(({ objects }) => objects, () => []);
    promise.then((objects) => detail.objects.set(key, objects));
    detail.objectPromises.set(key, promise);
  }
  return detail.objectPromises.get(key);
}

/** What can be picked on the page right now: objects still there, and marks. */
function deletable(page) {
  const gone = new Set(page.removed ?? []);
  const objects = (detail.objects.get(`${page.sourceId}:${page.index}`) ?? []).filter((object) => !gone.has(object.id));
  const marks = (page.marks ?? []).flatMap((mark) => mark.rects.map((box) => ({ id: `m:${mark.id}`, type: "mark", box })));
  return [...marks, ...objects];
}

/**
 * The object a click at this point picks: marks first (they lie on top), then the smallest
 * object, so text on top of a background picture wins. If what is picked already is under the
 * point, the next one below it: clicking again reaches the text under a mark.
 */
function objectAt(page, [u, v]) {
  const slack = 0.004;
  const under = deletable(page)
    .filter(({ box: [u0, v0, u1, v1] }) => u >= u0 - slack && u <= u1 + slack && v >= v0 - slack && v <= v1 + slack)
    .map((object) => ({ object, area: (object.box[2] - object.box[0]) * (object.box[3] - object.box[1]) }))
    .sort((a, b) => (b.object.type === "mark") - (a.object.type === "mark") || a.area - b.area)
    .map(({ object }) => object);
  const ids = [...new Set(under.map((object) => object.id))];
  const picked = state.picked?.pageId === page.id && state.picked.ids.length === 1 ? state.picked.ids[0] : null;
  const at = ids.indexOf(picked);
  const id = at >= 0 && ids.length > 1 ? ids[(at + 1) % ids.length] : ids[0];
  return under.find((object) => object.id === id) ?? null;
}

function showObjectHover(event) {
  const sheet = event.target.closest?.(".sheet");
  const page = sheet && pages().find((p) => p.id === sheet.parentElement.dataset.id);
  if (!page) return hideObjectHover();
  objectsOf(page);
  const object = objectAt(page, sheetPoint(event, sheet));
  for (const box of ui.stage.querySelectorAll(".object-hover")) {
    const here = object && box.parentElement === sheet;
    box.hidden = !here;
    if (here) box.style.cssText = boxStyle(object.box);
  }
}

function hideObjectHover() {
  for (const box of ui.stage.querySelectorAll(".object-hover")) box.hidden = true;
}

/** Picks the object under a click, or everything whose middle is inside a dragged rectangle. */
async function pickAt(pageId, rect, dragged, add) {
  let page = pages().find((p) => p.id === pageId);
  if (!page) return;
  await objectsOf(page);
  page = pages().find((p) => p.id === pageId);
  if (!page) return;
  let ids;
  if (dragged) {
    const [u0, v0, u1, v1] = [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])];
    ids = deletable(page)
      .filter(({ box }) => {
        const cu = (box[0] + box[2]) / 2;
        const cv = (box[1] + box[3]) / 2;
        return cu >= u0 && cu <= u1 && cv >= v0 && cv <= v1;
      })
      .map((object) => object.id);
  } else {
    const hit = objectAt(page, [rect[0], rect[1]]);
    ids = hit ? [hit.id] : [];
  }
  // Shift or Ctrl adds to (or takes from) what is picked on the same page.
  if (add && state.picked?.pageId === pageId) {
    const now = new Set(state.picked.ids);
    for (const id of ids) {
      if (now.has(id) && !dragged) now.delete(id);
      else now.add(id);
    }
    ids = [...now];
  }
  pick(ids.length ? { pageId, ids: [...new Set(ids)] } : null, pageId);
}

function pick(picked, pageId = picked?.pageId) {
  state.picked = picked;
  if (pageId) {
    state.detailId = pageId;
    state.focusId = pageId;
  }
  // A single picked mark is also the current mark of the list on the right.
  state.markId = picked?.ids.length === 1 && picked.ids[0].startsWith("m:") ? picked.ids[0].slice(2) : null;
  hideObjectHover();
  renderDetails();
  if (picked) announce(picked.ids.length === 1 ? "1 object selected." : `${picked.ids.length} objects selected.`);
}

const TYPE_NAMES = { text: "Text", image: "Image", group: "Group of objects", annotation: "Annotation", mark: "Mark" };

function renderPickPanel() {
  const picked = state.picked;
  const page = picked && pages().find((p) => p.id === picked.pageId);
  ui.pickPanel.hidden = !page;
  if (!page) {
    detail.pickKey = null;
    return;
  }
  const all = deletable(page);
  const objects = [...new Set(picked.ids)].map((id) => all.find((object) => object.id === id)).filter(Boolean);
  const single = objects.length === 1 ? objects[0] : null;
  ui.pickWhat.textContent = single
    ? `${TYPE_NAMES[single.type]} on page ${indexOf(page.id) + 1}`
    : `${objects.length} objects on page ${indexOf(page.id) + 1}`;
  const editable = single?.type === "text";
  ui.pickTextRow.hidden = !editable;
  const mark = single?.type === "mark" ? (page.marks ?? []).find((m) => `m:${m.id}` === single.id) : null;
  if (mark) ui.pickWhat.textContent = `${mark.kind === "private" ? "Private mark" : "Highlight"} on page ${indexOf(page.id) + 1}`;
  ui.pickMark.hidden = !mark;
  // Fill the fields only when something else is selected or its values changed, not while typing.
  const values = mark ? JSON.stringify(mark) + (placeholders(pages()).get(mark.id) ?? "") : editable ? (page.edits?.[single.id] ?? "") : "";
  const key = `${page.id}|${picked.ids.join(",")}|${values}`;
  if (key === detail.pickKey) return;
  detail.pickKey = key;
  ui.pickMark.replaceChildren(...(mark ? [markEditor(page, mark)] : []));
  showPdfSource(page, single, mark, key);
  if (!editable) return;
  const changed = page.edits?.[single.id];
  ui.pickText.value = changed ?? "";
  ui.pickText.dataset.original = changed ?? "";
  if (changed === undefined) {
    // What the run says now, read from the page.
    textOf(page).then((items) => {
      if (detail.pickKey !== key || ui.pickText.value !== "") return;
      const { text } = textInRect(items, single.box);
      ui.pickText.value = text;
      ui.pickText.dataset.original = text;
    });
  }
}

/** Developer options: how the selected object is written in the PDF. */
function showPdfSource(page, single, mark, key) {
  ui.pickSource.hidden = !(state.developer && single);
  if (ui.pickSource.hidden) return;
  ui.pickSourceText.textContent = "…";
  const request = { sourceId: page.sourceId, index: page.index };
  if (mark) Object.assign(request, { mark, placeholder: placeholders(pages()).get(mark.id) });
  else request.id = single.id;
  worker.call("inspect", request).then(
    ({ source }) => {
      if (detail.pickKey !== key) return;
      const changed = !mark && page.edits?.[single.id] !== undefined;
      ui.pickSourceText.textContent = changed
        ? `% As in the uploaded file. Saving replaces it by: ${JSON.stringify(page.edits[single.id])}\n${source}`
        : source;
    },
    (error) => {
      if (detail.pickKey === key) ui.pickSourceText.textContent = `% Could not be read: ${error.message}`;
    },
  );
}

function applyPickedText() {
  const picked = state.picked;
  const page = picked && pages().find((p) => p.id === picked.pageId);
  if (!page || picked.ids.length !== 1) return;
  const text = ui.pickText.value;
  if (text.trim() === "") return deletePicked();
  if (text === ui.pickText.dataset.original) return;
  commit(editText(pages(), page.id, picked.ids[0], text), { animate: false });
  announce("Text changed.");
}

function deletePicked() {
  const picked = state.picked;
  const page = picked && pages().find((p) => p.id === picked.pageId);
  if (!page) return;
  const marks = picked.ids.filter((id) => id.startsWith("m:")).map((id) => id.slice(2));
  const objects = picked.ids.filter((id) => !id.startsWith("m:"));
  state.picked = null;
  state.markId = null;
  commit(erase(pages(), page.id, { objects, marks }), { animate: false });
  toast(`Deleted ${plural(marks.length + objects.length, "object")}.`, { action: { label: "Undo", run: undo } });
}

$("pick-apply").addEventListener("click", applyPickedText);
$("pick-delete").addEventListener("click", deletePicked);
ui.pickText.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    applyPickedText();
  }
});

async function addMarkFromRect(pageId, rect) {
  const page = pages().find((p) => p.id === pageId);
  const kind = state.tool;
  if (!page || !kind) return;
  const { text, rects } = textInRect(await textOf(page), rect);
  if (indexOf(page.id) < 0) return; // deleted while the text was read
  const mark = { id: newMarkId(), kind, text, rects };
  if (kind === "private") mark.category = ui.category.value;
  else mark.color = state.highlightColor;
  state.detailId = page.id;
  // The new mark is selected, so its colour, text and comment can be set right away.
  state.picked = { pageId: page.id, ids: [`m:${mark.id}`] };
  state.markId = mark.id;
  commit(addMark(pages(), page.id, mark), { animate: false });
  announce(kind === "private" ? `Marked ${text || "an area"} as private.` : `Highlighted ${text || "an area"}.`);
}

function detailKey(event) {
  const key = event.key;
  const mod = event.ctrlKey || event.metaKey;
  const list = pages();
  const index = indexOf(state.detailId);
  if (mod || event.altKey) return;
  if (key === "ArrowLeft") {
    event.preventDefault();
    goDetail(index - 1);
  } else if (key === "ArrowRight") {
    event.preventDefault();
    goDetail(index + 1);
  } else if (key === "Home" && !event.target.closest?.("input, select")) {
    event.preventDefault();
    goDetail(0);
  } else if (key === "End" && !event.target.closest?.("input, select")) {
    event.preventDefault();
    goDetail(list.length - 1);
  } else if (key.toLowerCase() === "h") {
    event.preventDefault();
    setTool("highlight");
  } else if (key.toLowerCase() === "p") {
    event.preventDefault();
    setTool("private");
  } else if (key.toLowerCase() === "s" || key.toLowerCase() === "v") {
    event.preventDefault();
    setTool("select");
  } else if (key.toLowerCase() === "r") {
    event.preventDefault();
    rotateInDetails(state.detailId, event.shiftKey ? -90 : 90);
  } else if ((key === "Delete" || key === "Backspace") && state.picked) {
    event.preventDefault();
    deletePicked();
  } else if ((key === "Delete" || key === "Backspace") && state.markId) {
    event.preventDefault();
    deleteMark(state.detailId, state.markId);
  }
}

$("view-arrange").addEventListener("click", showArrange);
$("view-details").addEventListener("click", () => showDetails());
$("tool-highlight").addEventListener("click", () => setTool("highlight"));
$("tool-private").addEventListener("click", () => setTool("private"));
$("tool-select").addEventListener("click", () => setTool("select"));

// Quick access: type a page number.
ui.pageInput.addEventListener("change", () => {
  const n = Math.round(Number(ui.pageInput.value));
  if (Number.isFinite(n) && n >= 1) goDetail(n - 1);
  ui.pageInput.value = indexOf(state.detailId) + 1;
});
ui.pageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") ui.pageInput.blur();
});
ui.pageInput.addEventListener("focus", () => ui.pageInput.select());

let resizeTimer = 0;
addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => state.view === "details" && renderDetails(), 120);
});

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
  state.view = "arrange";
  state.detailId = null;
  state.markId = null;
  state.picked = null;
  setTool("select");
  detail.sheetKey = "";
  detail.sheets.clear();
  ui.stage.replaceChildren();
  detail.items.clear();
  detail.objects.clear();
  detail.objectPromises.clear();
  for (const pdf of edited.values()) pdf.then((doc) => doc.destroy(), () => {});
  edited.clear();
  detail.filmKey = "";
  ui.filmstrip.replaceChildren();
  previews.clear();
  for (const card of cards.values()) previewObserver.unobserve(card);
  cards.clear();
  ui.pages.replaceChildren();
  render({ animate: false });
  worker.call("reset");
});

// Developer options, remembered between visits.
const DEV_KEY = "pdf-studio:developer";
try {
  state.developer = localStorage.getItem(DEV_KEY) === "1";
} catch {}
ui.devOptions.checked = state.developer;
ui.devOptions.addEventListener("change", () => {
  state.developer = ui.devOptions.checked;
  try {
    localStorage.setItem(DEV_KEY, state.developer ? "1" : "0");
  } catch {}
  detail.pickKey = null; // fill the selection panel again
  if (state.view === "details") renderDetails();
});

// Colour of the next highlight, remembered between visits.
const COLOR_KEY = "pdf-studio:highlight-color";
try {
  state.highlightColor = colorOf(localStorage.getItem(COLOR_KEY)).id;
} catch {}
function renderToolColors() {
  $("highlight-colors").replaceChildren(
    ...swatches(
      state.highlightColor,
      (color) => {
        state.highlightColor = color;
        try {
          localStorage.setItem(COLOR_KEY, color);
        } catch {}
        renderToolColors();
      },
      "",
    ).children,
  );
}
renderToolColors();

for (const element of document.querySelectorAll("[data-version]")) element.textContent = `Version ${VERSION}`;

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
// Offline, versions and updates (the service worker is registered in update.js)

let install = null;

const updates = setupUpdates({
  isBusy: () => pages().length > 0,
  confirmLoss: () => {
    if (state.dirty && !confirm("Update and reload now? Your changes have not been downloaded and will be lost.")) return false;
    state.dirty = false; // no second question from beforeunload
    return true;
  },
  onChange: (status) => {
    install?.refresh();
    for (const element of document.querySelectorAll("[data-version]")) {
      element.textContent = `Version ${describeVersion(status.current)}`;
    }
  },
  toast,
});
install = setupInstall({ button: $("install"), dialog: $("install-dialog"), toast, updates });

render({ animate: false });
// For the browser test and debugging; not used by the app itself.
window.pdfStudio = { state, pages };
