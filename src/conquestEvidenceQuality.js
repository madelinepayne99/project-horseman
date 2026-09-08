import { EvidenceSource, distinctSources } from "../schema/provenance.js";

/**
 * BEHAVIOURAL CONQUEST — EVIDENCE QUALITY (Conquest level)
 *
 * STATUS: INERT. Nothing imports this yet.
 *
 * Answers one question: how much trustworthy behavioural and crowd evidence
 * do we actually have?
 *
 * ---------------------------------------------------------------------
 * THE FAILURE THIS EXISTS TO PREVENT
 * ---------------------------------------------------------------------
 * Conquest now derives a great many signals — four observations, up to five
 * regimes, an analogue count, per-horizon outcome distributions. Every one
 * of them comes from a single OHLCV feed.
 *
 * TEN CALCULATIONS FROM ONE MARKET-HISTORY FEED ARE NOT TEN SOURCES.
 *
 * Quality is therefore assessed per CHANNEL, and a channel counts once
 * however many signals were derived from it. `derivedSignalCount` is
 * reported for transparency but never feeds the score — it is a measure of
 * how much we computed, not of how much we know.
 *
 * This is not Council weighting. It is a truthful structure Council can
 * later consume without mistaking quantity of derived features for
 * independence.
 */

export const EvidenceChannel = Object.freeze({
  /** Step 3 observations and Step 4 regimes, from the price/volume series. */
  MARKET_BEHAVIOUR: "MARKET_BEHAVIOUR",
  /** Step 5 analogues — the SAME feed, read historically. */
  HISTORICAL_ANALOGUE: "HISTORICAL_ANALOGUE",
  /** Genuine public crowd evidence, when a provider exists. */
  DIRECT_CROWD: "DIRECT_CROWD",
});

/** Which underlying feed each channel rests on. */
export const CHANNEL_SOURCE = Object.freeze({
  [EvidenceChannel.MARKET_BEHAVIOUR]: EvidenceSource.MARKET_HISTORY,
  [EvidenceChannel.HISTORICAL_ANALOGUE]: EvidenceSource.MARKET_HISTORY,
  [EvidenceChannel.DIRECT_CROWD]: EvidenceSource.CROWD_FEED,
});

export const ChannelStatus = Object.freeze({
  PRESENT: "PRESENT",
  /** The channel was consulted and had nothing. A finding, not a gap. */
  NONE_OBSERVED: "NONE_OBSERVED",
  /** No provider or no usable data. We did not look. */
  UNAVAILABLE: "UNAVAILABLE",
  /** Present but too thin to support a conclusion. */
  INSUFFICIENT: "INSUFFICIENT",
});

export const QualityBand = Object.freeze({
  STRONG: "STRONG", MODERATE: "MODERATE", WEAK: "WEAK", INSUFFICIENT: "INSUFFICIENT",
});

export const QUALITY_BANDS = Object.freeze({ calibrated: false, STRONG: 0.7, MODERATE: 0.45 });

function band(score) {
  if (score === null) return QualityBand.INSUFFICIENT;
  if (score >= QUALITY_BANDS.STRONG) return QualityBand.STRONG;
  if (score >= QUALITY_BANDS.MODERATE) return QualityBand.MODERATE;
  return QualityBand.WEAK;
}
const clamp01 = n => Math.max(0, Math.min(1, n));
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function channel(name, { status, score = null, sampleSize = null, derivedSignalCount = 0, factors = {}, notes = [] }) {
  return Object.freeze({
    channel: name,
    source: CHANNEL_SOURCE[name],
    status,
    qualityBand: status === ChannelStatus.PRESENT ? band(score) : QualityBand.INSUFFICIENT,
    qualityScore: status === ChannelStatus.PRESENT ? score : null,
    sampleSize,
    /** Reported for transparency. Deliberately NOT part of the score. */
    derivedSignalCount,
    factors: Object.freeze(factors),
    notes: Object.freeze(notes),
  });
}

/**
 * Assembles Conquest's evidence-quality picture.
 *
 * Every argument is optional: a missing channel becomes UNAVAILABLE rather
 * than silently absent, so a reader can tell "we could not look" from "we
 * looked and found little".
 *
 * @param {object} [observations] result of observeMarketBehaviour()
 * @param {object} [regimes]      result of classifyBehaviouralRegimes()
 * @param {object} [analogues]    result of findBehaviouralAnalogues()
 * @param {object} [crowdQuality] result of assessCrowdEvidenceQuality()
 * @param {object} [crowdAttention] result of assessCrowdAttention()
 */
export function assessConquestEvidenceQuality({
  observations = null, regimes = null, analogues = null,
  crowdQuality = null, crowdAttention = null,
} = {}) {
  const channels = [];

  /* ---- MARKET BEHAVIOUR --------------------------------------------- */
  const measuredObservations = observations
    ? [observations.participation, observations.movementMagnitude,
       observations.rangeExpansion, observations.participationRatio]
      .filter(o => o && (o.status === "MEASURED" || o.status === "SMALL_SAMPLE"))
    : [];
  const regimeCount = regimes ? (regimes.regimeIds?.length ?? 0) : 0;

  if (!observations) {
    channels.push(channel(EvidenceChannel.MARKET_BEHAVIOUR, {
      status: ChannelStatus.UNAVAILABLE,
      notes: ["No market observations were supplied."],
    }));
  } else if (measuredObservations.length === 0) {
    channels.push(channel(EvidenceChannel.MARKET_BEHAVIOUR, {
      status: ChannelStatus.UNAVAILABLE, derivedSignalCount: regimeCount,
      notes: ["No market observation could be measured, so market behaviour is unknown rather than ordinary."],
    }));
  } else {
    // Coverage of the four dimensions, and how much history backed them.
    const coverage = measuredObservations.length / 4;
    const sampleSizes = measuredObservations.map(o => o.sampleSize).filter(Number.isFinite);
    const depth = sampleSizes.length ? clamp01(Math.min(...sampleSizes) / 60) : null;
    const factors = { dimensionCoverage: clamp01(coverage), historyDepth: depth };
    channels.push(channel(EvidenceChannel.MARKET_BEHAVIOUR, {
      status: ChannelStatus.PRESENT,
      score: Number(mean(Object.values(factors).filter(v => typeof v === "number")).toFixed(4)),
      sampleSize: sampleSizes.length ? Math.min(...sampleSizes) : null,
      // Four observations plus however many regimes were classified — all
      // from one feed, and none of it adds independence.
      derivedSignalCount: measuredObservations.length + regimeCount,
      factors,
      notes: ["Every signal in this channel derives from one price and volume series; the number of signals does not add independence."],
    }));
  }

  /* ---- HISTORICAL ANALOGUES ----------------------------------------- */
  if (!analogues) {
    channels.push(channel(EvidenceChannel.HISTORICAL_ANALOGUE, {
      status: ChannelStatus.UNAVAILABLE, notes: ["No historical analogue search was supplied."],
    }));
  } else if (analogues.analogueCount === 0) {
    channels.push(channel(EvidenceChannel.HISTORICAL_ANALOGUE, {
      status: ChannelStatus.NONE_OBSERVED, sampleSize: 0,
      notes: ["No comparable historical episodes were found. This is a finding, not a gap."],
    }));
  } else {
    const n = analogues.analogueCount;
    const factors = { episodeSample: clamp01(n / 12) };
    channels.push(channel(EvidenceChannel.HISTORICAL_ANALOGUE, {
      status: n < 5 ? ChannelStatus.INSUFFICIENT : ChannelStatus.PRESENT,
      score: Number(factors.episodeSample.toFixed(4)),
      sampleSize: n, derivedSignalCount: 1, factors,
      notes: n < 5 ? [`Only ${n} comparable historical episode(s); too few to describe what followed.`]
        : ["Historical analogues read the same price and volume series as market behaviour, so they are not an independent source."],
    }));
  }

  /* ---- DIRECT CROWD -------------------------------------------------- */
  if (!crowdQuality || crowdQuality.directEvidence !== true) {
    channels.push(channel(EvidenceChannel.DIRECT_CROWD, {
      status: ChannelStatus.UNAVAILABLE,
      notes: ["No direct public-crowd evidence. Crowd sentiment and crowd attention are unknown, not neutral."],
    }));
  } else {
    channels.push(channel(EvidenceChannel.DIRECT_CROWD, {
      status: ChannelStatus.PRESENT,
      score: crowdQuality.qualityScore ?? null,
      sampleSize: crowdAttention?.counts?.usable ?? null,
      derivedSignalCount: 1,
      factors: crowdQuality.factors || {},
      notes: ["Genuine crowd evidence is independent of the market-history channels."],
    }));
  }

  /* ---- INDEPENDENCE -------------------------------------------------- */
  // The count that matters: how many genuinely different FEEDS contributed,
  // not how many signals were computed from them.
  const present = channels.filter(c => c.status === ChannelStatus.PRESENT);
  const independentSources = [...new Set(present.map(c => c.source))];
  const derivedSignalTotal = channels.reduce((a, c) => a + c.derivedSignalCount, 0);

  const overallScore = present.length
    ? Number(mean(independentSources.map(src => {
        // One score per SOURCE: several channels on one feed are averaged,
        // never summed, so a second calculation cannot raise the total.
        const onSource = present.filter(c => c.source === src && typeof c.qualityScore === "number");
        return onSource.length ? mean(onSource.map(c => c.qualityScore)) : 0;
      })).toFixed(4))
    : null;

  return Object.freeze({
    channels: Object.freeze(channels),
    /** Genuinely different feeds that contributed evidence. */
    independentSourceCount: independentSources.length,
    independentSources: Object.freeze(independentSources),
    /** How much was computed. Transparency only; never scored. */
    derivedSignalCount: derivedSignalTotal,
    overallQualityScore: overallScore,
    overallQualityBand: band(overallScore),
    missingChannels: Object.freeze(
      channels.filter(c => c.status === ChannelStatus.UNAVAILABLE).map(c => c.channel)),
    limitations: Object.freeze([
      "Evidence quality describes how much trustworthy evidence Conquest holds. Several signals derived from one feed count as one source, not several.",
      "Quality bands are provisional and have not been calibrated.",
    ]),
  });
}

export { distinctSources };
