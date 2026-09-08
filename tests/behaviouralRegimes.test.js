import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyBehaviouralRegimes, BehaviouralRegime, REGIME_THRESHOLDS,
  REQUIRED_OBSERVATIONS, DEFERRED_REGIMES,
} from "../src/conquest/behaviouralRegimes.js";
import { observeMarketBehaviour, ObservationStatus } from "../src/conquest/marketObservations.js";
import { EpistemicLayer, FindingSubject, EpistemicViolation, makeEpistemicFinding } from "../src/schema/epistemics.js";
import { EvidenceOrigin } from "../src/schema/crowd.js";
import { EvidenceSource, CorrelationGroup, areCorrelated } from "../src/schema/provenance.js";

/** Behavioural regimes. Pure, deterministic, no network. */

const NOW = new Date("2026-09-04T20:45:00Z");
const MIDSESSION = new Date("2026-09-04T18:00:00Z");
const DAY = 86400000;

function makeSeries({ n = 60, lastDate = "2026-09-04", volume = () => 1_000_000,
  close = () => 100, high = null, low = null } = {}) {
  const lastTs = Date.parse(`${lastDate}T00:00:00Z`);
  const points = [];
  for (let i = 0; i < n; i++) {
    const ts = lastTs - (n - 1 - i) * DAY;
    const c = close(i);
    points.push({ date: new Date(ts).toISOString().slice(0, 10), timestamp: ts,
      open: c, high: high ? high(i, c) : c * 1.01, low: low ? low(i, c) : c * 0.99,
      close: c, volume: volume(i) });
  }
  return { points, market: { exchangeTimezone: "America/New_York" },
    source: { provider: "twelvedata", fetchedAt: new Date().toISOString() } };
}
const classify = (series, now = NOW) => classifyBehaviouralRegimes(observeMarketBehaviour(series, { now }));

/** A synthetic observation set, for precise threshold control. */
const obs = (over = {}) => ({
  participation: { id: "PARTICIPATION_PERCENTILE", status: ObservationStatus.MEASURED, percentile: 50, value: 1, sampleSize: 59 },
  movementMagnitude: { id: "MOVEMENT_MAGNITUDE_PERCENTILE", status: ObservationStatus.MEASURED, percentile: 50, value: 1, sampleSize: 58 },
  rangeExpansion: { id: "RANGE_PERCENTILE", status: ObservationStatus.MEASURED, percentile: 50, value: 1, sampleSize: 59 },
  participationRatio: { id: "PARTICIPATION_RATIO", status: ObservationStatus.MEASURED, value: 1, sampleSize: 20 },
  ...over,
});
const p = (percentile) => ({ status: ObservationStatus.MEASURED, percentile, value: 1, sampleSize: 50 });

/* ================================================================== */
/* WHAT IS AND IS NOT IMPLEMENTED                                     */
/* ================================================================== */

test("regimes requiring the sign of the return are deferred, not approximated", () => {
  for (const id of ["ADVANCE_ON_RISING_PARTICIPATION", "DECLINE_ON_RISING_PARTICIPATION",
                    "SHARP_DECLINE_ON_HIGH_PARTICIPATION", "RAPID_DECLINE_PARTICIPATION_SURGE"]) {
    assert.ok(DEFERRED_REGIMES[id], `${id} must be recorded as deferred`);
    assert.match(DEFERRED_REGIMES[id], /sign of the return/);
    assert.ok(!Object.values(BehaviouralRegime).includes(id));
  }
});

test("regimes requiring acceleration are deferred, since Step 3 deferred that measurement", () => {
  for (const id of ["ACCELERATION_WITH_EXPANDING_PARTICIPATION", "EXTREME_ACCELERATION"]) {
    assert.match(DEFERRED_REGIMES[id], /acceleration measurement/);
  }
});

test("SELLING_SURGE is rejected because OHLCV records no trade initiation", () => {
  assert.match(DEFERRED_REGIMES.SELLING_SURGE, /no trade initiation/);
  assert.ok(!Object.values(BehaviouralRegime).includes("SELLING_SURGE"));
});

test("every implemented regime declares the observations it requires", () => {
  for (const id of [BehaviouralRegime.QUIET, BehaviouralRegime.ELEVATED_ACTIVITY,
                    BehaviouralRegime.EXTREME_ACTIVITY, BehaviouralRegime.FADING_PARTICIPATION]) {
    assert.ok(REQUIRED_OBSERVATIONS[id]?.length > 0, `${id} declares no required observations`);
  }
});

/* ================================================================== */
/* QUIET                                                              */
/* ================================================================== */

test("QUIET requires the full declared combination", () => {
  const quiet = classifyBehaviouralRegimes(obs({
    participation: p(10), movementMagnitude: p(10), rangeExpansion: p(10) }));
  assert.deepEqual(quiet.regimeIds, [BehaviouralRegime.QUIET]);
  assert.match(quiet.regimes[0].statement, /resembles a quiet behavioural regime/);
});

test("ADVERSARIAL: low participation with an extreme move is NOT quiet", () => {
  const r = classifyBehaviouralRegimes(obs({
    participation: p(5), movementMagnitude: p(99), rangeExpansion: p(20) }));
  assert.ok(!r.regimeIds.includes(BehaviouralRegime.QUIET),
    "a quiet-volume session with an extreme price move is not a quiet market");
  assert.equal(r.status, BehaviouralRegime.UNKNOWN, "contradictory evidence yields no forced label");
});

test("ADVERSARIAL: low movement with an extreme range is NOT quiet", () => {
  const r = classifyBehaviouralRegimes(obs({
    participation: p(10), movementMagnitude: p(10), rangeExpansion: p(98) }));
  assert.ok(!r.regimeIds.includes(BehaviouralRegime.QUIET));
  assert.equal(r.status, BehaviouralRegime.UNKNOWN);
});

test("ADVERSARIAL: high participation with low movement produces no activity regime", () => {
  const r = classifyBehaviouralRegimes(obs({
    participation: p(97), movementMagnitude: p(12), rangeExpansion: p(30) }));
  assert.deepEqual(r.regimeIds, []);
  assert.equal(r.status, BehaviouralRegime.UNKNOWN);
});

test("the boundary is inclusive and explicit", () => {
  const at = REGIME_THRESHOLDS.QUIET_MAX_PERCENTILE;
  assert.deepEqual(classifyBehaviouralRegimes(obs({
    participation: p(at), movementMagnitude: p(at), rangeExpansion: p(at) })).regimeIds,
    [BehaviouralRegime.QUIET]);
  assert.deepEqual(classifyBehaviouralRegimes(obs({
    participation: p(at + 1), movementMagnitude: p(at), rangeExpansion: p(at) })).regimeIds, []);
});

/* ================================================================== */
/* ELEVATED / EXTREME                                                 */
/* ================================================================== */

test("ELEVATED_ACTIVITY requires both participation and movement to be high", () => {
  const r = classifyBehaviouralRegimes(obs({ participation: p(85), movementMagnitude: p(88) }));
  assert.deepEqual(r.regimeIds, [BehaviouralRegime.ELEVATED_ACTIVITY]);
  // One high, one not, is not elevated activity.
  assert.deepEqual(classifyBehaviouralRegimes(obs({
    participation: p(85), movementMagnitude: p(40) })).regimeIds, []);
});

test("EXTREME_ACTIVITY supersedes ELEVATED at the higher boundary", () => {
  const r = classifyBehaviouralRegimes(obs({ participation: p(97), movementMagnitude: p(99) }));
  assert.deepEqual(r.regimeIds, [BehaviouralRegime.EXTREME_ACTIVITY],
    "only one activity-level regime is emitted");
  assert.match(r.regimes[0].statement, /consistent with unusually intense market activity/);
});

/* ================================================================== */
/* FADING PARTICIPATION                                               */
/* ================================================================== */

test("FADING_PARTICIPATION interprets the measured ratio and cites it", () => {
  const r = classifyBehaviouralRegimes(obs({
    participationRatio: { status: ObservationStatus.MEASURED, value: 0.4, sampleSize: 20 } }));
  const fading = r.regimes.find(x => x.regime === BehaviouralRegime.FADING_PARTICIPATION);
  assert.ok(fading);
  assert.deepEqual(fading.basedOn, ["PARTICIPATION_RATIO"]);
  assert.match(fading.statement, /resembles fading participation/);
});

test("FADING_PARTICIPATION does not imply selling, bearishness or loss of interest", () => {
  const r = classifyBehaviouralRegimes(obs({
    participationRatio: { status: ObservationStatus.MEASURED, value: 0.4, sampleSize: 20 } }));
  const text = JSON.stringify(r).toLowerCase();
  for (const banned of ["selling", "bearish", "weakness", "lost interest", "loss of interest",
                        "capitulat", "exhaust", "give up"]) {
    // The limitation explicitly DENIES these, so check the statement only.
    assert.ok(!r.regimes[0].statement.toLowerCase().includes(banned), `${banned} must not be claimed`);
  }
  assert.ok(r.limitations.some(l => /does not indicate selling, loss of interest, weakness/.test(l)));
  assert.ok(text.includes("resembles fading participation"));
});

test("participation regimes can co-occur with an activity regime", () => {
  const r = classifyBehaviouralRegimes(obs({
    participation: p(10), movementMagnitude: p(10), rangeExpansion: p(10),
    participationRatio: { status: ObservationStatus.MEASURED, value: 0.3, sampleSize: 20 } }));
  assert.deepEqual([...r.regimeIds].sort(),
    [BehaviouralRegime.FADING_PARTICIPATION, BehaviouralRegime.QUIET].sort());
});

/* ================================================================== */
/* INSUFFICIENT / MISSING / PROVISIONAL                                */
/* ================================================================== */

test("insufficient history produces INSUFFICIENT_HISTORY, never a normal regime", () => {
  const r = classify(makeSeries({ n: 4 }));
  assert.equal(r.status, BehaviouralRegime.INSUFFICIENT_HISTORY);
  assert.deepEqual(r.regimeIds, []);
  assert.notEqual(r.status, BehaviouralRegime.QUIET);
  assert.ok(r.limitations.some(l => /not evidence that behaviour is ordinary/.test(l)));
});

test("REGRESSION: suppressed provisional volume cannot produce QUIET", () => {
  // Mid-session, part-formed volume, and otherwise quiet measurements.
  const series = makeSeries({ n: 60, lastDate: "2026-09-04",
    volume: i => (i === 59 ? 50_000 : 1_000_000), close: () => 100 });
  const observations = observeMarketBehaviour(series, { now: MIDSESSION });
  assert.equal(observations.participation.status, ObservationStatus.SUPPRESSED_PROVISIONAL);

  const r = classifyBehaviouralRegimes(observations);
  assert.ok(!r.regimeIds.includes(BehaviouralRegime.QUIET),
    "an unmeasured participation must not be read as a quiet market");
  assert.ok(r.limitations.some(l => /still open/.test(l)));
});

test("missing observations fail safely and are not treated as ordinary", () => {
  for (const bad of [null, undefined, {}, { participation: null }]) {
    const r = classifyBehaviouralRegimes(bad);
    assert.equal(r.status, BehaviouralRegime.UNKNOWN);
    assert.deepEqual(r.regimeIds, []);
    assert.equal(r.findings.length, 0);
  }
});

test("UNKNOWN is an absence of classification, not a neutral market reading", () => {
  const r = classifyBehaviouralRegimes(obs({ participation: p(50), movementMagnitude: p(50) }));
  assert.equal(r.status, BehaviouralRegime.UNKNOWN);
  const text = JSON.stringify(r).toLowerCase();
  for (const banned of ["neutral", "normal market", "ordinary behaviour", "balanced"]) {
    assert.ok(!text.includes(banned), `${banned} must not be asserted`);
  }
});

test("unavailable observations are distinguished from insufficient history", () => {
  const unavailable = classifyBehaviouralRegimes(obs({
    participation: { status: ObservationStatus.UNAVAILABLE, percentile: null },
    movementMagnitude: { status: ObservationStatus.UNAVAILABLE, percentile: null },
    rangeExpansion: { status: ObservationStatus.UNAVAILABLE, percentile: null },
    participationRatio: { status: ObservationStatus.UNAVAILABLE, value: null } }));
  assert.equal(unavailable.status, BehaviouralRegime.UNKNOWN);
  assert.ok(unavailable.limitations.some(l => /were unavailable/.test(l)));
});

/* ================================================================== */
/* EPISTEMIC SAFETY                                                   */
/* ================================================================== */

test("every interpretation is OBSERVED_MARKET_BEHAVIOUR + BEHAVIOURAL_INTERPRETATION + MARKET", () => {
  const r = classifyBehaviouralRegimes(obs({
    participation: p(10), movementMagnitude: p(10), rangeExpansion: p(10),
    participationRatio: { status: ObservationStatus.MEASURED, value: 0.3, sampleSize: 20 } }));
  assert.ok(r.findings.length >= 2);
  for (const f of r.findings) {
    assert.equal(f.origin, EvidenceOrigin.OBSERVED_MARKET_BEHAVIOUR);
    assert.equal(f.layer, EpistemicLayer.BEHAVIOURAL_INTERPRETATION);
    assert.equal(f.subject, FindingSubject.MARKET);
    assert.equal(f.provenance.source, EvidenceSource.MARKET_HISTORY);
    assert.equal(f.provenance.declared, true);
  }
});

test("every interpretation cites real Step 3 observation ids", () => {
  const realIds = new Set(["PARTICIPATION_PERCENTILE", "MOVEMENT_MAGNITUDE_PERCENTILE",
    "RANGE_PERCENTILE", "PARTICIPATION_RATIO"]);
  const r = classifyBehaviouralRegimes(obs({
    participation: p(10), movementMagnitude: p(10), rangeExpansion: p(10),
    participationRatio: { status: ObservationStatus.MEASURED, value: 0.3, sampleSize: 20 } }));
  for (const f of r.findings) {
    assert.ok(f.basedOn.length > 0, `${f.id} has empty basedOn`);
    for (const id of f.basedOn) assert.ok(realIds.has(id), `${id} is not a real observation id`);
  }
});

test("a market-derived regime can never emit INTENT", () => {
  const r = classifyBehaviouralRegimes(obs({ participation: p(97), movementMagnitude: p(99) }));
  for (const f of r.findings) assert.notEqual(f.layer, EpistemicLayer.INTENT);
  assert.throws(() => makeEpistemicFinding({
    origin: EvidenceOrigin.OBSERVED_MARKET_BEHAVIOUR, layer: EpistemicLayer.INTENT,
    subject: FindingSubject.MARKET, id: "X", statement: "Traders are euphoric.", basedOn: ["A"],
  }), EpistemicViolation);
});

test("no intent, causation, prediction or psychology language is emitted", () => {
  const cases = [obs({ participation: p(10), movementMagnitude: p(10), rangeExpansion: p(10) }),
                 obs({ participation: p(97), movementMagnitude: p(99) }),
                 obs({ participationRatio: { status: ObservationStatus.MEASURED, value: 0.3, sampleSize: 20 } })];
  for (const c of cases) {
    const statements = classifyBehaviouralRegimes(c).regimes.map(x => x.statement).join(" ").toLowerCase();
    for (const banned of ["because", "fomo", "panic", "fear", "euphor", "greed", "chasing",
                          "accumulat", "distribut", "investors are", "traders are", "will ", "expect"]) {
      assert.ok(!statements.includes(banned), `${banned} must not appear in an interpretation`);
    }
  }
});

test("interpretations are phrased as resemblance, enforced at construction", () => {
  const r = classifyBehaviouralRegimes(obs({ participation: p(10), movementMagnitude: p(10), rangeExpansion: p(10) }));
  assert.match(r.regimes[0].statement, /resembles|is consistent with|has the shape of/);
});

/* ================================================================== */
/* CORRELATION                                                        */
/* ================================================================== */

test("composite regimes claim no single phenomenon and correlate with nothing", () => {
  const r = classifyBehaviouralRegimes(obs({ participation: p(97), movementMagnitude: p(99) }));
  const prov = r.findings[0].provenance;
  assert.equal(prov.composite, true, "it combines participation and movement");
  assert.equal(prov.correlationGroup, null);

  const deathRapid = { source: EvidenceSource.MARKET_HISTORY,
    correlationGroup: CorrelationGroup.MARKET_ACCELERATION, declared: true, composite: false,
    horizon: { unit: "SESSIONS", length: 20 } };
  assert.equal(areCorrelated(prov, deathRapid), false,
    "a composite must not suppress or be suppressed by a single-phenomenon finding");
});

test("different horizons do not become correlated accidentally", () => {
  const r = classifyBehaviouralRegimes(obs({ participation: p(97), movementMagnitude: p(99) }));
  const prov = r.findings[0].provenance;
  for (const length of [1, 5, 20]) {
    assert.equal(areCorrelated(prov, { source: EvidenceSource.MARKET_HISTORY,
      correlationGroup: CorrelationGroup.MARKET_ACCELERATION, declared: true, composite: false,
      horizon: { unit: "SESSIONS", length } }), false);
  }
});

/* ================================================================== */
/* COUNCIL / DEATH BOUNDARIES                                         */
/* ================================================================== */

test("no regime creates a directional Council contribution", () => {
  const cases = [obs({ participation: p(97), movementMagnitude: p(99) }),
                 obs({ participation: p(5), movementMagnitude: p(5), rangeExpansion: p(5) })];
  for (const c of cases) {
    const text = JSON.stringify(classifyBehaviouralRegimes(c));
    for (const banned of ["BULLISH", "BEARISH", "stance", "vote", "confidence", "verdict", "\"direction\""]) {
      assert.ok(!text.includes(banned), `${banned} must not be emitted`);
    }
  }
});

test("no regime emits a risk or trade judgment — that is Death's and the Council's", () => {
  const r = classifyBehaviouralRegimes(obs({ participation: p(97), movementMagnitude: p(99) }));
  // Checked against what Conquest ASSERTS. The deferral reasons legitimately
  // name what they refuse to claim (e.g. "seller-initiated"), so they are
  // not part of the emitted judgment surface.
  const asserted = [...r.regimes.map(x => x.statement), ...r.limitations].join(" ").toLowerCase();
  for (const banned of ["too risky", "do not proceed", "avoid", "bad trade", "safe trade",
                        " buy ", " sell ", "risky", "risk of"]) {
    assert.ok(!asserted.includes(banned), `${banned} must not appear in a Conquest regime`);
  }
  // And no regime id is a judgment.
  for (const id of r.regimeIds) assert.ok(!/BUY|SELL|AVOID|PROCEED|RISK/.test(id));
});

/* ================================================================== */
/* STRUCTURE                                                          */
/* ================================================================== */

test("thresholds are centralized, reported and explicitly uncalibrated", () => {
  assert.equal(REGIME_THRESHOLDS.calibrated, false);
  const r = classifyBehaviouralRegimes(obs());
  assert.equal(r.thresholds.calibrated, false);
  assert.equal(r.thresholds, REGIME_THRESHOLDS, "the same object is reported, not a copy that could drift");
  assert.ok(r.limitations.some(l => /have not been calibrated/.test(l)));
});

test("deferred regimes are reported so the gap is inspectable", () => {
  const r = classifyBehaviouralRegimes(obs());
  assert.ok(Object.keys(r.deferredRegimes).length >= 7);
});

test("results are deterministic and frozen", () => {
  const c = obs({ participation: p(10), movementMagnitude: p(10), rangeExpansion: p(10) });
  assert.deepEqual(classifyBehaviouralRegimes(c), classifyBehaviouralRegimes(c));
  const r = classifyBehaviouralRegimes(c);
  assert.throws(() => { r.status = "X"; }, TypeError);
  assert.throws(() => { r.regimes.push({}); }, TypeError);
  assert.throws(() => { r.limitations.push("x"); }, TypeError);
});

test("classification consumes only the locked observation layer", async () => {
  const raw = await import("node:fs").then(fs =>
    fs.readFileSync(new URL("../src/conquest/behaviouralRegimes.js", import.meta.url), "utf8"));
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const banned of ["warFactsV2", "rsi14", "movingAverages", "famine", "death", "council"]) {
    assert.ok(!code.toLowerCase().includes(banned.toLowerCase()), `must not consume ${banned}`);
  }
});

test("an end-to-end quiet series classifies as QUIET through the real observation layer", () => {
  // Flat price, flat volume: every percentile lands at the mid-rank 50 for
  // a perfectly uniform series, so a genuinely quiet fixture needs a
  // declining tail against a more active history.
  const series = makeSeries({ n: 60,
    volume: i => (i >= 55 ? 100_000 : 2_000_000),
    close: i => (i >= 55 ? 100 : 100 + (i % 2) * 3),
    high: (i, c) => (i >= 55 ? c * 1.001 : c * 1.05),
    low: (i, c) => (i >= 55 ? c * 0.999 : c * 0.95) });
  const observations = observeMarketBehaviour(series, { now: NOW });
  const r = classifyBehaviouralRegimes(observations);
  assert.ok(r.regimeIds.includes(BehaviouralRegime.QUIET), `got ${JSON.stringify(r.regimeIds)}`);
  assert.deepEqual(r.regimes.find(x => x.regime === BehaviouralRegime.QUIET).basedOn,
    REQUIRED_OBSERVATIONS[BehaviouralRegime.QUIET]);
});

/* ================================================================== */
/* HARDENING — participation symmetry and correlation truth            */
/* ================================================================== */

import { PARTICIPATION_CHANGE_HORIZON } from "../src/conquest/marketObservations.js";

const ratioOf = v => obs({ participationRatio: { status: ObservationStatus.MEASURED, value: v, sampleSize: 20 } });

test("materially lower participation produces FADING_PARTICIPATION", () => {
  const r = classifyBehaviouralRegimes(ratioOf(0.4));
  assert.ok(r.regimeIds.includes(BehaviouralRegime.FADING_PARTICIPATION));
});

test("materially higher participation produces RISING_PARTICIPATION", () => {
  const r = classifyBehaviouralRegimes(ratioOf(3));
  assert.ok(r.regimeIds.includes(BehaviouralRegime.RISING_PARTICIPATION));
  assert.match(r.regimes[0].statement, /resembles rising participation/);
});

test("the dimension is no longer one-sided", () => {
  const down = classifyBehaviouralRegimes(ratioOf(0.4)).regimeIds;
  const up = classifyBehaviouralRegimes(ratioOf(3)).regimeIds;
  assert.ok(down.length === 1 && up.length === 1, "both directions of change are expressible");
  assert.notDeepEqual(down, up);
});

test("thresholds are exact reciprocals, so neither side triggers more easily", () => {
  assert.equal(REGIME_THRESHOLDS.RISING_MIN_RATIO, 1 / REGIME_THRESHOLDS.FADING_MAX_RATIO);
  // Log-symmetry: equal-magnitude changes on a multiplicative scale.
  const lnDown = Math.abs(Math.log(REGIME_THRESHOLDS.FADING_MAX_RATIO));
  const lnUp = Math.abs(Math.log(REGIME_THRESHOLDS.RISING_MIN_RATIO));
  assert.ok(Math.abs(lnDown - lnUp) < 1e-12, "|ln(0.70)| must equal |ln(1.4286)|");

  // A naive 1.30 pairing would have been biased toward triggering "rising".
  assert.ok(Math.abs(Math.log(1.3)) < lnDown,
    "1.30 is a smaller change than 0.70, which is why it was not used");
  assert.equal(REGIME_THRESHOLDS.FADING_MAX_RATIO, 0.7, "the Step 4 boundary is preserved");
  assert.equal(REGIME_THRESHOLDS.calibrated, false);
});

test("the boundaries behave symmetrically at their edges", () => {
  assert.deepEqual(classifyBehaviouralRegimes(ratioOf(0.7)).regimeIds, [BehaviouralRegime.FADING_PARTICIPATION]);
  assert.deepEqual(classifyBehaviouralRegimes(ratioOf(0.71)).regimeIds, []);
  assert.deepEqual(classifyBehaviouralRegimes(ratioOf(1 / 0.7)).regimeIds, [BehaviouralRegime.RISING_PARTICIPATION]);
  assert.deepEqual(classifyBehaviouralRegimes(ratioOf(1.42)).regimeIds, [], "just inside is not material");
});

test("neither participation regime implies direction, intent or continuation", () => {
  for (const v of [0.4, 3]) {
    const r = classifyBehaviouralRegimes(ratioOf(v));
    const statement = r.regimes[0].statement.toLowerCase();
    for (const banned of ["buying", "selling", "accumulat", "distribut", "fomo", "enthusias",
                          "bullish", "bearish", "institution", "loss of interest", "weakness",
                          "will ", "continue", "expect"]) {
      assert.ok(!statement.includes(banned), `${banned} must not be claimed`);
    }
  }
  assert.ok(classifyBehaviouralRegimes(ratioOf(3)).limitations.some(l =>
    /does not indicate buying, enthusiasm, accumulation/.test(l)));
  assert.ok(classifyBehaviouralRegimes(ratioOf(0.4)).limitations.some(l =>
    /does not indicate selling, loss of interest, weakness/.test(l)));
});

test("both participation regimes cite PARTICIPATION_RATIO", () => {
  for (const v of [0.4, 3]) {
    assert.deepEqual(classifyBehaviouralRegimes(ratioOf(v)).findings[0].basedOn, ["PARTICIPATION_RATIO"]);
  }
});

/* ---------------- correlation truth ---------------- */

test("REGRESSION: participation change is ONE phenomenon, not a composite", () => {
  const prov = classifyBehaviouralRegimes(ratioOf(0.4)).findings[0].provenance;
  assert.equal(prov.composite, false,
    "it rests on one observation describing one phenomenon");
  assert.equal(prov.correlationGroup, CorrelationGroup.MARKET_PARTICIPATION_CHANGE);
  assert.deepEqual(prov.horizon, PARTICIPATION_CHANGE_HORIZON);
});

test("REGRESSION: another finding on the same participation change cannot earn false independence", () => {
  const conquest = classifyBehaviouralRegimes(ratioOf(0.4)).findings[0].provenance;
  // A hypothetical Death risk resting on the same 5-vs-20 contraction.
  const deathSameChange = { source: EvidenceSource.MARKET_HISTORY,
    correlationGroup: CorrelationGroup.MARKET_PARTICIPATION_CHANGE, declared: true, composite: false,
    horizon: { unit: "SESSIONS", length: 5, baselineLength: 20 } };
  assert.equal(areCorrelated(conquest, deathSameChange), true,
    "the same participation contraction seen twice is one phenomenon");
});

test("participation LEVEL and participation CHANGE are not collapsed", () => {
  const change = classifyBehaviouralRegimes(ratioOf(0.4)).findings[0].provenance;
  const level = { source: EvidenceSource.MARKET_HISTORY,
    correlationGroup: CorrelationGroup.MARKET_PARTICIPATION, declared: true, composite: false, horizon: null };
  assert.equal(areCorrelated(change, level), false,
    "today's volume level and a multi-session change are different facts");
});

test("participation change over DIFFERENT windows is not the same measurement", () => {
  const fiveVsTwenty = classifyBehaviouralRegimes(ratioOf(0.4)).findings[0].provenance;
  const tenVsSixty = { source: EvidenceSource.MARKET_HISTORY,
    correlationGroup: CorrelationGroup.MARKET_PARTICIPATION_CHANGE, declared: true, composite: false,
    horizon: { unit: "SESSIONS", length: 10, baselineLength: 60 } };
  assert.equal(areCorrelated(fiveVsTwenty, tenVsSixty), false);
});

test("activity-level regimes remain composite, which inspection confirms is truthful", () => {
  const prov = classifyBehaviouralRegimes(obs({ participation: p(97), movementMagnitude: p(99) })).findings[0].provenance;
  assert.equal(prov.composite, true,
    "ELEVATED/EXTREME genuinely combine two different phenomena");
  assert.equal(prov.correlationGroup, null);
});

test("the Step 3 observation layer declares the corrected participation-change provenance", () => {
  const series = makeSeries({ n: 60, volume: i => (i >= 55 ? 300_000 : 1_000_000) });
  const o = observeMarketBehaviour(series, { now: NOW });
  const ratioProv = o.participationRatio.finding.provenance;
  const levelProv = o.participation.finding.provenance;
  assert.equal(ratioProv.correlationGroup, CorrelationGroup.MARKET_PARTICIPATION_CHANGE);
  assert.deepEqual(ratioProv.horizon, PARTICIPATION_CHANGE_HORIZON);
  assert.equal(areCorrelated(levelProv, ratioProv), false,
    "level and change must not have been collapsed at the observation layer either");
});
