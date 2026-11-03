import {
  type Component,
  Key,
  type KeyId,
  decodeKittyPrintable,
  matchesKey,
} from "@earendil-works/pi-tui";

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { FrecencyConfig, ScopeName } from "./config.ts";
import { type PromptStore, type UsageRow, scopeKeyFor } from "./db.ts";
import { type FuzzyHit, fuzzyFilterDetailed } from "./fuzzy.ts";
import { scoreOf } from "./score.ts";
import { ansiPalette, type CellRole, type PickerPalette, themePalette } from "./theme.ts";

/** What the picker returns when it closes. */
export interface PickerResult {
  action: "accept" | "cancel";
  /** Prompt text for accept. */
  text?: string;
  scope?: ScopeName;
  query?: string;
}

export interface PickerSource {
  config: FrecencyConfig;
  store: PromptStore;
  cwd: string;
  session: string;
  /** Live pi theme. The picker falls back to SGR codes when it is absent. */
  theme?: Theme;
}

type Edit = "left" | "right" | "home" | "end" | "wordLeft" | "wordRight" | "deleteBack" | "deleteForward" | "killWordBack" | "killWordFwd" | "killToStart" | "killToEnd" | "yank";

const EDIT_KEYS = new Map<KeyId, Edit>();
EDIT_KEYS.set(Key.left, "left");
EDIT_KEYS.set(Key.ctrl("b"), "left");
EDIT_KEYS.set(Key.right, "right");
EDIT_KEYS.set(Key.ctrl("f"), "right");
EDIT_KEYS.set(Key.home, "home");
EDIT_KEYS.set(Key.ctrl("a"), "home");
EDIT_KEYS.set(Key.end, "end");
EDIT_KEYS.set(Key.ctrl("e"), "end");
EDIT_KEYS.set(Key.alt("left"), "wordLeft");
EDIT_KEYS.set(Key.alt("b"), "wordLeft");
EDIT_KEYS.set(Key.alt("right"), "wordRight");
EDIT_KEYS.set(Key.alt("f"), "wordRight");
EDIT_KEYS.set(Key.backspace, "deleteBack");
EDIT_KEYS.set(Key.ctrl("h"), "deleteBack");
EDIT_KEYS.set(Key.delete, "deleteForward");
EDIT_KEYS.set(Key.ctrl("d"), "deleteForward");
EDIT_KEYS.set(Key.alt("backspace"), "killWordBack");
EDIT_KEYS.set(Key.ctrl("w"), "killWordBack");
EDIT_KEYS.set(Key.alt("delete"), "killWordFwd");
EDIT_KEYS.set(Key.alt("d"), "killWordFwd");
EDIT_KEYS.set(Key.ctrl("u"), "killToStart");
EDIT_KEYS.set(Key.ctrl("k"), "killToEnd");
EDIT_KEYS.set(Key.ctrl("y"), "yank");

/** The edit for a raw input sequence, or null when the key does not edit text. */
function editFor(data: string): Edit | null {
  for (const [key, edit] of EDIT_KEYS) if (matchesKey(data, key)) return edit;
  return null;
}

/** The chunk a word delete removes from the end of `text`. */
function chunkBefore(text: string): string {
  const found = /([ \t]+|[^ \t]+)$/.exec(text);
  return found?.[0] ?? "";
}

/** The chunk a word delete removes from the start of `text`. */
function chunkAfter(text: string): string {
  const found = /^([ \t]+[^ \t]*|[^ \t]+)/.exec(text);
  return found?.[0] ?? "";
}

/** The column the caret reaches when it moves one word back from the end of `text`. */
function wordStartBefore(text: string): number {
  const head = text.replace(/[ \t]+$/, "");
  const word = /[^ \t]+$/.exec(head);
  if (word === null) return 0;
  return head.length - word[0].length;
}

/** How many columns the caret jumps to reach the end of the next word. */
function wordEndAfter(text: string): number {
  const spaces = /^[ \t]*/.exec(text)?.[0] ?? "";
  const word = /^[^ \t]+/.exec(text.slice(spaces.length))?.[0] ?? "";
  return spaces.length + word.length;
}

/**
 * Fuzzy prompt picker drawn as one component.
 *
 * The component owns the query string, the ranked rows, and the selection. It is
 * built for `ctx.ui.custom`, which needs `render`, `handleInput`, and
 * `invalidate`. A query change re-runs one SQL read plus the fuzzy pass, which
 * costs under a millisecond for 500 rows.
 */
export class PromptPicker implements Component {
  private hits: FuzzyHit<UsageRow>[] = [];
  private query = "";
  private caret = 0;
  private kill = "";
  private cursor = 0;
  private scroll = 0;
  private scope: ScopeName;
  private scopeKey: string;
  private closed = false;
  private readonly palette: PickerPalette;

  private readonly source: PickerSource;
  private readonly onDone: (result: PickerResult) => void;

  constructor(
    source: PickerSource,
    onDone: (result: PickerResult) => void,
    initialScope?: ScopeName,
    initialQuery = "",
  ) {
    const scopes = source.config.scopes;
    this.source = source;
    this.onDone = onDone;
    this.palette = source.theme ? themePalette(source.theme) : ansiPalette;
    this.scope = initialScope && scopes.includes(initialScope) ? initialScope : scopes[0]!;
    this.scopeKey = scopeKeyFor(this.scope, source.cwd, source.session) ?? "g";
    this.query = initialQuery;
    this.caret = initialQuery.length;
    this.refresh();
  }

  /** Re-read candidates for the active scope and rank them by fuzzy score. */
  private refresh(): void {
    const { config, store } = this.source;
    const found = store.candidates(this.scopeKey, config.candidateLimit);
    this.hits = fuzzyFilterDetailed(found, this.query, (row) => display(row.text));
    if (this.cursor >= this.hits.length) this.cursor = Math.max(0, this.hits.length - 1);
    if (this.hits.length === 0) this.cursor = 0;
  }

  private cycleScope(step: number): void {
    const scopes = this.source.config.scopes;
    const index = scopes.indexOf(this.scope);
    const next = ((index < 0 ? 0 : index) + step + scopes.length) % scopes.length;
    const scope = scopes[next]!;
    const key = scopeKeyFor(scope, this.source.cwd, this.source.session);
    if (key === null) return;
    this.scope = scope;
    this.scopeKey = key;
    this.cursor = 0;
    this.scroll = 0;
    this.refresh();
  }

  /** Replace the query and place the caret in it. */
  private setQuery(query: string, caret = query.length): void {
    this.query = query;
    this.caret = Math.max(0, Math.min(caret, query.length));
    this.cursor = 0;
    this.scroll = 0;
    this.refresh();
  }

  /** Move the caret without touching the query. */
  private setCaret(caret: number): void {
    this.caret = Math.max(0, Math.min(caret, this.query.length));
  }

  private accept(): void {
    if (this.closed) return;
    const hit = this.hits[this.cursor];
    if (hit === undefined) {
      this.close({ action: "cancel", scope: this.scope, query: this.query });
      return;
    }
    this.close({ action: "accept", text: hit.item.text, scope: this.scope, query: this.query });
  }

  private close(result: PickerResult): void {
    if (this.closed) return;
    this.closed = true;
    this.onDone(result);
  }

  handleInput(data: string): void {
    if (this.closed) return;
    const cancel = matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"));
    if (cancel) {
      this.close({ action: "cancel", scope: this.scope, query: this.query });
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.accept();
      return;
    }
    if (matchesKey(data, Key.tab)) {
      this.cycleScope(1);
      return;
    }
    if (matchesKey(data, "shift+tab")) {
      this.cycleScope(-1);
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.move(-1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.move(1);
      return;
    }
    const edit = editFor(data);
    if (edit !== null) {
      this.apply(edit);
      return;
    }
    const printable = printableInput(data);
    if (printable === null) return;
    this.setQuery(this.paste(this.query, this.caret, printable), this.caret + 1);
  }

  /** Apply one editing key to the query and its caret. */
  private apply(edit: Edit): void {
    const query = this.query;
    const caret = this.caret;
    switch (edit) {
      case "left":
        this.setCaret(caret - 1);
        break;
      case "right":
        this.setCaret(caret + 1);
        break;
      case "home":
        this.setCaret(0);
        break;
      case "end":
        this.setCaret(query.length);
        break;
      case "wordLeft":
        this.setCaret(wordStartBefore(query.slice(0, caret)));
        break;
      case "wordRight":
        this.setCaret(caret + wordEndAfter(query.slice(caret)));
        break;
      case "deleteBack": {
        if (caret === 0) break;
        this.setQuery(query.slice(0, caret - 1) + query.slice(caret), caret - 1);
        break;
      }
      case "deleteForward": {
        if (caret >= query.length) break;
        this.setQuery(query.slice(0, caret) + query.slice(caret + 1), caret);
        break;
      }
      case "killWordBack": {
        const head = query.slice(0, caret);
        const chunk = chunkBefore(head);
        if (chunk.length === 0) break;
        const rest = head.slice(0, head.length - chunk.length);
        this.kill = chunk;
        this.setQuery(rest + query.slice(caret), rest.length);
        break;
      }
      case "killWordFwd": {
        const tail = query.slice(caret);
        const chunk = chunkAfter(tail);
        if (chunk.length === 0) break;
        this.kill = chunk;
        this.setQuery(query.slice(0, caret) + tail.slice(chunk.length), caret);
        break;
      }
      case "killToStart": {
        const chunk = query.slice(0, caret);
        if (chunk.length === 0) break;
        this.kill = chunk;
        this.setQuery(query.slice(caret), 0);
        break;
      }
      case "killToEnd": {
        const chunk = query.slice(caret);
        if (chunk.length === 0) break;
        this.kill = chunk;
        this.setQuery(query.slice(0, caret), caret);
        break;
      }
      case "yank": {
        if (this.kill.length === 0) break;
        this.setQuery(this.paste(query, caret, this.kill), caret + this.kill.length);
        break;
      }
    }
  }

  /** `text` with `chunk` inserted at `caret`. */
  private paste(text: string, caret: number, chunk: string): string {
    return text.slice(0, caret) + chunk + text.slice(caret);
  }

  private move(step: number): void {
    if (this.hits.length === 0) return;
    const count = this.source.config.visibleRows;
    let next = this.cursor + step;
    if (next < 0) next = this.hits.length - 1;
    if (next >= this.hits.length) next = 0;
    this.cursor = next;
    if (next < this.scroll) this.scroll = next;
    if (next >= this.scroll + count) this.scroll = next - count + 1;
  }

  invalidate(): void {
    // The component holds no cached render output.
  }

  render(width: number): string[] {
    const { palette } = this;
    const now = Math.floor(Date.now() / 1000);
    const lines: string[] = [palette.border(width)];

    lines.push(this.scopeLine());
    lines.push("");
    lines.push(this.queryLine(width));
    lines.push("");

    const scoreWidth = this.scoreWidth(now);
    if (this.hits.length === 0) {
      const empty = this.query.length > 0 ? "no matches" : "no stored prompts";
      lines.push(palette.hint(empty));
    }
    const count = this.source.config.visibleRows;
    for (let index = this.scroll; index < this.scroll + count; index++) {
      const hit = this.hits[index];
      if (hit === undefined) break;
      lines.push(this.rowLine(hit, width, index === this.cursor, scoreWidth, now));
    }

    lines.push("");
    lines.push(palette.hint(this.footer()));
    lines.push(palette.border(width));
    return lines;
  }

  /** The query row: the prompt, the typed text, and the caret as a block. */
  private queryLine(width: number): string {
    const { palette } = this;
    const shown = clip(this.query, Math.max(0, width - 3));
    if (shown.length === 0) return `${palette.prompt()} ${palette.cursor(" ")}`;
    const caret = Math.min(this.caret, shown.length);
    const cell = caret < shown.length ? shown.charAt(caret) : " ";
    const parts = [`${palette.prompt()} `];
    if (caret > 0) parts.push(palette.query(shown.slice(0, caret)));
    parts.push(palette.cursor(cell));
    if (caret < shown.length) parts.push(palette.query(shown.slice(caret + 1)));
    return parts.join("");
  }

  /** Width of the score column: as wide as the widest score in the result set. */
  private scoreWidth(now: number): number {
    let width = 0;
    for (const hit of this.hits) {
      const score = scoreOf(hit.item.rank, hit.item.last_used, now).toFixed(1).length;
      width = Math.max(width, score);
    }
    return Math.max(1, width);
  }

  /** The scope row. The active name carries the accent color. */
  private scopeLine(): string {
    const { palette } = this;
    const names = this.source.config.scopes
      .map((scope) =>
        scope === this.scope ? palette.scopeActive(scope) : palette.scopeOther(scope),
      )
      .join(palette.hint(" | "));
    return `${palette.hint("Scope:")} ${names}`;
  }

  /** One row line: gutter, score column, then the prompt with its hits colored. */
  private rowLine(
    hit: FuzzyHit<UsageRow>,
    width: number,
    selected: boolean,
    scoreWidth: number,
    now: number,
  ): string {
    const { palette } = this;
    const score = scoreOf(hit.item.rank, hit.item.last_used, now).toFixed(1).padStart(scoreWidth);
    const textWidth = Math.max(0, width - scoreWidth - 3);
    const shown = clip(display(hit.item.text), textWidth);
    const pad = selected ? " ".repeat(Math.max(0, textWidth - shown.length)) : "";
    return [
      palette.cell(GUTTER_MARK, "gutter", selected),
      palette.cell(" ", "gap", selected),
      palette.cell(score, "score", selected),
      palette.cell(" ", "gap", selected),
      ...textCells(shown, hit.positions, selected, palette),
      pad.length > 0 ? palette.cell(pad, "gap", selected) : "",
    ].join("");
  }

  /** Footer text under the bottom rule. */
  private footer(): string {
    const count = this.source.config.visibleRows;
    const shown = this.hits.length === 0 ? 0 : Math.min(count, this.hits.length - this.scroll);
    const matches = `${this.hits.length} match${this.hits.length === 1 ? "" : "es"}`;
    const position = shown === 0 ? "" : ` (${this.cursor + 1}/${this.hits.length})`;
    return `enter use · tab scope · esc close · ${matches}${position}`;
  }
}

/** Text typed by the user, or null for keys that are not printable input. */
function printableInput(data: string): string | null {
  if (data.length === 0) return null;
  if (data[0] !== "\x1b") return data;
  const decoded = decodeKittyPrintable(data);
  return decoded && decoded.length > 0 ? decoded : null;
}

/** The gutter glyph. The selected row gets it in the accent color. */
const GUTTER_MARK = "▏";

/** Cut plain text (no styling) to a width. */
function clip(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  return `${text.slice(0, Math.max(0, width - 1))}\u2026`;
}

/** One line form of a stored prompt. Matching and painting use this exact string. */
function display(text: string): string {
  return text.replace(/\s+/g, " ");
}

/**
 * Split `text` into runs of matched and unmatched characters, then style each run.
 *
 * The runs come from the plain text, so every index in `positions` stays valid and
 * no escape code ever counts toward the width of the line.
 */
function textCells(
  text: string,
  positions: readonly number[],
  selected: boolean,
  palette: PickerPalette,
): string[] {
  if (text.length === 0) return [];
  if (positions.length === 0) return [palette.cell(text, "text", selected)];

  const hits = new Set(positions);
  const cells: string[] = [];
  let run = "";
  let on = false;
  for (let index = 0; index < text.length; index++) {
    const isHit = hits.has(index);
    if (run.length > 0 && isHit !== on) {
      cells.push(palette.cell(run, on ? "hit" : "text", selected));
      run = "";
    }
    on = isHit;
    run += text[index];
  }
  if (run.length > 0) cells.push(palette.cell(run, on ? "hit" : "text", selected));
  return cells;
}
