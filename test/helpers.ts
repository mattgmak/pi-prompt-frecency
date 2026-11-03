/**
 * Test helpers for the pi-prompt-frecency suite.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HOME_DEFAULTS, type FrecencyConfig } from "../src/config.ts";
import { PromptStore } from "../src/db.ts";
import { hashPrompt } from "../src/text.ts";

let counter = 0;

/** Fresh temp dir for one test file. */
export function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pf-test-"));
}

/** Remove a temp dir made by makeTempDir. */
export function removeTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Store backed by a fresh database file inside dir. One database file per test
 * keeps counts isolated.
 */
export function openStore(dir: string, overrides: Partial<FrecencyConfig> = {}): PromptStore {
  counter += 1;
  const config: FrecencyConfig = {
    ...HOME_DEFAULTS,
    dbPath: join(dir, `db-${counter}.db`),
    ...overrides,
  };
  return new PromptStore(config);
}

/** Write a session file and return its path. */
export function writeSession(dir: string, name: string, lines: readonly string[]): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
  return file;
}

/** Session header line with a cwd. */
export function headerLine(cwd: string): string {
  return JSON.stringify({
    type: "session",
    version: 3,
    id: "session-one",
    timestamp: "2026-11-01T10:00:00.000Z",
    cwd,
  });
}

/** User message line with an ISO timestamp. */
export function userLine(text: string, at: string): string {
  return JSON.stringify({
    type: "message",
    id: `m-${hashPrompt(text).slice(0, 8)}`,
    parentId: null,
    timestamp: at,
    message: { role: "user", content: text },
  });
}

/** User message line built from content parts instead of one string. */
export function userPartsLine(parts: readonly string[], at: string): string {
  return JSON.stringify({
    type: "message",
    id: `p-${hashPrompt(parts.join("")).slice(0, 8)}`,
    parentId: null,
    timestamp: at,
    message: { role: "user", content: parts.map((text) => ({ type: "text", text })) },
  });
}

/** Assistant message line, which the scanner must skip. */
export function assistantLine(text: string, at: string): string {
  return JSON.stringify({
    type: "message",
    id: `a-${hashPrompt(text).slice(0, 8)}`,
    parentId: null,
    timestamp: at,
    message: { role: "assistant", content: text },
  });
}
