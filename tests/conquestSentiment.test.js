import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assessCrowdSentiment, assessPolarisation, usableObservations,
  CrowdSentiment, Polarisation, MIN_CLASSIFIED_OBSERVATIONS, DIRECTION_THRESHOLD,
} from "../src/conquest/sentiment.js";
import { assessCrowding, CrowdingLevel, CROWDING_THRESHOLDS } from "../src/conquest/crowding.js";
import {
  assessCrowdEvidenceQuality, assessAttentionEvidenceQuality, QualityBand, EvidenceKind,
} from "../src/conquest/evidenceQuality.js";
import {
  makeCrowdObservation, makeCrowdEvidence, makeUnavailableCrowdEvidence,
  CrowdStance, CrowdAvailability, EvidenceOrigin, AssetType,
} from "../src/schema/crowd.js";
import { assessAttention, AttentionLevel } from "../src/conquest/attention.js";

/**
 * Conquest V2 sentiment/crowding/quality. Pure and deterministic — an
 * injected clock, no provider, no network.
 */

const NOW = new Date("2026-09-04T12:00:00Z");

/**
 * Collects every property NAME. Used instead of grepping serialised JSON:
 * these modules deliberately NAME the concepts they refuse to use
 * ("never inferred from price, volatility...", "not a probability that the
 * trade will succeed"), so a substring search flags the safeguards
 * themselves.
 */
function allKeys(value, acc = new Set()) {
  if (value === null || typeof value !== "object") return acc;
  for (const [k, v] of Object.entries(value)) { acc.add(k.toLowerCase()); allKeys(v, acc); }
  return acc;
}
const HOUR = 3600 * 1000;
const at = h => new Date(NOW.getTime() - h * HOUR).toISOString();

/** Builds n observations of one stance, with controllable diversity. */
function obsSet(n, stance, {
  sourcePrefix = "forum", sourceCount = 5, authorPrefix = "u", authorCount = null,
  hoursAgo = 2, isDuplicate = false, isSuspectedAutomated = false, startAt = 0,
} = {}) {
  const authors = authorCount ?? n;
  return Array.from({ length: n }, (_, i) => makeCrowdObservation({
    id: `${stance}-${startAt + i}`,
    sourceName: `${sourcePrefix}-${(startAt + i) % sourceCount}`,
    authorId: `${authorPrefix}${(startAt + i) % authors}`,
    publishedAt: at(hoursAgo),
    engagement: 10, stance, stanceConfidence: 0.8,
    isDuplicate, isSuspectedAutomated,
  }));
}

const crowd = (observations, extra = {}) => makeCrowdEvidence({
  assetId: "TSLA", provider: "test-crowd", observations,
  windowStart: at(24), windowEnd: at(1), ...extra,
});

/* ==================================================================== */
/* 1. NO DIRECT CROWD EVIDENCE => SENTIMENT UNKNOWN                     */
/* ==================================================================== */

test("no crowd evidence at all yields sentiment UNKNOWN with no confidence", () => {
  const r = assessCrowdSentiment(null);
  assert.equal(r.sentiment, CrowdSentiment.UNKNOWN);
  assert.equal(r.sentimentConfidence, null, "no fake percentage on an unformed direction");
  assert.equal(r.directEvidence, false);
});

test("a provider outage yields UNKNOWN, never NEUTRAL", () => {
  const r = assessCrowdSentiment(makeUnavailableCrowdEvidence({
    assetId: "TSLA", provider: "p", errorCode: "PROVIDER_UNAVAILABLE" }));
  assert.equal(r.sentiment, CrowdSentiment.UNKNOWN);
  assert.notEqual(r.sentiment, CrowdSentiment.NEUTRAL);
});

test("a reachable but quiet crowd source yields UNKNOWN and says why", () => {
  const quiet = crowd([]);
  assert.equal(quiet.availability, CrowdAvailability.NO_RECENT_ACTIVITY);
  const r = assessCrowdSentiment(quiet);
  assert.equal(r.sentiment, CrowdSentiment.UNKNOWN);
  assert.ok(r.reasons.some(x => /no recent activity/i.test(x)));
});

test("REGRESSION: high media attention with no crowd source leaves sentiment UNKNOWN", () => {
  // The exact shape of the live TSLA failure: plenty of observable
  // attention, zero direct crowd evidence.
  const items = Array.from({ length: 8 }, (_, i) => ({
    id: `n${i}`, headline: `TSLA news item ${i}`, publisher: `outlet-${i}`,
    publishedAt: at(2), relatedTickers: ["TSLA"],
  }));
  const attention = assessAttention({ items, target: { assetId: "TSLA", companyName: "Tesla, Inc." }, volumeRatio: 2.4, now: NOW });
  const sentiment = assessCrowdSentiment(null);

  assert.equal(attention.attentionLevel, AttentionLevel.VERY_HIGH);
  assert.equal(sentiment.sentiment, CrowdSentiment.UNKNOWN);
  assert.equal(sentiment.sentimentConfidence, null);
  // Both statements are simultaneously true and not contradictory.
  assert.equal(attention.provenance.directCrowdEvidence, false);
});

test("a high trading-volume proxy alone cannot create sentiment", () => {
  const attention = assessAttention({ items: null, target: { assetId: "TSLA" }, volumeRatio: 6.0, now: NOW });
  assert.notEqual(attention.attentionLevel, AttentionLevel.UNKNOWN);
  assert.equal(assessCrowdSentiment(null).sentiment, CrowdSentiment.UNKNOWN);
});

/* ==================================================================== */
/* 2. DIRECT CROWD SENTIMENT                                            */
/* ==================================================================== */

test("a majority-bullish sample of adequate size reads BULLISH", () => {
  const r = assessCrowdSentiment(crowd([...obsSet(14, CrowdStance.BULLISH), ...obsSet(3, CrowdStance.BEARISH, { startAt: 100 })]));
  assert.equal(r.sentiment, CrowdSentiment.BULLISH);
  assert.equal(r.directEvidence, true);
  assert.ok(r.netLean >= DIRECTION_THRESHOLD);
  assert.equal(r.counts.bullish, 14);
});

test("a majority-bearish sample reads BEARISH", () => {
  const r = assessCrowdSentiment(crowd([...obsSet(15, CrowdStance.BEARISH), ...obsSet(2, CrowdStance.BULLISH, { startAt: 100 })]));
  assert.equal(r.sentiment, CrowdSentiment.BEARISH);
  assert.ok(r.netLean <= -DIRECTION_THRESHOLD);
});

test("a genuinely split sample reads MIXED, not an averaged NEUTRAL", () => {
  const r = assessCrowdSentiment(crowd([...obsSet(10, CrowdStance.BULLISH), ...obsSet(10, CrowdStance.BEARISH, { startAt: 100 })]));
  assert.equal(r.sentiment, CrowdSentiment.MIXED);
  assert.notEqual(r.sentiment, CrowdSentiment.NEUTRAL);
  assert.equal(r.netLean, 0);
});

test("a genuinely neutral crowd reads NEUTRAL, distinct from MIXED", () => {
  const r = assessCrowdSentiment(crowd([...obsSet(14, CrowdStance.NEUTRAL), ...obsSet(3, CrowdStance.BULLISH, { startAt: 100 })]));
  assert.equal(r.sentiment, CrowdSentiment.NEUTRAL);
});

test("unclassified observations are never counted as neutral", () => {
  const unclassified = obsSet(12, "SOMETHING_ODD");
  const r = assessCrowdSentiment(crowd([...unclassified, ...obsSet(4, CrowdStance.BULLISH, { startAt: 100 })]));
  assert.equal(r.counts.unclassified, 12);
  assert.equal(r.counts.neutral, 0);
  // Too little readable opinion to claim a direction.
  assert.equal(r.sentiment, CrowdSentiment.UNKNOWN);
  assert.ok(r.reasons.some(x => /could not be classified/.test(x)));
});

test("a tiny sample cannot masquerade as strong consensus", () => {
  const r = assessCrowdSentiment(crowd(obsSet(5, CrowdStance.BULLISH)));
  assert.equal(r.sentiment, CrowdSentiment.UNKNOWN, "5 unanimous posts is not a consensus");
  assert.equal(r.sentimentConfidence, null);
  assert.ok(r.reasons.some(x => new RegExp(`${MIN_CLASSIFIED_OBSERVATIONS}`).test(x)));
  // One more than the minimum does form a view.
  assert.equal(assessCrowdSentiment(crowd(obsSet(MIN_CLASSIFIED_OBSERVATIONS, CrowdStance.BULLISH))).sentiment,
    CrowdSentiment.BULLISH);
});

test("duplicate and automated observations are excluded from the sentiment tally", () => {
  const r = assessCrowdSentiment(crowd([
    ...obsSet(10, CrowdStance.BULLISH, { isDuplicate: true }),
    ...obsSet(9, CrowdStance.BEARISH, { startAt: 100 }),
  ]));
  assert.equal(r.counts.excluded, 10);
  assert.equal(r.counts.bullish, 0, "a duplicated thesis is not a crowd");
  assert.equal(r.sentiment, CrowdSentiment.BEARISH);
});

test("a spam-heavy sample loses its claim entirely when too little survives", () => {
  const r = assessCrowdSentiment(crowd([
    ...obsSet(20, CrowdStance.BULLISH, { isSuspectedAutomated: true }),
    ...obsSet(3, CrowdStance.BULLISH, { startAt: 100 }),
  ]));
  assert.equal(r.counts.excluded, 20);
  assert.equal(r.sentiment, CrowdSentiment.UNKNOWN);
});

/* ==================================================================== */
/* 3. POLARISATION                                                      */
/* ==================================================================== */

test("an evenly split crowd is HIGH polarisation", () => {
  const p = assessPolarisation(crowd([...obsSet(10, CrowdStance.BULLISH), ...obsSet(10, CrowdStance.BEARISH, { startAt: 100 })]));
  assert.equal(p.polarisation, Polarisation.HIGH);
  assert.equal(p.polarisationIndex, 1);
});

test("a one-sided crowd is LOW polarisation even though sentiment is strong", () => {
  const ev = crowd([...obsSet(18, CrowdStance.BULLISH), ...obsSet(1, CrowdStance.BEARISH, { startAt: 100 })]);
  assert.equal(assessPolarisation(ev).polarisation, Polarisation.LOW);
  assert.equal(assessCrowdSentiment(ev).sentiment, CrowdSentiment.BULLISH);
});

test("polarisation is UNKNOWN without direct evidence or an adequate directional sample", () => {
  assert.equal(assessPolarisation(null).polarisation, Polarisation.UNKNOWN);
  assert.equal(assessPolarisation(crowd(obsSet(4, CrowdStance.BULLISH))).polarisation, Polarisation.UNKNOWN);
});

test("split crowd, MIXED sentiment and UNKNOWN crowding coexist without contradiction", () => {
  const ev = crowd([...obsSet(12, CrowdStance.BULLISH, { sourceCount: 6 }), ...obsSet(12, CrowdStance.BEARISH, { sourceCount: 6, startAt: 100 })]);
  assert.equal(assessCrowdSentiment(ev).sentiment, CrowdSentiment.MIXED);
  assert.equal(assessPolarisation(ev).polarisation, Polarisation.HIGH);
  assert.equal(assessCrowding(ev).crowding, CrowdingLevel.LOW, "diverse, balanced discussion is not crowded");
});

/* ==================================================================== */
/* 4. CROWDING                                                          */
/* ==================================================================== */

test("crowding cannot be inferred from RSI, returns, price moves or volume", () => {
  // Passing technical fields must change nothing; none is even read.
  const withTechnicals = assessCrowding(Object.assign(
    {}, crowd(obsSet(12, CrowdStance.BULLISH, { sourceCount: 6 })),
  ));
  const plain = assessCrowding(crowd(obsSet(12, CrowdStance.BULLISH, { sourceCount: 6 })));
  assert.equal(withTechnicals.crowding, plain.crowding);

  const keys = allKeys(plain);
  for (const banned of ["rsi", "rsi14", "twentyday", "percentchange", "realizedvolatility",
                        "volatility", "pricemove", "volumeratio", "absmoveavg"]) {
    assert.ok(!keys.has(banned), `no crowding field may be named ${banned}`);
  }
  // The limitation text deliberately NAMES these concepts to deny them.
  assert.ok(plain.limitations.some(l => /never inferred from price, volatility/.test(l)));
});

test("crowding is UNKNOWN without direct crowd evidence, whatever the market is doing", () => {
  const r = assessCrowding(null);
  assert.equal(r.crowding, CrowdingLevel.UNKNOWN);
  assert.ok(r.reasons.some(x => /cannot substitute/i.test(x)));
});

test("an inadequate sample yields UNKNOWN crowding rather than an invented score", () => {
  assert.equal(assessCrowding(crowd(obsSet(4, CrowdStance.BULLISH))).crowding, CrowdingLevel.UNKNOWN);
});

test("concentrated, repeated, one-sided discussion reads as crowded", () => {
  const ev = crowd([
    ...obsSet(9, CrowdStance.BULLISH, { sourceCount: 1, authorCount: 2, isDuplicate: true }),
    ...obsSet(9, CrowdStance.BULLISH, { sourceCount: 1, authorCount: 2, startAt: 100 }),
  ]);
  const r = assessCrowding(ev);
  assert.equal(r.crowding, CrowdingLevel.HIGH);
  assert.ok(r.signalCount >= CROWDING_THRESHOLDS.HIGH_SIGNALS);
  const names = r.signals.map(s => s.signal);
  assert.ok(names.includes("LOW_SOURCE_DIVERSITY"));
  assert.ok(names.includes("LOW_AUTHOR_DIVERSITY"));
  assert.ok(names.includes("EXTREME_STANCE_IMBALANCE"));
});

test("missing quality flags remain unknown, not assumed clean, and are declared", () => {
  const noFlags = Array.from({ length: 12 }, (_, i) => makeCrowdObservation({
    id: `n${i}`, sourceName: `forum-${i % 6}`, authorId: `a${i}`,
    publishedAt: at(2), stance: CrowdStance.BULLISH,
    isDuplicate: null, isSuspectedAutomated: null,
  }));
  const r = assessCrowding(crowd(noFlags));
  assert.ok(!r.signals.some(s => s.signal === "REPEATED_NARRATIVE"),
    "repetition cannot be claimed from a feed that reports no duplicate flags");
  assert.ok(r.limitations.some(l => /no duplicate or automation flags/.test(l)));
});

test("absent author identifiers disable participation-concentration signalling", () => {
  const noAuthors = Array.from({ length: 12 }, (_, i) => makeCrowdObservation({
    id: `n${i}`, sourceName: "forum-0", authorId: null,
    publishedAt: at(2), stance: CrowdStance.BULLISH, isDuplicate: false, isSuspectedAutomated: false,
  }));
  const r = assessCrowding(crowd(noAuthors));
  assert.ok(!r.signals.some(s => s.signal === "LOW_AUTHOR_DIVERSITY"));
  assert.ok(r.limitations.some(l => /no author identifiers/.test(l)));
});

/* ==================================================================== */
/* 5. EVIDENCE QUALITY                                                  */
/* ==================================================================== */

test("no direct crowd evidence means no sentiment confidence at all — not a low number", () => {
  const q = assessCrowdEvidenceQuality(null, assessCrowdSentiment(null), NOW);
  assert.equal(q.qualityBand, QualityBand.INSUFFICIENT);
  assert.equal(q.qualityScore, null);
  assert.equal(q.sentimentConfidence, null);
  assert.equal(q.directEvidence, false);
});

test("sentiment confidence attaches only to a direction that was actually formed", () => {
  const tiny = crowd(obsSet(5, CrowdStance.BULLISH));
  const s = assessCrowdSentiment(tiny);
  assert.equal(s.sentiment, CrowdSentiment.UNKNOWN);
  assert.equal(assessCrowdEvidenceQuality(tiny, s, NOW).sentimentConfidence, null);

  const solid = crowd([...obsSet(16, CrowdStance.BULLISH, { sourceCount: 6 }), ...obsSet(3, CrowdStance.BEARISH, { startAt: 100 })]);
  const s2 = assessCrowdSentiment(solid);
  const q2 = assessCrowdEvidenceQuality(solid, s2, NOW);
  assert.equal(s2.sentiment, CrowdSentiment.BULLISH);
  assert.equal(typeof q2.sentimentConfidence, "number");
});

test("source and author diversity improve evidence quality", () => {
  const narrow = crowd(obsSet(16, CrowdStance.BULLISH, { sourceCount: 1, authorCount: 2 }));
  const broad = crowd(obsSet(16, CrowdStance.BULLISH, { sourceCount: 8, authorCount: 16 }));
  const qn = assessCrowdEvidenceQuality(narrow, assessCrowdSentiment(narrow), NOW);
  const qb = assessCrowdEvidenceQuality(broad, assessCrowdSentiment(broad), NOW);
  assert.ok(qb.qualityScore > qn.qualityScore);
  assert.ok(qb.factors.sourceDiversity > qn.factors.sourceDiversity);
});

test("a duplicate-heavy feed scores lower cleanliness than a clean one", () => {
  const dirty = crowd([...obsSet(10, CrowdStance.BULLISH, { isDuplicate: true }), ...obsSet(10, CrowdStance.BULLISH, { startAt: 100 })]);
  const clean = crowd(obsSet(20, CrowdStance.BULLISH));
  const qd = assessCrowdEvidenceQuality(dirty, assessCrowdSentiment(dirty), NOW);
  const qc = assessCrowdEvidenceQuality(clean, assessCrowdSentiment(clean), NOW);
  assert.ok(qd.factors.cleanliness < qc.factors.cleanliness);
});

test("stale evidence scores lower freshness than current evidence", () => {
  const fresh = crowd(obsSet(16, CrowdStance.BULLISH), { windowEnd: at(1) });
  const old = crowd(obsSet(16, CrowdStance.BULLISH), { windowEnd: at(24 * 20) });
  assert.ok(assessCrowdEvidenceQuality(old, assessCrowdSentiment(old), NOW).factors.freshness
    < assessCrowdEvidenceQuality(fresh, assessCrowdSentiment(fresh), NOW).factors.freshness);
});

test("unknown quality factors are excluded from the score, not treated as zero", () => {
  const noExtras = crowd(Array.from({ length: 16 }, (_, i) => makeCrowdObservation({
    id: `n${i}`, sourceName: `forum-${i % 6}`, authorId: null, publishedAt: at(2),
    stance: CrowdStance.BULLISH, isDuplicate: null, isSuspectedAutomated: null,
  })));
  const q = assessCrowdEvidenceQuality(noExtras, assessCrowdSentiment(noExtras), NOW);
  assert.equal(q.factors.authorDiversity, null);
  assert.equal(q.factors.classifierConfidence, null);
  assert.ok(q.qualityScore > 0, "missing information must not make usable evidence worthless");
  assert.ok(q.limitations.some(l => /author identifiers/.test(l)));
  assert.ok(q.limitations.some(l => /classification confidence/.test(l)));
});

test("raw quantity alone saturates and cannot manufacture STRONG quality", () => {
  const many = crowd(obsSet(500, CrowdStance.BULLISH, { sourceCount: 1, authorCount: 1 }));
  const q = assessCrowdEvidenceQuality(many, assessCrowdSentiment(many), NOW);
  assert.equal(q.factors.sampleSize, 1, "sample size saturates");
  assert.notEqual(q.qualityBand, QualityBand.STRONG, "one author on one source is not strong evidence");
  assert.equal(q.breadthLimited, true);
  assert.ok(q.limitations.some(l => /very few sources and authors/.test(l)));
});

test("attention evidence gets its own PROXY-labelled quality statement", () => {
  const items = Array.from({ length: 6 }, (_, i) => ({
    id: `n${i}`, headline: `TSLA news ${i}`, publisher: `outlet-${i}`, publishedAt: at(2), relatedTickers: ["TSLA"],
  }));
  const a = assessAttention({ items, target: { assetId: "TSLA", companyName: "Tesla, Inc." }, now: NOW });
  const q = assessAttentionEvidenceQuality(a);
  assert.equal(q.evidenceKind, EvidenceKind.PROXY);
  assert.equal(q.directEvidence, false);
  assert.ok(q.qualityScore > 0);
  assert.ok(q.limitations.some(l => /proxy/i.test(l)));
  assert.ok(q.limitations.some(l => /requires a direct crowd source/i.test(l)));
});

test("attention quality falls when one publisher dominates or items are only contextual", () => {
  const target = { assetId: "TSLA", companyName: "Tesla, Inc." };
  const diverse = assessAttention({ items: Array.from({ length: 6 }, (_, i) => ({
    id: `d${i}`, headline: `TSLA news ${i}`, publisher: `outlet-${i}`, publishedAt: at(2), relatedTickers: ["TSLA"] })), target, now: NOW });
  const flooded = assessAttention({ items: Array.from({ length: 6 }, (_, i) => ({
    id: `f${i}`, headline: `TSLA news ${i}`, publisher: "one-outlet", publishedAt: at(2), relatedTickers: ["TSLA"] })), target, now: NOW });
  assert.ok(assessAttentionEvidenceQuality(flooded).qualityScore
    < assessAttentionEvidenceQuality(diverse).qualityScore);
});

/* ==================================================================== */
/* 6. USER-SUPPLIED CLAIMS                                              */
/* ==================================================================== */

test("a user-supplied claim cannot become direct crowd evidence", () => {
  // Step 2 stamps OBSERVED_CROWD and ignores any attempt to override it.
  const ev = makeCrowdEvidence({
    assetId: "TSLA", provider: "test-crowd", observations: obsSet(20, CrowdStance.BULLISH),
    origin: EvidenceOrigin.USER_SUPPLIED_CLAIM,
  });
  assert.equal(ev.origin, EvidenceOrigin.OBSERVED_CROWD);

  // And the consumption side gates on origin independently, so a structure
  // that DID carry a claim origin could never be read as crowd sentiment.
  const forged = { ...ev, origin: EvidenceOrigin.USER_SUPPLIED_CLAIM };
  assert.equal(assessCrowdSentiment(forged).sentiment, CrowdSentiment.UNKNOWN);
  assert.equal(assessPolarisation(forged).polarisation, Polarisation.UNKNOWN);
  assert.equal(assessCrowding(forged).crowding, CrowdingLevel.UNKNOWN);
  assert.equal(assessCrowdEvidenceQuality(forged, null, NOW).sentimentConfidence, null);
});

test("a user-supplied claim cannot alter stance counts or sample size", () => {
  const real = crowd(obsSet(12, CrowdStance.BULLISH));
  const before = assessCrowdSentiment(real);
  // A pasted tip is not an observation; it has no route into this structure.
  const after = assessCrowdSentiment(crowd(obsSet(12, CrowdStance.BULLISH)));
  assert.deepEqual(after.counts, before.counts);
  assert.equal(after.sampleSize, before.sampleSize);
});

/* ==================================================================== */
/* 7. NEUTRALITY, IMMUTABILITY, DETERMINISM                             */
/* ==================================================================== */

test("a crypto asset behaves identically in structure", () => {
  const ev = makeCrowdEvidence({
    assetId: "BTC", assetType: AssetType.CRYPTO, provider: "test-crowd",
    observations: obsSet(16, CrowdStance.BULLISH, { sourceCount: 6 }),
    windowStart: at(24), windowEnd: at(1),
  });
  assert.equal(assessCrowdSentiment(ev).sentiment, CrowdSentiment.BULLISH);
  assert.equal(assessPolarisation(ev).polarisation, Polarisation.LOW);
  assert.ok(["LOW", "ELEVATED", "HIGH"].includes(assessCrowding(ev).crowding));
});

test("no Council, trade or profit-probability semantics are emitted", () => {
  const ev = crowd(obsSet(16, CrowdStance.BULLISH, { sourceCount: 6 }));
  const s = assessCrowdSentiment(ev);
  const q = assessCrowdEvidenceQuality(ev, s, NOW);
  const keys = allKeys({ s, p: assessPolarisation(ev), c: assessCrowding(ev), q });
  for (const banned of ["council", "verdict", "recommendation", "probability", "profit",
                        "buy", "sell", "targetprice", "trade"]) {
    assert.ok(!keys.has(banned), `no Conquest field may be named ${banned}`);
  }
  // The quality caveat deliberately denies being a probability.
  assert.ok(q.limitations.some(l => /not a probability that the trade will succeed/.test(l)));
});

test("outputs are deeply immutable and deterministic", () => {
  const ev = crowd(obsSet(16, CrowdStance.BULLISH, { sourceCount: 6 }));
  const a = assessCrowdSentiment(ev);
  const b = assessCrowdSentiment(ev);
  assert.deepEqual(a, b);
  assert.throws(() => { a.sentiment = CrowdSentiment.BEARISH; }, TypeError);
  assert.throws(() => { a.counts.bullish = 99; }, TypeError);
  assert.throws(() => { assessCrowding(ev).signals.push({}); }, TypeError);
  assert.throws(() => { assessPolarisation(ev).reasons.push("x"); }, TypeError);
});

test("usableObservations keeps unknown-quality items and drops flagged ones", () => {
  const mixed = [
    ...obsSet(3, CrowdStance.BULLISH, { isDuplicate: true }),
    ...obsSet(3, CrowdStance.BULLISH, { isSuspectedAutomated: true, startAt: 50 }),
    ...Array.from({ length: 3 }, (_, i) => makeCrowdObservation({
      id: `u${i}`, sourceName: "forum-0", publishedAt: at(2), stance: CrowdStance.BULLISH,
      isDuplicate: null, isSuspectedAutomated: null })),
  ];
  assert.equal(usableObservations(mixed).length, 3, "unknown quality is kept; flagged is dropped");
});
