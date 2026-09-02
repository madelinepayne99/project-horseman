import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWarInput } from "../src/technicals/buildWarInput.js";
import { makePoints } from "./fixtures/sampleSeries.js";

const US_EQUITY_META = { exchange: "NASDAQ", country: "United States" };
const LSE_META = { exchange: "LSE", country: "United Kingdom" };

function seriesFrom(closes, { simulated = false, provider = "test", providerMeta = US_EQUITY_META } = {}) {
  return {
    ticker: "TEST",
    companyName: "Test Co",
    points: makePoints(closes, { withVolume: true }),
    source: { provider, simulated, fetchedAt: new Date().toISOString(), requestedTicker: "TEST", providerMeta },
  };
}

test("buildWarInput() returns INSUFFICIENT_EVIDENCE rather than fabricating data with almost no history", () => {
  const series = seriesFrom([100, 101, 102]);
  const result = buildWarInput(series);
  assert.equal(result.dataStatus, "INSUFFICIENT_EVIDENCE");
  assert.ok(result.reason);
});

test("buildWarInput() reports PARTIAL_DATA and a null ma200 when fewer than 200 points are available", () => {
  const closes = Array.from({ length: 60 }, (_, i) => 100 + i * 0.5);
  const series = seriesFrom(closes);
  const result = buildWarInput(series);
  assert.equal(result.dataStatus, "PARTIAL_DATA");
  assert.equal(result.movingAverages.ma200, null);
  assert.ok(result.completeness.missing.includes("ma200"));
  assert.ok(typeof result.movingAverages.ma20 === "number");
  assert.ok(typeof result.movingAverages.ma50 === "number");
});

test("buildWarInput() marks stale data explicitly rather than presenting it as fresh", () => {
  const closes = Array.from({ length: 220 }, (_, i) => 100 + i * 0.1);
  const series = seriesFrom(closes);
  series.points[series.points.length - 1].timestamp = Date.now() - 20 * 24 * 60 * 60 * 1000;
  const result = buildWarInput(series);
  assert.equal(result.dataStatus, "STALE_DATA");
  assert.equal(result.freshness.status, "stale");
});

test("buildWarInput() never fabricates the source provider label", () => {
  const series = seriesFrom(Array.from({ length: 210 }, (_, i) => 100 + i), { simulated: true, provider: "simulated-demo", providerMeta: { exchange: "SIMULATED" } });
  const result = buildWarInput(series);
  assert.equal(result.source.simulated, true);
  assert.equal(result.source.provider, "simulated-demo");
});

test("buildWarInput() rejects a real non-US security as UNSUPPORTED_SECURITY rather than analysing or simulating it", () => {
  const closes = Array.from({ length: 210 }, (_, i) => 100 + i * 0.1);
  const series = seriesFrom(closes, { providerMeta: LSE_META });
  const result = buildWarInput(series);
  assert.equal(result.dataStatus, "UNSUPPORTED_SECURITY");
  assert.equal(result.movingAverages, undefined);
});

test("buildWarInput() does NOT apply the US-equity scope gate to simulated data", () => {
  const closes = Array.from({ length: 210 }, (_, i) => 100 + i * 0.1);
  const series = seriesFrom(closes, { simulated: true, providerMeta: LSE_META });
  const result = buildWarInput(series);
  assert.notEqual(result.dataStatus, "UNSUPPORTED_SECURITY");
});

test("buildWarInput() carries a debug/provenance block for tracing a result back to its layer", () => {
  const closes = Array.from({ length: 210 }, (_, i) => 100 + i * 0.1);
  const series = seriesFrom(closes);
  const result = buildWarInput(series);
  assert.ok(result.debug);
  assert.equal(result.debug.providerMeta, US_EQUITY_META);
  assert.ok(result.debug.technicalFacts);
  assert.equal(result.debug.oldestDate, series.points[0].date);
  assert.equal(result.debug.newestDate, series.points[series.points.length - 1].date);
});
