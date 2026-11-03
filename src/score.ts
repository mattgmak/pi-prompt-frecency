/**
 * zoxide scoring, ported to TypeScript.
 *
 * Source: github.com/ajeetdsouza/zoxide src/util.rs (time constants),
 * src/db/dir.rs (score), src/db/mod.rs (age). zoxide stores directories as
 * `rank` plus `last_accessed`. This extension stores prompts the same way.
 */

export const SECOND = 1;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const WEEK = 7 * DAY;
export const MONTH = 30 * DAY;

/** zoxide db/mod.rs: MIN_RANK and MAX_RANK. */
export const MIN_RANK = 0.01;
export const MAX_RANK = 9_999_999.99;

/** zoxide db/dir.rs `score`: rank times an age bucket multiplier. */
export function ageMultiplier(ageSec: number): number {
  if (ageSec < HOUR) return 4.0;
  if (ageSec < DAY) return 2.0;
  if (ageSec < WEEK) return 0.5;
  return 0.25;
}

/** Display score, clamped to the range zoxide prints. */
export function scoreOf(rank: number, lastUsed: number, now: number): number {
  const age = Math.max(0, now - lastUsed);
  return Math.min(9999, Math.max(0, rank * ageMultiplier(age)));
}

/** zoxide db/mod.rs `age`: clamp rank into [MIN_RANK, MAX_RANK]. */
export function clampRank(rank: number): number {
  if (Number.isNaN(rank)) return MIN_RANK;
  return Math.min(MAX_RANK, Math.max(MIN_RANK, rank));
}

/**
 * zoxide db/mod.rs `age`: when the total rank of a group passes maxage, every
 * row in the group is scaled by `0.9 * maxage / total`. Returns 0 when no
 * aging is needed.
 */
export function ageFactor(total: number, maxAge: number): number {
  if (total <= maxAge) return 0;
  return (0.9 * maxAge) / total;
}

/** zoxide drops a row when its rank falls below 1.0 after scaling. */
export const DROP_RANK = 1.0;
