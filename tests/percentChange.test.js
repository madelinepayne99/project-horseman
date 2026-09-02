import { test } from "node:test";
import assert from "node:assert/strict";
import { percentChangeOverPeriods } from "../src/technicals/percentChange.js";

test("percentChangeOverPeriods() computes change N bars back, hand-verified", () => {
  const closes = [100, 102, 104, 110, 121];
  // 1 period back: 121 vs 110 -> +10%
  assert.equal(percentChangeOverPeriods(closes, 1), 10);
  // 4 periods back: 121 vs 100 -> +21%
  assert.equal(percentChangeOverPeriods(closes, 4), 21);
});

test("percentChangeOverPeriods() returns null rather than a guess with insufficient history", () => {
  assert.equal(percentChangeOverPeriods([100, 102], 5), null);
});
