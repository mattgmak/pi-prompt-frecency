import { strict as assert } from "node:assert";
import { existsSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";

import type { ExtensionAPI, ExtensionContext, InputEvent, Theme } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager, TUI } from "@earendil-works/pi-tui";

import extension, { capture, openPicker, parseCommandArgs, resolveRuntime, seedQuery } from "../index.ts";
import { GLOBAL_SCOPE } from "../src/db.ts";
import type { PickerResult } from "../src/picker.ts";
import { makeTempDir, openStore } from "./helpers.ts";

/** Config for the whole file. PF_CONFIG wins, so the test never touches the real database. */
const root = makeTempDir();
const configPath = join(root, "config.json");
writeFileSync(
  configPath,
  JSON.stringify({
    dbPath: join(root, "extension.db"),
    sessionDirs: [root],
    shortcut: "ctrl+k",
    commandName: "prompt-frecency",
    logLevel: "silent",
  }),
  "utf8",
);
process.env.PF_CONFIG = configPath;

interface FakePi {
  api: ExtensionAPI;
  shortcuts: string[];
  commands: string[];
  events: string[];
}

/** Minimal ExtensionAPI that records what the entry registers. */
function fakePi(): FakePi {
  const fake = {
    shortcuts: [] as string[],
    commands: [] as string[],
    events: [] as string[],
  };
  const api = {
    registerShortcut(key: string): void {
      fake.shortcuts.push(key);
    },
    registerCommand(name: string): void {
      fake.commands.push(name);
    },
    on(event: string): void {
      fake.events.push(event);
    },
  } as unknown as ExtensionAPI;
  return { api, ...fake };
}

/** Context with only the two members capture reads. */
function stubContext(cwd: string, sessionFile: string): ExtensionContext {
  return {
    cwd,
    sessionManager: { getSessionFile: () => sessionFile },
  } as unknown as ExtensionContext;
}

function inputEvent(source: "interactive" | "rpc" | "extension", text: string): InputEvent {
  return { type: "input", text, source };
}

/**
 * TUI context whose overlay factory is called at once and answered with a fixed
 * result. It records every editor write.
 */
function fakeTuiContext(
  editorText: string,
  result: PickerResult,
): { ctx: ExtensionContext; calls: string[]; line: (index: number) => string } {
  const calls: string[] = [];
  let frame: string[] = [];
  const ui = {
    theme: undefined,
    notify: () => {
      calls.push("notify");
    },
    getEditorText: () => editorText,
    setEditorText: (text: string) => {
      calls.push(`set:${text}`);
    },
    pasteToEditor: (text: string) => {
      calls.push(`paste:${text}`);
    },
    custom: (
      factory: (
        tui: TUI,
        theme: Theme,
        keybindings: KeybindingsManager,
        done: (value: PickerResult) => void,
      ) => { render(width: number): string[] },
    ) => {
      frame = factory(
        {} as TUI,
        undefined as unknown as Theme,
        undefined as unknown as KeybindingsManager,
        () => undefined,
      ).render(80);
      return Promise.resolve(result);
    },
  };
  const ctx = {
    mode: "tui",
    cwd: "/repo",
    sessionManager: { getSessionFile: () => "/s.jsonl" },
    ui,
  } as unknown as ExtensionContext;
  const rows = () => frame.filter((line) => line.trim().length > 0);
  return { ctx, calls, line: (index: number) => rows()[index] ?? "" };
}

test("the picker query comes from the composer text", async () => {
  const fake = fakeTuiContext("commit\nand   push", { action: "cancel" });
  await openPicker(fake.ctx);
  assert.ok(fake.line(2).includes("commit and push"));
  assert.deepEqual(fake.calls, []);
});

test("enter replaces the composer text with the picked prompt", async () => {
  const typed = fakeTuiContext("commit", { action: "accept", text: "commit and push" });
  await openPicker(typed.ctx);
  assert.deepEqual(typed.calls, ["set:commit and push"]);
  const empty = fakeTuiContext("", { action: "accept", text: "commit and push" });
  await openPicker(empty.ctx);
  assert.deepEqual(empty.calls, ["set:commit and push"]);
});

test("an explicit query wins over the composer text", async () => {
  const fake = fakeTuiContext("commit", { action: "cancel" });
  await openPicker(fake.ctx, "global", "fix tests");
  assert.ok(fake.line(2).includes("fix tests"));
});

test("the entry registers the shortcut, the command, and two handlers", () => {
  const { api, shortcuts, commands, events } = fakePi();
  extension(api);
  assert.deepEqual(shortcuts, ["ctrl+k"]);
  assert.deepEqual(commands, ["prompt-frecency"]);
  assert.deepEqual(events.sort(), ["input", "session_start"]);
  assert.ok(existsSync(join(root, "extension.db")));
});

test("command args split into a scope and a query", () => {
  assert.deepEqual(parseCommandArgs("cwd commit push"), { scope: "cwd", query: "commit push" });
  assert.deepEqual(parseCommandArgs("session"), { scope: "session", query: "" });
  assert.deepEqual(parseCommandArgs("global fix"), { scope: "global", query: "fix" });
});

test("command args without a scope word stay a plain query", () => {
  assert.deepEqual(parseCommandArgs("commit push"), { query: "commit push" });
  assert.deepEqual(parseCommandArgs("   "), { query: "" });
  assert.deepEqual(parseCommandArgs("globally fix"), { query: "globally fix" });
});

test("seedQuery folds composer text into one line and caps it", () => {
  const store = openStore(makeTempDir());
  assert.equal(seedQuery("commit\nand   push", store.config), "commit and push");
  assert.equal(seedQuery("   ", store.config), "");
  assert.equal(seedQuery("commit and push", { ...store.config, maxPromptChars: 6 }), "commit");
  store.close();
});

test("resolveRuntime uses the configured runtime", () => {
  const store = openStore(makeTempDir());
  assert.equal(resolveRuntime({ ...store.config, runtime: "bun" }), "bun");
  assert.equal(resolveRuntime({ ...store.config, runtime: "/usr/bin/deno" }), "/usr/bin/deno");
  store.close();
});

test("resolveRuntime prefers the running executable", () => {
  const store = openStore(makeTempDir());
  const found = resolveRuntime({ ...store.config, runtime: null });
  store.close();
  const base = basename(process.execPath);
  if (base === "node" || base === "bun" || base === "deno") {
    assert.equal(found, process.execPath);
    return;
  }
  assert.ok(found === null || found.length > 0);
});

test("capture records an interactive prompt", () => {
  const dir = makeTempDir();
  const store = openStore(dir);
  capture(store.config, store, inputEvent("interactive", "commit and push"), stubContext("/repo", "/s.jsonl"));
  assert.deepEqual(store.candidates(GLOBAL_SCOPE, 10).map((row) => row.text), ["commit and push"]);
  store.close();
});

test("capture ignores rpc and extension input", () => {
  const dir = makeTempDir();
  const store = openStore(dir);
  capture(store.config, store, inputEvent("rpc", "hello there"), stubContext("/repo", "/s.jsonl"));
  capture(store.config, store, inputEvent("extension", "hello there"), stubContext("/repo", "/s.jsonl"));
  assert.equal(store.candidates(GLOBAL_SCOPE, 10).length, 0);
  store.close();
});

test("capture ignores a slash command and text below the minimum length", () => {
  const dir = makeTempDir();
  const store = openStore(dir);
  capture(store.config, store, inputEvent("interactive", "/help"), stubContext("/repo", "/s.jsonl"));
  capture(store.config, store, inputEvent("interactive", "ok"), stubContext("/repo", "/s.jsonl"));
  assert.equal(store.candidates(GLOBAL_SCOPE, 10).length, 0);
  store.close();
});

test("capture swallows a database failure", () => {
  const dir = makeTempDir();
  const store = openStore(dir);
  store.close();
  assert.doesNotThrow(() =>
    capture(store.config, store, inputEvent("interactive", "commit and push"), stubContext("/repo", "/s.jsonl")),
  );
});
