import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  GLOBAL_SCOPE,
  PromptStore,
  claimIndexRun,
  cwdScopeKey,
  getScanState,
  scopeKeyFor,
  sessionScopeKey,
  setScanState,
  type PromptEvent,
} from "../src/db.ts";
import { makeTempDir, openStore, removeTempDir } from "./helpers.ts";

const dir = makeTempDir();

test("scope keys carry the global, cwd, and session prefixes", () => {
  assert.equal(GLOBAL_SCOPE, "g");
  assert.equal(cwdScopeKey("/repo"), "c:/repo");
  assert.equal(sessionScopeKey("/s.jsonl"), "s:/s.jsonl");
  assert.equal(scopeKeyFor("global", "/repo", "/s.jsonl"), "g");
  assert.equal(scopeKeyFor("cwd", "/repo", "/s.jsonl"), "c:/repo");
  assert.equal(scopeKeyFor("session", "/repo", "/s.jsonl"), "s:/s.jsonl");
  assert.equal(scopeKeyFor("cwd", "", "/s.jsonl"), null);
  assert.equal(scopeKeyFor("session", "/repo", ""), null);
});

test("one send writes the global, cwd, and session rows", () => {
  const store = openStore(dir);
  const at = Math.floor(Date.now() / 1000) - 10;
  assert.equal(store.recordUse({ text: "commit and push", at, cwd: "/repo", session: "/s.jsonl" }), true);
  const rows = store.all<{ scope: string; uses: number; rank: number }>(
    `SELECT u.scope AS scope, u.uses AS uses, u.rank AS rank
     FROM usages u JOIN prompts p ON p.hash = u.hash
     WHERE p.text = ? ORDER BY u.scope`,
    ["commit and push"],
  );
  assert.deepEqual(rows.map((row) => row.scope), ["c:/repo", "g", "s:/s.jsonl"]);
  assert.deepEqual(rows.map((row) => row.uses), [1, 1, 1]);
  assert.deepEqual(rows.map((row) => row.rank), [1, 1, 1]);
  store.close();
});

test("a second send inside the dedupe window is skipped", () => {
  const store = openStore(dir);
  const at = Math.floor(Date.now() / 1000) - 10;
  assert.equal(store.recordUse({ text: "run the tests", at, cwd: "/repo", session: "/s.jsonl" }), true);
  assert.equal(store.recordUse({ text: "run the tests", at: at + 1, cwd: "/repo", session: "/s.jsonl" }), false);
  const rows = store.all<{ uses: number }>(
    `SELECT u.uses AS uses FROM usages u JOIN prompts p ON p.hash = u.hash
     WHERE p.text = ? AND u.scope = ?`,
    ["run the tests", GLOBAL_SCOPE],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.uses, 1);
  store.close();
});

test("one prompt sent from two directories writes one row per scope", () => {
  const store = openStore(dir);
  const at = Math.floor(Date.now() / 1000) - 60;
  const events: PromptEvent[] = [
    { text: "push it", at, cwd: "/a", session: "/a.jsonl" },
    { text: "push it", at: at + 30, cwd: "/b", session: "/b.jsonl" },
  ];
  assert.equal(store.applyEvents(events), 2);
  const rows = store.all<{ scope: string; uses: number }>(
    `SELECT u.scope AS scope, u.uses AS uses FROM usages u JOIN prompts p ON p.hash = u.hash
     WHERE p.text = ? ORDER BY u.scope`,
    ["push it"],
  );
  assert.deepEqual(
    rows.map((row) => ({ scope: row.scope, uses: row.uses })),
    [
      { scope: "c:/a", uses: 1 },
      { scope: "c:/b", uses: 1 },
      { scope: "g", uses: 2 },
      { scope: "s:/a.jsonl", uses: 1 },
      { scope: "s:/b.jsonl", uses: 1 },
    ],
  );
  store.close();
});

test("two sends in one directory count twice", () => {
  const store = openStore(dir);
  const at = Math.floor(Date.now() / 1000) - 120;
  const events: PromptEvent[] = [
    { text: "fix the lint", at, cwd: "/repo", session: "/s.jsonl" },
    { text: "fix the lint", at: at + 60, cwd: "/repo", session: "/s.jsonl" },
  ];
  assert.equal(store.applyEvents(events), 1);
  const rows = store.all<{ uses: number; rank: number }>(
    "SELECT u.uses AS uses, u.rank AS rank FROM usages u WHERE u.scope = ?",
    [GLOBAL_SCOPE],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.uses, 2);
  assert.equal(rows[0]?.rank, 2);
  store.close();
});

test("a prompt below minPromptLength is never stored", () => {
  const store = openStore(dir, { minPromptLength: 6 });
  const events: PromptEvent[] = [{ text: "ok", at: 1_700_000_000, cwd: "/r", session: "/s" }];
  assert.equal(store.applyEvents(events), 0);
  assert.equal(store.all("SELECT hash FROM prompts").length, 0);
  store.close();
});

test("candidates returns one scope ordered by rank", () => {
  const store = openStore(dir);
  const now = Math.floor(Date.now() / 1000);
  store.applyEvents([
    { text: "alpha prompt", at: now - 100, cwd: "/r", session: "/s" },
    { text: "alpha prompt", at: now - 90, cwd: "/r", session: "/s" },
    { text: "beta prompt", at: now - 80, cwd: "/r", session: "/s" },
    { text: "gamma prompt", at: now - 70, cwd: "/other", session: "/o" },
  ]);
  assert.deepEqual(
    store.candidates(GLOBAL_SCOPE, 10).map((row) => row.text),
    ["alpha prompt", "gamma prompt", "beta prompt"],
  );
  assert.deepEqual(
    store.candidates(cwdScopeKey("/r"), 10).map((row) => row.text),
    ["alpha prompt", "beta prompt"],
  );
  store.close();
});

test("candidates honours the limit", () => {
  const store = openStore(dir);
  const now = Math.floor(Date.now() / 1000);
  store.applyEvents([
    { text: "first prompt", at: now - 30, cwd: "/r", session: "/s" },
    { text: "second prompt", at: now - 20, cwd: "/r", session: "/s" },
    { text: "third prompt", at: now - 10, cwd: "/r", session: "/s" },
  ]);
  assert.equal(store.candidates(GLOBAL_SCOPE, 2).length, 2);
  store.close();
});

test("aging rescales ranks instead of wiping the scope", () => {
  const store = openStore(dir, { maxAge: 10 });
  const now = Math.floor(Date.now() / 1000);
  const events: PromptEvent[] = [];
  for (let i = 0; i < 20; i++) {
    events.push({ text: "ship it", at: now - 200 + i * 10, cwd: "/r", session: "/s" });
  }
  assert.equal(store.applyEvents(events), 1);
  const rows = store.all<{ rank: number }>("SELECT u.rank AS rank FROM usages u WHERE u.scope = ?", [
    GLOBAL_SCOPE,
  ]);
  assert.equal(rows.length, 1);
  assert.ok(Math.abs((rows[0]?.rank ?? 0) - 9) < 1e-9);
  assert.ok(Math.abs(store.scopeTotal(GLOBAL_SCOPE) - 9) < 1e-9);
  store.close();
});

test("aging drops ranks that fall below the delete threshold", () => {
  const store = openStore(dir, { maxAge: 3 });
  const now = Math.floor(Date.now() / 1000);
  const events: PromptEvent[] = [];
  for (let i = 0; i < 4; i++) {
    events.push({ text: `prompt number ${i}`, at: now - 40 + i, cwd: "/r", session: "/s" });
  }
  assert.equal(store.applyEvents(events), 4);
  assert.equal(store.candidates(GLOBAL_SCOPE, 10).length, 0);
  assert.equal(store.scopeTotal(GLOBAL_SCOPE), 0);
  store.close();
});

test("applyEvents runs inside a caller transaction when asked", () => {
  const store = openStore(dir);
  const now = Math.floor(Date.now() / 1000);
  const events: PromptEvent[] = [{ text: "nested call", at: now, cwd: "/r", session: "/s" }];
  store.transaction(() => store.applyEvents(events, { transaction: false }));
  assert.equal(store.candidates(GLOBAL_SCOPE, 10).length, 1);
  store.close();
});

test("the scan state machine lets exactly one process claim a run", () => {
  const store = openStore(dir);
  assert.equal(getScanState(store), "uninitialized");
  assert.equal(claimIndexRun(store), true);
  assert.equal(getScanState(store), "running");
  assert.equal(claimIndexRun(store), false);
  setScanState(store, "done");
  assert.equal(getScanState(store), "done");
  assert.equal(claimIndexRun(store), false);
  store.close();
});

test("meta values round trip through string and number accessors", () => {
  const store = openStore(dir);
  store.setMetaString("k", "v");
  assert.equal(store.getMetaString("k"), "v");
  store.setMetaStringIfAbsent("k", "other");
  assert.equal(store.getMetaString("k"), "v");
  store.setMetaStringIfAbsent("k2", "second");
  assert.equal(store.getMetaString("k2"), "second");
  store.close();
});

export function cleanup(): void {
  removeTempDir(dir);
}
