import { test } from "node:test";
import assert from "node:assert/strict";
import {
  observeMarketBehaviour, midRankPercentile, ObservationStatus,
  HISTORY_GATES, PARTICIPATION_WINDOWS, MOVEMENT_HORIZON,
} from "../src/conquest/marketObservations.js";
import { EpistemicLayer, FindingSubject, EpistemicViolation, makeEpistemicFinding } from "../src/schema/epistemics.js";
import { EvidenceOrigin } from "../src/schema/crowd.js";
import { EvidenceSource, CorrelationGroup, areCorrelated, sameHorizon } from "../src/schema/provenance.js";

/**
 * Behavioural market observations. Pure, deterministic, no network.
 * Series are built with fixed dates and an injected clock.
 */

const NOW = new Date("2026-09-04T20:45:00Z");   // after the New York close
const MIDSESSION = new Date("2026-09-04T18:00:00Z");
const DAY = 86400000;

/** Ascending series ending on the given date. */
function makeSeries({
  n = 60, lastDate = "2026-09-04", volume = () => 1_000_000,
  close = i => 100 + i * 0.1, high = null, low = null,
} = {}) {
  const lastTs = Date.parse(`${lastDate}T00:00:00Z`);
  const points = [];
  for (let i = 0; i < n; i++) {
    const ts = lastTs - (n - 1 - i) * DAY;
    const c = close(i);
    points.push({
      date: new Date(ts).toISOString().slice(0, 10), timestamp: ts,
      open: c, high: high ? high(i, c) : c * 1.01, low: low ? low(i, c) : c * 0.99,
      close: c, volume: volume(i),
    });
  }
  return {
    points,
    market: { exchange: "NASDAQ", country: "United States", exchangeTimezone: "America/New_York" },
    source: { provider: "twelvedata", fetchedAt: new Date().toISOString() },
  };
}
const observe = (series, now = NOW) => observeMarketBehaviour(series, { now });

/* ---------------- percentile mechanics ---------------- */

test("mid-rank percentile is deterministic and handles ties symmetrically", () => {
  assert.equal(midRankPercentile(5, [1, 2, 3, 4]), 100);
  assert.equal(midRankPercentile(0, [1, 2, 3, 4]), 0);
  // A value equal to every member of a flat population is unremarkable,
  // so it scores 50 rather than 0 or 100.
  assert.equal(midRankPercentile(3, [3, 3, 3, 3]), 50);
  // Half credit for ties.
  assert.equal(midRankPercentile(2, [1, 2, 3, 4]), 38);
  assert.equal(midRankPercentile(5, []), null);
  assert.equal(midRankPercentile(NaN, [1, 2]), null);
});

test("percentiles are reported as whole numbers, avoiding false precision", () => {
  const r = observe(makeSeries({ volume: i => 1000 + i }));
  assert.equal(Number.isInteger(r.participation.percentile), true);
});

/* ---------------- participation ---------------- */

test("participation percentile is calculated from settled history", () => {
  // 59 prior sessions at 1,000,000; today far higher.
  const r = observe(makeSeries({ n: 60, volume: i => (i === 59 ? 5_000_000 : 1_000_000) }));
  assert.equal(r.participation.status, ObservationStatus.MEASURED);
  assert.equal(r.participation.percentile, 100);
  assert.equal(r.participation.sampleSize, 59, "sample size is exposed");
  assert.equal(r.participation.value, 5_000_000);

  const quiet = observe(makeSeries({ n: 60, volume: i => (i === 59 ? 10_000 : 1_000_000) }));
  assert.equal(quiet.participation.percentile, 0);
});

test("participation carries no inference about who traded or why", () => {
  const r = observe(makeSeries({ n: 60, volume: i => (i === 59 ? 5_000_000 : 1_000_000) }));
  const text = JSON.stringify(r).toLowerCase();
  for (const banned of ["accumulat", "distribut", "buying pressure", "selling pressure",
                        "enthusias", "panic", "chasing", "institution", "retail"]) {
    assert.ok(!text.includes(banned), `${banned} must not appear in an observation layer`);
  }
});

/* ---------------- movement magnitude ---------------- */

test("movement uses ABSOLUTE magnitude, so it cannot become directional", () => {
  const up = observe(makeSeries({ n: 60, close: i => (i === 59 ? 110 : 100) }));
  const down = observe(makeSeries({ n: 60, close: i => (i === 59 ? 90 : 100) }));
  assert.equal(up.movementMagnitude.value, down.movementMagnitude.value,
    "a +10% and a -10% session are behaviourally identical");
  assert.equal(up.movementMagnitude.percentile, down.movementMagnitude.percentile);
});

test("an unusually large move ranks high; an ordinary one does not", () => {
  const big = observe(makeSeries({ n: 60, close: i => (i === 59 ? 110 : 100 + (i % 2) * 0.1) }));
  assert.ok(big.movementMagnitude.percentile >= 95);
  const flat = observe(makeSeries({ n: 60, close: () => 100 }));
  assert.equal(flat.movementMagnitude.value, 0, "a flat series has zero movement");
  assert.equal(flat.movementMagnitude.percentile, 50, "unremarkable, not extreme");
});

test("no directional or trading language is emitted", () => {
  const r = observe(makeSeries({ n: 60, close: i => (i === 59 ? 110 : 100) }));
  const text = JSON.stringify(r).toLowerCase();
  for (const banned of ["bullish", "bearish", "buy", "sell", "breakout", "breakdown",
                        "rsi", "moving average", "support", "resistance", "trend call", "overbought"]) {
    assert.ok(!text.includes(banned), `${banned} must not appear`);
  }
});

/* ---------------- range ---------------- */

test("range is normalised by price level, not compared in raw currency", () => {
  // Two assets with identical PROPORTIONAL ranges at very different prices.
  const cheap = observe(makeSeries({ n: 60, close: () => 20,
    high: (i, c) => (i === 59 ? c * 1.05 : c * 1.01), low: (i, c) => (i === 59 ? c * 0.95 : c * 0.99) }));
  const dear = observe(makeSeries({ n: 60, close: () => 200,
    high: (i, c) => (i === 59 ? c * 1.05 : c * 1.01), low: (i, c) => (i === 59 ? c * 0.95 : c * 0.99) }));
  assert.equal(cheap.rangeExpansion.value, dear.rangeExpansion.value,
    "a 10% range is a 10% range at any price level");
  assert.equal(cheap.rangeExpansion.percentile, dear.rangeExpansion.percentile);
  assert.equal(cheap.rangeExpansion.percentile, 100);
});

/* ---------------- participation trend ---------------- */

test("the participation ratio is a MEASUREMENT and carries no classification", () => {
  const r = observe(makeSeries({ n: 60, volume: i => (i >= 55 ? 3_000_000 : 1_000_000) }));
  const p = r.participationRatio;

  assert.equal(p.status, ObservationStatus.MEASURED);
  assert.equal(p.value, 3, "recent activity averaged 3x the baseline");
  assert.equal(p.finding.detail.ratio, 3);
  assert.equal(p.finding.detail.recentMean, 3_000_000);
  assert.equal(p.finding.detail.baselineMean, 1_000_000);
  assert.equal(p.finding.detail.recentSessions, PARTICIPATION_WINDOWS.RECENT);
  assert.equal(p.finding.detail.baselineSessions, PARTICIPATION_WINDOWS.BASELINE);
  assert.equal(p.sampleSize, PARTICIPATION_WINDOWS.BASELINE);
});

test("REGRESSION: no increasing/decreasing/stable classification is emitted", () => {
  for (const volume of [i => (i >= 55 ? 3_000_000 : 1_000_000),   // sharply higher
                        i => (i >= 55 ? 200_000 : 1_000_000),      // sharply lower
                        () => 1_000_000]) {                        // unchanged
    const r = observe(makeSeries({ n: 60, volume }));
    const serialised = JSON.stringify(r);
    for (const banned of ["INCREASING", "DECREASING", "STABLE", "RISING", "FALLING",
                          "UNCHANGED", "trend", "Trend"]) {
      assert.ok(!serialised.includes(banned), `${banned} must not be emitted by an observation layer`);
    }
    // The continuous statistic is still fully available.
    assert.equal(typeof r.participationRatio.value, "number");
  }
});

test("no uncalibrated classification thresholds remain in the module", async () => {
  const src = await import("node:fs").then(fs =>
    fs.readFileSync(new URL("../src/conquest/marketObservations.js", import.meta.url), "utf8"));
  for (const banned of ["TREND_THRESHOLDS", "INCREASING_AT", "DECREASING_AT", "1.25", "0.8,"]) {
    assert.ok(!src.includes(banned), `${banned} must have been removed`);
  }
});

/* ---------------- no future leakage ---------------- */

test("the latest observation is compared only against EARLIER sessions", () => {
  // If the future leaked in, the latest value would be inside its own
  // comparison population and could never reach the 100th percentile.
  const r = observe(makeSeries({ n: 60, volume: i => (i === 59 ? 9_000_000 : 1_000_000) }));
  assert.equal(r.participation.sampleSize, 59, "60 bars, 59 prior comparisons");
  assert.equal(r.participation.percentile, 100);

  const moves = observe(makeSeries({ n: 60, close: i => (i === 59 ? 200 : 100) }));
  assert.equal(moves.movementMagnitude.sampleSize, 58, "58 prior returns from 59 prior bars");
});

/* ---------------- history gating ---------------- */

test("insufficient history yields INSUFFICIENT_HISTORY, never a neutral percentile", () => {
  const r = observe(makeSeries({ n: 4 }));
  assert.equal(r.participation.status, ObservationStatus.INSUFFICIENT_HISTORY);
  assert.equal(r.participation.percentile, null, "no percentile is invented");
  assert.notEqual(r.participation.percentile, 50);
  assert.equal(r.participation.finding, null, "nothing is asserted");
  assert.equal(HISTORY_GATES.INSUFFICIENT_BELOW, 5);
});

test("a small sample is measured but flagged", () => {
  const r = observe(makeSeries({ n: 7 }));
  assert.equal(r.participation.status, ObservationStatus.SMALL_SAMPLE);
  assert.equal(typeof r.participation.percentile, "number");
  assert.equal(r.participation.sampleSize, 6);
  assert.equal(HISTORY_GATES.SMALL_SAMPLE_BELOW, 8);
});

test("at the normal minimum the status is MEASURED", () => {
  const r = observe(makeSeries({ n: 9 }));
  assert.equal(r.participation.status, ObservationStatus.MEASURED);
  assert.equal(r.participation.sampleSize, 8);
});

test("the participation ratio reports insufficient history rather than guessing", () => {
  const r = observe(makeSeries({ n: 10 }));
  assert.equal(r.participationRatio.status, ObservationStatus.INSUFFICIENT_HISTORY);
  assert.equal(r.participationRatio.value, null);
  assert.equal(r.participationRatio.finding, null);
});

/* ---------------- provisional bar ---------------- */

test("a provisional session's volume is SUPPRESSED, not reported as unusually quiet", () => {
  // Today's bar, mid-session, with only part of the day's volume recorded.
  const series = makeSeries({ n: 60, lastDate: "2026-09-04", volume: i => (i === 59 ? 120_000 : 1_000_000) });
  const r = observe(series, MIDSESSION);

  assert.equal(r.latestBarProvisional, true);
  assert.equal(r.participation.status, ObservationStatus.SUPPRESSED_PROVISIONAL);
  assert.equal(r.participation.percentile, null,
    "a part-formed bar must not read as the 0th percentile");
  assert.equal(r.participation.finding, null);
  assert.ok(r.limitations.some(l => /still open/.test(l)));
});

test("after the close the same series produces a real participation percentile", () => {
  const series = makeSeries({ n: 60, lastDate: "2026-09-04", volume: i => (i === 59 ? 120_000 : 1_000_000) });
  const r = observe(series, NOW);
  assert.equal(r.latestBarProvisional, false);
  assert.equal(r.participation.status, ObservationStatus.MEASURED);
  assert.equal(r.participation.percentile, 0);
});

test("movement is still measured on a provisional bar, and the distinction is stated", () => {
  const series = makeSeries({ n: 60, lastDate: "2026-09-04", close: i => (i === 59 ? 110 : 100) });
  const r = observe(series, MIDSESSION);
  assert.equal(r.movementMagnitude.status, ObservationStatus.MEASURED,
    "the current price is real, it simply is not final");
  assert.ok(r.limitations.some(l => /current but not final/.test(l)));
});

/* ---------------- missing and malformed data ---------------- */

test("missing volume stays unknown rather than becoming neutral", () => {
  const r = observe(makeSeries({ n: 60, volume: i => (i === 59 ? null : 1_000_000) }));
  assert.equal(r.participation.status, ObservationStatus.UNAVAILABLE);
  assert.equal(r.participation.percentile, null);
  assert.equal(r.participation.finding, null);
  assert.ok(r.limitations.some(l => /Volume was unavailable/.test(l)));
});

test("zero and negative volume are treated as unusable, not as minimum activity", () => {
  for (const bad of [0, -5]) {
    const r = observe(makeSeries({ n: 60, volume: i => (i === 59 ? bad : 1_000_000) }));
    assert.equal(r.participation.status, ObservationStatus.UNAVAILABLE);
  }
});

test("malformed and empty series fail safely", () => {
  for (const bad of [null, undefined, {}, { points: [] }, { points: [{ close: 1 }] }]) {
    const r = observeMarketBehaviour(bad, { now: NOW });
    assert.equal(r.participation.status, ObservationStatus.UNAVAILABLE);
    assert.equal(r.findings.length, 0);
    assert.ok(Array.isArray(r.limitations));
  }
});

test("a flat price produces zero movement and zero range without dividing by zero", () => {
  const r = observe(makeSeries({ n: 60, close: () => 50, high: (i, c) => c, low: (i, c) => c }));
  assert.equal(r.movementMagnitude.value, 0);
  assert.equal(r.rangeExpansion.value, 0);
  assert.equal(r.rangeExpansion.percentile, 50);
});

/* ---------------- epistemic safety ---------------- */

test("every emitted finding is OBSERVED_MARKET_BEHAVIOUR + OBSERVATION + MARKET", () => {
  const r = observe(makeSeries({ n: 60, volume: i => (i >= 55 ? 3_000_000 : 1_000_000) }));
  assert.ok(r.findings.length >= 3);
  for (const f of r.findings) {
    assert.equal(f.origin, EvidenceOrigin.OBSERVED_MARKET_BEHAVIOUR);
    assert.equal(f.layer, EpistemicLayer.OBSERVATION);
    assert.equal(f.subject, FindingSubject.MARKET);
    assert.equal(f.provenance.source, EvidenceSource.MARKET_HISTORY);
    assert.equal(f.provenance.declared, true);
  }
});

test("this layer cannot construct an interpretation or an intent claim", () => {
  const r = observe(makeSeries({ n: 60 }));
  for (const f of r.findings) assert.notEqual(f.layer, EpistemicLayer.BEHAVIOURAL_INTERPRETATION);
  // And the factory itself still refuses intent from market history.
  assert.throws(() => makeEpistemicFinding({
    origin: EvidenceOrigin.OBSERVED_MARKET_BEHAVIOUR, layer: EpistemicLayer.INTENT,
    subject: FindingSubject.MARKET, id: "X", statement: "Traders are panicking.", basedOn: ["A"],
  }), EpistemicViolation);
});

test("each observation family carries a semantically truthful correlation group", () => {
  const r = observe(makeSeries({ n: 60, volume: i => (i >= 55 ? 3_000_000 : 1_000_000) }));
  const groupOf = id => r.findings.find(f => f.id === id).provenance.correlationGroup;

  assert.equal(groupOf("PARTICIPATION_PERCENTILE"), CorrelationGroup.MARKET_PARTICIPATION);
  // CORRECTED: participation LEVEL and participation CHANGE are different
  // phenomena. Grouping them together let today's volume level and a
  // multi-session change count as one fact, so one could suppress the other.
  assert.equal(groupOf("PARTICIPATION_RATIO"), CorrelationGroup.MARKET_PARTICIPATION_CHANGE,
    "a change in participation is not the same fact as its level");
  assert.equal(groupOf("MOVEMENT_MAGNITUDE_PERCENTILE"), CorrelationGroup.MARKET_ACCELERATION);
  assert.equal(groupOf("RANGE_PERCENTILE"), CorrelationGroup.MARKET_RANGE,
    "intraday range is a distinct observable from close-to-close movement");
});

test("REGRESSION: one-session movement does NOT correlate with a twenty-session move", () => {
  const r = observe(makeSeries({ n: 60, close: i => (i === 59 ? 110 : 100) }));
  const oneSession = r.findings.find(f => f.id === "MOVEMENT_MAGNITUDE_PERCENTILE").provenance;

  assert.deepEqual(oneSession.horizon, { unit: "SESSIONS", length: 1, baselineLength: null },
    "the measurement window is declared, not implied");

  // Death's RAPID_MOVEMENT is a twenty-session cumulative move.
  const twentySession = { source: EvidenceSource.MARKET_HISTORY,
    correlationGroup: CorrelationGroup.MARKET_ACCELERATION, declared: true, composite: false,
    horizon: { unit: "SESSIONS", length: 20 } };

  assert.equal(areCorrelated(oneSession, twentySession), false,
    "a quiet session inside a large twenty-session move must not suppress either observation");
  assert.equal(sameHorizon(oneSession, twentySession), false);
});

test("two observations of the SAME phenomenon at the SAME horizon do correlate", () => {
  const r = observe(makeSeries({ n: 60, close: i => (i === 59 ? 110 : 100) }));
  const oneSession = r.findings.find(f => f.id === "MOVEMENT_MAGNITUDE_PERCENTILE").provenance;

  // A future Conquest or Death observation of the same single session.
  const alsoOneSession = { source: EvidenceSource.MARKET_HISTORY,
    correlationGroup: CorrelationGroup.MARKET_ACCELERATION, declared: true, composite: false,
    horizon: { unit: "SESSIONS", length: 1 } };
  assert.equal(areCorrelated(oneSession, alsoOneSession), true,
    "the same move at the same window remains one phenomenon");
});

test("Death's own twenty-session finding declares its horizon", async () => {
  const { buildDeathInput } = await import("../src/death/deathInput.js");
  const { deathAnalysis } = await import("../src/death/deathAnalysis.js");
  const r = deathAnalysis(buildDeathInput({
    assetId: "TEST",
    technical: { dataStatus: "COMPLETE", rsi14: 55, percentChange20d: 30,
      freshnessStatus: "fresh", provider: "twelvedata" },
    fundamental: { dataStatus: "COMPLETE", completenessScore: 1, freshnessStatus: "CURRENT" },
    crowd: null, consensus: { directions: { WAR: "BULLISH", FAMINE: "BULLISH", CONQUEST: "UNKNOWN" } },
  }));
  const rapid = r.observedRisks.find(f => f.id === "RAPID_MOVEMENT");
  assert.deepEqual(rapid.provenance.horizon, { unit: "SESSIONS", length: 20, baselineLength: null },
    "a single-window horizon carries no baseline");
});

test("different source evidence remains independent exactly as before", () => {
  const r = observe(makeSeries({ n: 60, close: i => (i === 59 ? 110 : 100) }));
  const movement = r.findings.find(f => f.id === "MOVEMENT_MAGNITUDE_PERCENTILE").provenance;
  const range = r.findings.find(f => f.id === "RANGE_PERCENTILE").provenance;
  const crowd = { source: EvidenceSource.CROWD_FEED, correlationGroup: CorrelationGroup.CROWD_BEHAVIOUR,
    declared: true, composite: false };

  assert.equal(areCorrelated(movement, crowd), false, "a crowd reading is independent evidence");
  assert.equal(areCorrelated(range, movement), false, "range is a different phenomenon");
  // And horizon does not accidentally correlate different phenomena.
  const participation = r.findings.find(f => f.id === "PARTICIPATION_PERCENTILE").provenance;
  assert.equal(areCorrelated(participation, movement), false);
});

test("observations produce no directional Council contribution", () => {
  const r = observe(makeSeries({ n: 60, close: i => (i === 59 ? 130 : 100) }));
  const text = JSON.stringify(r);
  for (const banned of ["\"direction\"", "stance", "vote", "BULLISH", "BEARISH", "confidence", "verdict"]) {
    assert.ok(!text.includes(banned), `${banned} must not be emitted by an observation layer`);
  }
});

test("results are deterministic and frozen", () => {
  const series = makeSeries({ n: 60, volume: i => (i === 59 ? 4_000_000 : 1_000_000) });
  assert.deepEqual(observe(series), observe(series));
  const r = observe(series);
  assert.throws(() => { r.participation.percentile = 1; }, TypeError);
  assert.throws(() => { r.findings.push({}); }, TypeError);
  assert.throws(() => { r.limitations.push("x"); }, TypeError);
});

test("the module never reads War's analytical output", async () => {
  const raw = await import("node:fs").then(fs =>
    fs.readFileSync(new URL("../src/conquest/marketObservations.js", import.meta.url), "utf8"));
  // Strip comments: the module deliberately NAMES what it refuses to use.
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const banned of ["warFactsV2", "buildWarInput", "deriveTechnicalFacts", "rsi14", "movingAverages"]) {
    assert.ok(!code.includes(banned), `Conquest must not depend on ${banned}`);
  }
  // And it imports nothing from War.
  assert.ok(!/from\s+"\.\.\/technicals\//.test(raw), "no import from War's technicals");
});
