import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type ScopeName = "global" | "cwd" | "session";

export interface FrecencyConfig {
  /** SQLite file. */
  dbPath: string;
  /** Session directories to index. Defaults to the pi agent session dir. */
  sessionDirs: string[];
  /** Shortcut that opens the picker. */
  shortcut: string;
  /** Slash command name. */
  commandName: string;
  /** Scopes the picker cycles through with tab and shift-tab. */
  scopes: ScopeName[];
  /** Scope the picker opens on. */
  defaultScope: ScopeName;
  /** Rows fetched from SQL before the fuzzy pass. */
  candidateLimit: number;
  /** Rows the picker shows at once. */
  visibleRows: number;
  /** Shorter prompts are not stored. */
  minPromptLength: number;
  /** Longest stored prompt in characters. */
  maxPromptChars: number;
  /** zoxide maxage: total rank budget per scope. */
  maxAge: number;
  /** Two sends of one prompt inside this window count once. */
  dedupeWindowSec: number;
  /** Glob patterns for session files to skip. */
  ignorePatterns: string[];
  /** Text prefixes that mark an injected message instead of a typed prompt. */
  ignorePrefixes: string[];
  /** Glob patterns for working directories to skip. */
  excludeCwdPatterns: string[];
  /** Run the first index job on first launch. */
  indexOnStart: boolean;
  /** Command used to run the indexer child. Auto-detected when null. */
  runtime: string | null;
  /** Log level for the extension and indexer. */
  logLevel: "info" | "warn" | "error" | "silent";
  /** Log file. Empty string disables the file log. */
  logPath: string;
}

const REPO_DIR = dirname(fileURLToPath(import.meta.url));

export const HOME_DEFAULTS: FrecencyConfig = {
  dbPath: "",
  sessionDirs: [],
  shortcut: "ctrl+k",
  commandName: "prompt-frecency",
  scopes: ["global", "cwd", "session"],
  defaultScope: "global",
  candidateLimit: 500,
  visibleRows: 12,
  minPromptLength: 4,
  maxPromptChars: 8000,
  maxAge: 10000,
  dedupeWindowSec: 5,
  ignorePatterns: ["*/node_modules/*", "*/.git/*"],
  ignorePrefixes: ["<file name=", "<system-reminder>", "<task>", "<command-name>"],
  excludeCwdPatterns: [],
  indexOnStart: true,
  runtime: null,
  logLevel: "info",
  logPath: "",
};

/** pi agent dir: PI_CODING_AGENT_DIR, else ~/.pi/agent. */
export function agentDir(): string {
  const fromEnv = process.env.PI_CODING_AGENT_DIR;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return join(homedir(), ".pi", "agent");
}

/** Default data dir: XDG_DATA_HOME, else ~/.local/share. */
function dataDir(): string {
  const fromEnv = process.env.XDG_DATA_HOME;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return join(homedir(), ".local", "share");
}

function readJson(path: string): Partial<FrecencyConfig> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Partial<FrecencyConfig>;
  } catch {
    return null;
  }
}

/**
 * Config files, lowest precedence first.
 *
 * `extensions/pi-prompt-frecency.json` in the agent dir is the active copy that
 * home-manager or `pi` writes. `<repo>/config.json` overrides it for
 * development. `PF_CONFIG` overrides both.
 */
export function configFilePaths(): string[] {
  const paths = [
    join(agentDir(), "extensions", "pi-prompt-frecency.json"),
    join(REPO_DIR, "config.json"),
  ];
  const fromEnv = process.env.PF_CONFIG;
  if (fromEnv && fromEnv.length > 0) paths.push(resolve(fromEnv));
  return paths;
}

export function loadConfig(): FrecencyConfig {
  let merged: Partial<FrecencyConfig> = {};
  for (const path of configFilePaths()) {
    const found = readJson(path);
    if (found) merged = { ...merged, ...found };
  }
  const config = { ...HOME_DEFAULTS, ...merged } as FrecencyConfig;

  if (!config.dbPath) config.dbPath = join(dataDir(), "pi-prompt-frecency", "prompts.db");
  if (config.sessionDirs.length === 0) config.sessionDirs = [join(agentDir(), "sessions")];
  if (!config.logPath) config.logPath = join(dataDir(), "pi-prompt-frecency", "extension.log");
  config.sessionDirs = config.sessionDirs.map((dir) => resolve(dir.replace(/^~/, homedir())));
  config.dbPath = resolve(config.dbPath.replace(/^~/, homedir()));
  return config;
}

/** Compile one glob into a RegExp. Supports `**`, `*`, and `?`. */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (char === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(char)) {
      out += `\\${char}`;
    } else {
      out += char;
    }
  }
  return new RegExp(`^${out}$`);
}

/** True when any pattern matches the path. */
export function matchesAny(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(path));
}
