import assert from "node:assert/strict";
import test from "node:test";

import {
  DAY,
  DROP_RANK,
  HOUR,
  MAX_RANK,
  MINUTE,
  MIN_RANK,
  MONTH,
  SECOND,
  WEEK,
  ageFactor,
  ageMultiplier,
  clampRank,
  scoreOf,
} from "../src/score.ts";

test("time constants match zoxide util.rs", () => {
  assert.equal(SECOND, 1);
  assert.equal(MINUTE, 60);
  assert.equal(HOUR, 3600);
  assert.equal(DAY, 86400);
  assert.equal(WEEK, 604800);
  assert.equal(MONTH, 2592000);
});

test("ageMultiplier returns the zoxide age buckets", () => {
  assert.equal(ageMultiplier(0), 4);
  assert.equal(ageMultiplier(HOUR - 1), 4);
  assert.equal(ageMultiplier(HOUR), 2);
  assert.equal(ageMultiplier(DAY - 1), 2);
  assert.equal(ageMultiplier(DAY), 0.5);
  assert.equal(ageMultiplier(WEEK - 1), 0.5);
  assert.equal(ageMultiplier(WEEK), 0.25);
  assert.equal(ageMultiplier(MONTH), 0.25);
});

test("scoreOf multiplies rank by the age bucket", () => {
  const now = 1_700_000_000;
  assert.equal(scoreOf(3, now, now), 12);
  assert.equal(scoreOf(3, now - HOUR, now), 6);
  assert.equal(scoreOf(3, now - DAY, now), 1.5);
  assert.equal(scoreOf(3, now - WEEK, now), 0.75);
});

test("scoreOf clamps to the printed range", () => {
  const now = 1_700_000_000;
  assert.equal(scoreOf(MAX_RANK, now, now), 9999);
  assert.equal(scoreOf(0, now, now), 0);
  assert.equal(scoreOf(3, now + MONTH, now), 12);
});

test("clampRank keeps rank inside the zoxide bounds", () => {
  assert.equal(clampRank(Number.NaN), MIN_RANK);
  assert.equal(clampRank(0), MIN_RANK);
  assert.equal(clampRank(5), 5);
  assert.equal(clampRank(Number.MAX_VALUE), MAX_RANK);
});

test("ageFactor scales a group only past maxAge", () => {
  assert.equal(ageFactor(5_000, 10_000), 0);
  assert.equal(ageFactor(10_000, 10_000), 0);
  assert.equal(ageFactor(20_000, 10_000), 0.45);
});

test("DROP_RANK matches zoxide", () => {
  assert.equal(DROP_RANK, 1);
});
