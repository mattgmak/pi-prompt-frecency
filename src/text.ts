import { createHash } from "node:crypto";

/**
 * Collapse CRLF, trim trailing whitespace per line, trim the ends, and squash
 * runs of more than two blank lines.
 */
export function normalizePrompt(raw: string): string {
  const text = raw.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trim();
  return text.replace(/\n{3,}/g, "\n\n");
}

/** Single line form used to fold spacing variants onto one identity. */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function hashPrompt(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Identity of a prompt.
 *
 * A one line prompt is stored as its own text. A multi line prompt is stored as
 * its single line form, so "a\n\nb" and "a b" share one row. The first form seen
 * wins because the table is keyed by hash and never overwritten.
 */
export function promptIdentity(raw: string): string {
  const text = normalizePrompt(raw);
  return text.includes("\n") ? collapseWhitespace(text) : text;
}

/**
 * True when the text is a typed prompt worth storing.
 *
 * Slash commands, bash lines, short text, and injected messages that start with
 * an ignored prefix are rejected.
 */
export function isStorablePrompt(
  text: string,
  minLength: number,
  ignorePrefixes: readonly string[] = [],
): boolean {
  if (text.length < minLength) return false;
  if (text.startsWith("/")) return false;
  if (text.startsWith("!")) return false;
  for (const prefix of ignorePrefixes) {
    if (text.startsWith(prefix)) return false;
  }
  return true;
}
