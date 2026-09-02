import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWarInput } from "../src/technicals/buildWarInput.js";

/**
 * End-to-end checks that a still-forming bar suppresses ONLY the volume
 * comparison, and that nothing else about the War input degrades.
 *
 * Series are built with fixed dates ending on 2026-09-02 (a Wednesday) so
 * the provisional logic can be exercised against an injected clock.
 */
function makeSeries({ lastDate = "2026-09-02", count = 260, lastVolume = 973020 } = {}) {
  const dayMs = 86400000;
  const lastTs = Date.parse(`${lastDate}T00:00:00Z`);
  const points = [];
  for (let i = count - 1; i >= 0; i--) {
    const ts = lastTs - i * dayMs;
    const close = 300 + (count - i) * 0.1;
    points.push({
      date: new Date(ts).toISOString().slice(0, 10),
      timestamp: ts,
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      // Every completed day has a realistic full-day volume; the newest bar
      // gets the part-day figure so the -97% artifact would appear if the
      // comparison were not suppressed.
      volume: i === 0 ? lastVolume : 40000000,
    });
  }
  return {
    ticker: "AAPL",
    companyName: null,
    points,
    source: {
      provider: "twelvedata",
      simulated: false,
      fetchedAt: new Date().toISOString(),
      requestedTicker: "AAPL",
      providerMeta: {
        symbol: "AAPL", interval: "1day", currency: "USD",
        exchange_timezone: "America/New_York", exchange: "NASDAQ",
        mic_code: "XNGS", type: "Common Stock",
      },
    },
  };
}

const MIDSESSION = new Date("2026-09-02T18:33:00Z"); // 14:33 New York
const AFTER_CLOSE = new Date("2026-09-02T20:45:00Z"); // 16:45 New York

test("provisional bar: volume average and vsAveragePct are null with an explicit reason", () => {
  const war = buildWarInput(makeSeries(), { now: MIDSESSION });

  assert.equal(war.latestBarIsProvisional, true);
  assert.equal(war.volume.average, null);
  assert.equal(war.volume.vsAveragePct, null);
  assert.equal(war.volume.reason, "PROVISIONAL_BAR");
  // The raw part-day figure is still reported — it is real, just incomplete.
  assert.equal(war.volume.latest, 973020);
});

test("provisional bar: the misleading -97% comparison is never produced", () => {
  const war = buildWarInput(makeSeries(), { now: MIDSESSION });
  // The regression this whole change exists to prevent.
  assert.notEqual(war.volume.vsAveragePct, -97.6);
  assert.equal(war.volume.vsAveragePct, null);
});

test("provisional bar: live price and price-based indicators are preserved, not suppressed", () => {
  const war = buildWarInput(makeSeries(), { now: MIDSESSION });

  assert.ok(typeof war.latestPrice === "number", "latest price must survive");
  assert.ok(typeof war.rsi14 === "number", "RSI must still be computed");
  assert.ok(typeof war.movingAverages.ma20 === "number");
  assert.ok(typeof war.movingAverages.ma50 === "number");
  assert.ok(typeof war.movingAverages.ma200 === "number");
  assert.ok(typeof war.priceVsMa50Pct === "number");
  assert.ok(typeof war.percentChange.oneDay === "number");
});

test("provisional bar: dataStatus stays COMPLETE — an open market is not degraded data", () => {
  const war = buildWarInput(makeSeries(), { now: MIDSESSION });

  assert.equal(war.dataStatus, "COMPLETE");
  assert.equal(war.completeness.score, 1);
  assert.deepEqual(war.completeness.missing, []);
  // Specifically: the suppressed field must not be reported as missing.
  assert.ok(!war.completeness.missing.includes("volumeAverage"));
});

test("after the close: the same series produces a real volume comparison again", () => {
  const war = buildWarInput(makeSeries(), { now: AFTER_CLOSE });

  assert.equal(war.latestBarIsProvisional, false);
  assert.ok(typeof war.volume.average === "number");
  assert.ok(typeof war.volume.vsAveragePct === "number");
  assert.equal(war.volume.reason, undefined);
  assert.equal(war.dataStatus, "COMPLETE");
});

test("after the close: a genuine low-volume day is still reported, not swallowed", () => {
  // Guards against over-suppression: the fix must not hide real signals.
  const war = buildWarInput(makeSeries({ lastVolume: 20000000 }), { now: AFTER_CLOSE });
  assert.ok(war.volume.vsAveragePct < 0, "a genuinely below-average day must still show as negative");
  assert.ok(war.volume.vsAveragePct > -60, "and should be a plausible magnitude, not the part-day artifact");
});

test("a prior-day bar is never treated as provisional even during an open session", () => {
  const war = buildWarInput(makeSeries({ lastDate: "2026-08-28" }), { now: MIDSESSION });
  assert.equal(war.latestBarIsProvisional, false);
  assert.ok(typeof war.volume.vsAveragePct === "number");
});

test("the calculation version is bumped so a production response identifies the deployed logic", () => {
  const war = buildWarInput(makeSeries(), { now: MIDSESSION });
  assert.equal(war.debug.calculationVersion, "war-technicals-v2");
});
