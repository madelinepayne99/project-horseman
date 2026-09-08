import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildConquestInput, ConquestStatus } from "../src/conquest/buildConquestInput.js";
import { conquestAnalysis, hasDirectionalCrowdEvidence } from "../src/conquest/conquestAnalysis.js";
import { observeMarketBehaviour } from "../src/conquest/marketObservations.js";
import { classifyBehaviouralRegimes, BehaviouralRegime } from "../src/conquest/behaviouralRegimes.js";
import { findBehaviouralAnalogues, SampleStatus } from "../src/conquest/historicalAnalogues.js";
import { CrowdAttentionLevel } from "../src/conquest/crowdAttention.js";
import { CrowdSentiment, Polarisation } from "../src/conquest/sentiment.js";
import { CrowdingLevel } from "../src/conquest/crowding.js";
import { EvidenceChannel, ChannelStatus } from "../src/conquest/conquestEvidenceQuality.js";
import { makeCrowdObservation, makeCrowdEvidence, makeUnavailableCrowdEvidence, CrowdStance, EvidenceOrigin } from "../src/schema/crowd.js";
import { EvidenceSource } from "../src/schema/provenance.js";
import { EpistemicLayer, FindingSubject } from "../src/schema/epistemics.js";

/** Conquest V2 assembly. Pure, deterministic, no network. */

const NOW = new Date("2026-09-04T20:45:00Z");
const DAY = 86400000;

function makeSeries({ n = 200, episodes = [] } = {}) {
  const lastTs = Date.parse("2026-09-04T00:00:00Z");
  const points = []; let price = 100;
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

const crowdObs = (i, over = {}) => makeCrowdObservation({
  id: `o${i}`, sourceName: `forum-${i % 6}`, authorId: `u${i}`,
  publishedAt: new Date(NOW.getTime() - 2 * 3600 * 1000).toISOString(),
  engagement: 5, stance: CrowdStance.BULLISH, stanceConfidence: 0.8,
  isDuplicate: false, isSuspectedAutomated: false, ...over });
const crowd = (n, over = {}) => makeCrowdEvidence({
  assetId: "TEST", provider: "test-crowd",
  observations: Array.from({ length: n }, (_, i) => crowdObs(i, over)),
  windowStart: new Date(NOW.getTime() - 24 * 3600 * 1000).toISOString(),
  windowEnd: new Date(NOW.getTime() - 3600 * 1000).toISOString() });

const assemble = (over = {}) => buildConquestInput({
  assetId: "TEST", series: makeSeries({ n: 200, episodes: [40, 41, 90, 91, 140, 141, 198, 199] }),
  crowdEvidence: null, now: NOW, ...over });
const analyse = (over = {}) => conquestAnalysis(assemble(over));

/* ================================================================== */
/* ASSEMBLY INTRODUCES NOTHING                                         */
/* ================================================================== */

test("REGRESSION: assembly introduces no measurement or threshold of its own", () => {
  for (const file of ["buildConquestInput.js", "conquestAnalysis.js"]) {
    const raw = readFileSync(new URL(`../src/conquest/${file}`, import.meta.url), "utf8");
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    // No arithmetic that could constitute a new statistic or threshold.
    for (const banned of ["percentile(", "Math.log", "Math.abs", "reduce((", "THRESHOLD", "calibrated"]) {
      assert.ok(!code.includes(banned), `${file} must not contain ${banned}`);
    }
  }
  const r = analyse();
  assert.equal(r.provenance.measurementsIntroducedByAssembly, 0);
});

test("every reported value is copied from the layer that owns it", () => {
  const series = makeSeries({ n: 200, episodes: [40, 41, 90, 91, 198, 199] });
  const observations = observeMarketBehaviour(series, { now: NOW });
  const regimes = classifyBehaviouralRegimes(observations);
  const analogues = findBehaviouralAnalogues(series, { now: NOW });
  const r = conquestAnalysis(buildConquestInput({ assetId: "TEST", series, now: NOW }));

  assert.deepEqual(r.behaviouralRegimes, regimes.regimeIds);
  assert.equal(r.regimeStatus, regimes.status);
  assert.equal(r.observations.participationPercentile, observations.participation.percentile ?? null);
  assert.equal(r.observations.movementMagnitudePercentile, observations.movementMagnitude.percentile ?? null);
  assert.equal(r.observations.rangePercentile, observations.rangeExpansion.percentile ?? null);
  assert.equal(r.historicalAnalogues.episodeCount, analogues.analogueCount);
  assert.equal(r.historicalAnalogues.status, analogues.status);
  assert.equal(r.observations.latestBarProvisional, observations.latestBarProvisional);
});

test("layer results are passed through, not recomputed", () => {
  const series = makeSeries({ n: 200, episodes: [40, 41, 198, 199] });
  const direct = findBehaviouralAnalogues(series, { now: NOW });
  const viaAssembly = buildConquestInput({ assetId: "TEST", series, now: NOW }).marketBehaviour.analogues;
  assert.deepEqual(viaAssembly, direct, "the analogue result is the same object shape, unmodified");
});

/* ================================================================== */
/* MARKET BEHAVIOUR WITHOUT ANY PROVIDER                               */
/* ================================================================== */

test("market behaviour is fully available with no crowd provider", () => {
  const r = analyse();
  assert.equal(r.status, ConquestStatus.ASSESSED);
  assert.equal(typeof r.observations.participationPercentile, "number");
  assert.equal(typeof r.observations.movementMagnitudePercentile, "number");
  assert.ok(Array.isArray(r.behaviouralRegimes));
  assert.ok(r.findings.length > 0, "the locked layers produced findings");
  assert.equal(r.provenance.marketBehaviourAvailable, true);
});

test("rich market behaviour coexists with entirely UNKNOWN crowd fields", () => {
  const r = analyse();
  assert.equal(r.crowdAttention, CrowdAttentionLevel.UNAVAILABLE);
  assert.equal(r.crowdSentiment, CrowdSentiment.UNKNOWN);
  assert.equal(r.crowding, CrowdingLevel.UNKNOWN);
  assert.equal(r.polarisation, Polarisation.UNKNOWN);
  assert.equal(r.crowdSentimentConfidence, null);
  // And that combination is coherent, not an error state.
  assert.equal(r.status, ConquestStatus.ASSESSED);
});

test("no series and no crowd is INSUFFICIENT_EVIDENCE, not a quiet market", () => {
  const r = conquestAnalysis(buildConquestInput({ assetId: "TEST", series: null, crowdEvidence: null, now: NOW }));
  assert.equal(r.status, ConquestStatus.INSUFFICIENT_EVIDENCE);
  assert.equal(r.evidenceQuality.independentSourceCount, 0);
  assert.notEqual(r.regimeStatus, BehaviouralRegime.QUIET);
  assert.ok(r.missingEvidence.length > 0);
});

/* ================================================================== */
/* CROWD CHANNEL                                                       */
/* ================================================================== */

test("crowd fields become available when a genuine provider supplies evidence", () => {
  const r = analyse({ crowdEvidence: crowd(30) });
  assert.notEqual(r.crowdAttention, CrowdAttentionLevel.UNAVAILABLE);
  assert.equal(r.crowdSentiment, CrowdSentiment.BULLISH);
  assert.equal(r.provenance.directCrowdEvidence, true);
  assert.equal(typeof r.crowdSentimentConfidence, "number");
});

test("a crowd provider failure leaves crowd UNKNOWN and never implies balance", () => {
  const r = analyse({ crowdEvidence: makeUnavailableCrowdEvidence({
    assetId: "TEST", provider: "p", errorCode: "PROVIDER_UNAVAILABLE" }) });
  assert.equal(r.crowdAttention, CrowdAttentionLevel.UNAVAILABLE);
  assert.equal(r.crowdSentiment, CrowdSentiment.UNKNOWN);
  assert.notEqual(r.crowdSentiment, CrowdSentiment.NEUTRAL);
  assert.ok(r.limitations.some(l => /not evidence that opinion is balanced/.test(l)));
});

test("REGRESSION: a user-supplied claim cannot populate any crowd field", () => {
  const forged = { ...crowd(30), origin: EvidenceOrigin.USER_SUPPLIED_CLAIM };
  const r = analyse({ crowdEvidence: forged });
  assert.equal(r.crowdAttention, CrowdAttentionLevel.UNAVAILABLE);
  assert.equal(r.crowdSentiment, CrowdSentiment.UNKNOWN);
  assert.equal(r.crowding, CrowdingLevel.UNKNOWN);
  assert.equal(r.polarisation, Polarisation.UNKNOWN);
  assert.equal(r.provenance.directCrowdEvidence, false);
  assert.equal(r.provenance.directionalContributionPermitted, false);
});

/* ================================================================== */
/* DIRECTIONAL BOUNDARY                                                */
/* ================================================================== */

test("REGRESSION: market behaviour never produces a directional contribution", () => {
  // An extreme market fixture with no crowd source.
  const r = analyse({ series: makeSeries({ n: 200, episodes: [...Array(6)].map((_, k) => 194 + k) }) });
  assert.equal(r.provenance.directionalContributionPermitted, false);
  assert.equal(hasDirectionalCrowdEvidence(r), false);
  const text = JSON.stringify({
    regimes: r.behaviouralRegimes, observations: r.observations,
    analogues: r.historicalAnalogues.status });
  for (const banned of ["BULLISH", "BEARISH"]) {
    assert.ok(!text.includes(banned), `${banned} must not come from market behaviour`);
  }
});

test("only direct crowd evidence permits a directional contribution", () => {
  const withoutCrowd = analyse();
  const withCrowd = analyse({ crowdEvidence: crowd(30) });
  assert.equal(withoutCrowd.provenance.directionalContributionPermitted, false);
  assert.equal(withCrowd.provenance.directionalContributionPermitted, true);
  assert.equal(hasDirectionalCrowdEvidence(withCrowd), true);
});

test("UNKNOWN sentiment is an abstention, never a neutral vote", () => {
  const r = analyse();
  assert.equal(r.crowdSentiment, CrowdSentiment.UNKNOWN);
  assert.equal(hasDirectionalCrowdEvidence(r), false,
    "an abstention must not be read as a directional contribution");
  assert.notEqual(r.crowdSentiment, CrowdSentiment.NEUTRAL);
});

/* ================================================================== */
/* EVIDENCE QUALITY / INDEPENDENCE                                     */
/* ================================================================== */

test("REGRESSION: many market-derived signals remain ONE independent source", () => {
  const r = analyse();
  const marketChannels = r.evidenceQuality.channels.filter(c => c.source === EvidenceSource.MARKET_HISTORY);
  assert.equal(marketChannels.length, 2, "market behaviour and analogues are separate channels");
  assert.equal(r.evidenceQuality.independentSourceCount, 1, "but one feed");
  assert.deepEqual(r.evidenceQuality.independentSources, [EvidenceSource.MARKET_HISTORY]);
  assert.ok(r.evidenceQuality.derivedSignalCount > 1, "many signals, reported but not scored");
});

test("genuine crowd evidence adds a second independent source", () => {
  assert.equal(analyse().evidenceQuality.independentSourceCount, 1);
  assert.equal(analyse({ crowdEvidence: crowd(30) }).evidenceQuality.independentSourceCount, 2);
});

test("missing evidence is named explicitly, never silently absent", () => {
  const r = analyse();
  const names = r.missingEvidence.map(m => m.item);
  assert.ok(names.includes(EvidenceChannel.DIRECT_CROWD), "the absent crowd channel is named");
  const crowdChannel = r.evidenceQuality.channels.find(c => c.channel === EvidenceChannel.DIRECT_CROWD);
  assert.equal(crowdChannel.status, ChannelStatus.UNAVAILABLE);
  assert.match(crowdChannel.notes[0], /unknown, not neutral/);
});

test("insufficient analogues are reported as limited history, not hidden", () => {
  const r = analyse({ series: makeSeries({ n: 200, episodes: [60, 61, 198, 199] }) });
  if (r.historicalAnalogues.status === SampleStatus.INSUFFICIENT_ANALOGUES) {
    assert.ok(r.missingEvidence.some(m => m.item === "HISTORICAL_ANALOGUES"));
    assert.ok(r.limitations.some(l => /Limited history/.test(l)));
  }
  assert.ok(r.historicalAnalogues.matchingSessions >= r.historicalAnalogues.episodeCount);
});

/* ================================================================== */
/* EPISTEMIC AND ROLE BOUNDARIES                                       */
/* ================================================================== */

test("all findings remain OBSERVATION or BEHAVIOURAL_INTERPRETATION about the MARKET", () => {
  const r = analyse();
  assert.ok(r.findings.length > 0);
  for (const f of r.findings) {
    assert.ok([EpistemicLayer.OBSERVATION, EpistemicLayer.BEHAVIOURAL_INTERPRETATION].includes(f.layer));
    assert.notEqual(f.layer, EpistemicLayer.INTENT);
    assert.equal(f.subject, FindingSubject.MARKET);
    assert.equal(f.provenance.source, EvidenceSource.MARKET_HISTORY);
  }
});

test("no verdict, recommendation, probability or risk judgment is emitted", () => {
  const r = analyse({ crowdEvidence: crowd(30) });
  const keys = new Set();
  (function walk(v) { if (v && typeof v === "object") for (const [k, val] of Object.entries(v)) { keys.add(k.toLowerCase()); walk(val); } })(r);
  for (const banned of ["verdict", "recommendation", "probability", "expectedreturn",
                        "targetprice", "profit", "winrate", "risk", "riskseverity"]) {
    assert.ok(!keys.has(banned), `no Conquest field may be named ${banned}`);
  }
  const asserted = r.limitations.join(" ").toLowerCase();
  for (const banned of ["too risky", "do not proceed", " buy ", " sell ", "avoid"]) {
    assert.ok(!asserted.includes(banned), `${banned} must not appear`);
  }
});

test("no War-style technical output appears", () => {
  const r = analyse();
  // Word-bounded: "rsi" is a substring of "rising_participation", which is a
  // legitimate behavioural regime.
  const text = JSON.stringify(r).toLowerCase();
  for (const banned of ["rsi", "movingaverage", "moving average", "support level",
                        "resistance", "overbought", "oversold", "breakout"]) {
    assert.ok(!new RegExp(`\\b${banned}\\b`).test(text), `${banned} belongs to War`);
  }
  // And no field is named for a technical indicator.
  const keys = new Set();
  (function walk(v) { if (v && typeof v === "object") for (const [k, val] of Object.entries(v)) { keys.add(k.toLowerCase()); walk(val); } })(r);
  for (const banned of ["rsi14", "movingaverages", "support", "resistance", "trend"]) {
    assert.ok(!keys.has(banned), `no Conquest field may be named ${banned}`);
  }
});

test("no intent, causation or prediction language is emitted", () => {
  const r = analyse();
  const statements = r.findings.map(f => f.statement).join(" ").toLowerCase();
  for (const banned of ["because", "fomo", "panic", "euphor", "greed", "investors are",
                        "traders are", "will rise", "will fall", "expected to", "likely to"]) {
    assert.ok(!statements.includes(banned), `${banned} must not appear in a Conquest statement`);
  }
});

/* ================================================================== */
/* STRUCTURE                                                           */
/* ================================================================== */

test("assetType is preserved for future crypto support without crypto logic", () => {
  const r = conquestAnalysis(buildConquestInput({ assetId: "BTC", assetType: "CRYPTO",
    series: makeSeries({ n: 200, episodes: [40, 41, 198, 199] }), now: NOW }));
  assert.equal(r.assetType, "CRYPTO");
  assert.equal(r.assetId, "BTC");
  const raw = readFileSync(new URL("../src/conquest/buildConquestInput.js", import.meta.url), "utf8");
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const banned of ["CRYPTO ===", "if (assetType", "24/7", "bitcoin"]) {
    assert.ok(!code.toLowerCase().includes(banned.toLowerCase()), "no crypto-specific behaviour");
  }
});

test("an assetId is required", () => {
  assert.throws(() => buildConquestInput({}), /requires an assetId/);
  assert.throws(() => buildConquestInput({ assetId: "   " }), /requires an assetId/);
});

test("results are deterministic and deeply frozen", () => {
  const a = analyse();
  assert.deepEqual(a, analyse());
  assert.throws(() => { a.crowdSentiment = CrowdSentiment.BULLISH; }, TypeError);
  assert.throws(() => { a.behaviouralRegimes.push("X"); }, TypeError);
  assert.throws(() => { a.limitations.push("x"); }, TypeError);
  assert.throws(() => { a.missingEvidence.push({}); }, TypeError);
});

test("the assembly consumes no other Horseman and makes no network call", () => {
  for (const file of ["buildConquestInput.js", "conquestAnalysis.js"]) {
    const raw = readFileSync(new URL(`../src/conquest/${file}`, import.meta.url), "utf8");
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const banned of ["fetch(", "http", "warFactsV2", "famine", "deathAnalysis", "councilAnalysis"]) {
      assert.ok(!code.toLowerCase().includes(banned.toLowerCase()), `${file} must not reference ${banned}`);
    }
  }
});

test("the excluded legacy attention model is not part of the assembly", () => {
  const raw = readFileSync(new URL("../src/conquest/buildConquestInput.js", import.meta.url), "utf8");
  assert.ok(!raw.includes('from "./attention.js"'),
    "the volume-contaminated attention model is excluded from the assembly");
  assert.ok(raw.includes('from "./crowdAttention.js"'));
});
