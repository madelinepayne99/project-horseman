import { ConquestStatus } from "./buildConquestInput.js";
import { BehaviouralRegime } from "./behaviouralRegimes.js";
import { CrowdAttentionLevel } from "./crowdAttention.js";
import { CrowdSentiment, Polarisation } from "./sentiment.js";
import { CrowdingLevel } from "./crowding.js";
import { SampleStatus } from "./historicalAnalogues.js";
import { EvidenceChannel, ChannelStatus } from "./conquestEvidenceQuality.js";

/**
 * CONQUEST V2 — OUTPUT CONTRACT
 *
 * STATUS: INERT. Nothing imports this yet.
 *
 * CONQUEST OBSERVES BEHAVIOUR. HE DOESN'T PRETEND TO KNOW PEOPLE'S
 * INTENTIONS.
 *
 * Presents what the locked layers found. It performs no measurement, no
 * classification and no re-derivation: every value below is copied from a
 * layer that owns it.
 *
 * ---------------------------------------------------------------------
 * WHAT CONQUEST DOES NOT PRODUCE
 * ---------------------------------------------------------------------
 * No verdict, no recommendation, no risk judgement, no probability, no
 * price forecast, and no directional vote from market behaviour. Death
 * decides whether behaviour is a reason not to proceed; the Council
 * judges; the user decides.
 *
 * The ONE field that may ever influence Council directionally is
 * `crowdSentiment`, and only when a genuine crowd provider supplied the
 * evidence behind it. With no provider it is UNKNOWN, which is an
 * abstention — never a neutral vote.
 */

/**
 * Council may treat this Conquest output as a directional contributor only
 * when this is true. It restates the crowd layer's own gate rather than
 * re-deriving it.
 */
export function hasDirectionalCrowdEvidence(conquestOutput) {
  return !!conquestOutput
    && conquestOutput.crowdSentiment !== CrowdSentiment.UNKNOWN
    && conquestOutput.provenance.directCrowdEvidence === true;
}

/**
 * Builds the Conquest V2 output from an assembled input.
 * @param {object} input result of buildConquestInput()
 */
export function conquestAnalysis(input) {
  const { marketBehaviour: mb, crowd, evidenceQuality } = input;

  const crowdChannel = evidenceQuality.channels.find(c => c.channel === EvidenceChannel.DIRECT_CROWD);
  const directCrowdEvidence = crowdChannel ? crowdChannel.status === ChannelStatus.PRESENT : false;

  /* ---- limitations: the layers' own, plus the standing boundaries ---- */
  const limitations = [
    "Conquest describes how market participants are behaving. It does not explain why, does not forecast, and does not judge whether a trade is wise.",
    ...mb.observations.limitations,
    ...mb.regimes.limitations,
    ...mb.analogues.limitations,
    ...crowd.attention.limitations,
    ...(crowd.crowding.limitations || []),
    ...evidenceQuality.limitations,
  ];
  if (!directCrowdEvidence) {
    limitations.push("No direct public-crowd source is connected, so crowd sentiment, crowding and polarisation are unknown. This is not evidence that opinion is balanced or that nobody is interested.");
  }

  /* ---- what is missing, named explicitly ----------------------------- */
  const missingEvidence = [];
  for (const o of mb.observations.observations) {
    if (!o.finding) missingEvidence.push({ item: o.id, status: o.status, channel: EvidenceChannel.MARKET_BEHAVIOUR });
  }
  if (mb.analogues.status === SampleStatus.INSUFFICIENT_ANALOGUES) {
    missingEvidence.push({ item: "HISTORICAL_ANALOGUES", status: mb.analogues.status,
      channel: EvidenceChannel.HISTORICAL_ANALOGUE });
  }
  for (const c of evidenceQuality.missingChannels) {
    missingEvidence.push({ item: c, status: ChannelStatus.UNAVAILABLE, channel: c });
  }

  return Object.freeze({
    assetId: input.assetId,
    assetType: input.assetType,
    status: input.status,

    /* ---- MARKET BEHAVIOUR (available without any provider) ---------- */
    behaviouralRegimes: mb.regimes.regimeIds,
    regimeStatus: mb.regimes.status,
    observations: Object.freeze({
      participationPercentile: percentileOf(mb.observations.participation),
      movementMagnitudePercentile: percentileOf(mb.observations.movementMagnitude),
      rangePercentile: percentileOf(mb.observations.rangeExpansion),
      participationRatio: valueOf(mb.observations.participationRatio),
      latestBarProvisional: mb.observations.latestBarProvisional,
    }),
    historicalAnalogues: Object.freeze({
      status: mb.analogues.status,
      episodeCount: mb.analogues.analogueCount,
      matchingSessions: mb.analogues.search.matchingSessions,
      horizons: mb.analogues.horizons,
      method: mb.analogues.method,
    }),

    /* ---- CROWD (UNKNOWN without a provider) ------------------------- */
    crowdAttention: crowd.attention.crowdAttention,
    crowdSentiment: crowd.sentiment.sentiment,
    // Owned by the crowd evidence-quality layer: the sentiment layer
    // deliberately leaves this null because strength is a property of the
    // evidence, not of the tally. Passed through, not recomputed.
    crowdSentimentConfidence: crowd.quality ? crowd.quality.sentimentConfidence : null,
    crowding: crowd.crowding.crowding,
    polarisation: crowd.polarisation.polarisation,

    /* ---- EVIDENCE QUALITY ------------------------------------------- */
    evidenceQuality: Object.freeze({
      overallBand: evidenceQuality.overallQualityBand,
      overallScore: evidenceQuality.overallQualityScore,
      independentSourceCount: evidenceQuality.independentSourceCount,
      independentSources: evidenceQuality.independentSources,
      derivedSignalCount: evidenceQuality.derivedSignalCount,
      channels: evidenceQuality.channels,
    }),

    /* ---- PROVENANCE ------------------------------------------------- */
    provenance: Object.freeze({
      directCrowdEvidence,
      marketBehaviourAvailable: mb.observations.findings.length > 0,
      /**
       * Council may read `crowdSentiment` directionally only when direct
       * crowd evidence exists. Market-derived behaviour is context and
       * evidence quality — never a directional vote.
       */
      directionalContributionPermitted: directCrowdEvidence
        && crowd.sentiment.sentiment !== CrowdSentiment.UNKNOWN,
      layersConsulted: input.assembly.layersConsulted,
      measurementsIntroducedByAssembly: input.assembly.measurementsIntroduced,
    }),

    findings: input.findings,
    missingEvidence: Object.freeze(missingEvidence.map(m => Object.freeze(m))),
    limitations: Object.freeze(limitations),
  });
}

/** Copies a percentile through, or null when the layer did not measure it. */
function percentileOf(observation) {
  return observation && Number.isFinite(observation.percentile) ? observation.percentile : null;
}
function valueOf(observation) {
  return observation && Number.isFinite(observation.value) ? observation.value : null;
}

export {
  ConquestStatus, BehaviouralRegime, CrowdAttentionLevel,
  CrowdSentiment, Polarisation, CrowdingLevel, SampleStatus,
};
