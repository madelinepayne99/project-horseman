import {
  hasDirectCrowdEvidence, CrowdStance, CrowdAvailability, EvidenceOrigin,
  isPresent, factValue,
} from "../schema/crowd.js";

/**
 * CONQUEST V2 — DIRECT CROWD SENTIMENT AND POLARISATION
 *
 * STATUS: INERT. Nothing imports this yet.
 *
 * ---------------------------------------------------------------------
 * THE NON-NEGOTIABLE RULE
 * ---------------------------------------------------------------------
 *   NO DIRECT CROWD EVIDENCE  =>  SENTIMENT UNKNOWN
 *
 * Sentiment is never derived from headline tone, media attention, trading
 * volume, price movement, RSI, 20-day return, realized volatility or
 * Famine evidence. None of those establish what people BELIEVE. The live
 * Production run that reported CONQUEST: BEARISH 84 did exactly that — its
 * "bearish" signal came from two Lululemon headlines — and this module is
 * shaped so the same conclusion is unreachable.
 *
 * Only OBSERVED_CROWD evidence can support a directional crowd claim, and
 * it is gated twice: once on Step 2's hasDirectCrowdEvidence(), and again
 * on the origin stamp, so a USER_SUPPLIED_CLAIM can never be mistaken for
 * public sentiment even if one were somehow routed here.
 *
 * Polarisation is computed by a SEPARATE function with a separate output.
 * A genuinely split crowd is high attention, highly polarised, sentiment
 * MIXED and crowding UNKNOWN — none of which contradict each other.
 */

export const CrowdSentiment = Object.freeze({
  BULLISH: "BULLISH",
  BEARISH: "BEARISH",
  /** Both camps are materially represented — a real split, not an average. */
  MIXED: "MIXED",
  /** The crowd is genuinely engaged but expressing no directional view. */
  NEUTRAL: "NEUTRAL",
  /** Insufficient or absent direct evidence. NOT a market view. */
  UNKNOWN: "UNKNOWN",
});

export const Polarisation = Object.freeze({
  LOW: "LOW",
  MODERATE: "MODERATE",
  HIGH: "HIGH",
  UNKNOWN: "UNKNOWN",
});

/**
 * A handful of posts is not a consensus. Below this many usable, classified
 * observations no directional claim is made at all — the answer is UNKNOWN
 * with an explicit reason, never a confident reading of five comments.
 */
export const MIN_CLASSIFIED_OBSERVATIONS = 8;

/** Net lean at or beyond this reads as directional rather than split. */
export const DIRECTION_THRESHOLD = 0.4;

/** A camp must hold at least this share of directional views to count as present. */
export const MATERIAL_CAMP_SHARE = 0.2;

/** Neutral must dominate this strongly before the crowd is called NEUTRAL. */
export const NEUTRAL_DOMINANCE_SHARE = 0.6;

/**
 * The directional camps must together hold at least this share of classified
 * observations before ANY lean is claimed.
 *
 * Without it, 3 bullish and 0 bearish among 14 neutrals produced netLean 1.0
 * and read BULLISH — three posts outvoting fourteen. That is precisely the
 * "tiny number masquerading as consensus" failure this module exists to
 * prevent, so the lean is now measured against the whole classified sample,
 * not just against the handful of people who expressed a direction.
 */
export const MIN_DIRECTIONAL_SHARE = 0.4;

/** Above this share of unclassified observations, no claim is made. */
export const MAX_UNCLASSIFIED_SHARE = 0.6;

/** Polarisation bands over the evenness of the bullish/bearish split. */
export const POLARISATION_THRESHOLDS = Object.freeze({ HIGH: 0.7, MODERATE: 0.4 });

/**
 * Observations that should carry weight in a sentiment reading.
 *
 * Provider-flagged duplicates and suspected automation are EXCLUDED: a
 * botnet repeating one thesis is not a crowd. Items whose quality is
 * UNKNOWN are INCLUDED — unknown is not the same as bad — but counted so
 * evidence quality can discount accordingly.
 */
export function usableObservations(observations = []) {
  return observations.filter(o => o.isDuplicate !== true && o.isSuspectedAutomated !== true);
}

function tally(observations) {
  const counts = { bullish: 0, bearish: 0, neutral: 0, unclassified: 0 };
  for (const o of observations) {
    if (o.stance === CrowdStance.BULLISH) counts.bullish++;
    else if (o.stance === CrowdStance.BEARISH) counts.bearish++;
    else if (o.stance === CrowdStance.NEUTRAL) counts.neutral++;
    // Anything unrecognised is UNCLASSIFIED — never folded into NEUTRAL.
    else counts.unclassified++;
  }
  return counts;
}

function unknownSentiment(reason, extra = {}) {
  return Object.freeze({
    sentiment: CrowdSentiment.UNKNOWN,
    // Absent, not a fabricated low percentage attached to a direction we
    // never formed.
    sentimentConfidence: null,
    netLean: null,
    counts: Object.freeze({ bullish: 0, bearish: 0, neutral: 0, unclassified: 0, usable: 0, excluded: 0 }),
    sampleSize: 0,
    directEvidence: false,
    reasons: Object.freeze([reason]),
    ...extra,
  });
}

/**
 * Interprets DIRECT crowd evidence into a sentiment reading.
 * Produces no probability, no trade view and no Council semantics.
 *
 * @param {object} crowdEvidence a structure from src/schema/crowd.js
 */
export function assessCrowdSentiment(crowdEvidence) {
  // Gate 1: Step 2's authoritative predicate.
  if (!hasDirectCrowdEvidence(crowdEvidence)) {
    const why = !crowdEvidence
      ? "No crowd evidence was supplied."
      : crowdEvidence.availability === CrowdAvailability.NO_RECENT_ACTIVITY
        ? "The crowd source was reachable but showed no recent activity, so no sentiment can be read."
        : "No direct public-crowd source was available, so crowd sentiment cannot be determined. Media attention and market activity do not establish what people believe.";
    return unknownSentiment(why);
  }

  // Gate 2: a user-supplied claim must never be read as public sentiment.
  if (crowdEvidence.origin !== EvidenceOrigin.OBSERVED_CROWD) {
    return unknownSentiment(
      "Evidence was not observed public crowd activity, so it cannot support a crowd-sentiment reading.");
  }

  const all = crowdEvidence.observations;
  const usable = usableObservations(all);
  const excluded = all.length - usable.length;
  const counts = tally(usable);
  const classified = counts.bullish + counts.bearish + counts.neutral;
  const total = usable.length;

  const base = {
    counts: Object.freeze({ ...counts, usable: total, excluded }),
    sampleSize: classified,
    directEvidence: true,
  };

  if (total > 0 && counts.unclassified / total > MAX_UNCLASSIFIED_SHARE) {
    return Object.freeze({
      ...unknownSentiment(
        `${counts.unclassified} of ${total} usable observations could not be classified, which is too few readable views to support a direction.`),
      ...base,
    });
  }

  if (classified < MIN_CLASSIFIED_OBSERVATIONS) {
    return Object.freeze({
      ...unknownSentiment(
        `Only ${classified} classified observation(s); at least ${MIN_CLASSIFIED_OBSERVATIONS} are required before a direction is claimed.`),
      ...base,
    });
  }

  const directional = counts.bullish + counts.bearish;
  const netLean = directional > 0
    ? Number(((counts.bullish - counts.bearish) / directional).toFixed(4))
    : 0;

  const bullShare = directional > 0 ? counts.bullish / directional : 0;
  const bearShare = directional > 0 ? counts.bearish / directional : 0;
  const neutralShare = counts.neutral / classified;

  const directionalShare = classified > 0 ? directional / classified : 0;

  let sentiment;
  const reasons = [];
  if (directionalShare < MIN_DIRECTIONAL_SHARE) {
    // Too few people expressed any direction for a lean to represent the
    // crowd, however lopsided that handful happens to be.
    if (neutralShare >= NEUTRAL_DOMINANCE_SHARE) {
      sentiment = CrowdSentiment.NEUTRAL;
      reasons.push(`${counts.neutral} of ${classified} classified observations expressed no directional view.`);
    } else {
      sentiment = CrowdSentiment.MIXED;
      reasons.push(`Only ${directional} of ${classified} classified observations expressed a direction, too few to represent the crowd.`);
    }
  } else if (netLean >= DIRECTION_THRESHOLD) {
    sentiment = CrowdSentiment.BULLISH;
    reasons.push(`${counts.bullish} bullish vs ${counts.bearish} bearish among ${classified} classified observations.`);
  } else if (netLean <= -DIRECTION_THRESHOLD) {
    sentiment = CrowdSentiment.BEARISH;
    reasons.push(`${counts.bearish} bearish vs ${counts.bullish} bullish among ${classified} classified observations.`);
  } else if (neutralShare >= NEUTRAL_DOMINANCE_SHARE) {
    sentiment = CrowdSentiment.NEUTRAL;
    reasons.push(`${counts.neutral} of ${classified} classified observations expressed no directional view.`);
  } else if (bullShare >= MATERIAL_CAMP_SHARE && bearShare >= MATERIAL_CAMP_SHARE) {
    sentiment = CrowdSentiment.MIXED;
    reasons.push(`Both camps are materially represented (${counts.bullish} bullish, ${counts.bearish} bearish) with no clear lean.`);
  } else {
    sentiment = CrowdSentiment.MIXED;
    reasons.push("No camp holds a clear lean and neutral views do not dominate.");
  }

  return Object.freeze({
    sentiment,
    // Deliberately null here: strength is EVIDENCE QUALITY, computed by
    // conquest/evidenceQuality.js, not invented inside the tally.
    sentimentConfidence: null,
    netLean,
    ...base,
    reasons: Object.freeze(reasons),
  });
}

/**
 * Polarisation — how EVENLY the directional views are split, independent of
 * which way they lean. Reported separately from sentiment because a split
 * crowd and a directional crowd are different observations.
 *
 * index 0 = entirely one-sided, 1 = perfectly split.
 */
export function assessPolarisation(crowdEvidence) {
  if (!hasDirectCrowdEvidence(crowdEvidence) || crowdEvidence.origin !== EvidenceOrigin.OBSERVED_CROWD) {
    return Object.freeze({
      polarisation: Polarisation.UNKNOWN,
      polarisationIndex: null,
      directionalSampleSize: 0,
      reasons: Object.freeze(["No direct crowd evidence, so polarisation cannot be assessed."]),
    });
  }

  const usable = usableObservations(crowdEvidence.observations);
  const counts = tally(usable);
  const directional = counts.bullish + counts.bearish;

  if (directional < MIN_CLASSIFIED_OBSERVATIONS) {
    return Object.freeze({
      polarisation: Polarisation.UNKNOWN,
      polarisationIndex: null,
      directionalSampleSize: directional,
      reasons: Object.freeze([
        `Only ${directional} directional observation(s); at least ${MIN_CLASSIFIED_OBSERVATIONS} are required before describing polarisation.`]),
    });
  }

  const index = Number((2 * Math.min(counts.bullish, counts.bearish) / directional).toFixed(4));
  const band = index >= POLARISATION_THRESHOLDS.HIGH ? Polarisation.HIGH
    : index >= POLARISATION_THRESHOLDS.MODERATE ? Polarisation.MODERATE
    : Polarisation.LOW;

  return Object.freeze({
    polarisation: band,
    polarisationIndex: index,
    directionalSampleSize: directional,
    reasons: Object.freeze([
      `${counts.bullish} bullish and ${counts.bearish} bearish among ${directional} directional observations.`]),
  });
}

export { CrowdSentiment as ConquestSentiment, isPresent, factValue };
