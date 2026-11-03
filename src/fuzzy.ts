/**
 * Fuzzy match scorer.
 *
 * Port of `fuzzyMatch` from @earendil-works/pi-tui `src/fuzzy.ts`. The port
 * keeps pi's scoring so picker results rank the way pi's own pickers rank. The
 * CLI needs the scorer without a dependency on pi, so the code lives here and
 * the extension imports this file.
 *
 * Lower score means a better match.
 */

export interface FuzzyMatch {
  matches: boolean;
  score: number;
  /** Index of each matched character in the text. */
  positions: number[];
}

const BOUNDARY = /[\s\-_./:]/;

function scorePositions(textLower: string, positions: readonly number[]): number {
  let score = 0;
  let lastMatchIndex = -1;
  let consecutiveMatches = 0;

  for (const index of positions) {
    if (lastMatchIndex === index - 1) {
      consecutiveMatches++;
      score -= consecutiveMatches * 5;
    } else {
      consecutiveMatches = 0;
      if (lastMatchIndex >= 0) score += (index - lastMatchIndex - 1) * 2;
    }
    if (index === 0 || BOUNDARY.test(textLower[index - 1]!)) score -= 10;
    score += index * 0.1;
    lastMatchIndex = index;
  }
  return score;
}

function matchQuery(normalizedQuery: string, textLower: string): FuzzyMatch {
  if (normalizedQuery.length === 0) return { matches: true, score: 0, positions: [] };
  if (normalizedQuery.length > textLower.length)
    return { matches: false, score: 0, positions: [] };

  const positions: number[] = [];
  let lastMatchIndex = -1;
  for (const char of normalizedQuery) {
    const index = textLower.indexOf(char, lastMatchIndex + 1);
    if (index === -1) return { matches: false, score: 0, positions: [] };
    positions.push(index);
    lastMatchIndex = index;
  }

  let score = scorePositions(textLower, positions);

  // Greedy alignment can scatter the query over an unrelated prefix, so every
  // contiguous occurrence is scored too and the best alignment wins.
  const scratch = [...positions];
  for (
    let start = textLower.indexOf(normalizedQuery);
    start !== -1;
    start = textLower.indexOf(normalizedQuery, start + 1)
  ) {
    for (let k = 0; k < scratch.length; k++) scratch[k] = start + k;
    score = Math.min(score, scorePositions(textLower, scratch));
  }

  if (normalizedQuery === textLower) score -= 100;
  return { matches: true, score, positions };
}

export function fuzzyMatch(query: string, text: string): FuzzyMatch {
  const queryLower = query.toLowerCase();
  const textLower = text.toLowerCase();

  const primary = matchQuery(queryLower, textLower);
  if (primary.matches) return primary;

  // "5x" matches "x5": a letter and digit swap is tried as a fallback.
  const alphaNumeric = queryLower.match(/^(?<letters>[a-z]+)(?<digits>[0-9]+)$/);
  const numericAlpha = queryLower.match(/^(?<digits>[0-9]+)(?<letters>[a-z]+)$/);
  const swapped = alphaNumeric
    ? `${alphaNumeric.groups?.digits ?? ""}${alphaNumeric.groups?.letters ?? ""}`
    : numericAlpha
      ? `${numericAlpha.groups?.letters ?? ""}${numericAlpha.groups?.digits ?? ""}`
      : "";
  if (!swapped) return primary;

  const swappedMatch = matchQuery(swapped, textLower);
  if (!swappedMatch.matches) return primary;
  return { matches: true, score: swappedMatch.score + 5, positions: swappedMatch.positions };
}

/** One filtered item with the merged match positions of every query token. */
export interface FuzzyHit<T> {
  item: T;
  score: number;
  positions: number[];
}

/**
 * Filter items that match every whitespace or slash separated token, best first.
 */
export function fuzzyFilterDetailed<T>(
  items: T[],
  query: string,
  getText: (item: T) => string,
): FuzzyHit<T>[] {
  const tokens = query.trim().split(/[\s/]+/).filter((token) => token.length > 0);
  if (tokens.length === 0) return items.map((item) => ({ item, score: 0, positions: [] }));

  const scored: Array<FuzzyHit<T>> = [];
  for (const item of items) {
    const text = getText(item);
    let total = 0;
    const positions: number[] = [];
    let matched = true;
    for (const token of tokens) {
      const match = fuzzyMatch(token, text);
      if (!match.matches) {
        matched = false;
        break;
      }
      total += match.score;
      positions.push(...match.positions);
    }
    if (matched) scored.push({ item, score: total, positions });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored;
}

export function fuzzyFilter<T>(items: T[], query: string, getText: (item: T) => string): T[] {
  return fuzzyFilterDetailed(items, query, getText).map((hit) => hit.item);
}
