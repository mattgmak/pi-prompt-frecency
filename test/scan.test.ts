import { strict as assert } from "node:assert";
import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { GLOBAL_SCOPE, cwdScopeKey, sessionScopeKey } from "../src/db.ts";
import {
  eventsFromLines,
  fileStateKey,
  listSessionFiles,
  readFileState,
  readHeaderCwd,
  readLinesFrom,
  scanAll,
  writeFileState,
} from "../src/scan.ts";
import {
  assistantLine,
  headerLine,
  makeTempDir,
  openStore,
  userLine,
  userPartsLine,
  writeSession,
} from "./helpers.ts";

const AT = "2026-11-01T10:00:00.000Z";
const LATER = "2026-11-01T10:01:00.000Z";
const EPOCH = Math.floor(Date.parse(AT) / 1000);

test("scanAll indexes one session file into every scope", () => {
  const dir = makeTempDir();
  writeSession(dir, "s.jsonl", [
    headerLine("/repo"),
    userLine("commit and push", AT),
    userLine("run the tests", LATER),
  ]);
  const store = openStore(dir, { sessionDirs: [dir] });
  const result = scanAll(store, store.config);

  assert.equal(result.files, 1);
  assert.equal(result.events, 2);
  assert.ok(result.bytes > 0);
  assert.deepEqual(
    store.candidates(GLOBAL_SCOPE, 10).map((row) => row.text).sort(),
    ["commit and push", "run the tests"],
  );
  assert.equal(store.candidates(cwdScopeKey("/repo"), 10).length, 2);
  assert.equal(store.candidates(sessionScopeKey(join(dir, "s.jsonl")), 10).length, 2);
  store.close();
});

test("scanAll skips a file that did not change", () => {
  const dir = makeTempDir();
  writeSession(dir, "s.jsonl", [headerLine("/repo"), userLine("commit and push", AT)]);
  const store = openStore(dir, { sessionDirs: [dir] });

  assert.equal(scanAll(store, store.config).files, 1);
  assert.deepEqual(scanAll(store, store.config), { files: 0, bytes: 0, events: 0 });
  store.close();
});

test("force rescans an unchanged file and dedupes every event", () => {
  const dir = makeTempDir();
  writeSession(dir, "s.jsonl", [headerLine("/repo"), userLine("commit and push", AT)]);
  const store = openStore(dir, { sessionDirs: [dir] });

  assert.equal(scanAll(store, store.config).events, 1);
  const again = scanAll(store, store.config, { force: true });
  assert.equal(again.files, 1);
  assert.equal(again.events, 0);
  assert.equal(store.candidates(GLOBAL_SCOPE, 10).length, 1);
  store.close();
});

test("a rescan reads only the appended lines", () => {
  const dir = makeTempDir();
  const file = writeSession(dir, "s.jsonl", [headerLine("/repo"), userLine("commit and push", AT)]);
  const store = openStore(dir, { sessionDirs: [dir] });
  assert.equal(scanAll(store, store.config).events, 1);

  appendFileSync(file, `${userLine("push to main", LATER)}\n`);
  const second = scanAll(store, store.config);
  assert.equal(second.files, 1);
  assert.equal(second.events, 1);
  assert.equal(store.candidates(GLOBAL_SCOPE, 10).length, 2);
  assert.equal(store.candidates(cwdScopeKey("/repo"), 10).length, 2);
  store.close();
});

test("scanAll returns nothing when a session dir does not exist", () => {
  const dir = makeTempDir();
  const store = openStore(dir, { sessionDirs: [join(dir, "missing")] });
  assert.deepEqual(scanAll(store, store.config), { files: 0, bytes: 0, events: 0 });
  store.close();
});

test("readHeaderCwd reads the cwd from the first line only", () => {
  const dir = makeTempDir();
  const file = writeSession(dir, "s.jsonl", [headerLine("/srv/app"), userLine("hello there", AT)]);
  assert.equal(readHeaderCwd(file), "/srv/app");
});

test("readHeaderCwd returns an empty string when line one is not a header", () => {
  const dir = makeTempDir();
  const file = join(dir, "plain.jsonl");
  writeFileSync(file, `${userLine("hello there", AT)}\n`, "utf8");
  assert.equal(readHeaderCwd(file), "");
});

test("eventsFromLines turns user lines into events", () => {
  const lines = [
    headerLine("/work"),
    assistantLine("sure thing", AT),
    userLine("commit and push", AT),
    userPartsLine(["fix the ", "bug"], LATER),
    "not json at all",
  ];
  const events = eventsFromLines(lines, "/w/s.jsonl", "/work");

  assert.equal(events.length, 2);
  assert.deepEqual(events[0], {
    text: "commit and push",
    at: EPOCH,
    session: "/w/s.jsonl",
    cwd: "/work",
  });
  assert.equal(events[1]?.text, "fix the\nbug");
});

test("listSessionFiles skips ignored patterns and files that are not jsonl", () => {
  const dir = makeTempDir();
  mkdirSync(join(dir, "sub", "node_modules"), { recursive: true });
  writeFileSync(join(dir, "sub", "keep.jsonl"), `${headerLine("/repo")}\n`, "utf8");
  writeFileSync(join(dir, "sub", "node_modules", "dep.jsonl"), `${headerLine("/dep")}\n`, "utf8");
  writeFileSync(join(dir, "sub", "notes.txt"), "hello\n", "utf8");

  assert.deepEqual(listSessionFiles([dir], ["*/node_modules/*"]), [join(dir, "sub", "keep.jsonl")]);
});

test("listSessionFiles returns nothing for a missing directory", () => {
  const dir = makeTempDir();
  assert.deepEqual(listSessionFiles([join(dir, "nope")], []), []);
});

test("readLinesFrom leaves a partial trailing line for the next read", () => {
  const dir = makeTempDir();
  const file = join(dir, "partial.jsonl");
  const first = '{"type":"message","id":"m1"}';
  writeFileSync(file, `${first}\n{"type":"mes`, "utf8");

  const head = readLinesFrom(file, 0);
  assert.deepEqual(head.lines, [first]);

  writeFileSync(file, `${first}\n{"type":"message","id":"m2"}\n`, "utf8");
  const next = readLinesFrom(file, head.nextOffset);
  assert.deepEqual(next.lines, ['{"type":"message","id":"m2"}']);
});

test("readLinesFrom returns nothing for a missing file", () => {
  const dir = makeTempDir();
  assert.deepEqual(readLinesFrom(join(dir, "gone.jsonl"), 0), { lines: [], nextOffset: 0 });
});

test("file state round trips and rejects a corrupt record", () => {
  const dir = makeTempDir();
  const store = openStore(dir);
  const file = join(dir, "s.jsonl");

  assert.equal(readFileState(store, file), null);
  writeFileState(store, file, { offset: 12, size: 34, mtimeMs: 56 });
  assert.deepEqual(readFileState(store, file), { offset: 12, size: 34, mtimeMs: 56 });

  store.setMetaString(fileStateKey(file), "not json");
  assert.equal(readFileState(store, file), null);
  store.close();
});
