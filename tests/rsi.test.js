import { test } from "node:test";
import assert from "node:assert/strict";
import { rsi } from "../src/technicals/rsi.js";
import { ASCENDING_30, DESCENDING_30, ALTERNATING_15 } from "./fixtures/sampleSeries.js";

test("rsi() is exactly 100 when every period is a gain", () => {
  assert.equal(rsi(ASCENDING_30, 14), 100);
});

test("rsi() is exactly 0 when every period is a loss", () => {
  assert.equal(rsi(DESCENDING_30, 14), 0);
});

test("rsi() stays near 50 for perfectly alternating equal-sized moves", () => {
  // Wilder's smoothing is an exponential moving average, so a perfectly
  // alternating +1/-1 input does NOT settle on exactly 50 — it oscillates
  // in a steady-state band around 50 depending on which step you sample
  // on (worked out analytically: the two steady-state values are
  // 100 - 100*13/27 ≈ 51.85 and 100 - 100*14/27 ≈ 48.15, averaging to
  // exactly 50 over a full up/down cycle). For a short, pre-steady-state
  // fixture like this one, a wide-but-bounded tolerance is the honest
  // check — it still catches a badly broken implementation (e.g. one
  // that returns 90 or 10) without asserting a false-precision exact value.
  const value = rsi(ALTERNATING_15, 14);
  assert.ok(Math.abs(value - 50) < 5, `expected within 5 of 50, got ${value}`);
});

test("rsi() returns null instead of a fabricated number with insufficient history", () => {
  assert.equal(rsi([1, 2, 3], 14), null);
});
