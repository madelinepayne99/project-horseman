import { makeFact, isPresent, factValue } from "../schema/fundamentals.js";
import { classifyConquestRelevance, ConquestRelevance } from "./relevance.js";

/**
 * CONQUEST V2 — ATTENTION MODEL
 *
 * STATUS: INERT. Nothing imports this yet.
 *
 * ---------------------------------------------------------------------
 * WHAT AN ATTENTION LEVEL MEANS — AND WHAT IT DOES NOT
 * ---------------------------------------------------------------------
 *   ATTENTION: VERY_HIGH
 *     means  "there is unusually high observable activity around this asset"
 *     NOT    "the crowd strongly believes this will rise or fall"
 *
 * This module emits NO direction, sentiment, conviction, verdict or
 * recommendation. Observing that people are talking about something says
 * nothing about what they think, and collapsing the two is exactly how the
 * live Production run reported CONQUEST: BEARISH 84 on the strength of
 * two Lululemon headlines.
 *
 * ---------------------------------------------------------------------
 * NO TECHNICAL INPUTS
 * ---------------------------------------------------------------------
 * RSI, 20-day return, realized volatility, one-day price move and average
 * absolute move are deliberately ABSENT from this module — not as inputs,
 * not as outputs. War owns technical interpretation. The only market
 * signal accepted here is unusual TRADING VOLUME, and it is carried
 * strictly as a labelled proxy for activity: it never implies why anyone
 * is trading.
 *
 * Provider-neutral and asset-type-neutral: it takes classified items and
 * an optional volume ratio, so equities, forum observations and future
 * crypto discussion all flow through unchanged.
 */

export const AttentionLevel = Object.freeze({
  /** No evidence source was supplied — we did not look. */
  UNKNOWN: "UNKNOWN",
  /** We looked and observed no activity for this asset. A finding. */
  NONE_OBSERVED: "NONE_OBSERVED",
  LOW: "LOW",
  MEDIUM: "MEDIUM",
  HIGH: "HIGH",
  VERY_HIGH: "VERY_HIGH",
});

/**
 * Relevance weights for attention counting ONLY.
 * Contextual discussion is genuine evidence that the asset is being talked
 * about within a wider basket, but it is substantially discounted so ten
 * "Magnificent Seven" mentions cannot look like ten direct stories.
 */
export const RELEVANCE_WEIGHTS = Object.freeze({
  [ConquestRelevance.TARGET_SPECIFIC]: 1.0,
  [ConquestRelevance.CONTEXTUAL]: 0.25,
  [ConquestRelevance.IRRELEVANT]: 0,
});

/**
 * Recency multipliers. Attention decays quickly: a story from three weeks
 * ago is not evidence that people are paying attention now.
 * An undateable item is NOT dropped and NOT treated as current — it is
 * counted at a reduced weight and recorded as a limitation.
 */
export const RECENCY_WEIGHTS = Object.freeze({
  WITHIN_24H: 1.0,
  WITHIN_72H: 0.6,
  WITHIN_14D: 0.25,
  OLDER: 0.1,
  UNDATED: 0.5,
});

/** A duplicate carries almost no additional evidence of attention. */
export const DUPLICATE_WEIGHT = 0.2;

/**
 * Diminishing returns per source: the nth item from the same publisher is
 * worth 1/n. One outlet publishing ten times is repetition, not breadth —
 * ten outlets publishing once each is genuinely wider attention.
 * (10 items, 1 source ≈ 2.93 weighted; 10 items, 10 sources = 10.)
 */
export function sourceRepetitionFactor(occurrenceIndex) {
  return 1 / occurrenceIndex;
}

/** Weighted-count thresholds. Explicit and inspectable by design. */
export const ATTENTION_THRESHOLDS = Object.freeze({
  VERY_HIGH: 6,
  HIGH: 3,
  MEDIUM: 1.2,
});

/** Unusual-volume proxy contributions. Secondary to observed discussion. */
export const VOLUME_PROXY = Object.freeze({
  STRONG_RATIO: 2,      // >= 2x average -> +1.0
  ELEVATED_RATIO: 1.35, // >= 1.35x     -> +0.5
  STRONG_POINTS: 1.0,
  ELEVATED_POINTS: 0.5,
});

const HOUR = 3600 * 1000;

function recencyWeightFor(publishedAt, now) {
  if (!publishedAt) return { weight: RECENCY_WEIGHTS.UNDATED, band: "UNDATED", ageHours: null };
  const t = Date.parse(publishedAt);
  if (Number.isNaN(t)) return { weight: RECENCY_WEIGHTS.UNDATED, band: "UNDATED", ageHours: null };
  const ageHours = (now.getTime() - t) / HOUR;
  if (ageHours <= 24) return { weight: RECENCY_WEIGHTS.WITHIN_24H, band: "WITHIN_24H", ageHours };
  if (ageHours <= 72) return { weight: RECENCY_WEIGHTS.WITHIN_72H, band: "WITHIN_72H", ageHours };
  if (ageHours <= 24 * 14) return { weight: RECENCY_WEIGHTS.WITHIN_14D, band: "WITHIN_14D", ageHours };
  return { weight: RECENCY_WEIGHTS.OLDER, band: "OLDER", ageHours };
}

function timestampOf(item) {
  return item.publishedAt ?? item.observedAt ?? item.date ?? null;
}
function sourceOf(item) {
  return item.sourceName ?? item.publisher ?? item.provider ?? null;
}
function idOf(item) {
  return item.id ?? item.url ?? null;
}

/**
 * Assesses observable attention for one asset.
 *
 * @param {object}   args
 * @param {Array}    args.items      raw items, or entries already carrying `.relevance`
 * @param {object}   args.target     { assetId, companyName? } — required if items are unclassified
 * @param {number}   args.volumeRatio latest volume vs its own recent average, or null
 * @param {Date}     args.now
 */
export function assessAttention({ items = null, target = {}, volumeRatio = null, now = new Date() } = {}) {
  const limitations = [
    // The most important caveat in the whole module.
    "Attention measures observable activity around an asset. It does not indicate what anyone believes about it.",
    "No direct public-crowd source is connected; attention here is derived from published items and market activity, both of which are proxies for crowd interest.",
  ];

  // Distinguish "we did not look" from "we looked and saw nothing".
  const volumeFact = makeFact(volumeRatio);
  if (items === null || items === undefined) {
    if (!isPresent(volumeFact)) {
      limitations.push("No discussion items and no market-activity proxy were supplied, so attention could not be assessed.");
      return buildResult({
        level: AttentionLevel.UNKNOWN, weightedCount: null, entries: [],
        volumeFact, volumePoints: 0, limitations, observed: false,
      });
    }
    limitations.push("No discussion items were supplied; attention rests on the market-activity proxy alone.");
  }

  const list = Array.isArray(items) ? items.filter(Boolean) : [];

  // Accept pre-classified entries from Step 3, or classify raw items here.
  const classified = list.map(entry => {
    if (entry && entry.relevance && entry.item) return entry;
    const r = classifyConquestRelevance(entry, target);
    return { item: entry, relevance: r.relevance, signals: r.signals, reasons: r.reasons };
  });

  // Drop exact repeats by identifier before weighting, so the same item
  // appearing twice in a provider response cannot count twice.
  const seenIds = new Set();
  const deduped = [];
  let exactRepeats = 0;
  for (const c of classified) {
    const id = idOf(c.item);
    if (id && seenIds.has(id)) { exactRepeats++; continue; }
    if (id) seenIds.add(id);
    deduped.push(c);
  }

  const sourceSeen = new Map();
  const entries = deduped.map(c => {
    const relevanceWeight = RELEVANCE_WEIGHTS[c.relevance] ?? 0;
    const recency = recencyWeightFor(timestampOf(c.item), now);
    const flaggedDuplicate = c.item.isDuplicate === true;
    const duplicateWeight = flaggedDuplicate ? DUPLICATE_WEIGHT : 1;

    const source = sourceOf(c.item);
    const occurrence = source ? (sourceSeen.get(source) || 0) + 1 : 1;
    if (source) sourceSeen.set(source, occurrence);
    const repetition = source ? sourceRepetitionFactor(occurrence) : 1;

    const contribution = relevanceWeight * recency.weight * duplicateWeight * repetition;
    return Object.freeze({
      relevance: c.relevance,
      source,
      recencyBand: recency.band,
      ageHours: recency.ageHours,
      flaggedDuplicate,
      sourceOccurrence: occurrence,
      contribution: Number(contribution.toFixed(4)),
    });
  });

  const targetSpecificCount = entries.filter(e => e.relevance === ConquestRelevance.TARGET_SPECIFIC).length;
  const contextualCount = entries.filter(e => e.relevance === ConquestRelevance.CONTEXTUAL).length;
  const irrelevantCount = entries.filter(e => e.relevance === ConquestRelevance.IRRELEVANT).length;

  // Unusual volume is a SECONDARY proxy. It says activity is unusual; it
  // says nothing about direction, conviction, crowding or FOMO.
  let volumePoints = 0;
  if (isPresent(volumeFact)) {
    const ratio = factValue(volumeFact);
    if (ratio >= VOLUME_PROXY.STRONG_RATIO) volumePoints = VOLUME_PROXY.STRONG_POINTS;
    else if (ratio >= VOLUME_PROXY.ELEVATED_RATIO) volumePoints = VOLUME_PROXY.ELEVATED_POINTS;
  } else {
    limitations.push("Unusual-volume proxy unavailable on this run; it contributed nothing rather than being treated as zero.");
  }

  const discussionWeight = entries.reduce((a, e) => a + e.contribution, 0);
  const weightedCount = Number((discussionWeight + volumePoints).toFixed(4));

  if (entries.some(e => e.recencyBand === "UNDATED")) {
    limitations.push("Some items carried no usable timestamp and were counted at reduced weight rather than assumed current.");
  }
  if (exactRepeats > 0) {
    limitations.push(`${exactRepeats} exact repeat item(s) were removed before counting.`);
  }

  let level = levelFor(weightedCount, entries.length, isPresent(volumeFact));

  // ---- CONTEXTUAL-ONLY CAP ------------------------------------------
  // Without a single item genuinely about this asset, broad market or
  // basket discussion cannot demonstrate high attention on the asset
  // itself, however much of it there is. The same cap applies when the
  // only evidence is the volume proxy.
  let cappedByContextualOnly = false;
  if (targetSpecificCount === 0 && (level === AttentionLevel.HIGH || level === AttentionLevel.VERY_HIGH)) {
    level = AttentionLevel.MEDIUM;
    cappedByContextualOnly = true;
    limitations.push("No item was specifically about this asset, so attention is capped at MEDIUM: broad market or basket discussion alone cannot demonstrate high attention on the asset itself.");
  }

  return buildResult({
    level, weightedCount, entries, volumeFact, volumePoints, limitations,
    observed: true, targetSpecificCount, contextualCount, irrelevantCount,
    exactRepeats, cappedByContextualOnly, sourceSeen, now,
  });
}

function levelFor(weightedCount, itemCount, hasVolume) {
  if (itemCount === 0 && !hasVolume) return AttentionLevel.UNKNOWN;
  if (weightedCount <= 0) return AttentionLevel.NONE_OBSERVED;
  if (weightedCount >= ATTENTION_THRESHOLDS.VERY_HIGH) return AttentionLevel.VERY_HIGH;
  if (weightedCount >= ATTENTION_THRESHOLDS.HIGH) return AttentionLevel.HIGH;
  if (weightedCount >= ATTENTION_THRESHOLDS.MEDIUM) return AttentionLevel.MEDIUM;
  return AttentionLevel.LOW;
}

function buildResult({
  level, weightedCount, entries, volumeFact, volumePoints, limitations, observed,
  targetSpecificCount = 0, contextualCount = 0, irrelevantCount = 0,
  exactRepeats = 0, cappedByContextualOnly = false, sourceSeen = new Map(), now = new Date(),
}) {
  const recent24 = entries.filter(e => e.recencyBand === "WITHIN_24H").length;
  const recent72 = entries.filter(e => e.recencyBand === "WITHIN_24H" || e.recencyBand === "WITHIN_72H").length;

  return Object.freeze({
    // The level describes OBSERVABLE ACTIVITY, never belief.
    attentionLevel: level,
    weightedAttentionCount: weightedCount,
    counts: Object.freeze({
      targetSpecific: targetSpecificCount,
      contextual: contextualCount,
      irrelevant: irrelevantCount,
      withinLast24h: recent24,
      withinLast72h: recent72,
      exactRepeatsRemoved: exactRepeats,
    }),
    sourceDiversity: sourceSeen.size,
    dominantSourceShare: entries.length
      ? Number((Math.max(0, ...Array.from(sourceSeen.values())) / entries.length).toFixed(4))
      : 0,
    volumeProxy: Object.freeze({
      ratio: volumeFact,
      pointsContributed: volumePoints,
      // Named so no consumer can mistake this for a sentiment reading.
      interpretation: "unusual trading activity only; does not indicate direction, conviction or crowding",
    }),
    provenance: Object.freeze({
      evidenceKinds: Object.freeze([
        ...(entries.length ? ["published_items"] : []),
        ...(isPresent(volumeFact) ? ["market_activity_proxy"] : []),
      ]),
      directCrowdEvidence: false,
      observed,
      cappedByContextualOnly,
    }),
    entries: Object.freeze(entries),
    limitations: Object.freeze(limitations),
  });
}
