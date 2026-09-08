import { hasDirectCrowdEvidence, CrowdStance, EvidenceOrigin } from "../schema/crowd.js";
import { usableObservations, MIN_CLASSIFIED_OBSERVATIONS } from "./sentiment.js";

/**
 * CONQUEST V2 — CROWDING
 *
 * STATUS: INERT. Nothing imports this yet.
 *
 * ---------------------------------------------------------------------
 * CROWDING IS CROWD BEHAVIOUR, NOT A PRICE CONDITION
 * ---------------------------------------------------------------------
 * Legacy Conquest inferred "crowding" from RSI extremes, a large 20-day
 * return and unusual volume, then fed that straight into Death's risk
 * score. Those are price statistics wearing a sentiment label: they are
 * War's data being reinterpreted by Conquest with no crowd evidence
 * whatsoever.
 *
 * This module accepts NONE of the following, as inputs or outputs:
 *   RSI · 20-day return · one-day price move · realized volatility ·
 *   average absolute move · trading volume
 *
 * Trading volume remains an ATTENTION proxy in Step 4. It cannot prove
 * that a trade is crowded — it cannot even tell us why anyone traded.
 *
 * What crowding CAN legitimately be read from is the shape of the
 * discussion itself: few sources carrying it, few authors carrying it,
 * heavy duplication of one narrative, and an extreme stance imbalance
 * backed by an adequate sample. When the evidence cannot support such a
 * conclusion, the answer is UNKNOWN — not a score invented because
 * Conquest happens to have a field for one.
 */

export const CrowdingLevel = Object.freeze({
  LOW: "LOW",
  ELEVATED: "ELEVATED",
  HIGH: "HIGH",
  UNKNOWN: "UNKNOWN",
});

export const CROWDING_THRESHOLDS = Object.freeze({
  /** At or below this many distinct sources, the narrative is concentrated. */
  LOW_SOURCE_DIVERSITY: 2,
  /** Distinct authors per observation, at or below which participation is narrow. */
  LOW_AUTHOR_RATIO: 0.5,
  /** Share of observations flagged duplicate, at or above which repetition dominates. */
  HIGH_DUPLICATE_SHARE: 0.3,
  /** |net lean| at or above which one thesis overwhelmingly dominates. */
  EXTREME_IMBALANCE: 0.8,
  /** Signals required for each band. */
  HIGH_SIGNALS: 3,
  ELEVATED_SIGNALS: 2,
});

/**
 * Assesses crowding from direct crowd evidence only.
 *
 * @param {object} crowdEvidence a structure from src/schema/crowd.js
 */
export function assessCrowding(crowdEvidence) {
  const unknown = reason => Object.freeze({
    crowding: CrowdingLevel.UNKNOWN,
    signals: Object.freeze([]),
    signalCount: 0,
    sampleSize: 0,
    reasons: Object.freeze([reason]),
    limitations: Object.freeze([
      "Crowding describes observable crowd behaviour. It is never inferred from price, volatility, momentum or trading volume.",
    ]),
  });

  if (!hasDirectCrowdEvidence(crowdEvidence) || crowdEvidence.origin !== EvidenceOrigin.OBSERVED_CROWD) {
    return unknown("No direct crowd evidence, so crowding cannot be assessed. Price and volume conditions cannot substitute for it.");
  }

  const all = crowdEvidence.observations;
  const usable = usableObservations(all);

  if (usable.length < MIN_CLASSIFIED_OBSERVATIONS) {
    return unknown(`Only ${usable.length} usable observation(s); at least ${MIN_CLASSIFIED_OBSERVATIONS} are required before describing crowding.`);
  }

  const bullish = usable.filter(o => o.stance === CrowdStance.BULLISH).length;
  const bearish = usable.filter(o => o.stance === CrowdStance.BEARISH).length;
  const directional = bullish + bearish;
  const netLean = directional > 0 ? Math.abs(bullish - bearish) / directional : 0;

  const distinctSources = new Set(all.map(o => o.sourceName)).size;
  const distinctAuthors = new Set(all.map(o => o.authorId).filter(Boolean)).size;
  const authorRatio = all.length ? distinctAuthors / all.length : 0;
  const duplicateShare = all.length
    ? all.filter(o => o.isDuplicate === true).length / all.length
    : 0;

  // Quality flags may be genuinely unknown across a whole feed. That does
  // not make the evidence unusable, but duplication-based signals cannot be
  // claimed from it, so we record the gap rather than assuming "clean".
  const qualityUnknown = all.every(o => o.isDuplicate === null && o.isSuspectedAutomated === null);
  const authorsUnknown = distinctAuthors === 0;

  const signals = [];
  if (distinctSources <= CROWDING_THRESHOLDS.LOW_SOURCE_DIVERSITY) {
    signals.push({ signal: "LOW_SOURCE_DIVERSITY",
      detail: `Discussion is carried by only ${distinctSources} distinct source(s).` });
  }
  if (!authorsUnknown && authorRatio <= CROWDING_THRESHOLDS.LOW_AUTHOR_RATIO) {
    signals.push({ signal: "LOW_AUTHOR_DIVERSITY",
      detail: `${distinctAuthors} distinct author(s) across ${all.length} observations.` });
  }
  if (!qualityUnknown && duplicateShare >= CROWDING_THRESHOLDS.HIGH_DUPLICATE_SHARE) {
    signals.push({ signal: "REPEATED_NARRATIVE",
      detail: `${Math.round(duplicateShare * 100)}% of observations are flagged as duplicates of one another.` });
  }
  if (directional >= MIN_CLASSIFIED_OBSERVATIONS && netLean >= CROWDING_THRESHOLDS.EXTREME_IMBALANCE) {
    signals.push({ signal: "EXTREME_STANCE_IMBALANCE",
      detail: `${bullish} bullish vs ${bearish} bearish — one thesis dominates an adequate sample.` });
  }

  const limitations = [
    "Crowding describes observable crowd behaviour. It is never inferred from price, volatility, momentum or trading volume.",
  ];
  if (qualityUnknown) limitations.push("The source supplied no duplicate or automation flags, so repetition-based crowding could not be assessed.");
  if (authorsUnknown) limitations.push("The source supplied no author identifiers, so participation concentration could not be assessed.");

  const level = signals.length >= CROWDING_THRESHOLDS.HIGH_SIGNALS ? CrowdingLevel.HIGH
    : signals.length >= CROWDING_THRESHOLDS.ELEVATED_SIGNALS ? CrowdingLevel.ELEVATED
    : CrowdingLevel.LOW;

  return Object.freeze({
    crowding: level,
    signals: Object.freeze(signals.map(s => Object.freeze(s))),
    signalCount: signals.length,
    sampleSize: usable.length,
    observed: Object.freeze({
      distinctSources, distinctAuthors,
      authorRatio: Number(authorRatio.toFixed(4)),
      duplicateShare: Number(duplicateShare.toFixed(4)),
      netLeanMagnitude: Number(netLean.toFixed(4)),
    }),
    reasons: Object.freeze(signals.length
      ? signals.map(s => s.detail)
      : ["No concentration, repetition or imbalance signals were present in the observed discussion."]),
    limitations: Object.freeze(limitations),
  });
}
