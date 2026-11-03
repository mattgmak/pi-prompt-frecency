import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  collapseWhitespace,
  hashPrompt,
  isStorablePrompt,
  normalizePrompt,
  promptIdentity,
} from "../src/text.ts";

test("normalizePrompt folds CRLF and trailing spaces", () => {
  assert.equal(normalizePrompt("a  \r\nb\t\r\n"), "a\nb");
});

test("normalizePrompt caps blank line runs at one blank line", () => {
  assert.equal(normalizePrompt("a\n\n\n\nb"), "a\n\nb");
});

test("collapseWhitespace flattens text to one line", () => {
  assert.equal(collapseWhitespace(" a\n\tb  c "), "a b c");
});

test("hashPrompt returns a stable sha256 hex digest", () => {
  assert.match(hashPrompt("x"), /^[0-9a-f]{64}$/);
  assert.equal(hashPrompt("x"), hashPrompt("x"));
});

test("promptIdentity folds spacing variants of a multi line prompt", () => {
  assert.equal(promptIdentity("a\n\nb"), "a b");
  assert.equal(promptIdentity("a\nb"), promptIdentity("a b"));
  assert.notEqual(promptIdentity("a  b"), promptIdentity("a b"));
});

test("promptIdentity keeps a single line prompt as is", () => {
  assert.equal(promptIdentity("  commit and push  "), "commit and push");
});

test("isStorablePrompt rejects short text, slash commands, and bang lines", () => {
  assert.equal(isStorablePrompt("abc", 4), false);
  assert.equal(isStorablePrompt("abcd", 4), true);
  assert.equal(isStorablePrompt("/help", 1), false);
  assert.equal(isStorablePrompt("!ls", 1), false);
});

test("isStorablePrompt rejects configured injected prefixes", () => {
  const prefixes = ["<system-reminder>", "<task>"];
  assert.equal(isStorablePrompt("<task> run", 1, prefixes), false);
  assert.equal(isStorablePrompt("<system-reminder> note", 1, prefixes), false);
  assert.equal(isStorablePrompt("run", 1, prefixes), true);
});
