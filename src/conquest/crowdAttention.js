import {
  hasDirectCrowdEvidence, CrowdAvailability, EvidenceOrigin, isPresent, factValue,
} from "../schema/crowd.js";

/**
 * BEHAVIOURAL CONQUEST — CROWD ATTENTION (rescoped)
 *
 * STATUS: INERT. Nothing imports this yet.
 *
 * ---------------------------------------------------------------------
 * WHY THIS REPLACES attention.js FOR THE NEW ASSEMBLY
 * ---------------------------------------------------------------------
 * The original attention model added a volume proxy into the same weighted
 * count as discussion items, so it would report an attention level from
 * market data alone — `assessAttention({ items: null, volumeRatio: 5 })`
 * returns LOW with no discussion evidence whatsoever.
 *
 * Under Conquest's evolved role that is the wrong claim. Heavy trading is
 * observable MARKET ACTIVITY, and Step 3 already measures it properly as a
 * participation percentile against the asset's own history. It is not
 * evidence that anybody is talking about the asset. Inferring public
 * attention from price and volume is the same category error as inferring
 * intent from them.
 *
 * So the two are separated:
 *
 *   MARKET ACTIVITY  Step 3 observations + Step 4 regimes + Step 5 analogues
 *   CROWD ATTENTION  this module, from genuine OBSERVED_CROWD evidence only
 *
 * With no crowd provider connected, crowd attention is UNAVAILABLE — never
 * substituted from market data, and never NONE_OBSERVED, which would imply
 * we looked and found silence.
 *
 * attention.js is left in place unchanged. It is legacy and is excluded
 * from the new assembly rather than deleted.
 */

export const CrowdAttentionLevel = Object.freeze({
  /** No crowd source was connected. We did not look. */
  UNAVAILABLE: "UNAVAILABLE",
  /** A crowd source answered and there was no relevant recent activity. */
  NONE_OBSERVED: "NONE_OBSERVED",
  LOW: "LOW",
  MODERATE: "MODERATE",
  HIGH: "HIGH",
  VERY_HIGH: "VERY_HIGH",
});

/**
 * PROVISIONAL AND UNCALIBRATED. Thresholds are on the effective item count,
 * which is the observation count after duplicates and suspected automation
 * are removed and after source breadth is taken into account.
 */
export const CROWD_ATTENTION_THRESHOLDS = Object.freeze({
  calibrated: false,
  VERY_HIGH: 60,
  HIGH: 25,
  MODERATE: 8,
  /** Below this many distinct sources, breadth is judged narrow. */
  NARROW_SOURCE_COUNT: 2,
  /** Weight applied when all activity comes from one or two sources. */
  NARROW_BREADTH_FACTOR: 0.5,
  /** Hours within which an observation counts as current. */
  RECENT_HOURS: 72,
});

/**
 * Crowd attention from genuine crowd evidence.
 *
 * Duplicates and suspected automation are excluded before counting: a
 * hundred copies of one message is one message repeated, not a hundred
 * people paying attention.
 *
 * @param {object} crowdEvidence structure from src/schema/crowd.js, or null
 * @param {Date}   [now]
 */
export function assessCrowdAttention(crowdEvidence, { now = new Date() } = {}) {
  const limitations = [
    "Crowd attention measures observable public discussion. It is never inferred from trading activity, which is measured separately as market behaviour.",
  ];

  // No provider, or a provider that failed: we did not look.
  if (!crowdEvidence || crowdEvidence.availability === CrowdAvailability.PROVIDER_UNAVAILABLE
      || crowdEvidence.availability === CrowdAvailability.MALFORMED) {
    limitations.push("No crowd source was available, so public attention could not be measured. This is not evidence that the asset is being ignored.");
    return build({ level: CrowdAttentionLevel.UNAVAILABLE, limitations, available: false });
  }

  // A user-supplied claim can never be read as crowd evidence.
  if (crowdEvidence.origin !== EvidenceOrigin.OBSERVED_CROWD) {
    limitations.push("The evidence supplied was not observed public crowd activity, so it cannot indicate public attention.");
    return build({ level: CrowdAttentionLevel.UNAVAILABLE, limitations, available: false });
  }

  // A source that answered with nothing IS a finding: the crowd is quiet.
  if (!hasDirectCrowdEvidence(crowdEvidence)) {
    return build({
      level: CrowdAttentionLevel.NONE_OBSERVED, limitations, available: true,
      observationCount: 0, effectiveCount: 0,
    });
  }

  const all = crowdEvidence.observations;
  // Repetition is not attention.
  const usable = all.filter(o => o.isDuplicate !== true && o.isSuspectedAutomated !== true);
  const excluded = all.length - usable.length;

  const cutoff = now.getTime() - CROWD_ATTENTION_THRESHOLDS.RECENT_HOURS * 3600 * 1000;
  const recent = usable.filter(o => {
    const t = Date.parse(o.publishedAt);
    return Number.isFinite(t) && t >= cutoff;
  });

  const distinctSources = new Set(usable.map(o => o.sourceName)).size;
  const distinctAuthors = new Set(usable.map(o => o.authorId).filter(Boolean)).size;

  // Narrow breadth is discounted: one forum shouting is not broad attention.
  const narrow = distinctSources <= CROWD_ATTENTION_THRESHOLDS.NARROW_SOURCE_COUNT;
  const effectiveCount = Number((recent.length * (narrow ? CROWD_ATTENTION_THRESHOLDS.NARROW_BREADTH_FACTOR : 1)).toFixed(2));

  const T = CROWD_ATTENTION_THRESHOLDS;
  const level = effectiveCount >= T.VERY_HIGH ? CrowdAttentionLevel.VERY_HIGH
    : effectiveCount >= T.HIGH ? CrowdAttentionLevel.HIGH
    : effectiveCount >= T.MODERATE ? CrowdAttentionLevel.MODERATE
    : effectiveCount > 0 ? CrowdAttentionLevel.LOW
    : CrowdAttentionLevel.NONE_OBSERVED;

  if (excluded > 0) limitations.push(`${excluded} observation(s) were excluded as duplicates or suspected automation; repetition is not attention.`);
  if (narrow) limitations.push(`Activity came from only ${distinctSources} source(s), so breadth is narrow and the count is discounted.`);
  if (distinctAuthors === 0) limitations.push("The source supplied no author identifiers, so participation breadth could not be assessed.");

  return build({
    level, limitations, available: true,
    observationCount: all.length, usableCount: usable.length, recentCount: recent.length,
    effectiveCount, excludedForRepetition: excluded,
    sourceBreadth: distinctSources, authorBreadth: distinctAuthors || null,
    providerReportedVolume: crowdEvidence.volume,
  });
}

function build({
  level, limitations, available, observationCount = null, usableCount = null,
  recentCount = null, effectiveCount = null, excludedForRepetition = 0,
  sourceBreadth = null, authorBreadth = null, providerReportedVolume = null,
}) {
  return Object.freeze({
    crowdAttention: level,
    available,
    counts: Object.freeze({
      observations: observationCount, usable: usableCount, recent: recentCount,
      effective: effectiveCount, excludedForRepetition,
    }),
    breadth: Object.freeze({ sources: sourceBreadth, authors: authorBreadth }),
    providerReportedVolume,
    thresholds: CROWD_ATTENTION_THRESHOLDS,
    limitations: Object.freeze(limitations),
  });
}

export { isPresent, factValue };
