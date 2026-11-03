#!/usr/bin/env node
/**
 * Command line entry for pi-prompt-frecency.
 *
 * pi spawns this file as a detached child for the first index run. It also works
 * on its own: `node cli.ts query "refac"` prints ranked matches.
 */
import { parseArgs } from "node:util";
import { resolve } from "node:path";

import { loadConfig } from "./src/config.ts";
import type { ScopeName } from "./src/config.ts";
import {
  GLOBAL_SCOPE,
  PromptStore,
  getScanState,
  scopeKeyFor,
  setScanState,
  type UsageRow,
} from "./src/db.ts";
import { fuzzyFilter } from "./src/fuzzy.ts";
import { scanAll } from "./src/scan.ts";
import { scoreOf } from "./src/score.ts";

const USAGE = `pi-prompt-frecency <command> [options]

Commands
  index              Index new session files into the database (default)
  stats              Show row counts and the top global prompts
  query <pattern>    Fuzzy search stored prompts, best match first
  add <text>         Record one prompt send
  state              Show the index state

Options
  --db <path>        Database file (overrides config)
  --scope <name>     global | cwd | session (default global)
  --cwd <path>       cwd for scope resolution (default process.cwd())
  --session <path>   Session file for scope resolution
  --limit <n>        Candidate limit (default from config)
  --at <iso|epoch>   Timestamp for add (default now)
  --full             Ignore stored file cursors and read every file again
  --json             Print machine readable output where supported
`;

function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function parseAt(raw: string | undefined): number {
  if (raw === undefined) return Math.floor(Date.now() / 1000);
  const epoch = Number(raw);
  if (Number.isFinite(epoch)) return Math.floor(epoch);
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) fail(`invalid --at value: ${raw}`);
  return Math.floor(parsed / 1000);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    db: { type: "string" },
    scope: { type: "string" },
    cwd: { type: "string" },
    session: { type: "string" },
    limit: { type: "string" },
    at: { type: "string" },
    full: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  },
});

const command = positionals[0] ?? "index";
const config = loadConfig();
if (values.db) config.dbPath = resolve(values.db);

const scopeName = (values.scope ?? config.defaultScope) as ScopeName;
const cwdValue = values.cwd ?? process.cwd();
const sessionValue = values.session ?? "";
const limitValue = values.limit ? Number(values.limit) : config.candidateLimit;

const store = new PromptStore(config);
const now = Math.floor(Date.now() / 1000);

if (command === "index") {
  const result = scanAll(store, config, { force: values.full });
  setScanState(store, "done");
  const payload = { ...result, dbPath: config.dbPath };
  process.stdout.write(values.json ? `${JSON.stringify(payload)}\n` : summarizeIndex(payload));
} else if (command === "state") {
  process.stdout.write(`${getScanState(store)}\n`);
} else if (command === "stats") {
  process.stdout.write(summarizeStats(store, now, values.json));
} else if (command === "query") {
  const pattern = positionals.slice(1).join(" ");
  if (!pattern) fail("query needs a pattern");
  const scope = scopeKeyFor(scopeName, cwdValue, sessionValue) ?? GLOBAL_SCOPE;
  const rows = store.candidates(scope, limitValue);
  const matched = fuzzyFilter(rows, pattern, (row) => row.text);
  process.stdout.write(summarizeRows(matched, now, values.json));
} else if (command === "add") {
  const text = positionals.slice(1).join(" ");
  if (!text) fail("add needs text");
  const applied = store.recordUse({
    text,
    at: parseAt(values.at),
    cwd: cwdValue,
    session: sessionValue,
  });
  process.stdout.write(`${applied ? "recorded" : "skipped"}\n`);
} else {
  process.stdout.write(USAGE);
  process.exit(command === "help" ? 0 : 1);
}

store.close();

function summarizeIndex(payload: { files: number; bytes: number; events: number }): string {
  const lines = [
    `files  ${payload.files}`,
    `bytes  ${payload.bytes}`,
    `groups ${payload.events}`,
    `db     ${config.dbPath}`,
  ];
  return `${lines.join("\n")}\n`;
}

function summarizeStats(store: PromptStore, now: number, json: boolean): string {
  const counts = store.all<{ n: number }>("SELECT COUNT(*) AS n FROM prompts");
  const scopes = store.all<{ scope: string; n: number; top: number }>(
    `SELECT scope, COUNT(*) AS n, MAX(rank) AS top FROM usages
     GROUP BY scope ORDER BY n DESC LIMIT 20`,
  );
  const top = store
    .candidates(GLOBAL_SCOPE, 10)
    .map((row) => `${scoreOf(row.rank, row.last_used, now).toFixed(1)}\t${clip(row.text)}`);

  if (json) {
    return `${JSON.stringify({ prompts: counts[0]?.n ?? 0, scopes, top }, null, 2)}\n`;
  }
  const lines = [`prompts  ${counts[0]?.n ?? 0}`, "scopes"];
  for (const scope of scopes) lines.push(`  ${scope.scope.padEnd(24)} ${scope.n}`);
  lines.push("top");
  for (const line of top) lines.push(`  ${line}`);
  return `${lines.join("\n")}\n`;
}

function summarizeRows(rows: UsageRow[], now: number, json: boolean): string {
  if (json) return `${JSON.stringify(rows, null, 2)}\n`;
  if (rows.length === 0) return "no match\n";
  return `${rows.map((row) => `${scoreOf(row.rank, row.last_used, now).toFixed(1)}\t${clip(row.text)}`).join("\n")}\n`;
}

function clip(text: string, width = 100): string {
  const flat = text.replace(/\s+/g, " ");
  return flat.length <= width ? flat : `${flat.slice(0, width - 1)}\u2026`;
}
