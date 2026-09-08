import { test } from "node:test";
import assert from "node:assert/strict";
import { assessCrowdAttention, CrowdAttentionLevel, CROWD_ATTENTION_THRESHOLDS } from "../src/conquest/crowdAttention.js";
import {
  assessConquestEvidenceQuality, EvidenceChannel, ChannelStatus, QualityBand,
} from "../src/conquest/conquestEvidenceQuality.js";
import {
  makeCrowdObservation, makeCrowdEvidence, makeUnavailableCrowdEvidence,
  CrowdStance, CrowdAvailability, EvidenceOrigin,
} from "../src/schema/crowd.js";
import { CrowdProvider, CrowdErrorCodes } from "../src/providers/CrowdProvider.js";
import { assessCrowdSentiment, CrowdSentiment } from "../src/conquest/sentiment.js";
import { assessCrowding, CrowdingLevel } from "../src/conquest/crowding.js";
import { classifyConquestRelevance, ConquestRelevance } from "../src/conquest/relevance.js";
import { observeMarketBehaviour } from "../src/conquest/marketObservations.js";
import { classifyBehaviouralRegimes } from "../src/conquest/behaviouralRegimes.js";
import { EvidenceSource } from "../src/schema/provenance.js";
import { readFileSync } from "node:fs";

/** Step 6 rescope. Focused on the changed contracts only. */

const NOW = new Date("2026-09-04T12:00:00Z");
const HOUR = 3600 * 1000;
const at = h => new Date(NOW.getTime() - h * HOUR).toISOString();

const obs = (i, over = {}) => makeCrowdObservation({
  id: `o${i}`, sourceName: `forum-${i % 6}`, authorId: `u${i}`, publishedAt: at(2),
  engagement: 5, stance: CrowdStance.NEUTRAL, isDuplicate: false, isSuspectedAutomated: false, ...over,
});
const crowd = (n, over = {}) => makeCrowdEvidence({
  assetId: "TEST", provider: "test-crowd",
  observations: Array.from({ length: n }, (_, i) => obs(i, over.observation || {})),
  windowStart: at(24), windowEnd: at(1),
});

/* ================================================================== */
/* MARKET ACTIVITY IS NOT CROWD ATTENTION                              */
/* ================================================================== */

test("REGRESSION: trading activity cannot become crowd attention", () => {
  // No crowd source at all, whatever the market is doing.
  const r = assessCrowdAttention(null, { now: NOW });
  assert.equal(r.crowdAttention, CrowdAttentionLevel.UNAVAILABLE);
  assert.equal(r.available, false);
  assert.ok(r.limitations.some(l => /never inferred from trading activity/.test(l)));

  // There is no parameter through which market data could reach it: unlike
  // the legacy attention model, no volume or price input exists.
  const src = readFileSync(new URL("../src/conquest/crowdAttention.js", import.meta.url), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const banned of ["volumeRatio", "percentile", "close", "ohlcv", "priceMove"]) {
    assert.ok(!code.includes(banned), `crowd attention must not read ${banned}`);
  }
});

test("no crowd evidence means UNAVAILABLE, never NONE_OBSERVED", () => {
  const failed = assessCrowdAttention(makeUnavailableCrowdEvidence({
    assetId: "T", provider: "p", errorCode: CrowdErrorCodes.PROVIDER_UNAVAILABLE }), { now: NOW });
  assert.equal(failed.crowdAttention, CrowdAttentionLevel.UNAVAILABLE);
  assert.notEqual(failed.crowdAttention, CrowdAttentionLevel.NONE_OBSERVED,
    "an outage must not read as a quiet crowd");
  assert.ok(failed.limitations.some(l => /not evidence that the asset is being ignored/.test(l)));
});

test("a source that answered with nothing IS a finding", () => {
  const quiet = assessCrowdAttention(crowd(0), { now: NOW });
  assert.equal(quiet.crowdAttention, CrowdAttentionLevel.NONE_OBSERVED);
  assert.equal(quiet.available, true);
});

test("genuine crowd activity produces a level, discounted for narrow breadth", () => {
  const broad = assessCrowdAttention(crowd(30), { now: NOW });
  assert.equal(broad.crowdAttention, CrowdAttentionLevel.HIGH);
  assert.equal(broad.breadth.sources, 6);

  // Same volume, one source: narrower breadth is worth less.
  const narrow = makeCrowdEvidence({ assetId: "T", provider: "p", windowStart: at(24), windowEnd: at(1),
    observations: Array.from({ length: 30 }, (_, i) => obs(i, { sourceName: "forum-0" })) });
  const narrowResult = assessCrowdAttention(narrow, { now: NOW });
  assert.ok(narrowResult.counts.effective < broad.counts.effective);
  assert.ok(narrowResult.limitations.some(l => /breadth is narrow/.test(l)));
});

test("REGRESSION: repetition is not attention", () => {
  const clean = assessCrowdAttention(crowd(20), { now: NOW });
  const duplicated = makeCrowdEvidence({ assetId: "T", provider: "p", windowStart: at(24), windowEnd: at(1),
    observations: [
      ...Array.from({ length: 20 }, (_, i) => obs(i)),
      ...Array.from({ length: 40 }, (_, i) => obs(100 + i, { isDuplicate: true })),
      ...Array.from({ length: 40 }, (_, i) => obs(200 + i, { isSuspectedAutomated: true })),
    ] });
  const r = assessCrowdAttention(duplicated, { now: NOW });
  assert.equal(r.counts.excludedForRepetition, 80);
  assert.equal(r.counts.usable, clean.counts.usable,
    "eighty repeats of the same thing add no attention");
  assert.equal(r.crowdAttention, clean.crowdAttention);
});

test("stale crowd activity does not count as current attention", () => {
  const old = makeCrowdEvidence({ assetId: "T", provider: "p", windowStart: at(24 * 30), windowEnd: at(24 * 20),
    observations: Array.from({ length: 30 }, (_, i) => obs(i, { publishedAt: at(24 * 25) })) });
  const r = assessCrowdAttention(old, { now: NOW });
  assert.equal(r.counts.recent, 0);
  assert.equal(r.crowdAttention, CrowdAttentionLevel.NONE_OBSERVED);
});

/* ================================================================== */
/* USER-SUPPLIED CLAIMS                                                */
/* ================================================================== */

test("REGRESSION: a user-supplied claim creates no crowd attention", () => {
  const ev = crowd(20);
  const forged = { ...ev, origin: EvidenceOrigin.USER_SUPPLIED_CLAIM };
  const r = assessCrowdAttention(forged, { now: NOW });
  assert.equal(r.crowdAttention, CrowdAttentionLevel.UNAVAILABLE);
  assert.equal(r.available, false);
});

test("a user-supplied claim creates no crowd sentiment and no crowd sample", () => {
  const ev = crowd(20, { observation: { stance: CrowdStance.BULLISH } });
  // The schema refuses to stamp a claim origin in the first place...
  const stamped = makeCrowdEvidence({ assetId: "T", provider: "p",
    observations: [obs(1)], origin: EvidenceOrigin.USER_SUPPLIED_CLAIM });
  assert.equal(stamped.origin, EvidenceOrigin.OBSERVED_CROWD);
  // ...and every consumer gates on origin independently.
  const forged = { ...ev, origin: EvidenceOrigin.USER_SUPPLIED_CLAIM };
  assert.equal(assessCrowdSentiment(forged).sentiment, CrowdSentiment.UNKNOWN);
  assert.equal(assessCrowding(forged).crowding, CrowdingLevel.UNKNOWN);
});

/* ================================================================== */
/* SENTIMENT AND CROWDING (preserved contracts)                        */
/* ================================================================== */

test("market behaviour cannot manufacture directional crowd sentiment", () => {
  // An extreme market fixture, and no crowd evidence.
  const series = { points: Array.from({ length: 60 }, (_, i) => ({
      date: `2026-0${1 + Math.floor(i / 30)}-${String((i % 30) + 1).padStart(2, "0")}`,
      timestamp: Date.parse("2026-09-04T00:00:00Z") - (59 - i) * 86400000,
      open: 100, high: i === 59 ? 150 : 101, low: 99, close: i === 59 ? 145 : 100,
      volume: i === 59 ? 90_000_000 : 1_000_000 })),
    market: { exchangeTimezone: "America/New_York" }, source: { provider: "t" } };
  const observations = observeMarketBehaviour(series, { now: new Date("2026-09-04T20:45:00Z") });
  const regimes = classifyBehaviouralRegimes(observations);

  assert.ok(observations.participation.percentile >= 90, "the market fixture is genuinely extreme");
  assert.equal(assessCrowdSentiment(null).sentiment, CrowdSentiment.UNKNOWN,
    "no amount of market activity creates crowd sentiment");
  assert.equal(assessCrowdAttention(null, { now: NOW }).crowdAttention, CrowdAttentionLevel.UNAVAILABLE);
  // And the regimes themselves carry no sentiment.
  assert.ok(!JSON.stringify(regimes).match(/BULLISH|BEARISH|sentiment/i));
});

test("crowding still requires direct evidence and describes expressed opinion only", () => {
  assert.equal(assessCrowding(null).crowding, CrowdingLevel.UNKNOWN);
  const r = assessCrowding(crowd(12, { observation: { stance: CrowdStance.BULLISH } }));
  // Its signals are about what was SAID, never about positions held.
  for (const s of r.signals) {
    assert.ok(["LOW_SOURCE_DIVERSITY", "LOW_AUTHOR_DIVERSITY", "REPEATED_NARRATIVE",
               "EXTREME_STANCE_IMBALANCE"].includes(s.signal));
  }
  const text = JSON.stringify(r).toLowerCase();
  for (const banned of ["position", "holding", "owns", "exposure"]) {
    assert.ok(!text.includes(banned), `${banned} would claim positions the evidence cannot measure`);
  }
});

/* ================================================================== */
/* RELEVANCE (preserved)                                               */
/* ================================================================== */

test("contextual and irrelevant material cannot become target-specific evidence", () => {
  const target = { assetId: "TSLA", companyName: "Tesla, Inc." };
  assert.equal(classifyConquestRelevance(
    { headline: "Stocks fall; Snowflake, Dell, Tesla in focus", relatedTickers: ["SNOW", "DELL", "TSLA"] }, target).relevance,
    ConquestRelevance.CONTEXTUAL);
  assert.equal(classifyConquestRelevance(
    { headline: "Lululemon cuts guidance", relatedTickers: ["LULU"] }, target).relevance,
    ConquestRelevance.IRRELEVANT);
});

/* ================================================================== */
/* EVIDENCE QUALITY — INDEPENDENCE, NOT QUANTITY                       */
/* ================================================================== */

const marketObservations = () => observeMarketBehaviour({
  points: Array.from({ length: 80 }, (_, i) => ({
    date: `d${i}`, timestamp: Date.parse("2026-09-04T00:00:00Z") - (79 - i) * 86400000,
    open: 100 + i * 0.1, high: 101 + i * 0.1, low: 99 + i * 0.1, close: 100 + i * 0.1,
    volume: 1_000_000 + i * 1000 })),
  market: { exchangeTimezone: "America/New_York" }, source: { provider: "t" },
}, { now: new Date("2026-09-04T20:45:00Z") });

test("REGRESSION: many signals from one feed do not become many sources", () => {
  const observations = marketObservations();
  const regimes = classifyBehaviouralRegimes(observations);
  const q = assessConquestEvidenceQuality({
    observations, regimes,
    analogues: { analogueCount: 9, status: "MEASURED" },
  });

  // Two channels, both on the market-history feed.
  const marketChannels = q.channels.filter(c => c.source === EvidenceSource.MARKET_HISTORY);
  assert.equal(marketChannels.length, 2);
  assert.equal(q.independentSourceCount, 1,
    "market behaviour and historical analogues read the same feed");
  assert.deepEqual(q.independentSources, [EvidenceSource.MARKET_HISTORY]);
  assert.ok(q.derivedSignalCount > q.independentSourceCount,
    "many signals were computed, and that is reported without being scored");
});

test("adding more derived signals from the same feed cannot raise quality", () => {
  const observations = marketObservations();
  const few = assessConquestEvidenceQuality({
    observations, regimes: { regimeIds: [] },
    analogues: { analogueCount: 9, status: "MEASURED" } });
  const many = assessConquestEvidenceQuality({
    observations, regimes: { regimeIds: ["A", "B", "C", "D", "E"] },
    analogues: { analogueCount: 9, status: "MEASURED" } });

  assert.ok(many.derivedSignalCount > few.derivedSignalCount, "more signals were computed");
  assert.equal(many.overallQualityScore, few.overallQualityScore,
    "but knowing more calculations is not knowing more");
  assert.equal(many.independentSourceCount, few.independentSourceCount);
});

test("genuine crowd evidence DOES add an independent source", () => {
  const observations = marketObservations();
  const withoutCrowd = assessConquestEvidenceQuality({ observations, regimes: { regimeIds: [] } });
  const withCrowd = assessConquestEvidenceQuality({
    observations, regimes: { regimeIds: [] },
    crowdQuality: { directEvidence: true, qualityScore: 0.8, factors: {} },
    crowdAttention: { counts: { usable: 40 } },
  });
  assert.equal(withoutCrowd.independentSourceCount, 1);
  assert.equal(withCrowd.independentSourceCount, 2);
  assert.ok(withCrowd.independentSources.includes(EvidenceSource.CROWD_FEED));
});

test("missing channels are named, never silently absent", () => {
  const q = assessConquestEvidenceQuality({});
  assert.deepEqual([...q.missingChannels].sort(),
    [EvidenceChannel.DIRECT_CROWD, EvidenceChannel.HISTORICAL_ANALOGUE, EvidenceChannel.MARKET_BEHAVIOUR].sort());
  assert.equal(q.independentSourceCount, 0);
  assert.equal(q.overallQualityBand, QualityBand.INSUFFICIENT);
  const crowdChannel = q.channels.find(c => c.channel === EvidenceChannel.DIRECT_CROWD);
  assert.match(crowdChannel.notes[0], /unknown, not neutral/);
});

test("no analogues is NONE_OBSERVED, distinct from an unavailable channel", () => {
  const observations = marketObservations();
  const none = assessConquestEvidenceQuality({ observations, analogues: { analogueCount: 0, status: "INSUFFICIENT_ANALOGUES" } });
  const missing = assessConquestEvidenceQuality({ observations });
  assert.equal(none.channels.find(c => c.channel === EvidenceChannel.HISTORICAL_ANALOGUE).status,
    ChannelStatus.NONE_OBSERVED);
  assert.equal(missing.channels.find(c => c.channel === EvidenceChannel.HISTORICAL_ANALOGUE).status,
    ChannelStatus.UNAVAILABLE);
});

test("a thin analogue sample is INSUFFICIENT, not scored as evidence", () => {
  const q = assessConquestEvidenceQuality({
    observations: marketObservations(), analogues: { analogueCount: 3, status: "INSUFFICIENT_ANALOGUES" } });
  const ch = q.channels.find(c => c.channel === EvidenceChannel.HISTORICAL_ANALOGUE);
  assert.equal(ch.status, ChannelStatus.INSUFFICIENT);
  assert.equal(ch.qualityScore, null);
  assert.match(ch.notes[0], /too few/);
});

/* ================================================================== */
/* PROVIDER SOCKET AND INERTNESS                                       */
/* ================================================================== */

test("the provider-neutral crowd contract is intact and depends on no company", async () => {
  const p = new CrowdProvider();
  await assert.rejects(() => p.getCrowdEvidence("TEST"), /must be implemented/);
  const src = await import("node:fs").then(fs =>
    fs.readFileSync(new URL("../src/providers/CrowdProvider.js", import.meta.url), "utf8"));
  for (const banned of ["reddit", "twitter", "discord", "http", "fetch("]) {
    assert.ok(!src.toLowerCase().includes(banned), `${banned} must not appear in the socket`);
  }
});

test("the rescoped modules make no network call and consume no other Horseman", async () => {
  for (const file of ["crowdAttention.js", "conquestEvidenceQuality.js"]) {
    const raw = await import("node:fs").then(fs =>
      fs.readFileSync(new URL(`../src/conquest/${file}`, import.meta.url), "utf8"));
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const banned of ["fetch(", "http", "warFactsV2", "famine", "deathAnalysis", "council"]) {
      assert.ok(!code.toLowerCase().includes(banned.toLowerCase()), `${file} must not reference ${banned}`);
    }
  }
});

test("results are frozen and deterministic", () => {
  const a = assessCrowdAttention(crowd(20), { now: NOW });
  assert.deepEqual(a, assessCrowdAttention(crowd(20), { now: NOW }));
  assert.throws(() => { a.crowdAttention = "X"; }, TypeError);
  const q = assessConquestEvidenceQuality({ observations: marketObservations() });
  assert.throws(() => { q.channels.push({}); }, TypeError);
});

test("thresholds are centralized and explicitly uncalibrated", () => {
  assert.equal(CROWD_ATTENTION_THRESHOLDS.calibrated, false);
  assert.equal(assessCrowdAttention(crowd(20), { now: NOW }).thresholds, CROWD_ATTENTION_THRESHOLDS);
});
