import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

/** Part of a picker row that a palette colors. */
export type CellRole = "gutter" | "gap" | "score" | "text" | "hit";

/**
 * Every color the picker draws, behind one interface.
 *
 * `themePalette` uses the live pi theme, so colors match the rest of the TUI.
 * `ansiPalette` needs no theme, which keeps the class testable off the TUI.
 */
export interface PickerPalette {
  /** Full width rule for the top and the bottom of the picker. */
  border(width: number): string;
  /** The `>` glyph on the query line. */
  prompt(): string;
  /** Typed query text. */
  query(text: string): string;
  /** Faint text: the query placeholder, the footer hints, the scope label. */
  hint(text: string): string;
  /** A scope name the picker does not show. */
  scopeOther(text: string): string;
  /** A scope name the picker shows. */
  scopeActive(text: string): string;
  /** The caret cell on the query line. */
  cursor(text: string): string;
  /** One run of a row line, styled for its role and its selection. */
  cell(text: string, role: CellRole, selected: boolean): string;
}

const ANSI = {
  border: "\x1b[90m",
  bold: "\x1b[1m",
  faint: "\x1b[2m",
  accent: "\x1b[96m",
  plain: "\x1b[39m",
  selectedBg: "\x1b[48;5;236m",
} as const;
const RESET = "\x1b[0m";

function ansiFg(role: CellRole, selected: boolean): string {
  if (role === "gutter") return selected ? ANSI.accent : ANSI.faint;
  if (role === "hit") return ANSI.accent;
  if (role === "score") return selected ? ANSI.plain : ANSI.faint;
  return selected ? ANSI.plain : "";
}

/** Palette for a terminal, built from plain SGR codes. */
export const ansiPalette: PickerPalette = {
  border: (width) => `${ANSI.border}${"─".repeat(Math.max(1, width))}${RESET}`,
  prompt: () => `${ANSI.bold}>${RESET}`,
  query: (text) => `${ANSI.bold}${text}${RESET}`,
  hint: (text) => `${ANSI.faint}${text}${RESET}`,
  scopeOther: (text) => `${ANSI.faint}${text}${RESET}`,
  scopeActive: (text) => `${ANSI.accent}${text}${RESET}`,
  cursor: (text) => `\x1b[7m${text}${RESET}`,
  cell: (text, role, selected) => {
    if (text.length === 0) return "";
    if (!selected) {
      const fg = ansiFg(role, false);
      return fg === "" ? text : `${fg}${text}${RESET}`;
    }
    return `${ANSI.selectedBg}${ansiFg(role, true)}${text}${RESET}`;
  },
};

function themeFg(role: CellRole, selected: boolean): ThemeColor {
  if (role === "hit") return "accent";
  if (role === "gutter") return selected ? "accent" : "muted";
  if (role === "score") return selected ? "text" : "muted";
  return "text";
}

/** Palette built from a live pi theme. */
export function themePalette(theme: Theme): PickerPalette {
  return {
    border: (width) => theme.fg("border", "─".repeat(Math.max(1, width))),
    prompt: () => theme.fg("accent", ">"),
    query: (text) => theme.bold(text),
    hint: (text) => theme.fg("muted", text),
    scopeOther: (text) => theme.fg("muted", text),
    scopeActive: (text) => theme.fg("accent", text),
    cursor: (text) => theme.inverse(text),
    cell: (text, role, selected) => {
      if (text.length === 0) return "";
      if (selected) return theme.style(text, { fg: themeFg(role, true), bg: "selectedBg" });
      return theme.fg(themeFg(role, false), text);
    },
  };
}
