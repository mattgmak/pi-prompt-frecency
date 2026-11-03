import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import type { FrecencyConfig, ScopeName } from "./config.ts";
import { ageFactor, clampRank, DROP_RANK, MAX_RANK, MIN_RANK, scoreOf } from "./score.ts";
import { hashPrompt, isStorablePrompt, promptIdentity } from "./text.ts";

/** One prompt send. `at` is epoch seconds. */
export interface PromptEvent {
  text: string;
  at: number;
  session: string;
  cwd: string;
}

export interface UsageRow {
  hash: string;
  scope: string;
  uses: number;
  last_used: number;
  rank: number;
  text: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS prompts (
  hash TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  first_used INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS usages (
  hash TEXT NOT NULL,
  scope TEXT NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0,
  last_used INTEGER NOT NULL,
  rank REAL NOT NULL,
  PRIMARY KEY (hash, scope)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS usages_scope_rank ON usages (scope, rank DESC);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;
`;

/** Scope key for the global aggregate. */
export const GLOBAL_SCOPE = "g";

/** Scope key for one working directory. */
export function cwdScopeKey(cwd: string): string {
  return `c:${cwd}`;
}

/** Scope key for one session file. */
export function sessionScopeKey(session: string): string {
  return `s:${session}`;
}

/** Scope key for a scope name, or null when the value it needs is unknown. */
export function scopeKeyFor(name: ScopeName, cwd: string, session: string): string | null {
  if (name === "global") return GLOBAL_SCOPE;
  if (name === "cwd") return cwd ? cwdScopeKey(cwd) : null;
  return session ? sessionScopeKey(session) : null;
}

/**
 * SQLite store for prompt usage.
 *
 * One `prompts` row holds the text. One `usages` row holds the count, the last
 * used time, and the rank for one scope of that prompt. A prompt send writes up
 * to three `usages` rows: global, cwd, and session. Every scope is queried and
 * scored with the same code, which follows the zoxide design of one record type
 * with one score function.
 */
export class PromptStore {
  readonly config: FrecencyConfig;
  private db: DatabaseSync;
  private insertPrompt: StatementSync;
  private findUsage: StatementSync;
  private upsertUsage: StatementSync;
  private getMeta: StatementSync;
  private setMeta: StatementSync;
  private selectScope: StatementSync;

  constructor(config: FrecencyConfig) {
    this.config = config;
    mkdirSync(dirname(config.dbPath), { recursive: true });
    this.db = new DatabaseSync(config.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA temp_store = MEMORY");
    this.db.exec("PRAGMA user_version = 1");
    this.db.exec(SCHEMA);

    this.insertPrompt = this.db.prepare(
      "INSERT OR IGNORE INTO prompts (hash, text, first_used) VALUES (?, ?, ?)",
    );
    this.findUsage = this.db.prepare(
      "SELECT uses, last_used, rank FROM usages WHERE hash = ? AND scope = ?",
    );
    this.upsertUsage = this.db.prepare(
      `INSERT INTO usages (hash, scope, uses, last_used, rank) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(hash, scope) DO UPDATE SET
         uses = usages.uses + excluded.uses,
         last_used = MAX(usages.last_used, excluded.last_used),
         rank = MIN(?, MAX(?, usages.rank + excluded.rank))`,
    );
    this.getMeta = this.db.prepare("SELECT value FROM meta WHERE key = ?");
    this.setMeta = this.db.prepare(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    this.selectScope = this.db.prepare(
      `SELECT u.hash, u.scope, u.uses, u.last_used, u.rank, p.text
       FROM usages u JOIN prompts p ON p.hash = u.hash
       WHERE u.scope = ? ORDER BY u.rank DESC, u.last_used DESC LIMIT ?`,
    );
  }

  close(): void {
    this.db.close();
  }

  /** Run `body` inside one immediate transaction. */
  transaction<T>(body: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = body();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getMetaString(key: string): string | null {
    const row = this.getMeta.get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMetaString(key: string, value: string): void {
    this.setMeta.run(key, value);
  }

  /** Insert a meta row only when the key is absent. */
  setMetaStringIfAbsent(key: string, value: string): void {
    this.db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)").run(key, value);
  }

  /** Run one statement and report how many rows it changed. */
  run(sql: string, params: Array<string | number>): { changes: number } {
    return this.db.prepare(sql).run(...params) as unknown as { changes: number };
  }

  /** Read rows from an ad hoc query. */
  all<T = Record<string, unknown>>(sql: string, params: Array<string | number> = []): T[] {
    return this.db.prepare(sql).all(...params) as unknown as T[];
  }

  getMetaNumber(key: string): number | null {
    const raw = this.getMetaString(key);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  }

  private setMetaNumber(key: string, value: number): void {
    this.setMetaString(key, String(value));
  }

  /**
   * Record prompt sends.
   *
   * Events are grouped by prompt and scope before the write, so a batch of 500
   * events for one prompt costs one statement per scope. A group is skipped when
   * its newest event falls inside the dedupe window of the stored row. Returns
   * the number of groups written.
   */
  applyEvents(events: PromptEvent[], options?: { transaction?: boolean }): number {
    if (events.length === 0) return 0;
    const groups = this.groupEvents(events);
    if (groups.size === 0) return 0;

    const body = (): number => {
      let applied = 0;
      const scopes = new Set<string>();
      for (const group of groups.values()) {
        const written = this.writeGroup(group);
        if (written.length === 0) continue;
        applied++;
        for (const scope of written) scopes.add(scope);
      }
      for (const scope of scopes) this.ageScope(scope);
      return applied;
    };

    if (options?.transaction === false) return body();
    return this.transaction(body);
  }

  /** Record one prompt send. Returns false when the dedupe window skipped it. */
  recordUse(input: { text: string; at?: number; session?: string; cwd?: string }): boolean {
    const at = Math.floor(input.at ?? Date.now() / 1000);
    const events: PromptEvent[] = [
      {
        text: input.text,
        at,
        session: input.session ?? "",
        cwd: input.cwd ?? "",
      },
    ];
    return this.applyEvents(events) > 0;
  }

  /** Rows for one scope, best rank first. */
  candidates(scope: string, limit: number): UsageRow[] {
    return this.selectScope.all(scope, limit) as unknown as UsageRow[];
  }

  /**
   * zoxide `age`: keep the total rank of one scope inside `maxAge`.
   *
   * The total is cached in `meta` instead of summed on every write. When rows
   * drop, the stored total is the exact sum of the ranks that stay.
   */
  private ageScope(scope: string): void {
    const key = `total:${scope}`;
    let total = this.getMetaNumber(key);
    if (total === null) {
      const row = this.db
        .prepare("SELECT COALESCE(SUM(rank), 0) AS total FROM usages WHERE scope = ?")
        .get(scope) as { total: number } | undefined;
      total = row?.total ?? 0;
    }
    const factor = ageFactor(total, this.config.maxAge);
    if (factor === 0) return;

    const rows = this.db.prepare("SELECT hash, rank FROM usages WHERE scope = ?").all(scope) as
      unknown as Array<{ hash: string; rank: number }>;
    let next = 0;
    for (const row of rows) {
      const scaled = row.rank * factor;
      if (scaled < DROP_RANK) {
        this.db.prepare("DELETE FROM usages WHERE hash = ? AND scope = ?").run(row.hash, scope);
      } else {
        this.db
          .prepare("UPDATE usages SET rank = ? WHERE hash = ? AND scope = ?")
          .run(scaled, row.hash, scope);
        next += scaled;
      }
    }
    this.setMetaNumber(key, next);
  }

  /** Current rank total for one scope. */
  scopeTotal(scope: string): number {
    const cached = this.getMetaNumber(`total:${scope}`);
    if (cached !== null) return cached;
    const row = this.db
      .prepare("SELECT COALESCE(SUM(rank), 0) AS total FROM usages WHERE scope = ?")
      .get(scope) as { total: number } | undefined;
    return row?.total ?? 0;
  }

  /**
   * Write one group and return the scope rows it touched.
   *
   * A scope is skipped when the group falls inside the dedupe window of that
   * scope row and carries a single event. The check runs per scope, so a prompt
   * sent in two directories still records one use in each.
   */
  private writeGroup(group: EventGroup): string[] {
    const rank = clampRank(group.count);
    const scopes: string[] = [];
    for (const scope of group.scopes) {
      const existing = this.findUsage.get(group.hash, scope) as
        | { last_used: number }
        | undefined;
      if (
        existing &&
        group.at - existing.last_used < this.config.dedupeWindowSec &&
        group.count === 1
      ) {
        continue;
      }
      scopes.push(scope);
    }
    if (scopes.length === 0) return [];

    this.insertPrompt.run(group.hash, group.text, group.firstAt);
    for (const scope of scopes) {
      this.upsertUsage.run(group.hash, scope, group.count, group.at, rank, MAX_RANK, MIN_RANK);
    }
    return scopes;
  }

  /**
   * Group events by prompt identity plus origin.
   *
   * The key holds cwd and session because the usage row is per scope. Two sends
   * of one prompt from two directories become two groups, and each writes its
   * own global, cwd, and session rows.
   */
  private groupEvents(events: PromptEvent[]): Map<string, EventGroup> {
    const groups = new Map<string, EventGroup>();
    for (const event of events) {
      const text = promptIdentity(event.text);
      if (!isStorablePrompt(text, this.config.minPromptLength, this.config.ignorePrefixes)) {
        continue;
      }
      if (text.length > this.config.maxPromptChars) continue;
      const hash = hashPrompt(text);
      const key = `${hash}\u0000${event.cwd}\u0000${event.session}`;
      const existing = groups.get(key);
      if (existing) {
        existing.count++;
        if (event.at < existing.firstAt) existing.firstAt = event.at;
        if (event.at > existing.at) existing.at = event.at;
        continue;
      }
      const scopes = scopeList(event.cwd, event.session);
      groups.set(key, {
        hash,
        text,
        count: 1,
        at: event.at,
        firstAt: event.at,
        scopes,
      });
    }
    return groups;
  }
}

interface EventGroup {
  hash: string;
  text: string;
  count: number;
  /** Newest event time. */
  at: number;
  /** Oldest event time. */
  firstAt: number;
  /** Scope rows to write: global, plus cwd and session when known. */
  scopes: string[];
}

function scopeList(cwd: string, session: string): string[] {
  const scopes = [GLOBAL_SCOPE];
  if (cwd) scopes.push(cwdScopeKey(cwd));
  if (session) scopes.push(sessionScopeKey(session));
  return scopes;
}

/** Current index state of this database. */
export type ScanState = "uninitialized" | "pending" | "running" | "done" | "failed";

export const SCAN_STATE_KEY = "scan_state";

export function getScanState(store: PromptStore): ScanState {
  const raw = store.getMetaString(SCAN_STATE_KEY);
  if (raw === null) return "uninitialized";
  if (
    raw === "pending" ||
    raw === "running" ||
    raw === "done" ||
    raw === "failed"
  ) {
    return raw;
  }
  return "uninitialized";
}

export function setScanState(store: PromptStore, state: ScanState): void {
  store.setMetaString(SCAN_STATE_KEY, state);
}

/**
 * Claim a pending index run.
 *
 * One process wins because the update only matches a row that still says
 * `pending`. The first launch seeds that row with `INSERT OR IGNORE`, so a
 * second pi process cannot start a second run.
 */
export function claimIndexRun(store: PromptStore): boolean {
  store.setMetaStringIfAbsent(SCAN_STATE_KEY, "pending");
  const result = store.run(
    "UPDATE meta SET value = 'running' WHERE key = ? AND value = 'pending'",
    [SCAN_STATE_KEY],
  );
  return result.changes === 1;
}

/** Display score for a row. */
export function displayScore(row: UsageRow, now: number): number {
  return scoreOf(row.rank, row.last_used, now);
}
