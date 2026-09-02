import { test } from "node:test";
import assert from "node:assert/strict";
import { volumeVsAverage } from "../src/technicals/volume.js";

test("volumeVsAverage() compares latest volume to the prior 20-day average, hand-verified", () => {
  // 20 prior days all at volume 1000, latest day at 1200.
  const volumes = Array(20).fill(1000).concat([1200]);
  const result = volumeVsAverage(volumes, 20);
  assert.equal(result.latest, 1200);
  assert.equal(result.average, 1000);
  assert.equal(result.vsAveragePct, 20);
});

test("volumeVsAverage() returns nulls instead of a guess with insufficient history", () => {
  const result = volumeVsAverage([1000, 1100], 20);
  assert.equal(result.average, null);
  assert.equal(result.vsAveragePct, null);
});
