import assert from "node:assert/strict";
import { test } from "node:test";
import { History, insert, move, normalizeRotation, pagesOf, remove, rotate } from "../src/model.js";

const ids = (pages) => pages.map((page) => page.id);

function sample() {
  const pages = pagesOf("a", 5); // a1 … a5
  return { pages, id: (n) => pages[n - 1].id };
}

test("pagesOf numbers the pages of a source and gives unique ids", () => {
  const pages = [...pagesOf("a", 3), ...pagesOf("b", 2)];
  assert.deepEqual(pages.map((page) => `${page.sourceId}${page.index}`), ["a0", "a1", "a2", "b0", "b1"]);
  assert.equal(new Set(ids(pages)).size, 5);
  assert.ok(pages.every((page) => page.rotation === 0));
});

test("insert adds at the end or before a position", () => {
  const { pages } = sample();
  const extra = pagesOf("b", 2);
  assert.deepEqual(ids(insert(pages, extra)), [...ids(pages), ...ids(extra)]);
  assert.deepEqual(ids(insert(pages, extra, 1)), [pages[0].id, ...ids(extra), ...ids(pages.slice(1))]);
  assert.deepEqual(ids(insert(pages, extra, 99)).slice(-2), ids(extra));
});

test("move puts a page in front of the page at the target position", () => {
  const { pages, id } = sample();
  assert.deepEqual(ids(move(pages, [id(1)], 3)), [id(2), id(3), id(1), id(4), id(5)]);
  assert.deepEqual(ids(move(pages, [id(5)], 0)), [id(5), id(1), id(2), id(3), id(4)]);
  assert.deepEqual(ids(move(pages, [id(2)], 5)), [id(1), id(3), id(4), id(5), id(2)]);
});

test("move keeps a spread-out selection in its order and groups it", () => {
  const { pages, id } = sample();
  assert.deepEqual(ids(move(pages, [id(4), id(1)], 3)), [id(2), id(3), id(1), id(4), id(5)]);
  assert.deepEqual(ids(move(pages, [id(2), id(5)], 0)), [id(2), id(5), id(1), id(3), id(4)]);
});

test("move returns the same array when nothing changes", () => {
  const { pages, id } = sample();
  assert.equal(move(pages, [id(2)], 1), pages);
  assert.equal(move(pages, [id(2)], 2), pages);
  assert.equal(move(pages, ["unknown"], 0), pages);
  assert.equal(move(pages, [id(4), id(5)], 5), pages);
});

test("rotate adds clockwise and wraps around; other pages stay the same objects", () => {
  const { pages, id } = sample();
  const once = rotate(pages, [id(2)], 90);
  assert.equal(once[1].rotation, 90);
  assert.equal(once[0], pages[0]);
  assert.equal(pages[1].rotation, 0, "original unchanged");
  assert.equal(rotate(once, [id(2)], -180)[1].rotation, 270);
  assert.equal(rotate(rotate(once, [id(2)], 90), [id(2)], 180)[1].rotation, 0);
});

test("normalizeRotation", () => {
  assert.deepEqual([0, 90, 360, 450, -90, -360, -450].map(normalizeRotation), [0, 90, 0, 90, 270, 0, 270]);
});

test("remove drops the given pages", () => {
  const { pages, id } = sample();
  assert.deepEqual(ids(remove(pages, [id(1), id(3)])), [id(2), id(4), id(5)]);
  assert.deepEqual(remove(pages, ids(pages)), []);
});

test("History undoes and redoes, and a new change clears redo", () => {
  const { pages, id } = sample();
  const history = new History(pages);
  assert.equal(history.canUndo, false);
  assert.equal(history.push(pages), false, "unchanged state is not recorded");
  history.push(remove(pages, [id(1)]));
  history.push(rotate(history.present, [id(2)], 90));
  assert.equal(history.present.length, 4);
  history.undo();
  assert.equal(history.present[0].rotation, 0);
  history.undo();
  assert.equal(history.present, pages);
  assert.equal(history.undo(), false);
  history.redo();
  assert.equal(history.present.length, 4);
  history.push(move(history.present, [id(5)], 0));
  assert.equal(history.canRedo, false);
});
