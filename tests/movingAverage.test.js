import { test } from "node:test";
import assert from "node:assert/strict";
import { sma, percentVsReference } from "../src/technicals/movingAverage.js";

test("sma() averages the last N closes, hand-verified", () => {
  const closes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  // last 5: 6,7,8,9,10 -> average 8
  assert.equal(sma(closes, 5), 8);
  // last 10: 1..10 -> average 5.5
  assert.equal(sma(closes, 10), 5.5);
});

test("sma() returns null rather than a guess when history is too short", () => {
  assert.equal(sma([1, 2, 3], 5), null);
});

test("percentVsReference() computes signed percentage difference", () => {
  assert.equal(percentVsReference(110, 100), 10);
  assert.equal(percentVsReference(90, 100), -10);
});

test("percentVsReference() returns null instead of Infinity/NaN on bad reference", () => {
  assert.equal(percentVsReference(100, 0), null);
  assert.equal(percentVsReference(100, null), null);
});
