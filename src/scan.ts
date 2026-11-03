import {
  closeSync,
  fstatSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

import type { FrecencyConfig } from "./config.ts";
import { matchesAny } from "./config.ts";
import type { PromptEvent } from "./db.ts";
import { PromptStore } from "./db.ts";
import { normalizePrompt } from "./text.ts";

const CHUNK_SIZE = 65536;

/** Header line of a pi session file. */
interface SessionHeader {
  type?: string;
  version?: number;
  id?: string;
  timestamp?: string;
  cwd?: string;
}

/** One line of a session file. */
interface SessionLine {
  type?: string;
  timestamp?: string;
  message?: { role?: string; content?: unknown };
}

/** Stored read cursor for one session file. */
export interface FileState {
  offset: number;
  size: number;
  mtimeMs: number;
}

export interface ScanResult {
  files: number;
  bytes: number;
  events: number;
}

export function fileStateKey(file: string): string {
  return `file:${file}`;
}

export function readFileState(store: PromptStore, file: string): FileState | null {
  const raw = store.getMetaString(fileStateKey(file));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as FileState;
    if (typeof parsed.offset !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeFileState(store: PromptStore, file: string, state: FileState): void {
  store.setMetaString(fileStateKey(file), JSON.stringify(state));
}

/** List session JSONL files under each directory, skipping ignored patterns. */
export function listSessionFiles(dirs: string[], ignorePatterns: string[]): string[] {
  const files: string[] = [];
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir, { recursive: true, encoding: "utf8" }) as string[];
    } catch {
      continue;
    }
    for (const entry of entries) {
      const file = join(dir, entry);
      let stats;
      try {
        stats = statSync(file);
      } catch {
        continue;
      }
      if (!stats.isFile() || !file.endsWith(".jsonl")) continue;
      // Patterns are written against the relative layout, so check both forms.
      if (matchesAny(file, ignorePatterns) || matchesAny(entry, ignorePatterns)) continue;
      files.push(file);
    }
  }
  return files;
}

/**
 * Read complete lines after `offset`.
 *
 * A session file only grows, so a rescan reads the new tail only. The returned
 * offset covers complete lines, which leaves a partial last line for the next
 * read.
 */
export function readLinesFrom(file: string, offset: number): { lines: string[]; nextOffset: number } {
  let fd;
  try {
    fd = openSync(file, "r");
  } catch {
    return { lines: [], nextOffset: offset };
  }
  try {
    const size = fstatSync(fd).size;
    if (size <= offset) return { lines: [], nextOffset: Math.min(offset, size) };
    const buffer = Buffer.alloc(CHUNK_SIZE);
    const lines: string[] = [];
    let position = offset;
    let pending = "";
    while (position < size) {
      const bytesRead = readSync(fd, buffer, 0, Math.min(CHUNK_SIZE, size - position), position);
      if (bytesRead <= 0) break;
      position += bytesRead;
      const chunk = pending + buffer.toString("utf8", 0, bytesRead);
      const parts = chunk.split("\n");
      pending = parts.pop() ?? "";
      for (const part of parts) {
        if (part.length > 0) lines.push(part.replace(/\r$/, ""));
      }
    }
    // The bytes of the trailing partial line stay unread until the next append.
    const consumed = position - Buffer.byteLength(pending, "utf8");
    return { lines, nextOffset: consumed };
  } finally {
    closeSync(fd);
  }
}

/**
 * Read the header line of a session file.
 *
 * The header is line one and holds the cwd. A rescan that starts past line one
 * still needs it, so it is read on its own.
 */
export function readHeaderCwd(file: string): string {
  const { lines } = readLinesFrom(file, 0);
  const first = lines[0];
  if (first === undefined || !first.startsWith('{"type":"session"')) return "";
  try {
    const header = JSON.parse(first) as SessionHeader;
    return typeof header.cwd === "string" ? header.cwd : "";
  } catch {
    return "";
  }
}

/** Text of a message content field, which is a string or an array of parts. */
function extractText(content: unknown): string {
  if (typeof content === "string") return normalizePrompt(content);
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (part === null || typeof part !== "object") continue;
    const entry = part as { type?: unknown; text?: unknown };
    if (entry.type === "text" && typeof entry.text === "string") parts.push(entry.text);
  }
  return normalizePrompt(parts.join("\n"));
}

/**
 * Parse one session file into prompt events.
 *
 * The header line carries the cwd. Each `message` line with role `user` becomes
 * one event stamped with the line timestamp.
 */
export function eventsFromLines(lines: string[], file: string, headerCwd: string): PromptEvent[] {
  const events: PromptEvent[] = [];
  let cwd = headerCwd;
  for (const line of lines) {
    if (line.startsWith('{"type":"session"')) {
      const header = JSON.parse(line) as SessionHeader;
      if (typeof header.cwd === "string") cwd = header.cwd;
      continue;
    }
    if (!line.startsWith('{"type":"message"')) continue;
    const parsed = JSON.parse(line) as SessionLine;
    if (parsed.message?.role !== "user") continue;
    const text = extractText(parsed.message.content);
    if (text.length === 0) continue;
    const at = parsed.timestamp ? Date.parse(parsed.timestamp) : Number.NaN;
    if (Number.isNaN(at)) continue;
    events.push({ text, at: Math.floor(at / 1000), session: file, cwd });
  }
  return events;
}

/**
 * Index session files into the store.
 *
 * Files with an unchanged size and mtime are skipped. Each file that is read
 * costs one transaction, and its cursor is stored with the same commit.
 */
export function scanAll(store: PromptStore, config: FrecencyConfig, options?: { force?: boolean }): ScanResult {
  const files = listSessionFiles(config.sessionDirs, config.ignorePatterns);
  const result: ScanResult = { files: 0, bytes: 0, events: 0 };

  for (const file of files) {
    const stats = statSync(file);
    const state = options?.force ? null : readFileState(store, file);
    const unchanged =
      state !== null && state.size === stats.size && state.mtimeMs === stats.mtimeMs;
    if (unchanged) continue;
    const resume = state && stats.size > state.size;
    const offset = resume ? state.offset : 0;

    const { lines, nextOffset } = readLinesFrom(file, offset);
    const headerCwd = resume ? readHeaderCwd(file) : "";
    const events = eventsFromLines(lines, file, headerCwd);
    const applied = store.transaction(() => {
      const count = store.applyEvents(events, { transaction: false });
      writeFileState(store, file, {
        offset: nextOffset,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
      });
      return count;
    });

    result.files++;
    result.bytes += Math.max(0, nextOffset - offset);
    result.events += applied;
  }
  return result;
}
