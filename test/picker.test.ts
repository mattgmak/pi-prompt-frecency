import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { ScopeName } from "../src/config.ts";
import { cwdScopeKey, GLOBAL_SCOPE } from "../src/db.ts";
import { PromptPicker, type PickerResult, type PickerSource } from "../src/picker.ts";
import { ansiPalette } from "../src/theme.ts";
import { makeTempDir, openStore } from "./helpers.ts";

const KEYS = {
  escape: "\x1b",
  ctrlC: "\x03",
  enter: "\r",
  tab: "\t",
  shiftTab: "\x1b[Z",
  up: "\x1b[A",
  down: "\x1b[B",
  left: "\x1b[D",
  right: "\x1b[C",
  home: "\x1b[H",
  end: "\x1b[F",
  backspace: "\x7f",
  deleteKey: "\x1b[3~",
  ctrlA: "\x01",
  ctrlB: "\x02",
  ctrlD: "\x04",
  ctrlE: "\x05",
  ctrlF: "\x06",
  ctrlH: "\x08",
  ctrlK: "\x0b",
  ctrlU: "\x15",
  ctrlW: "\x17",
  ctrlY: "\x19",
  altB: "\x1bb",
  altF: "\x1bf",
  altBackspace: "\x1b\x7f",
  altD: "\x1bd",
};

interface MountOptions {
  texts?: string[];
  cwd?: string;
  session?: string;
  scope?: ScopeName;
  query?: string;
}

/** Build a picker over a fresh store and collect what it reports on close. */
function mount(options: MountOptions = {}): { picker: PromptPicker; results: PickerResult[] } {
  const dir = makeTempDir();
  const store = openStore(dir);
  const cwd = options.cwd ?? "/repo";
  const session = options.session ?? "/s.jsonl";
  const texts = options.texts ?? ["commit and push", "run the tests"];
  const now = Math.floor(Date.now() / 1000);
  store.applyEvents(
    texts.map((text, index) => ({
      text,
      at: now - texts.length + index,
      cwd,
      session,
    })),
  );

  const source: PickerSource = { config: store.config, store, cwd, session };
  const results: PickerResult[] = [];
  const picker = new PromptPicker(
    source,
    (result) => {
      results.push(result);
    },
    options.scope,
    options.query ?? "",
  );
  return { picker, results };
}

/** The render of a picker with the blank spacer lines removed. */
function shown(picker: PromptPicker): string[] {
  return picker.render(80).filter((line) => line !== "");
}

/** Render a fresh picker at width 80 without the blank spacer lines. */
function lines(options: MountOptions = {}): string[] {
  return shown(mount(options).picker);
}

/** The query line for `query` with the caret on column `caret`. */
function queryLine(query: string, caret = query.length): string {
  const { prompt, query: text, cursor } = ansiPalette;
  if (query.length === 0) return `${prompt()} ${cursor(" ")}`;
  const cell = caret < query.length ? query.charAt(caret) : " ";
  const parts = [`${prompt()} `];
  if (caret > 0) parts.push(text(query.slice(0, caret)));
  parts.push(cursor(cell));
  if (caret < query.length) parts.push(text(query.slice(caret + 1)));
  return parts.join("");
}

const HEADER = queryLine("");

/** The styled text part of a row where `hit` is the only matched run. */
function rowWithHits(hit: string, rest: string, selected = true): string {
  return `${ansiPalette.cell(hit, "hit", selected)}${ansiPalette.cell(rest, "text", selected)}`;
}

test("the picker opens on the default scope", () => {
  const rendered = lines();
  assert.ok(rendered[1]?.includes(ansiPalette.scopeActive("global")));
  assert.equal(rendered[2], HEADER);
});

test("an initial scope outside the config falls back to global", () => {
  const dir = makeTempDir();
  const store = openStore(dir, { scopes: ["global", "cwd"] });
  const source: PickerSource = { config: store.config, store, cwd: "/repo", session: "/s.jsonl" };
  const picker = new PromptPicker(source, () => {}, "session");
  assert.ok(shown(picker)[1]?.includes(ansiPalette.scopeActive("global")));
  store.close();
});

test("the frame draws a rule on the top and on the bottom", () => {
  const rendered = lines();
  assert.equal(rendered[0], ansiPalette.border(80));
  assert.equal(rendered[rendered.length - 1], ansiPalette.border(80));
});

test("the hint line sits inside the frame above the bottom rule", () => {
  const rendered = lines();
  assert.ok(rendered[rendered.length - 2]?.includes("esc close"));
  assert.equal(rendered[rendered.length - 1], ansiPalette.border(80));
  const raw = mount().picker.render(80);
  assert.equal(raw[raw.length - 3], "");
});

test("the scope line marks the active scope and lists the others", () => {
  const scope = lines({ scope: "cwd" })[1] ?? "";
  assert.ok(scope.includes(ansiPalette.scopeActive("cwd")));
  assert.ok(scope.includes(ansiPalette.scopeOther("global")));
  assert.ok(scope.includes(ansiPalette.scopeOther("session")));
});

test("rows show a score column and the footer counts matches", () => {
  const rendered = lines({ texts: ["commit and push", "run the tests"] });
  assert.equal(rendered.length, 7);
  assert.ok(rendered[3]?.includes("run the tests"));
  assert.ok(rendered[4]?.includes("commit and push"));
  assert.ok(rendered[5]?.includes("2 matches"));
  assert.equal(rendered[6], ansiPalette.border(80));
});

test("the selected row carries the selected background", () => {
  const rendered = lines();
  const selected = rendered[3] ?? "";
  const other = rendered[4] ?? "";
  assert.ok(selected.startsWith(ansiPalette.cell("▏", "gutter", true)));
  assert.ok(selected.includes(ansiPalette.cell("run the tests", "text", true)));
  assert.ok(!other.includes("48;5;236m"));
  assert.ok(other.startsWith(ansiPalette.cell("▏", "gutter", false)));
});

test("the score column is only as wide as the widest score", () => {
  const rendered = lines({ texts: ["commit and push"] });
  assert.ok((rendered[3] ?? "").includes(ansiPalette.cell("4.0", "score", true)));
});

test("an empty store shows the no prompts line", () => {
  const rendered = lines({ texts: [] });
  assert.ok(rendered[3]?.includes("no stored prompts"));
  assert.ok(rendered[4]?.includes("0 matches"));
});

test("escape closes with a cancel result", () => {
  const { picker, results } = mount();
  picker.handleInput(KEYS.escape);
  assert.deepEqual(results, [{ action: "cancel", scope: "global", query: "" }]);
});

test("ctrl+c closes with a cancel result", () => {
  const { picker, results } = mount();
  picker.handleInput(KEYS.ctrlC);
  assert.deepEqual(results, [{ action: "cancel", scope: "global", query: "" }]);
});

test("enter closes with the top row text", () => {
  const { picker, results } = mount({ texts: ["commit and push", "run the tests"] });
  picker.handleInput(KEYS.enter);
  assert.equal(results[0]?.action, "accept");
  assert.equal(results[0]?.text, "run the tests");
  assert.equal(results[0]?.scope, "global");
});

test("enter on an empty store cancels", () => {
  const { picker, results } = mount({ texts: [] });
  picker.handleInput(KEYS.enter);
  assert.deepEqual(results, [{ action: "cancel", scope: "global", query: "" }]);
});

test("input after close does nothing", () => {
  const { picker, results } = mount();
  picker.handleInput(KEYS.escape);
  picker.handleInput(KEYS.enter);
  picker.handleInput("x");
  assert.equal(results.length, 1);
});

test("tab moves to the next scope and re-reads its rows", () => {
  const { picker, results } = mount({ cwd: "/web" });
  picker.handleInput(KEYS.tab);
  assert.ok(shown(picker)[1]?.includes(ansiPalette.scopeActive("cwd")));
  assert.ok(shown(picker)[3]?.includes("run the tests"));
  assert.equal(results.length, 0);
});

test("shift tab moves to the previous scope", () => {
  const { picker } = mount({ scope: "cwd" });
  picker.handleInput(KEYS.shiftTab);
  assert.ok(shown(picker)[1]?.includes(ansiPalette.scopeActive("global")));
});

test("tab from the last scope wraps to the first", () => {
  const { picker } = mount({ scope: "session" });
  picker.handleInput(KEYS.tab);
  assert.ok(shown(picker)[1]?.includes(ansiPalette.scopeActive("global")));
});

test("typing builds a query and filters the rows", () => {
  const { picker } = mount();
  for (const char of "commit") picker.handleInput(char);
  const rendered = shown(picker).join("\n");
  assert.ok(rendered.includes(queryLine("commit")));
  assert.ok(rendered.includes(rowWithHits("commit", " and push")));
  assert.ok(rendered.includes("1 match"));
});

test("matched characters get the hit color only when a query exists", () => {
  assert.ok(!(lines()[3] ?? "").includes(ansiPalette.cell("commit", "hit", true)));
  assert.ok(lines({ query: "commit" }).join("\n").includes(rowWithHits("commit", " and push")));
});

test("the query line puts a block cursor on the caret", () => {
  const { picker } = mount({ query: "commit and push" });
  assert.equal(shown(picker)[2], queryLine("commit and push"));
  picker.handleInput(KEYS.left);
  assert.equal(shown(picker)[2], queryLine("commit and push", 14));
  picker.handleInput(KEYS.ctrlA);
  assert.equal(shown(picker)[2], queryLine("commit and push", 0));
  picker.handleInput(KEYS.ctrlE);
  assert.equal(shown(picker)[2], queryLine("commit and push"));
});

test("left and right move the caret one character", () => {
  const { picker } = mount({ query: "grill" });
  picker.handleInput(KEYS.left);
  assert.equal(shown(picker)[2], queryLine("grill", 4));
  picker.handleInput(KEYS.right);
  assert.equal(shown(picker)[2], queryLine("grill", 5));
});

test("alt+b and alt+f move the caret by word", () => {
  const { picker } = mount({ query: "commit and push" });
  picker.handleInput(KEYS.altB);
  assert.equal(shown(picker)[2], queryLine("commit and push", 11));
  picker.handleInput(KEYS.altF);
  assert.equal(shown(picker)[2], queryLine("commit and push", 15));
  picker.handleInput(KEYS.altB);
  assert.equal(shown(picker)[2], queryLine("commit and push", 11));
});

test("typing inserts at the caret", () => {
  const { picker } = mount({ query: "commi#" });
  picker.handleInput(KEYS.left);
  picker.handleInput("t");
  assert.equal(shown(picker)[2], queryLine("commit#", 6));
});

test("backspace and ctrl+h delete the character before the caret", () => {
  const { picker } = mount({ query: "commitx" });
  picker.handleInput(KEYS.backspace);
  assert.equal(shown(picker)[2], queryLine("commit"));
  picker.handleInput(KEYS.ctrlH);
  assert.equal(shown(picker)[2], queryLine("commi"));
  picker.handleInput(KEYS.ctrlH);
  picker.handleInput(KEYS.ctrlH);
  assert.equal(shown(picker)[2], queryLine("com"));
  picker.handleInput(KEYS.ctrlH);
  picker.handleInput(KEYS.ctrlH);
  picker.handleInput(KEYS.ctrlH);
  assert.equal(shown(picker)[2], HEADER);
  picker.handleInput(KEYS.ctrlH);
  assert.equal(shown(picker)[2], HEADER);
});

test("delete and ctrl+d remove the character at the caret", () => {
  const { picker } = mount({ query: "commit" });
  picker.handleInput(KEYS.ctrlA);
  picker.handleInput(KEYS.ctrlD);
  assert.equal(shown(picker)[2], queryLine("ommit", 0));
  picker.handleInput(KEYS.deleteKey);
  assert.equal(shown(picker)[2], queryLine("mmit", 0));
  picker.handleInput(KEYS.ctrlE);
  picker.handleInput(KEYS.ctrlD);
  assert.equal(shown(picker)[2], queryLine("mmit"));
});

test("ctrl+w and alt+backspace delete the word before the caret", () => {
  const { picker } = mount({ query: "commit and push" });
  picker.handleInput(KEYS.ctrlW);
  assert.equal(shown(picker)[2], queryLine("commit and "));
  picker.handleInput(KEYS.ctrlW);
  assert.equal(shown(picker)[2], queryLine("commit and"));
  picker.handleInput(KEYS.altBackspace);
  assert.equal(shown(picker)[2], queryLine("commit "));
  picker.handleInput(KEYS.altBackspace);
  assert.equal(shown(picker)[2], queryLine("commit"));
  picker.handleInput(KEYS.ctrlW);
  assert.equal(shown(picker)[2], HEADER);
  picker.handleInput(KEYS.ctrlW);
  assert.equal(shown(picker)[2], HEADER);
});

test("alt+d deletes the word after the caret", () => {
  const { picker } = mount({ query: "commit push" });
  picker.handleInput(KEYS.ctrlA);
  picker.handleInput(KEYS.altD);
  assert.equal(shown(picker)[2], queryLine(" push", 0));
  picker.handleInput(KEYS.altD);
  assert.equal(shown(picker)[2], HEADER);
  picker.handleInput(KEYS.altD);
  assert.equal(shown(picker)[2], HEADER);
});

test("ctrl+u kills the text before the caret and ctrl+k the text after it", () => {
  const { picker } = mount({ query: "commit and" });
  picker.handleInput(KEYS.ctrlA);
  picker.handleInput(KEYS.ctrlK);
  assert.equal(shown(picker)[2], HEADER);
  picker.handleInput(KEYS.ctrlY);
  assert.equal(shown(picker)[2], queryLine("commit and"));
  picker.handleInput(KEYS.ctrlE);
  picker.handleInput(KEYS.ctrlU);
  assert.equal(shown(picker)[2], HEADER);
});

test("ctrl+y yanks the last killed text back in", () => {
  const { picker } = mount({ query: "commit and" });
  picker.handleInput(KEYS.ctrlW);
  assert.equal(shown(picker)[2], queryLine("commit "));
  picker.handleInput(KEYS.ctrlY);
  assert.equal(shown(picker)[2], queryLine("commit and"));
  picker.handleInput(KEYS.ctrlY);
  assert.equal(shown(picker)[2], queryLine("commit andand"));
});

test("down moves the selection and wraps back to the top", () => {
  const { picker } = mount();
  const raw = () => picker.render(80);
  picker.handleInput(KEYS.down);
  assert.ok((raw()[6] ?? "").startsWith(ansiPalette.cell("▏", "gutter", true)));
  picker.handleInput(KEYS.down);
  assert.ok((raw()[5] ?? "").startsWith(ansiPalette.cell("▏", "gutter", true)));
});

test("arrow keys do nothing when no row exists", () => {
  const { picker, results } = mount({ texts: [] });
  picker.handleInput(KEYS.down);
  picker.handleInput(KEYS.up);
  assert.equal(results.length, 0);
  assert.ok(shown(picker).join("\n").includes("no stored prompts"));
});

test("the cwd scope only shows prompts from that directory", () => {
  const dir = makeTempDir();
  const store = openStore(dir);
  const now = Math.floor(Date.now() / 1000);
  store.applyEvents([
    { text: "commit and push", at: now, cwd: "/here", session: "/s.jsonl" },
    { text: "ship the build", at: now - 1, cwd: "/there", session: "/t.jsonl" },
  ]);
  const source: PickerSource = { config: store.config, store, cwd: "/here", session: "/s.jsonl" };
  const results: PickerResult[] = [];
  const picker = new PromptPicker(source, (result) => results.push(result), "cwd");
  assert.equal(shown(picker).length, 6);
  assert.ok(shown(picker).join("\n").includes("commit and push"));
  assert.equal(store.candidates(cwdScopeKey("/here"), 10).length, 1);
  assert.equal(store.candidates(GLOBAL_SCOPE, 10).length, 2);
  store.close();
});
