import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyTrend } from "../src/technicals/trend.js";

test("classifyTrend() is Bullish when price > MA20 > MA50 with meaningful separation", () => {
  const result = classifyTrend({ price: 110, ma20: 105, ma50: 100, ma200: null });
  assert.equal(result.classification, "Bullish");
});

test("classifyTrend() is Bearish when price < MA20 < MA50 with meaningful separation", () => {
  const result = classifyTrend({ price: 90, ma20: 95, ma50: 100, ma200: null });
  assert.equal(result.classification, "Bearish");
});

test("classifyTrend() is Neutral when MA20/MA50 are within the minimum separation, even if price sits on one side", () => {
  // ma20 vs ma50 separation here is well under 0.5%.
  const result = classifyTrend({ price: 101, ma20: 100.1, ma50: 100, ma200: null });
  assert.equal(result.classification, "Neutral");
});

test("classifyTrend() is Neutral on mixed stacking (price and averages disagree)", () => {
  const result = classifyTrend({ price: 102, ma20: 98, ma50: 100, ma200: null });
  assert.equal(result.classification, "Neutral");
});

test("classifyTrend() reports Insufficient data rather than defaulting to Neutral when inputs are missing", () => {
  const result = classifyTrend({ price: 100, ma20: null, ma50: 100, ma200: null });
  assert.equal(result.classification, "Insufficient data");
});

test("classifyTrend() flags long-term confirmation from MA200 without changing the primary call", () => {
  const confirmed = classifyTrend({ price: 110, ma20: 105, ma50: 100, ma200: 95 });
  assert.equal(confirmed.classification, "Bullish");
  assert.equal(confirmed.longTermConfirmation, "confirmed");

  const early = classifyTrend({ price: 110, ma20: 105, ma50: 100, ma200: 103 });
  assert.equal(early.classification, "Bullish");
  assert.equal(early.longTermConfirmation, "early");
});
