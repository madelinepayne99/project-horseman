import { test } from "node:test";
import assert from "node:assert/strict";
import { assessFreshness, assessCompleteness } from "../src/utils/dataQuality.js";

test("assessFreshness() marks a recent point as fresh", () => {
  const result = assessFreshness({ timestamp: Date.now() - 60 * 60 * 1000 }); // 1 hour ago
  assert.equal(result.status, "fresh");
});

test("assessFreshness() marks an old point as stale rather than pretending it's current", () => {
  const result = assessFreshness({ timestamp: Date.now() - 10 * 24 * 60 * 60 * 1000 }); // 10 days ago
  assert.equal(result.status, "stale");
});

test("assessFreshness() reports unavailable when there is no point at all", () => {
  const result = assessFreshness(null);
  assert.equal(result.status, "unavailable");
  assert.equal(result.latestDataTimestamp, null);
});

test("assessCompleteness() flags exactly the missing fields, not a mystery score", () => {
  const result = assessCompleteness({ ma20: 100, ma50: null, rsi14: 55, ma200: null });
  assert.deepEqual(result.missing.sort(), ["ma200", "ma50"].sort());
  assert.equal(result.score, 0.5);
});
