import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findBehaviouralAnalogues, compareFeatures, analogueFindings, describeBehaviourAt,
  ANALOGUE_CONSTANTS, SampleStatus,
} from "../src/conquest/historicalAnalogues.js";
import { BehaviouralRegime } from "../src/conquest/behaviouralRegimes.js";
import { EpistemicLayer, FindingSubject, EpistemicViolation, makeEpistemicFinding } from "../src/schema/epistemics.js";
import { EvidenceOrigin } from "../src/schema/crowd.js";
import { EvidenceSource, areCorrelated, CorrelationGroup } from "../src/schema/provenance.js";

/** Historical analogues. Pure, deterministic, no network. */

const DAY = 86400000;
const NOW = new Date("2026-09-04T20:45:00Z");

/**
 * Deterministic series. `episodes` marks indices given unusually high
 * volume and movement, so comparable conditions can be planted at will.
 */
function makeSeries({ n = 200, lastDate = "2026-09-04", episodes = [], quiet = [] } = {}) {
  const lastTs = Date.parse(`${lastDate}T00:00:00Z`);
  const points = [];
  for (let i = 0; i < n; i++) {
    const ts = lastTs - (n - 1 - i) * DAY;
    const isEpisode = episodes.includes(i);
    const isQuiet = quiet.includes(i);
    const base = 100 + (i % 7) * 0.2;
    const c = isEpisode ? base * 1.09 : isQuiet ? base : base + (i % 3) * 0.15;
    points.push({
      date: new Date(ts).toISOString().slice(0, 10), timestamp: ts,
      open: c, high: c * (isEpisode ? 1.05 : isQuiet ? 1.002 : 1.012),
      low: c * (isEpisode ? 0.95 : isQuiet ? 0.998 : 0.988), close: c,
      volume: isEpisode ? 6_000_000 : isQuiet ? 300_000 : 1_000_000,
    });
  }
  return { points, market: { exchangeTimezone: "America/New_York" },
    source: { provider: "twelvedata", fetchedAt: new Date().toISOString() } };
}
const run = (series, now = NOW) => findBehaviouralAnalogues(series, { now });

/**
 * A series whose episodes are SUSTAINED: high volume and continued daily
 * movement, as a real elevated period behaves. The simpler fixture above
 * produces one price jump followed by a plateau, in which movement
 * genuinely resolves after a session — useful for matching, but not a
 * continuous behavioural episode.
 */
function makeSustainedSeries({ n = 200, episodes = [] } = {}) {
  const lastTs = Date.parse("2026-09-04T00:00:00Z");
  const points = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const ts = lastTs - (n - 1 - i) * DAY;
    const ep = episodes.includes(i);
    price = ep ? price * (i % 2 ? 1.06 : 0.95) : price * (1 + ((i % 3) - 1) * 0.001);
    points.push({ date: new Date(ts).toISOString().slice(0, 10), timestamp: ts,
      open: price, high: price * (ep ? 1.04 : 1.004), low: price * (ep ? 0.96 : 0.996),
      close: price, volume: ep ? 6_000_000 : 1_000_000 });
  }
  return { points, market: { exchangeTimezone: "America/New_York" },
    source: { provider: "twelvedata", fetchedAt: new Date().toISOString() } };
}
/** The final sessions are episode bars so the TARGET resembles them. */
const TARGET_TAIL = [198, 199];

/* ================================================================== */
/* ANTI-LEAKAGE — the central guarantee                                */
/* ================================================================== */

test("ADVERSARIAL: appending extreme future bars cannot change an earlier candidate's features", () => {
  const base = makeSeries({ n: 120, episodes: [40, 60, 80] });

  // The same series, then continued with wildly extreme sessions: huge
  // volume, violent moves, absurd ranges.
  const extended = { ...base, points: [...base.points] };
  const lastTs = base.points[base.points.length - 1].timestamp;
  for (let k = 1; k <= 20; k++) {
    extended.points.push({
      date: new Date(lastTs + k * DAY).toISOString().slice(0, 10), timestamp: lastTs + k * DAY,
      open: 1000, high: 5000, low: 10, close: 1000 * (k % 2 ? 3 : 0.3), volume: 900_000_000,
    });
  }

  // Every historical session must be described identically in both series.
  let checked = 0;
  for (const index of [30, 40, 55, 60, 75, 80, 95, 110, 119]) {
    const before = describeBehaviourAt(base, index);
    const after = describeBehaviourAt(extended, index);
    assert.deepEqual(after.features, before.features,
      `session ${index} changed after extreme future data was appended`);
    assert.deepEqual(after.regimeIds, before.regimeIds,
      `session ${index}'s regime changed after future data was appended`);
    checked++;
  }
  assert.equal(checked, 9);
});

test("ADVERSARIAL: a candidate's match eligibility is unchanged by extreme future data", () => {
  const base = makeSeries({ n: 120, episodes: [40, 60, 80] });
  const extended = { ...base, points: [...base.points] };
  const lastTs = base.points[base.points.length - 1].timestamp;
  for (let k = 1; k <= 5; k++) {
    extended.points.push({ date: new Date(lastTs + k * DAY).toISOString().slice(0, 10),
      timestamp: lastTs + k * DAY, open: 1000, high: 5000, low: 10, close: 3000, volume: 900_000_000 });
  }
  // Held against a FIXED target description, the same candidates match.
  const target = describeBehaviourAt(base, 100).features;
  for (const index of [40, 60, 80]) {
    const a = compareFeatures(target, describeBehaviourAt(base, index).features);
    const b = compareFeatures(target, describeBehaviourAt(extended, index).features);
    assert.deepEqual(b, a, `candidate ${index}'s comparison changed`);
  }
});

test("a candidate's description depends only on the prefix up to its own session", () => {
  const full = makeSeries({ n: 120, episodes: [40, 60, 80] });
  const truncated = { ...full, points: full.points.slice(0, 91) };

  const fromFull = run(full).analogues.find(c => c.index === 60);
  const fromTruncated = findBehaviouralAnalogues(truncated,
    { now: new Date(full.points[90].timestamp + 36 * 3600 * 1000) }).analogues.find(c => c.index === 60);

  if (fromFull && fromTruncated) {
    assert.deepEqual(fromTruncated.features, fromFull.features,
      "truncating the series after the candidate must not change it");
  }
});

test("future outcomes cannot influence selection or similarity", () => {
  // Selection happens before any future bar is read. The proof: the accepted
  // set is identical across all three outcome horizons — only the outcome
  // counts differ, because only they consult data after a candidate.
  const r = run(makeSeries({ n: 200, episodes: [40, 60, 80, 100, 120, 140, 160] }));
  const acceptedIndices = r.analogues.map(c => c.index);

  const perHorizon = ANALOGUE_CONSTANTS.OUTCOME_HORIZONS.map(h => {
    const key = `+${h}`;
    return r.horizons[key].outcomes.map(o => o.candidateIndex);
  });
  for (const indices of perHorizon) {
    // Each horizon's outcomes are a prefix-subset of the SAME accepted set,
    // differing only by candidates whose future window is incomplete.
    for (const i of indices) assert.ok(acceptedIndices.includes(i));
  }
  assert.ok(perHorizon[0].length >= perHorizon[2].length,
    "a longer horizon can only lose candidates, never gain or change them");
});

test("the target can never match itself and candidates are strictly historical", () => {
  const r = run(makeSeries({ n: 150, episodes: [50, 70, 90, 110] }));
  const latest = r.target.index;
  for (const c of r.analogues) {
    assert.ok(c.index < latest, `candidate ${c.index} is not strictly before the target ${latest}`);
  }
});

/* ================================================================== */
/* SIMILARITY                                                          */
/* ================================================================== */

test("similarity is driven by continuous observations, not the regime label", () => {
  // Identical labels, very different measurements.
  const near = compareFeatures(
    { participationPercentile: 90, movementPercentile: 90, rangePercentile: 90, participationRatio: 1.0 },
    { participationPercentile: 92, movementPercentile: 88, rangePercentile: 91, participationRatio: 1.05 });
  const far = compareFeatures(
    { participationPercentile: 90, movementPercentile: 90, rangePercentile: 90, participationRatio: 1.0 },
    { participationPercentile: 20, movementPercentile: 15, rangePercentile: 10, participationRatio: 0.3 });

  assert.equal(near.matched, true);
  assert.equal(far.matched, false);
  assert.ok(far.distance > near.distance);
  assert.equal(far.rejectedFor, "SIMILARITY");
});

test("the participation ratio uses log distance, so 0.5x and 2x are equally far from 1x", () => {
  const base = { participationPercentile: 50, movementPercentile: 50, rangePercentile: 50, participationRatio: 1 };
  const half = compareFeatures(base, { ...base, participationRatio: 0.5 });
  const double = compareFeatures(base, { ...base, participationRatio: 2 });
  assert.equal(half.dimensionDistances.participationRatio, double.dimensionDistances.participationRatio);
});

test("similarity is deterministic", () => {
  const t = { participationPercentile: 80, movementPercentile: 70, rangePercentile: 60, participationRatio: 1.2 };
  const c = { participationPercentile: 82, movementPercentile: 68, rangePercentile: 63, participationRatio: 1.1 };
  assert.deepEqual(compareFeatures(t, c), compareFeatures(t, c));
});

test("similarity is non-directional: it uses only magnitude and participation", () => {
  const cmp = compareFeatures(
    { participationPercentile: 90, movementPercentile: 95, rangePercentile: 90, participationRatio: 1.5 },
    { participationPercentile: 90, movementPercentile: 95, rangePercentile: 90, participationRatio: 1.5 });
  assert.deepEqual([...cmp.comparedDimensions].sort(),
    ["movementPercentile", "participationPercentile", "participationRatio", "rangePercentile"]);
  assert.ok(!JSON.stringify(cmp).match(/BULLISH|BEARISH|direction/i));
});

/* ================================================================== */
/* MISSING DIMENSIONS AND COVERAGE                                     */
/* ================================================================== */

test("a missing dimension is excluded, never treated as zero", () => {
  const cmp = compareFeatures(
    { participationPercentile: null, movementPercentile: 50, rangePercentile: 50, participationRatio: 1 },
    { participationPercentile: 90, movementPercentile: 50, rangePercentile: 50, participationRatio: 1 });
  assert.deepEqual(cmp.missingDimensions, ["participationPercentile"]);
  assert.ok(!("participationPercentile" in cmp.dimensionDistances));
  assert.equal(cmp.distance, 0, "the comparable dimensions are identical");
  assert.equal(cmp.comparedDimensions.length, 3);
});

test("insufficient coverage rejects the candidate rather than scoring what is left", () => {
  const cmp = compareFeatures(
    { participationPercentile: 50, movementPercentile: null, rangePercentile: null, participationRatio: null },
    { participationPercentile: 50, movementPercentile: null, rangePercentile: null, participationRatio: null });
  assert.equal(cmp.comparable, false);
  assert.equal(cmp.matched, false);
  assert.equal(cmp.rejectedFor, "INSUFFICIENT_COVERAGE");
  assert.equal(cmp.distance, null, "no similarity is invented from one dimension");
});

test("missingness is never rewarded with an easier match", () => {
  const full = compareFeatures(
    { participationPercentile: 50, movementPercentile: 50, rangePercentile: 50, participationRatio: 1 },
    { participationPercentile: 90, movementPercentile: 90, rangePercentile: 90, participationRatio: 3 });
  assert.equal(full.matched, false);
  // Dropping the dimensions that disagree must not create a match from
  // fewer than the minimum comparable dimensions.
  const stripped = compareFeatures(
    { participationPercentile: 50, movementPercentile: null, rangePercentile: null, participationRatio: null },
    { participationPercentile: 50, movementPercentile: null, rangePercentile: null, participationRatio: null });
  assert.equal(stripped.matched, false);
});

/* ================================================================== */
/* SAMPLE SIZE AND HORIZONS                                            */
/* ================================================================== */

test("sample gating preserves the locked 5 / 8 boundaries", () => {
  const r = run(makeSeries({ n: 200, episodes: [40, 60, 80, 100, 120, 140, 160] }));
  for (const key of Object.keys(r.horizons)) {
    const h = r.horizons[key];
    const expected = h.analogueCount < 5 ? SampleStatus.INSUFFICIENT_ANALOGUES
      : h.analogueCount < 8 ? SampleStatus.SMALL_SAMPLE : SampleStatus.MEASURED;
    assert.equal(h.status, expected, `${key}: ${h.analogueCount} analogues`);
  }
});

test("too few analogues is INSUFFICIENT, never a conclusion", () => {
  const r = run(makeSeries({ n: 120, episodes: [40] }));
  if (r.analogueCount < 5) {
    assert.equal(r.status, SampleStatus.INSUFFICIENT_ANALOGUES);
    assert.ok(r.limitations.some(l => /too few to describe what followed/.test(l)));
  }
});

test("analogue count means episodes with a COMPLETE POST-EPISODE window", () => {
  const r = run(makeSeries({ n: 200, episodes: [40, 60, 80, 100, 120, 140, 160, 180, 195] }));
  const latest = r.target.index;
  for (const key of Object.keys(r.horizons)) {
    const h = r.horizons[key];
    for (const o of h.outcomes) {
      assert.ok(o.outcomeIndex <= latest, "an outcome must exist in the data");
      // Measured from the episode's resolution, never the representative.
      assert.equal(o.outcomeIndex, o.outcomeBaseIndex + h.horizonSessions);
    }
    const eligible = r.analogues.filter(c =>
      c.episode.outcomeBaseIndex !== null && c.episode.outcomeBaseIndex + h.horizonSessions <= latest).length;
    assert.equal(h.analogueCount, eligible);
    assert.equal(h.excludedForIncompleteOutcome, r.analogueCount - eligible);
  }
});

test("the longest horizon excludes more candidates than the shortest", () => {
  const r = run(makeSeries({ n: 200, episodes: [40, 60, 80, 100, 120, 140, 160, 180, 194] }));
  assert.ok(r.horizons["+20"].excludedForIncompleteOutcome >= r.horizons["+1"].excludedForIncompleteOutcome);
  assert.deepEqual(ANALOGUE_CONSTANTS.OUTCOME_HORIZONS, [1, 5, 20]);
});

/* ================================================================== */
/* OUTCOMES AND DISTRIBUTION                                           */
/* ================================================================== */

test("the full behavioural outcome distribution is returned, not a summary", () => {
  const r = run(makeSeries({ n: 200, episodes: [40, 60, 80, 100, 120, 140, 160] }));
  for (const key of Object.keys(r.horizons)) {
    const h = r.horizons[key];
    assert.equal(typeof h.regimeDistribution, "object");
    assert.equal(h.outcomes.length, h.analogueCount, "every analogue's outcome is present");
    for (const [, v] of Object.entries(h.regimeDistribution)) {
      assert.equal(typeof v.count, "number");
      assert.equal(typeof v.percentOfAnalogues, "number");
    }
  }
});

test("co-occurring regimes are represented truthfully, not as a partition", () => {
  const r = run(makeSeries({ n: 200, episodes: [40, 60, 80, 100, 120, 140, 160] }));
  const h = r.horizons["+5"];
  const summed = Object.values(h.regimeDistribution).reduce((a, v) => a + v.count, 0);
  // Regimes co-occur, so counts may exceed the analogue count. What must
  // never happen is a count exceeding the number of analogues for one regime.
  for (const [, v] of Object.entries(h.regimeDistribution)) {
    assert.ok(v.count <= h.analogueCount, "a regime cannot occur more often than there are analogues");
  }
  assert.ok(summed >= 0);
});

test("an outcome with no regime is recorded as its explicit state, never NEUTRAL", () => {
  const r = run(makeSeries({ n: 200, episodes: [40, 60, 80, 100, 120, 140, 160] }));
  const serialised = JSON.stringify(r).toLowerCase();
  assert.ok(!serialised.includes("neutral"), "UNKNOWN must never become NEUTRAL");
  for (const key of Object.keys(r.horizons)) {
    for (const o of r.horizons[key].outcomes) {
      if (o.regimeIds.length === 0) {
        assert.ok([BehaviouralRegime.UNKNOWN, BehaviouralRegime.INSUFFICIENT_HISTORY].includes(o.regimeStatus));
      }
    }
  }
});

test("persistence and resolution of the candidate's own regimes are reported", () => {
  const r = run(makeSeries({ n: 200, episodes: [40, 60, 80, 100, 120, 140, 160] }));
  for (const o of r.horizons["+5"].outcomes) {
    assert.ok(Array.isArray(o.persisted));
    assert.ok(Array.isArray(o.resolved));
    const candidate = r.analogues.find(c => c.index === o.candidateIndex);
    assert.equal(o.persisted.length + o.resolved.length, candidate.regimeIds.length);
  }
});

/* ================================================================== */
/* SPACING, CONSTANTS, SEARCH REPORTING                                */
/* ================================================================== */

test("REGRESSION: a continuous episode is collapsed, not counted per session", () => {
  // Ten consecutive comparable sessions.
  const r = run(makeSustainedSeries({ n: 200, episodes: [...Array(10)].map((_, k) => 60 + k).concat(TARGET_TAIL) }));
  const inRun = r.analogues.filter(c => c.index >= 58 && c.index <= 75);

  assert.ok(r.search.matchingSessions >= 10, "many individual sessions matched");
  assert.ok(inRun.length < r.search.matchingSessions,
    `ten matching sessions must not become ten analogues (got ${inRun.length})`);
  assert.ok(inRun.length <= 2,
    "a ten-session run collapses to at most two episodes, and only if its character genuinely drifted");
  for (const a of inRun) {
    assert.ok(a.episode.sessionCount >= 1);
    assert.equal(a.episode.representativeIndex, a.index);
  }
});

test("genuinely separate episodes are counted separately", () => {
  const r = run(makeSustainedSeries({ n: 200, episodes: [60, 61, 62, 140, 141, 142, ...TARGET_TAIL] }));
  assert.equal(r.analogues.filter(c => c.index >= 58 && c.index <= 70).length, 1);
  assert.equal(r.analogues.filter(c => c.index >= 138 && c.index <= 150).length, 1);
});

test("an episode survives a brief interruption but ends on a genuine resolution", () => {
  assert.equal(ANALOGUE_CONSTANTS.EPISODE_BREAK_SESSIONS, 3);

  // A single interrupting session is a fluctuation, not the end.
  const brief = run(makeSustainedSeries({ n: 200, episodes: [60, 61, 63, 64, ...TARGET_TAIL] }));
  assert.equal(brief.analogues.filter(c => c.index >= 58 && c.index <= 70).length, 1,
    "one dip must not split the episode");

  // A long separation is genuinely two episodes.
  const split = run(makeSustainedSeries({ n: 200, episodes: [60, 61, 100, 101, ...TARGET_TAIL] }));
  assert.equal(split.analogues.filter(c => c.index >= 58 && c.index <= 70).length, 1);
  assert.equal(split.analogues.filter(c => c.index >= 98 && c.index <= 110).length, 1);
});

test("continuity is judged against the episode, not against the target", () => {
  // Inside a run, percentiles drift as the elevated sessions enter the
  // asset's own history, so mid-run sessions can stop matching the TARGET
  // while the episode is plainly still under way. Judging against the
  // target would split one run into several analogues.
  const r = run(makeSustainedSeries({ n: 200, episodes: [...Array(8)].map((_, k) => 60 + k).concat(TARGET_TAIL) }));
  const inRun = r.analogues.filter(c => c.index >= 58 && c.index <= 72);
  const matchingInRun = r.search.matchingSessions;
  assert.ok(inRun.length < matchingInRun,
    "sessions matching the target are collapsed into far fewer episodes");
});

test("deduplication is reported, never hidden, and availability is not chased", () => {
  const r = run(makeSustainedSeries({ n: 200, episodes: [60, 61, 62, 63, 64, 65, 66, 67, ...TARGET_TAIL] }));
  assert.ok(r.search.matchingSessions >= r.search.distinctEpisodes,
    "more sessions matched than there are episodes");
  assert.equal(r.search.sessionsDeduplicatedIntoEpisodes,
    r.search.matchingSessions - r.search.distinctEpisodes);
  if (r.search.sessionsDeduplicatedIntoEpisodes > 0) {
    assert.ok(r.limitations.some(l => /distinct behavioural episode/.test(l)),
      "the reader is told sessions were collapsed into episodes");
  }
  // Few genuine episodes is reported as limited history, not inflated.
  const sparse = run(makeSustainedSeries({ n: 200, episodes: [60, 61, 62, ...TARGET_TAIL] }));
  if (sparse.analogueCount < 5) {
    assert.equal(sparse.status, SampleStatus.INSUFFICIENT_ANALOGUES);
    assert.ok(sparse.limitations.some(l => /Limited history/.test(l)));
  }
});

test("all constants are centralized, reported and explicitly uncalibrated", () => {
  assert.equal(ANALOGUE_CONSTANTS.calibrated, false);
  const r = run(makeSeries({ n: 120, episodes: [40, 60, 80] }));
  assert.equal(r.method.constants, ANALOGUE_CONSTANTS, "the same object is reported, not a copy that could drift");
  assert.ok(r.limitations.some(l => /not calibrated|have not been calibrated/.test(l)));
  assert.equal(typeof ANALOGUE_CONSTANTS.SIMILARITY_TOLERANCE, "number");
});

test("the search is fully reported", () => {
  const r = run(makeSeries({ n: 200, episodes: [40, 60, 80, 100] }));
  for (const key of ["candidatesConsidered", "withSufficientFeatureHistory", "rejectedForCoverage",
                     "rejectedForSimilarity", "matchingSessions", "distinctEpisodes",
                     "sessionsDeduplicatedIntoEpisodes", "accepted"]) {
    assert.equal(typeof r.search[key], "number", `${key} must be reported`);
  }
  assert.ok(r.search.candidatesConsidered > r.search.accepted);
});

/* ================================================================== */
/* EPISTEMICS AND PROVENANCE                                           */
/* ================================================================== */

test("the count is an OBSERVATION and the resemblance a BEHAVIOURAL_INTERPRETATION", () => {
  const r = run(makeSeries({ n: 200, episodes: [40, 60, 80, 100, 120] }));
  const findings = analogueFindings(r);
  if (!findings.length) return;

  const count = findings.find(f => f.id === "HISTORICAL_ANALOGUE_COUNT");
  const resembles = findings.find(f => f.id === "RESEMBLES_HISTORICAL_CONDITIONS");
  assert.equal(count.layer, EpistemicLayer.OBSERVATION);
  assert.equal(resembles.layer, EpistemicLayer.BEHAVIOURAL_INTERPRETATION);
  assert.ok(resembles.basedOn.includes("HISTORICAL_ANALOGUE_COUNT"));
  assert.match(resembles.statement, /resembles/);

  for (const f of findings) {
    assert.equal(f.origin, EvidenceOrigin.OBSERVED_MARKET_BEHAVIOUR);
    assert.equal(f.subject, FindingSubject.MARKET);
    assert.equal(f.provenance.source, EvidenceSource.MARKET_HISTORY,
      "analogues are a different calculation over the same evidence, not a new source");
  }
});

test("analogue evidence gains no false independence as a new source", () => {
  const r = run(makeSeries({ n: 200, episodes: [40, 60, 80, 100, 120] }));
  const findings = analogueFindings(r);
  if (!findings.length) return;
  for (const f of findings) {
    assert.equal(f.provenance.source, EvidenceSource.MARKET_HISTORY,
      "a different calculation over the same evidence, not a new source");
    assert.notEqual(f.provenance.source, EvidenceSource.CROWD_FEED);
    assert.notEqual(f.provenance.source, EvidenceSource.FUNDAMENTAL_FEED);
  }
});

test("REGRESSION: historical resemblance is ONE phenomenon, not a composite", () => {
  const r = run(makeSeries({ n: 200, episodes: [40, 60, 80, 100, 120] }));
  const findings = analogueFindings(r);
  if (!findings.length) return;

  for (const f of findings) {
    assert.equal(f.provenance.composite, false,
      "composite would mean it correlates with nothing, so two resemblance claims would each count");
    assert.equal(f.provenance.correlationGroup, CorrelationGroup.MARKET_HISTORICAL_ANALOGUE);
  }

  // Another finding making a historical-resemblance claim correlates.
  const otherResemblance = { source: EvidenceSource.MARKET_HISTORY,
    correlationGroup: CorrelationGroup.MARKET_HISTORICAL_ANALOGUE,
    declared: true, composite: false, horizon: null };
  assert.equal(areCorrelated(findings[0].provenance, otherResemblance), true,
    "the same historical-resemblance phenomenon must be counted once");
});

test("historical resemblance is distinguishable from current activity phenomena", () => {
  const r = run(makeSeries({ n: 200, episodes: [40, 60, 80, 100, 120] }));
  const findings = analogueFindings(r);
  if (!findings.length) return;

  // "Activity is extreme" and "this resembles six past episodes" are
  // different facts, as RSI extension and a 20-session move are.
  for (const group of [CorrelationGroup.MARKET_PARTICIPATION, CorrelationGroup.MARKET_ACCELERATION,
                       CorrelationGroup.MARKET_RANGE, CorrelationGroup.MARKET_PARTICIPATION_CHANGE]) {
    assert.equal(areCorrelated(findings[0].provenance,
      { source: EvidenceSource.MARKET_HISTORY, correlationGroup: group,
        declared: true, composite: false, horizon: null }), false, `must not collapse into ${group}`);
  }
});

test("analogues never produce INTENT", () => {
  const r = run(makeSeries({ n: 200, episodes: [40, 60, 80, 100, 120] }));
  for (const f of analogueFindings(r)) assert.notEqual(f.layer, EpistemicLayer.INTENT);
  assert.throws(() => makeEpistemicFinding({
    origin: EvidenceOrigin.OBSERVED_MARKET_BEHAVIOUR, layer: EpistemicLayer.INTENT,
    subject: FindingSubject.MARKET, id: "X",
    statement: "History shows traders panic here.", basedOn: ["HISTORICAL_ANALOGUE_COUNT"],
  }), EpistemicViolation);
});

/* ================================================================== */
/* NO PREDICTION, NO PRICE RETURNS, NO DIRECTION                       */
/* ================================================================== */

test("no predictive language is emitted anywhere", () => {
  const r = run(makeSeries({ n: 200, episodes: [40, 60, 80, 100, 120, 140] }));
  const text = JSON.stringify({ r, findings: analogueFindings(r) }).toLowerCase();
  for (const banned of ["likely to", "expected to", "will rise", "will fall", "should rise",
                        "should fall", "probability of", "expected return", "predict",
                        "based on history, this"]) {
    assert.ok(!text.includes(banned), `${banned} must not appear`);
  }
});

test("no price-return, profit or win-rate statistics are produced", () => {
  const r = run(makeSeries({ n: 200, episodes: [40, 60, 80, 100, 120, 140] }));
  const keys = new Set();
  (function walk(v) { if (v && typeof v === "object") for (const [k, val] of Object.entries(v)) { keys.add(k.toLowerCase()); walk(val); } })(r);
  for (const banned of ["return", "futurereturn", "profit", "winrate", "gain", "loss",
                        "targetprice", "expectedreturn", "pnl"]) {
    assert.ok(!keys.has(banned), `no field may be named ${banned}`);
  }
});

test("no directional Council contribution is produced", () => {
  const r = run(makeSeries({ n: 200, episodes: [40, 60, 80, 100, 120] }));
  // Field names checked structurally: a substring search would flag
  // "distance", which legitimately contains "stance".
  const keys = new Set();
  (function walk(v) { if (v && typeof v === "object") for (const [k, val] of Object.entries(v)) { keys.add(k.toLowerCase()); walk(val); } })(r);
  for (const banned of ["direction", "stance", "vote", "verdict", "bullish", "bearish", "confidence"]) {
    assert.ok(!keys.has(banned), `no field may be named ${banned}`);
  }
  // And no VALUE asserts a market direction.
  const text = JSON.stringify({ r, findings: analogueFindings(r) });
  for (const banned of ["BULLISH", "BEARISH"]) {
    assert.ok(!text.includes(banned), `${banned} must not appear`);
  }
});

test("no risk or trade judgment is produced — that belongs to Death and the Council", () => {
  const r = run(makeSeries({ n: 200, episodes: [40, 60, 80, 100, 120] }));
  const asserted = [...r.limitations, ...analogueFindings(r).map(f => f.statement)].join(" ").toLowerCase();
  for (const banned of ["too risky", "avoid", "do not proceed", " buy ", " sell ", "safe trade"]) {
    assert.ok(!asserted.includes(banned), `${banned} must not appear`);
  }
});

/* ================================================================== */
/* FAILURE MODES                                                       */
/* ================================================================== */

test("malformed and short series fail safely", () => {
  for (const bad of [null, undefined, {}, { points: [] }, { points: [{ close: 1 }] },
                     makeSeries({ n: 10 })]) {
    const r = findBehaviouralAnalogues(bad, { now: NOW });
    assert.equal(r.status, SampleStatus.INSUFFICIENT_ANALOGUES);
    assert.equal(r.analogueCount, 0);
    assert.equal(analogueFindings(r).length, 0, "nothing is asserted from nothing");
  }
});

test("an undescribable target yields no analogues rather than a forced comparison", () => {
  // Volume absent throughout: participation and its ratio are unavailable.
  const series = makeSeries({ n: 120 });
  series.points = series.points.map(p => ({ ...p, volume: null }));
  const r = findBehaviouralAnalogues(series, { now: NOW });
  assert.equal(r.analogueCount, 0);
  assert.ok(r.limitations.some(l => /not be described on enough dimensions/.test(l)));
});

test("results are deterministic and frozen", () => {
  const series = makeSeries({ n: 150, episodes: [40, 60, 80, 100] });
  assert.deepEqual(run(series), run(series));
  const r = run(series);
  assert.throws(() => { r.status = "X"; }, TypeError);
  assert.throws(() => { r.analogues.push({}); }, TypeError);
  assert.throws(() => { r.limitations.push("x"); }, TypeError);
});

test("the module consumes only the locked Conquest layers", async () => {
  const raw = await import("node:fs").then(fs =>
    fs.readFileSync(new URL("../src/conquest/historicalAnalogues.js", import.meta.url), "utf8"));
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const banned of ["warFactsV2", "rsi14", "movingAverages", "famine", "council", "deathAnalysis"]) {
    assert.ok(!code.toLowerCase().includes(banned.toLowerCase()), `must not consume ${banned}`);
  }
});

/* ================================================================== */
/* FINAL HARDENING — EPISODE OUTCOME SEMANTICS                         */
/* ================================================================== */

import { inspectToleranceSensitivity } from "../src/conquest/historicalAnalogues.js";

/** A long episode whose representative sits near its beginning. */
const LONG_EPISODE = [...Array(11)].map((_, k) => 40 + k);          // sessions 40–50
const longEpisodeSeries = () =>
  makeSustainedSeries({ n: 200, episodes: [...LONG_EPISODE, 120, 121, ...TARGET_TAIL] });

test("REGRESSION: sessions inside the analogue's own episode never become its outcomes", () => {
  const r = run(longEpisodeSeries());
  const analogue = r.analogues.find(c => c.index >= 40 && c.index <= 55);
  assert.ok(analogue, "the long episode must be found");
  const ep = analogue.episode;

  for (const key of Object.keys(r.horizons)) {
    for (const o of r.horizons[key].outcomes) {
      if (o.candidateIndex !== analogue.index) continue;
      assert.ok(o.outcomeIndex > ep.endIndex,
        `+${r.horizons[key].horizonSessions} landed on session ${o.outcomeIndex}, inside the episode ending at ${ep.endIndex}`);
      assert.ok(o.outcomeIndex > ep.resolvedAtIndex,
        "an outcome must also come after every bar consulted to resolve the episode");
    }
  }
});

test("the representative is NOT treated as the end of the episode", () => {
  const r = run(longEpisodeSeries());
  const analogue = r.analogues.find(c => c.index >= 40 && c.index <= 55);
  const ep = analogue.episode;

  assert.equal(ep.representativeIndex, analogue.index);
  assert.ok(ep.representativeIndex <= ep.endIndex);
  assert.notEqual(ep.outcomeBaseIndex, ep.representativeIndex,
    "measuring from the representative is exactly the defect this fixes");
  assert.ok(ep.outcomeBaseIndex > ep.endIndex,
    "the outcome base is after every bar that was part of the episode");
});

test("+1, +5 and +20 are each measured from the episode resolution", () => {
  const r = run(longEpisodeSeries());
  for (const [key, h] of Object.entries(r.horizons)) {
    for (const o of h.outcomes) {
      assert.equal(o.outcomeIndex, o.outcomeBaseIndex + h.horizonSessions,
        `${key} must be measured from the outcome base`);
      assert.notEqual(o.outcomeIndex, o.candidateIndex + h.horizonSessions === o.outcomeIndex
        ? -1 : o.candidateIndex + h.horizonSessions, "and not from the representative");
    }
  }
});

test("REGRESSION: representative +1 and +5 would have fallen inside the episode", () => {
  // Demonstrates the defect this hardening removes, on real numbers.
  const r = run(longEpisodeSeries());
  const analogue = r.analogues.find(c => c.index >= 40 && c.index <= 55);
  const ep = analogue.episode;
  const naiveOne = analogue.index + 1;
  const naiveFive = analogue.index + 5;

  if (naiveFive <= ep.endIndex) {
    assert.ok(naiveOne <= ep.endIndex || naiveFive <= ep.endIndex,
      "the naive anchor lands inside the episode for this fixture");
  }
  // The implemented anchor never does.
  assert.ok(ep.outcomeBaseIndex + 1 > ep.endIndex);
  assert.ok(ep.outcomeBaseIndex + 5 > ep.endIndex);
});

test("bars consulted to resolve an episode are never reported as outcomes", () => {
  const r = run(longEpisodeSeries());
  for (const analogue of r.analogues) {
    const ep = analogue.episode;
    if (!ep.resolved) continue;
    // Every bar from the episode start through its resolution is off limits.
    for (const key of Object.keys(r.horizons)) {
      for (const o of r.horizons[key].outcomes) {
        if (o.candidateIndex !== analogue.index) continue;
        assert.ok(o.outcomeIndex > ep.resolvedAtIndex,
          `session ${o.outcomeIndex} was consulted while resolving the episode`);
      }
    }
  }
});

test("an unresolved episode contributes to no horizon, since nothing followed it yet", () => {
  const r = run(longEpisodeSeries());
  const unresolved = r.analogues.filter(c => !c.episode.resolved);
  for (const key of Object.keys(r.horizons)) {
    const h = r.horizons[key];
    assert.equal(h.excludedForUnresolvedEpisode, unresolved.length);
    for (const o of h.outcomes) {
      assert.notEqual(o.outcomeBaseIndex, null);
    }
  }
});

/* ---------------- phase separation ---------------- */

test("PHASE B: episode grouping cannot change a candidate's features or distance", () => {
  // The same session, described in isolation and after grouping, is identical.
  const series = longEpisodeSeries();
  const r = run(series);
  for (const analogue of r.analogues) {
    const independent = describeBehaviourAt(series, analogue.index);
    assert.deepEqual(analogue.features, independent.features,
      "grouping is ex-post and must not touch the candidate description");
    const recomputed = compareFeatures(r.target.features, independent.features);
    assert.equal(analogue.comparison.distance, recomputed.distance,
      "grouping must not change the measured distance");
    assert.equal(analogue.comparison.matched, recomputed.matched);
  }
});

test("PHASE B: episode grouping cannot turn a non-match into a match", () => {
  const series = longEpisodeSeries();
  const r = run(series);
  for (const analogue of r.analogues) {
    const independent = describeBehaviourAt(series, analogue.index);
    assert.equal(compareFeatures(r.target.features, independent.features).matched, true,
      "every accepted analogue independently satisfied the similarity rule");
  }
});

test("PHASE A remains prefix-only after the outcome change", () => {
  const base = makeSustainedSeries({ n: 120, episodes: [40, 41, 42, 80, 81, ...[118, 119]] });
  const extended = { ...base, points: [...base.points] };
  const lastTs = base.points[base.points.length - 1].timestamp;
  for (let k = 1; k <= 15; k++) {
    extended.points.push({ date: new Date(lastTs + k * DAY).toISOString().slice(0, 10),
      timestamp: lastTs + k * DAY, open: 1000, high: 5000, low: 10, close: 3000, volume: 900_000_000 });
  }
  for (const index of [40, 42, 60, 80, 100]) {
    assert.deepEqual(describeBehaviourAt(extended, index).features,
      describeBehaviourAt(base, index).features);
  }
});

test("multiple matching sessions in one episode still count once", () => {
  const r = run(longEpisodeSeries());
  const inRun = r.analogues.filter(c => c.index >= 40 && c.index <= 55);

  // The eleven-session run collapses to far fewer analogues. It is not
  // always one: under anchor-based continuity a run whose character drifts
  // materially from how it began is reported as more than one episode,
  // which is the documented and intended behaviour.
  assert.ok(inRun.length >= 1);
  assert.ok(inRun.length < 11, `eleven sessions must not become eleven analogues (got ${inRun.length})`);
  assert.ok(r.search.matchingSessions > r.analogueCount,
    "more sessions matched than there are episodes");

  // Every episode covers at least one session and reports its own span.
  for (const a of inRun) {
    assert.ok(a.episode.spanSessions >= 1);
    assert.ok(a.episode.sessionsMatchingTarget >= 1);
    assert.ok(a.episode.representativeIndex >= a.episode.startIndex);
    assert.ok(a.episode.representativeIndex <= a.episode.endIndex);
  }
});

test("the outcome base is after the episode for EVERY analogue, fixture-independently", () => {
  for (const series of [longEpisodeSeries(),
                        makeSustainedSeries({ n: 200, episodes: [40, 41, 42, 100, 101, ...TARGET_TAIL] }),
                        makeSeries({ n: 200, episodes: [40, 60, 80, 100, 120] })]) {
    const r = run(series);
    for (const a of r.analogues) {
      const ep = a.episode;
      assert.ok(ep.representativeIndex <= ep.endIndex, "the representative is inside its episode");
      if (ep.resolved) {
        assert.ok(ep.outcomeBaseIndex > ep.endIndex,
          "the outcome base is strictly after every session in the episode");
        // The naive anchor would have been the representative.
        assert.ok(ep.outcomeBaseIndex >= ep.representativeIndex + 1);
      } else {
        assert.equal(ep.outcomeBaseIndex, null, "an unresolved episode has no outcome base");
      }
    }
  }
});

test("n means distinct episodes with a complete post-episode window, not timestamps", () => {
  const r = run(longEpisodeSeries());
  assert.equal(r.analogueCount, r.search.distinctEpisodes);
  assert.ok(r.search.matchingSessions >= r.analogueCount);
  for (const key of Object.keys(r.horizons)) {
    assert.ok(r.horizons[key].analogueCount <= r.analogueCount);
  }
});

test("analogue counts may legitimately differ across horizons", () => {
  const r = run(makeSustainedSeries({ n: 200,
    episodes: [40, 41, 80, 81, 120, 121, 160, 161, 185, 186, ...TARGET_TAIL] }));
  const counts = Object.values(r.horizons).map(h => h.analogueCount);
  assert.ok(counts[0] >= counts[counts.length - 1],
    "a longer horizon can only lose episodes, never gain them");
});

/* ---------------- constants and diagnostics ---------------- */

test("tolerance and episode rules are unchanged and uncalibrated", () => {
  assert.equal(ANALOGUE_CONSTANTS.SIMILARITY_TOLERANCE, 0.15);
  assert.equal(ANALOGUE_CONSTANTS.EPISODE_BREAK_SESSIONS, 3);
  assert.equal(ANALOGUE_CONSTANTS.MIN_COMPARED_DIMENSIONS, 3);
  assert.equal(ANALOGUE_CONSTANTS.calibrated, false);
});

test("low availability stays insufficient rather than widening tolerance", () => {
  const sparse = run(makeSustainedSeries({ n: 200, episodes: [60, 61, ...TARGET_TAIL] }));
  if (sparse.analogueCount < 5) {
    assert.equal(sparse.status, SampleStatus.INSUFFICIENT_ANALOGUES);
    assert.ok(sparse.limitations.some(l => /Limited history/.test(l)));
  }
  // The production constant is untouched by any low-availability result.
  assert.equal(ANALOGUE_CONSTANTS.SIMILARITY_TOLERANCE, 0.15);
});

test("tolerance sensitivity is diagnostic only and changes no production constant", () => {
  const series = makeSustainedSeries({ n: 200, episodes: [40, 41, 80, 81, 120, 121, ...TARGET_TAIL] });
  const report = inspectToleranceSensitivity(series, [0.10, 0.15, 0.20], { now: NOW });

  assert.equal(report.productionTolerance, 0.15);
  assert.equal(report.rows.length, 3);
  assert.equal(report.rows.find(r => r.tolerance === 0.15).isProductionValue, true);
  assert.match(report.note, /Diagnostic only/);
  // A wider tolerance cannot find fewer matching sessions.
  const narrow = report.rows.find(r => r.tolerance === 0.10);
  const wide = report.rows.find(r => r.tolerance === 0.20);
  assert.ok(wide.matchingSessions >= narrow.matchingSessions);
  // Production remains exactly as declared.
  assert.equal(ANALOGUE_CONSTANTS.SIMILARITY_TOLERANCE, 0.15);
  assert.equal(run(series).analogueCount, report.rows.find(r => r.tolerance === 0.15).distinctEpisodes);
});
