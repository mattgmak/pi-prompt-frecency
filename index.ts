#!/usr/bin/env node
/**
 * pi extension entry for Prompt Frecency.
 *
 * Binds ctrl+k and /prompt-frecency to the fuzzy picker. Records every typed
 * prompt into the SQLite store and starts the one-time index job on first launch.
 */

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";

import { loadConfig, type FrecencyConfig, type ScopeName } from "./src/config.ts";
import { PromptStore, claimIndexRun, getScanState, setScanState } from "./src/db.ts";
import { PromptPicker, type PickerResult, type PickerSource } from "./src/picker.ts";
import { scanAll } from "./src/scan.ts";
import { collapseWhitespace, isStorablePrompt } from "./src/text.ts";

const REPO_DIR = dirname(fileURLToPath(import.meta.url));
const RUNTIMES = ["node", "bun", "deno"];

interface Shared {
  config: FrecencyConfig;
  store: PromptStore | null;
}

let shared: Shared | null = null;

/** Load config and open the database once per process. A bad database disables the extension. */
function load(): Shared {
  if (shared === null) {
    const config = loadConfig();
    let store: PromptStore | null = null;
    try {
      store = new PromptStore(config);
    } catch (error) {
      writeLog(config, `database open failed: ${String(error)}`);
    }
    shared = { config, store };
  }
  return shared;
}

/** Write one line to the log file. A missing file must not break the extension. */
function writeLog(config: FrecencyConfig, message: string): void {
  if (config.logLevel === "silent" || config.logPath.length === 0) return;
  try {
    appendFileSync(config.logPath, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // The log is best effort, so a write error has no effect on the extension.
  }
}

/** JS runtime for the detached indexer, or null to index in the current process. */
export function resolveRuntime(config: FrecencyConfig): string | null {
  if (config.runtime) return config.runtime;
  const self = process.execPath;
  if (RUNTIMES.includes(basename(self))) return self;
  for (const name of RUNTIMES) {
    const probe = spawnSync("which", [name], { encoding: "utf8" });
    if (probe.status !== 0) continue;
    const found = probe.stdout.trim();
    if (found.length > 0) return found;
  }
  return null;
}

/**
 * Start the one-time index job when the database holds no scan state. The child
 * process writes the database while pi stays responsive.
 */
function startIndex(config: FrecencyConfig, store: PromptStore): void {
  if (!config.indexOnStart) return;
  if (getScanState(store) !== "uninitialized") return;
  if (!claimIndexRun(store)) return;
  const runtime = resolveRuntime(config);
  if (runtime === null) {
    indexHere(config, store);
    return;
  }
  const child = spawn(runtime, [join(REPO_DIR, "cli.ts"), "index"], {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => indexHere(config, store));
  child.unref();
  writeLog(config, `index started with ${runtime}`);
}

/** Index in the current process when no JS runtime is available. */
function indexHere(config: FrecencyConfig, store: PromptStore): void {
  try {
    scanAll(store, config);
    setScanState(store, "done");
  } catch (error) {
    setScanState(store, "failed");
    writeLog(config, `index failed: ${String(error)}`);
  }
}

/**
 * Split command args into a scope name and a query. A first word of global, cwd,
 * or session picks the scope.
 */
export function parseCommandArgs(raw: string): { scope?: ScopeName; query: string } {
  const words = raw.trim().split(/\s+/).filter((word) => word.length > 0);
  const first = words[0];
  if (first === "global" || first === "cwd" || first === "session") {
    return { scope: first, query: words.slice(1).join(" ") };
  }
  return { query: words.join(" ") };
}

/**
 * The query the picker opens with for composer text. The composer holds the
 * prompt in its raw form, so the query takes the single line form of it.
 */
export function seedQuery(text: string, config: FrecencyConfig): string {
  return collapseWhitespace(text).slice(0, config.maxPromptChars);
}

/** Open the picker and put the accepted prompt into the editor. */
export async function openPicker(
  ctx: ExtensionContext,
  scope?: ScopeName,
  query?: string,
): Promise<void> {
  const { config, store } = load();
  if (ctx.mode !== "tui" || store === null) {
    ctx.ui.notify("prompt-frecency needs the tui and a readable database", "warning");
    return;
  }
  const seed = query ?? seedQuery(ctx.ui.getEditorText(), config);
  const source: PickerSource = {
    config,
    store,
    cwd: ctx.cwd,
    session: ctx.sessionManager.getSessionFile() ?? "",
    theme: ctx.ui.theme,
  };
  const result = await ctx.ui.custom<PickerResult>(
    (_tui, _theme, _keybindings, done) => new PromptPicker(source, done, scope, seed),
  );
  if (result.action !== "accept" || result.text === undefined) return;
  // The composer text is the picker query, so a pick replaces it.
  ctx.ui.setEditorText(result.text);
}

/**
 * Record one typed prompt. Only interactive text is a real prompt, so the
 * handler skips rpc and extension input.
 */
export function capture(
  config: FrecencyConfig,
  store: PromptStore,
  event: InputEvent,
  ctx: ExtensionContext,
): void {
  if (event.source !== "interactive") return;
  if (!isStorablePrompt(event.text, config.minPromptLength, config.ignorePrefixes)) return;
  try {
    store.recordUse({
      text: event.text,
      cwd: ctx.cwd,
      session: ctx.sessionManager.getSessionFile() ?? "",
    });
  } catch (error) {
    writeLog(config, `record failed: ${String(error)}`);
  }
}

export default function (pi: ExtensionAPI): void {
  const { config, store } = load();

  pi.registerShortcut(config.shortcut as KeyId, {
    description: "Open the prompt frecency picker",
    handler: async (ctx) => {
      await openPicker(ctx, config.defaultScope);
    },
  });

  pi.registerCommand(config.commandName, {
    description: "Search stored prompts by frecency",
    handler: async (args, ctx) => {
      const parsed = parseCommandArgs(args);
      await openPicker(ctx, parsed.scope, parsed.query);
    },
  });

  pi.on("session_start", () => {
    if (store !== null) startIndex(config, store);
  });

  pi.on("input", (event, ctx) => {
    if (store === null) return;
    capture(config, store, event, ctx);
  });
}
