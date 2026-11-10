// The document being edited: an ordered list of pages, each pointing at a page of an uploaded
// file. All operations are pure: they return a new array and never change the old one, so undo
// and redo only need to keep the old arrays.
//
// A page is { id, sourceId, index, rotation }:
//   id        unique for this page in the editor (stable across moves)
//   sourceId  the uploaded file it comes from
//   index     0-based page number in that file
//   rotation  extra clockwise rotation the user added: 0, 90, 180 or 270

let nextId = 1;

/** New page entries for pages 0 … count−1 of a source. */
export function pagesOf(sourceId, count) {
  return Array.from({ length: count }, (_, index) => ({ id: `p${nextId++}`, sourceId, index, rotation: 0 }));
}

/** Inserts `added` before position `at` (default: at the end). */
export function insert(pages, added, at = pages.length) {
  const position = Math.max(0, Math.min(at, pages.length));
  return [...pages.slice(0, position), ...added, ...pages.slice(position)];
}

/**
 * Moves the pages with the given ids so that they land in front of the page that is at position
 * `to` now (`to` = pages.length: to the end). Moved pages keep their relative order, so a
 * selection spread over the document ends up together.
 */
export function move(pages, ids, to) {
  const moving = new Set(ids);
  const moved = pages.filter((page) => moving.has(page.id));
  if (moved.length === 0) return pages;
  const rest = pages.filter((page) => !moving.has(page.id));
  const target = pages.slice(0, Math.max(0, to)).filter((page) => !moving.has(page.id)).length;
  const result = [...rest.slice(0, target), ...moved, ...rest.slice(target)];
  return result.every((page, i) => page === pages[i]) ? pages : result;
}

/** Rotates the given pages by `degrees` (a multiple of 90; negative = counter-clockwise). */
export function rotate(pages, ids, degrees) {
  const rotating = new Set(ids);
  return pages.map((page) =>
    rotating.has(page.id) ? { ...page, rotation: normalizeRotation(page.rotation + degrees) } : page,
  );
}

/** Removes the given pages. */
export function remove(pages, ids) {
  const removing = new Set(ids);
  return pages.filter((page) => !removing.has(page.id));
}

/** 0, 90, 180 or 270 for any multiple of 90, also negative ones. */
export function normalizeRotation(degrees) {
  return ((Math.round(degrees / 90) * 90) % 360 + 360) % 360;
}

/** Undo and redo for the page list. Each state is an array returned by the functions above. */
export class History {
  constructor(initial = []) {
    this.past = [];
    this.present = initial;
    this.future = [];
  }

  /** Makes `next` the current state; unchanged states are not recorded. Returns true if it changed. */
  push(next) {
    if (next === this.present) return false;
    this.past.push(this.present);
    this.present = next;
    this.future = [];
    return true;
  }

  get canUndo() {
    return this.past.length > 0;
  }

  get canRedo() {
    return this.future.length > 0;
  }

  undo() {
    if (!this.canUndo) return false;
    this.future.push(this.present);
    this.present = this.past.pop();
    return true;
  }

  redo() {
    if (!this.canRedo) return false;
    this.past.push(this.present);
    this.present = this.future.pop();
    return true;
  }

  reset(initial = []) {
    this.past = [];
    this.present = initial;
    this.future = [];
  }
}
