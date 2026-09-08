import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assessAttention, AttentionLevel, RELEVANCE_WEIGHTS, RECENCY_WEIGHTS,
  ATTENTION_THRESHOLDS, DUPLICATE_WEIGHT, VOLUME_PROXY, sourceRepetitionFactor,
} from "../src/conquest/attention.js";
import { ConquestRelevance } from "../src/conquest/relevance.js";
import { isPresent, factValue } from "../src/schema/fundamentals.js";

/**
 * Attention model. Pure and deterministic — an injected clock, no network,
 * no provider. Every assertion is about OBSERVABLE ACTIVITY, never belief.
 */

const NOW = new Date("2026-09-04T12:00:00Z");
const HOUR = 3600 * 1000;
const at = h => new Date(NOW.getTime() - h * HOUR).toISOString();

const TSLA = { assetId: "TSLA", companyName: "Tesla, Inc." };

/**
 * Collects every property NAME in a structure. Used instead of grepping
 * serialised JSON, because a substring search produces false positives
 * against legitimate content: "sourceDiversity" contains "rsi", and the
 * volume caveat deliberately contains the words "conviction", "direction"
 * and "crowding" in order to deny them.
 */
function allKeys(value, acc = new Set()) {
  if (value === null || typeof value !== "object") return acc;
  for (const [k, v] of Object.entries(value)) { acc.add(k.toLowerCase()); allKeys(v, acc); }
  return acc;
}
/** Collects every string VALUE, so a stray "BULLISH" cannot hide in data. */
function allStringValues(value, acc = []) {
  if (typeof value === "string") { acc.push(value); return acc; }
  if (value === null || typeof value !== "object") return acc;
  for (const v of Object.values(value)) allStringValues(v, acc);
  return acc;
}

/** A target-specific item: names the ticker, so relevance is unambiguous. */
const targetItem = (i, { hoursAgo = 2, source = `outlet-${i}`, isDuplicate = null } = {}) => ({
  id: `t${i}`, headline: `TSLA update number ${i}`, publisher: source,
  publishedAt: at(hoursAgo), relatedTickers: ["TSLA"], isDuplicate,
});

/** A contextual item: a basket story that genuinely includes the target. */
const contextualItem = (i, { hoursAgo = 2, source = `outlet-c${i}` } = {}) => ({
  id: `c${i}`, headline: `Magnificent Seven stocks in focus, week ${i}`,
  publisher: source, publishedAt: at(hoursAgo),
  relatedTickers: ["AAPL", "MSFT", "TSLA", "NVDA", "META"],
});

/** An irrelevant item: another company entirely. */
const irrelevantItem = i => ({
  id: `x${i}`, headline: `Lululemon Q2 revenue miss, guidance cut ${i}`,
  publisher: `outlet-x${i}`, publishedAt: at(2), relatedTickers: ["LULU"],
});

const assess = (items, opts = {}) =>
  assessAttention({ items, target: TSLA, now: NOW, ...opts });

/* ---------------- core behaviour ---------------- */

test("multiple recent target-specific items from diverse sources produce elevated attention", () => {
  const r = assess([1, 2, 3, 4, 5, 6].map(i => targetItem(i)));
  assert.equal(r.counts.targetSpecific, 6);
  assert.equal(r.sourceDiversity, 6);
  assert.equal(r.weightedAttentionCount, 6);
  assert.equal(r.attentionLevel, AttentionLevel.VERY_HIGH);
  assert.equal(r.provenance.cappedByContextualOnly, false);
});

test("recency is preferred: the same items dated three weeks ago score far lower", () => {
  const fresh = assess([1, 2, 3, 4].map(i => targetItem(i, { hoursAgo: 2 })));
  const stale = assess([1, 2, 3, 4].map(i => targetItem(i, { hoursAgo: 24 * 21 })));
  assert.ok(stale.weightedAttentionCount < fresh.weightedAttentionCount);
  assert.equal(fresh.weightedAttentionCount, 4);
  assert.equal(stale.weightedAttentionCount, 4 * RECENCY_WEIGHTS.OLDER);
  assert.equal(stale.attentionLevel, AttentionLevel.LOW);
});

/* ---------------- the contextual-only cap ---------------- */

test("REGRESSION: ten Magnificent Seven mentions cannot reach HIGH or VERY_HIGH without target-specific evidence", () => {
  const r = assess(Array.from({ length: 10 }, (_, i) => contextualItem(i)));

  assert.equal(r.counts.targetSpecific, 0);
  assert.equal(r.counts.contextual, 10);
  assert.equal(r.attentionLevel, AttentionLevel.MEDIUM);
  assert.notEqual(r.attentionLevel, AttentionLevel.HIGH);
  assert.notEqual(r.attentionLevel, AttentionLevel.VERY_HIGH);
});

test("the contextual-only cap actively demotes volume that would otherwise reach HIGH", () => {
  // 30 contextual items across distinct sources weigh 7.5 — VERY_HIGH by
  // raw count. Without a single target-specific item it must still be MEDIUM.
  const r = assess(Array.from({ length: 30 }, (_, i) => contextualItem(i)));
  assert.ok(r.weightedAttentionCount >= ATTENTION_THRESHOLDS.VERY_HIGH,
    `raw weight ${r.weightedAttentionCount} would otherwise be VERY_HIGH`);
  assert.equal(r.attentionLevel, AttentionLevel.MEDIUM);
  assert.equal(r.provenance.cappedByContextualOnly, true);
  assert.ok(r.limitations.some(l => /capped at MEDIUM/.test(l)));
});

test("contextual evidence contributes at exactly 25% alongside a target-specific item", () => {
  const r = assess([targetItem(1), contextualItem(1), contextualItem(2), contextualItem(3), contextualItem(4)]);
  // 1.0 (target) + 4 x 0.25 (contextual) = 2.0
  assert.equal(r.weightedAttentionCount, 2);
  assert.equal(RELEVANCE_WEIGHTS[ConquestRelevance.CONTEXTUAL], 0.25);
  assert.equal(RELEVANCE_WEIGHTS[ConquestRelevance.TARGET_SPECIFIC], 1.0);
  assert.equal(r.provenance.cappedByContextualOnly, false, "one target-specific item lifts the cap");
});

test("a single target-specific item lifts the cap that contextual-only evidence imposes", () => {
  const contextualOnly = assess(Array.from({ length: 12 }, (_, i) => contextualItem(i)));
  const withOneTarget = assess([targetItem(99), ...Array.from({ length: 12 }, (_, i) => contextualItem(i))]);
  assert.equal(contextualOnly.attentionLevel, AttentionLevel.MEDIUM);
  assert.equal(withOneTarget.attentionLevel, AttentionLevel.HIGH);
});

test("irrelevant items contribute exactly zero", () => {
  const clean = assess([targetItem(1), targetItem(2)]);
  const polluted = assess([targetItem(1), targetItem(2), ...Array.from({ length: 20 }, (_, i) => irrelevantItem(i))]);
  assert.equal(polluted.weightedAttentionCount, clean.weightedAttentionCount);
  assert.equal(polluted.counts.irrelevant, 20);
  assert.equal(RELEVANCE_WEIGHTS[ConquestRelevance.IRRELEVANT], 0);
});

/* ---------------- duplicates and flooding ---------------- */

test("exact repeats by identifier are removed before counting", () => {
  const one = targetItem(1);
  const r = assess([one, one, one]);
  assert.equal(r.counts.exactRepeatsRemoved, 2);
  assert.equal(r.weightedAttentionCount, 1);
  assert.ok(r.limitations.some(l => /exact repeat/.test(l)));
});

test("items flagged as duplicates by a provider are heavily discounted", () => {
  const r = assess([
    targetItem(1, { source: "a" }),
    targetItem(2, { source: "b", isDuplicate: true }),
  ]);
  assert.equal(r.weightedAttentionCount, 1 + DUPLICATE_WEIGHT);
  assert.equal(DUPLICATE_WEIGHT, 0.2);
});

test("one publisher flooding is materially weaker than the same volume from independent sources", () => {
  const flood = assess(Array.from({ length: 10 }, (_, i) => targetItem(i, { source: "one-outlet" })));
  const diverse = assess(Array.from({ length: 10 }, (_, i) => targetItem(i, { source: `outlet-${i}` })));

  assert.equal(diverse.weightedAttentionCount, 10);
  assert.ok(flood.weightedAttentionCount < 3, `flood weighted ${flood.weightedAttentionCount}`);
  assert.equal(flood.attentionLevel, AttentionLevel.MEDIUM);
  assert.equal(diverse.attentionLevel, AttentionLevel.VERY_HIGH);
  assert.equal(flood.sourceDiversity, 1);
  assert.equal(diverse.sourceDiversity, 10);
});

test("source repetition follows an explicit, inspectable 1/n rule", () => {
  assert.equal(sourceRepetitionFactor(1), 1);
  assert.equal(sourceRepetitionFactor(2), 0.5);
  assert.equal(sourceRepetitionFactor(4), 0.25);
});

test("raw quantity alone cannot force maximum attention", () => {
  // 30 items, all from one outlet, all duplicates flagged.
  const r = assess(Array.from({ length: 30 }, (_, i) =>
    targetItem(i, { source: "spam-outlet", isDuplicate: true })));
  assert.notEqual(r.attentionLevel, AttentionLevel.VERY_HIGH);
  assert.ok(r.weightedAttentionCount < ATTENTION_THRESHOLDS.HIGH);
});

/* ---------------- volume proxy ---------------- */

test("unusual volume can raise attention but emits no sentiment fields", () => {
  const withoutVolume = assess([targetItem(1), targetItem(2)]);
  const withVolume = assess([targetItem(1), targetItem(2)], { volumeRatio: 2.4 });

  assert.equal(withVolume.weightedAttentionCount, withoutVolume.weightedAttentionCount + VOLUME_PROXY.STRONG_POINTS);
  assert.equal(withVolume.volumeProxy.pointsContributed, 1);
  assert.equal(factValue(withVolume.volumeProxy.ratio), 2.4);
  assert.match(withVolume.volumeProxy.interpretation, /does not indicate direction/);

  const keys = allKeys(withVolume);
  for (const banned of ["direction", "sentiment", "conviction", "verdict", "bullish", "bearish"]) {
    assert.ok(!keys.has(banned), `no field may be named ${banned}`);
  }
  // The caveat text deliberately NAMES these concepts in order to deny them.
  assert.match(withVolume.volumeProxy.interpretation, /does not indicate direction, conviction or crowding/);
});

test("elevated versus strong volume contribute different, explicit amounts", () => {
  const base = assess([targetItem(1)]).weightedAttentionCount;
  assert.equal(assess([targetItem(1)], { volumeRatio: 1.5 }).weightedAttentionCount, base + VOLUME_PROXY.ELEVATED_POINTS);
  assert.equal(assess([targetItem(1)], { volumeRatio: 3.0 }).weightedAttentionCount, base + VOLUME_PROXY.STRONG_POINTS);
  assert.equal(assess([targetItem(1)], { volumeRatio: 1.1 }).weightedAttentionCount, base, "ordinary volume adds nothing");
});

test("volume alone, with no target-specific discussion, is still capped at MEDIUM", () => {
  const r = assessAttention({ items: null, target: TSLA, volumeRatio: 5.0, now: NOW });
  assert.notEqual(r.attentionLevel, AttentionLevel.HIGH);
  assert.notEqual(r.attentionLevel, AttentionLevel.VERY_HIGH);
  assert.deepEqual(r.provenance.evidenceKinds, ["market_activity_proxy"]);
});

test("missing volume stays unknown and is never treated as zero", () => {
  const r = assess([targetItem(1)]);
  assert.equal(isPresent(r.volumeProxy.ratio), false);
  assert.equal(r.volumeProxy.ratio.value, null);
  assert.equal(r.volumeProxy.pointsContributed, 0);
  assert.ok(r.limitations.some(l => /rather than being treated as zero/.test(l)));
});

/* ---------------- missing / empty evidence ---------------- */

test("no evidence source at all is UNKNOWN, not zero attention", () => {
  const r = assessAttention({ items: null, target: TSLA, now: NOW });
  assert.equal(r.attentionLevel, AttentionLevel.UNKNOWN);
  assert.equal(r.weightedAttentionCount, null, "no count is invented");
  assert.equal(r.provenance.observed, false);
  assert.deepEqual(r.provenance.evidenceKinds, []);
});

test("looking and finding nothing is NONE_OBSERVED — distinct from not looking", () => {
  const nothingRelevant = assess(Array.from({ length: 5 }, (_, i) => irrelevantItem(i)));
  assert.equal(nothingRelevant.attentionLevel, AttentionLevel.NONE_OBSERVED);
  assert.equal(nothingRelevant.provenance.observed, true);
  assert.notEqual(nothingRelevant.attentionLevel, AttentionLevel.UNKNOWN);

  const emptyList = assess([]);
  assert.equal(emptyList.attentionLevel, AttentionLevel.UNKNOWN, "an empty list supplies no evidence either way");
});

test("undated items are counted at reduced weight, not assumed current or dropped", () => {
  const undated = assess([{ id: "u1", headline: "TSLA update", publisher: "a", publishedAt: null, relatedTickers: ["TSLA"] }]);
  assert.equal(undated.weightedAttentionCount, RECENCY_WEIGHTS.UNDATED);
  assert.ok(undated.limitations.some(l => /no usable timestamp/.test(l)));
});

/* ---------------- no technical leakage ---------------- */

test("no RSI, 20-day return, volatility or price-move input or output exists", () => {
  // Passing technical fields must have no effect whatsoever.
  const withTechnicals = assessAttention({
    items: [targetItem(1)], target: TSLA, now: NOW,
    rsi14: 82, percentChange: { oneDay: -6, twentyDay: -25 }, realizedVolatility: 3.2, absMoveAvg: 1.4,
  });
  const without = assess([targetItem(1)]);
  assert.equal(withTechnicals.weightedAttentionCount, without.weightedAttentionCount);
  assert.equal(withTechnicals.attentionLevel, without.attentionLevel);

  const keys = allKeys(withTechnicals);
  for (const banned of ["rsi", "rsi14", "twentyday", "percentchange", "realizedvolatility",
                        "absmoveavg", "onedaymove", "pricemove", "movingaverage"]) {
    assert.ok(!keys.has(banned), `no field may be named ${banned}`);
  }
});

/* ---------------- neutrality, immutability, determinism ---------------- */

test("a crypto asset behaves identically in structure", () => {
  const btc = { assetId: "BTC", companyName: "Bitcoin" };
  const r = assessAttention({
    items: [
      { id: "b1", headline: "BTC breaks higher", publisher: "forum-a", publishedAt: at(1), relatedAssets: ["BTC"] },
      { id: "b2", headline: "BTC volumes surge", publisher: "forum-b", publishedAt: at(3), relatedAssets: ["BTC"] },
    ],
    target: btc, volumeRatio: 2.2, now: NOW,
  });
  assert.equal(r.counts.targetSpecific, 2);
  // 2 target-specific items (1.0 each, distinct sources, recent) + 1.0 volume
  assert.equal(r.weightedAttentionCount, 3);
  assert.equal(r.attentionLevel, AttentionLevel.HIGH);
  assert.equal(r.volumeProxy.pointsContributed, 1);
});

test("pre-classified Step 3 entries are accepted without reclassification", () => {
  const entry = {
    item: { id: "p1", headline: "opaque text", publisher: "forum-a", publishedAt: at(1) },
    relevance: ConquestRelevance.TARGET_SPECIFIC,
  };
  const r = assessAttention({ items: [entry], target: TSLA, now: NOW });
  assert.equal(r.counts.targetSpecific, 1, "the supplied relevance is trusted");
  assert.equal(r.weightedAttentionCount, 1);
});

test("the result emits no directional, sentiment or verdict field", () => {
  const r = assess([targetItem(1), contextualItem(1)], { volumeRatio: 2.5 });
  const keys = allKeys(r);
  for (const banned of ["direction", "sentiment", "sentimentscore", "conviction", "verdict",
                        "council", "recommendation", "crowding", "bullish", "bearish", "score"]) {
    assert.ok(!keys.has(banned), `no field may be named ${banned}`);
  }
  // And no VALUE may assert a market view.
  for (const v of allStringValues(r)) {
    assert.ok(!/^(BULLISH|BEARISH)$/i.test(v.trim()), `no value may be a market direction: ${v}`);
  }
});

test("the attention level is documented as activity, not belief", () => {
  const r = assess([targetItem(1)]);
  assert.ok(r.limitations.some(l => /does not indicate what anyone believes/i.test(l)));
  assert.ok(r.limitations.some(l => /No direct public-crowd source/i.test(l)));
  assert.equal(r.provenance.directCrowdEvidence, false);
});

test("results are deeply immutable and deterministic", () => {
  const items = [targetItem(1), contextualItem(1)];
  const a = assess(items, { volumeRatio: 2.1 });
  const b = assess(items, { volumeRatio: 2.1 });
  assert.deepEqual(a, b);
  assert.throws(() => { a.attentionLevel = AttentionLevel.LOW; }, TypeError);
  assert.throws(() => { a.counts.targetSpecific = 99; }, TypeError);
  assert.throws(() => { a.entries.push({}); }, TypeError);
  assert.throws(() => { a.limitations.push("x"); }, TypeError);
});

test("thresholds are explicit and exported for inspection", () => {
  assert.equal(ATTENTION_THRESHOLDS.VERY_HIGH, 6);
  assert.equal(ATTENTION_THRESHOLDS.HIGH, 3);
  assert.equal(ATTENTION_THRESHOLDS.MEDIUM, 1.2);
});
