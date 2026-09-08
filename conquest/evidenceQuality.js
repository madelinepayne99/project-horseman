import { hasDirectCrowdEvidence, EvidenceOrigin, isPresent, factValue } from "../schema/crowd.js";
import { usableObservations, MIN_CLASSIFIED_OBSERVATIONS, CrowdSentiment } from "./sentiment.js";

/**
 * CONQUEST V2 — EVIDENCE QUALITY
 *
 * STATUS: INERT. Nothing imports this yet.
 *
 * ---------------------------------------------------------------------
 * WHAT CONQUEST CONFIDENCE MEANS
 * ---------------------------------------------------------------------
 *   "How strongly does the available evidence justify Conquest's OWN
 *    conclusions?"
 *
 * It is NOT the probability the stock rises, not trade confidence, not
 * Council confidence, and not generic certainty. Legacy Conquest's
 * confidence rose with ATTENTION VOLUME and keyword magnitude, which is
 * why a live run reported 84 on the strength of other companies'
 * headlines. Quality here is computed only from properties of the
 * evidence itself.
 *
 * ---------------------------------------------------------------------
 * NO ARBITRARY CAP
 * ---------------------------------------------------------------------
 * Proxy-only evidence is not "capped at 50". Instead the two are simply
 * different questions with different answers:
 *
 *   - Attention evidence (media items, market activity) gets its OWN
 *     quality statement, explicitly labelled PROXY.
 *   - Sentiment confidence does not exist at all without direct crowd
 *     evidence. UNKNOWN sentiment carries confidence null, because
 *     attaching any percentage to a direction we never formed would be
 *     inventing precision.
 */

export const QualityBand = Object.freeze({
  STRONG: "STRONG",
  MODERATE: "MODERATE",
  WEAK: "WEAK",
  INSUFFICIENT: "INSUFFICIENT",
});

export const EvidenceKind = Object.freeze({
  DIRECT_CROWD: "DIRECT_CROWD",
  PROXY: "PROXY",
});

export const QUALITY_BANDS = Object.freeze({ STRONG: 0.7, MODERATE: 0.45 });

/**
 * Breadth floor. Averaging factors let strong ones mask fatal ones: 500
 * observations from ONE author on ONE source scored 0.74 and banded STRONG,
 * because sample size, coverage, freshness and cleanliness were all perfect.
 * But one person posting 500 times is not a crowd at all.
 *
 * When BOTH source and author breadth are this weak, the band cannot exceed
 * MODERATE however well the other factors score. This is a structural
 * weakness gate on the BAND, not an arbitrary cap on proxy evidence.
 */
export const BREADTH_FLOOR = Object.freeze({ SOURCE_DIVERSITY: 0.4, AUTHOR_DIVERSITY: 0.2 });

/**
 * Sample-size sufficiency, saturating rather than rewarding raw volume
 * without limit: quantity alone must not manufacture strength.
 */
export const SAMPLE_SATURATION = 40;

function band(score) {
  if (score >= QUALITY_BANDS.STRONG) return QualityBand.STRONG;
  if (score >= QUALITY_BANDS.MODERATE) return QualityBand.MODERATE;
  return QualityBand.WEAK;
}

function clamp01(n) { return Math.max(0, Math.min(1, n)); }

/**
 * Quality of DIRECT crowd evidence, as an explicit factor breakdown.
 * Every factor is 0..1 and reported individually so a reader can see which
 * property is weak rather than being handed one opaque number.
 *
 * @param {object} crowdEvidence  structure from src/schema/crowd.js
 * @param {object} sentimentResult result of assessCrowdSentiment()
 * @param {Date}   now
 */
export function assessCrowdEvidenceQuality(crowdEvidence, sentimentResult = null, now = new Date()) {
  const insufficient = reason => Object.freeze({
    evidenceKind: EvidenceKind.DIRECT_CROWD,
    directEvidence: false,
    qualityBand: QualityBand.INSUFFICIENT,
    qualityScore: null,
    factors: Object.freeze({}),
    // Absent, never a fabricated low percentage on an unformed direction.
    sentimentConfidence: null,
    limitations: Object.freeze([reason]),
  });

  if (!hasDirectCrowdEvidence(crowdEvidence) || crowdEvidence.origin !== EvidenceOrigin.OBSERVED_CROWD) {
    return insufficient("No direct public-crowd evidence, so no crowd-sentiment confidence can be stated.");
  }

  const all = crowdEvidence.observations;
  const usable = usableObservations(all);
  const excludedShare = all.length ? (all.length - usable.length) / all.length : 0;

  const distinctSources = new Set(all.map(o => o.sourceName)).size;
  const distinctAuthors = new Set(all.map(o => o.authorId).filter(Boolean)).size;
  const classified = usable.filter(o => o.stance !== "UNCLASSIFIED").length;
  const coverage = usable.length ? classified / usable.length : 0;

  // Freshness of the observation window.
  const windowEnd = crowdEvidence.window?.end || crowdEvidence.source?.observedAt || null;
  const ageHours = windowEnd ? (now.getTime() - Date.parse(windowEnd)) / 3600000 : null;
  const freshness = ageHours === null || Number.isNaN(ageHours)
    ? 0.5                                    // unknown age: neither trusted nor discarded
    : ageHours <= 24 ? 1 : ageHours <= 72 ? 0.7 : ageHours <= 24 * 7 ? 0.4 : 0.15;

  const qualityUnknown = all.every(o => o.isDuplicate === null && o.isSuspectedAutomated === null);

  const factors = Object.freeze({
    // Saturating: 40+ usable observations is as much as quantity can buy.
    sampleSize: clamp01(usable.length / SAMPLE_SATURATION),
    sourceDiversity: clamp01(distinctSources / 5),
    authorDiversity: distinctAuthors === 0 ? null : clamp01(distinctAuthors / Math.max(1, all.length)),
    classificationCoverage: clamp01(coverage),
    freshness,
    // Heavy duplication/automation removal is a WEAKNESS of the feed.
    cleanliness: clamp01(1 - excludedShare),
    classifierConfidence: isPresent(crowdEvidence.classifierConfidence)
      ? clamp01(factValue(crowdEvidence.classifierConfidence))
      : null,
    // Agreement is a property of the evidence, not a market view.
    agreement: sentimentResult && typeof sentimentResult.netLean === "number"
      ? clamp01(Math.abs(sentimentResult.netLean))
      : null,
  });

  // Unknown factors are EXCLUDED from the mean rather than scored zero:
  // missing quality information reduces what can be CLAIMED, but must not
  // make otherwise usable evidence look worthless.
  const present = Object.entries(factors).filter(([, v]) => typeof v === "number");
  const qualityScore = present.length
    ? Number((present.reduce((a, [, v]) => a + v, 0) / present.length).toFixed(4))
    : null;

  const limitations = [
    "Evidence quality describes how well the available evidence supports Conquest's own conclusions. It is not a probability that the trade will succeed.",
  ];
  if (qualityUnknown) limitations.push("The source supplied no duplicate or automation flags, so feed cleanliness could not be verified.");
  if (factors.authorDiversity === null) limitations.push("The source supplied no author identifiers, so participation diversity could not be assessed.");
  if (factors.classifierConfidence === null) limitations.push("The source supplied no stance-classification confidence.");
  if (ageHours === null) limitations.push("The observation window carried no end timestamp, so freshness could not be established.");

  const breadthWeak = qualityScore !== null
    && factors.sourceDiversity < BREADTH_FLOOR.SOURCE_DIVERSITY
    && (factors.authorDiversity === null || factors.authorDiversity < BREADTH_FLOOR.AUTHOR_DIVERSITY);
  if (breadthWeak) {
    limitations.push("Discussion came from very few sources and authors, so the evidence cannot be rated strong however much of it there is.");
  }

  // Confidence attaches ONLY to a direction that was actually formed.
  const directionFormed = sentimentResult
    && sentimentResult.sentiment
    && sentimentResult.sentiment !== CrowdSentiment.UNKNOWN;
  const enoughSample = (sentimentResult?.sampleSize ?? 0) >= MIN_CLASSIFIED_OBSERVATIONS;
  const sentimentConfidence = directionFormed && enoughSample && qualityScore !== null
    ? Math.round(qualityScore * 100)
    : null;

  const rawBand = qualityScore === null ? QualityBand.INSUFFICIENT : band(qualityScore);
  const finalBand = breadthWeak && rawBand === QualityBand.STRONG ? QualityBand.MODERATE : rawBand;

  return Object.freeze({
    evidenceKind: EvidenceKind.DIRECT_CROWD,
    directEvidence: true,
    qualityBand: finalBand,
    breadthLimited: breadthWeak,
    qualityScore,
    factors,
    sentimentConfidence,
    limitations: Object.freeze(limitations),
  });
}

/**
 * Quality of ATTENTION evidence, which is PROXY by nature: published items
 * and market activity indicate that something is being discussed or traded,
 * never what anyone believes. Reported separately so a reader can see that
 * Conquest may know a lot about attention and nothing about sentiment.
 *
 * @param {object} attentionResult result of assessAttention() from Step 4
 */
export function assessAttentionEvidenceQuality(attentionResult) {
  if (!attentionResult || attentionResult.attentionLevel === "UNKNOWN") {
    return Object.freeze({
      evidenceKind: EvidenceKind.PROXY,
      directEvidence: false,
      qualityBand: QualityBand.INSUFFICIENT,
      qualityScore: null,
      factors: Object.freeze({}),
      limitations: Object.freeze(["No attention evidence was available to assess."]),
    });
  }

  const counts = attentionResult.counts || {};
  const targetSpecific = counts.targetSpecific || 0;
  const total = targetSpecific + (counts.contextual || 0);

  const factors = Object.freeze({
    // Target-specific items are worth far more than basket mentions.
    targetSpecificity: total ? clamp01(targetSpecific / total) : 0,
    sourceDiversity: clamp01((attentionResult.sourceDiversity || 0) / 5),
    // A single outlet dominating the results weakens the evidence.
    sourceConcentration: clamp01(1 - (attentionResult.dominantSourceShare || 0)),
    recency: total ? clamp01((counts.withinLast72h || 0) / total) : 0,
  });

  const qualityScore = Number(
    (Object.values(factors).reduce((a, v) => a + v, 0) / Object.keys(factors).length).toFixed(4));

  return Object.freeze({
    evidenceKind: EvidenceKind.PROXY,
    directEvidence: false,
    qualityBand: band(qualityScore),
    qualityScore,
    factors,
    limitations: Object.freeze([
      "Attention evidence is a proxy: published items and market activity show that an asset is being discussed or traded, not what anyone believes about it.",
      "This quality statement describes the attention evidence only. It says nothing about crowd sentiment, which requires a direct crowd source.",
    ]),
  });
}
