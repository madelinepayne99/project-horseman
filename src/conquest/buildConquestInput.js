import { observeMarketBehaviour } from "./marketObservations.js";
import { classifyBehaviouralRegimes } from "./behaviouralRegimes.js";
import { findBehaviouralAnalogues, analogueFindings } from "./historicalAnalogues.js";
import { assessCrowdAttention } from "./crowdAttention.js";
import { assessCrowdSentiment, assessPolarisation } from "./sentiment.js";
import { assessCrowding } from "./crowding.js";
import { assessCrowdEvidenceQuality } from "./evidenceQuality.js";
import { assessConquestEvidenceQuality } from "./conquestEvidenceQuality.js";

/**
 * CONQUEST V2 — INPUT ASSEMBLY
 *
 * STATUS: INERT. Nothing imports this yet.
 *
 * CONQUEST OBSERVES BEHAVIOUR. HE DOESN'T PRETEND TO KNOW PEOPLE'S
 * INTENTIONS.
 *
 * ---------------------------------------------------------------------
 * ORCHESTRATION ONLY
 * ---------------------------------------------------------------------
 * This module measures NOTHING. It calls the locked layers in order and
 * hands their results on unchanged. There is no new statistic, no new
 * threshold, no new classification and no re-derivation of anything a
 * locked layer already produced.
 *
 * If a value is absent here, it is absent because the layer that owns it
 * reported it absent — never because assembly filled a gap.
 *
 * ---------------------------------------------------------------------
 * TWO INDEPENDENT CHANNELS, NEVER MERGED
 * ---------------------------------------------------------------------
 *   MARKET BEHAVIOUR  observations, regimes, analogues — from OHLCV
 *   CROWD             attention, sentiment, crowding, polarisation —
 *                     only from a genuine crowd provider
 *
 * Market behaviour can be rich while every crowd field is UNKNOWN. That is
 * the expected state today, and it is a coherent, honest result: we can
 * describe how the asset is behaving without knowing what anybody thinks.
 */

export const ConquestStatus = Object.freeze({
  /** At least one channel produced usable evidence. */
  ASSESSED: "ASSESSED",
  /** Both channels were consulted and neither could describe anything. */
  INSUFFICIENT_EVIDENCE: "INSUFFICIENT_EVIDENCE",
});

/**
 * Assembles Conquest V2's input from the locked layers.
 *
 * @param {object}  args
 * @param {string}  args.assetId
 * @param {string}  [args.assetType]      preserved for future crypto support
 * @param {object}  [args.series]         normalised OHLCV series, or null
 * @param {object}  [args.crowdEvidence]  crowd evidence, or null when no provider
 * @param {Date}    [args.now]
 */
export function buildConquestInput({
  assetId, assetType = "EQUITY", series = null, crowdEvidence = null, now = new Date(),
} = {}) {
  if (!assetId || typeof assetId !== "string" || !assetId.trim()) {
    throw new Error("buildConquestInput requires an assetId");
  }

  /* ---- MARKET BEHAVIOUR CHANNEL ------------------------------------- */
  // Each layer decides its own availability. A missing series is passed
  // straight through so the layers report UNAVAILABLE themselves rather
  // than assembly inventing a substitute.
  const observations = observeMarketBehaviour(series, { now });
  const regimes = classifyBehaviouralRegimes(observations);
  const analogues = findBehaviouralAnalogues(series, { now });

  /* ---- CROWD CHANNEL ------------------------------------------------ */
  // Every crowd layer independently gates on genuine OBSERVED_CROWD
  // evidence. With no provider they return UNKNOWN or UNAVAILABLE, and
  // assembly does not soften, substitute or infer any of them.
  const crowdAttention = assessCrowdAttention(crowdEvidence, { now });
  const sentiment = assessCrowdSentiment(crowdEvidence);
  const polarisation = assessPolarisation(crowdEvidence);
  const crowding = assessCrowding(crowdEvidence);
  const crowdQuality = assessCrowdEvidenceQuality(crowdEvidence, sentiment, now);

  /* ---- EVIDENCE QUALITY --------------------------------------------- */
  // Channel-level accounting: several signals from one feed remain one
  // source. Assembly does not compute this, it delegates to the layer that
  // owns it.
  const evidenceQuality = assessConquestEvidenceQuality({
    observations, regimes, analogues, crowdQuality, crowdAttention,
  });

  const status = evidenceQuality.independentSourceCount > 0
    ? ConquestStatus.ASSESSED
    : ConquestStatus.INSUFFICIENT_EVIDENCE;

  return Object.freeze({
    assetId: assetId.trim(),
    assetType,
    status,
    marketBehaviour: Object.freeze({ observations, regimes, analogues }),
    crowd: Object.freeze({ attention: crowdAttention, sentiment, polarisation, crowding, quality: crowdQuality }),
    evidenceQuality,
    /** Findings from the locked layers, passed through unchanged. */
    findings: Object.freeze([
      ...observations.findings,
      ...regimes.findings,
      ...analogueFindings(analogues),
    ]),
    /**
     * Provenance of the assembly itself, so a reader can see that it
     * introduced no measurement of its own.
     */
    assembly: Object.freeze({
      layersConsulted: Object.freeze([
        "marketObservations", "behaviouralRegimes", "historicalAnalogues",
        "crowdAttention", "sentiment", "polarisation", "crowding",
        "crowdEvidenceQuality", "conquestEvidenceQuality",
      ]),
      measurementsIntroduced: 0,
      thresholdsIntroduced: 0,
      note: "Assembly orchestrates the locked layers and adds no measurement, threshold or classification of its own.",
    }),
  });
}
