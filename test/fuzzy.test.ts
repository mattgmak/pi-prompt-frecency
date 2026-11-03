import assert from "node:assert/strict";
import test from "node:test";

import { fuzzyFilter, fuzzyFilterDetailed, fuzzyMatch } from "../src/fuzzy.ts";

test("fuzzyMatch matches an exact string with the exact bonus", () => {
  const exact = fuzzyMatch("commit", "commit");
  assert.equal(exact.matches, true);
  const inside = fuzzyMatch("commit", "git commit -m fix");
  assert.equal(inside.matches, true);
  assert.ok(exact.score < inside.score);
});

test("fuzzyMatch rejects a text without the subsequence", () => {
  assert.deepEqual(fuzzyMatch("xyz", "commit"), { matches: false, score: 0, positions: [] });
});

test("fuzzyMatch treats an empty query as a zero score match", () => {
  assert.deepEqual(fuzzyMatch("", "commit"), { matches: true, score: 0, positions: [] });
});

test("fuzzyMatch reports the index of every matched character", () => {
  assert.deepEqual(fuzzyMatch("ab", "ab c").positions, [0, 1]);
  assert.deepEqual(fuzzyMatch("ab", "axb c").positions, [0, 2]);
  assert.deepEqual(fuzzyMatch("p", "ap").positions, [1]);
});

test("fuzzyMatch ignores case", () => {
  assert.equal(fuzzyMatch("COMMIT", "commit and push").matches, true);
  assert.equal(fuzzyMatch("commit", "COMMIT AND PUSH").matches, true);
});

test("fuzzyMatch rejects a query longer than the text", () => {
  assert.deepEqual(fuzzyMatch("commit now", "fix"), { matches: false, score: 0, positions: [] });
});

test("a boundary match scores better than a mid word match", () => {
  const boundary = fuzzyMatch("p", "a p");
  const middle = fuzzyMatch("p", "ap");
  assert.ok(boundary.score < middle.score);
});

test("a contiguous match scores better than a scattered one", () => {
  const tight = fuzzyMatch("ab", "ab c");
  const loose = fuzzyMatch("ab", "axb c");
  assert.ok(tight.score < loose.score);
});

test("fuzzyMatch accepts a letter and digit swap", () => {
  const swapped = fuzzyMatch("gpt4", "4gpt");
  assert.equal(swapped.matches, true);
  assert.deepEqual(swapped.positions, [0, 1, 2, 3]);
  const direct = fuzzyMatch("gpt4", "gpt4");
  assert.ok(swapped.score > direct.score);
});

test("fuzzyFilter returns items untouched for an empty query", () => {
  const items = ["commit and push", "run tests"];
  assert.deepEqual(fuzzyFilter(items, "  ", (item) => item), items);
});

test("fuzzyFilter keeps only items that match every token", () => {
  const items = ["commit and push", "push it", "run tests"];
  assert.deepEqual(fuzzyFilter(items, "push", (item) => item), ["push it", "commit and push"]);
  assert.deepEqual(fuzzyFilter(items, "push and", (item) => item), ["commit and push"]);
  assert.deepEqual(fuzzyFilter(items, "push/nope", (item) => item), []);
});

test("fuzzyFilter splits on whitespace and slash", () => {
  const items = ["commit and push", "commit only"];
  assert.deepEqual(fuzzyFilter(items, "commit/push", (item) => item), ["commit and push"]);
});

test("fuzzyFilterDetailed merges the positions of every token", () => {
  const items = ["commit and push"];
  const hits = fuzzyFilterDetailed(items, "pu sh", (item) => item);
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0]?.positions, [11, 12, 13, 14]);
});
