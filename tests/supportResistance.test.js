import { test } from "node:test";
import assert from "node:assert/strict";
import { findFractalPivots, nearestSupportResistance, SUPPORT_RESISTANCE_PARAMS } from "../src/technicals/supportResistance.js";

test("findFractalPivots() identifies a hand-placed swing high and swing low", () => {
  // Index 5 is a strict local max in highs; index 10 is a strict local min in lows.
  const highs = [10, 10, 10, 10, 10, 20, 10, 10, 10, 10, 10, 10, 10];
  const lows =  [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 5, 10, 10, 10];
  const { swingHighs, swingLows } = findFractalPivots(highs, lows, 2);
  assert.ok(swingHighs.some(p => p.index === 5 && p.price === 20));
  assert.ok(swingLows.some(p => p.index === 10 && p.price === 5));
});

test("findFractalPivots() does not count a tie as a pivot", () => {
  // Two adjacent bars share the max value -> neither is a *strict* extreme.
  const highs = [10, 10, 20, 20, 10, 10];
  const { swingHighs } = findFractalPivots(highs, highs, 2);
  assert.equal(swingHighs.some(p => p.index === 2 || p.index === 3), false);
});

test("nearestSupportResistance() picks the closest confirmed swing points around the current price", () => {
  const { LOOKBACK_DAYS, FRACTAL_WING } = SUPPORT_RESISTANCE_PARAMS;
  const n = LOOKBACK_DAYS + 2 * FRACTAL_WING + 10;
  const highs = Array(n).fill(100);
  const lows = Array(n).fill(100);

  // Plant a clean, isolated swing low (support) and swing high (resistance)
  // well inside the lookback window and away from each other/the edges.
  const lowIdx = n - 20;
  const highIdx = n - 10;
  lows[lowIdx] = 90;
  highs[highIdx] = 110;

  const result = nearestSupportResistance(highs, lows, 100);
  assert.equal(result.support, 90);
  assert.equal(result.resistance, 110);
  assert.equal(result.supportIsFallback, false);
  assert.equal(result.resistanceIsFallback, false);
});

test("nearestSupportResistance() falls back to window min/max and says so, when no confirmed pivot qualifies", () => {
  const { LOOKBACK_DAYS, FRACTAL_WING } = SUPPORT_RESISTANCE_PARAMS;
  const n = LOOKBACK_DAYS + 2 * FRACTAL_WING + 5;
  const highs = Array(n).fill(100); // perfectly flat -> no strict extremes anywhere
  const lows = Array(n).fill(100);

  const result = nearestSupportResistance(highs, lows, 100);
  assert.equal(result.supportIsFallback, true);
  assert.equal(result.resistanceIsFallback, true);
});

test("nearestSupportResistance() returns nulls with a reason instead of guessing when history is too short", () => {
  const result = nearestSupportResistance([100, 101], [99, 100], 100);
  assert.equal(result.support, null);
  assert.equal(result.resistance, null);
  assert.ok(result.reason);
});

test("nearestSupportResistance() is deterministic — same input always yields the same output", () => {
  const { LOOKBACK_DAYS, FRACTAL_WING } = SUPPORT_RESISTANCE_PARAMS;
  const n = LOOKBACK_DAYS + 2 * FRACTAL_WING + 10;
  const highs = Array.from({ length: n }, (_, i) => 100 + Math.sin(i) * 5);
  const lows = highs.map(h => h - 2);
  const a = nearestSupportResistance(highs, lows, 100);
  const b = nearestSupportResistance(highs, lows, 100);
  assert.deepEqual(a, b);
});
