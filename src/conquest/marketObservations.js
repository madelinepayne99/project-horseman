import { isProvisionalBar } from "../utils/marketSession.js";
import { CorrelationGroup } from "../schema/provenance.js";
import { EvidenceOrigin } from "../schema/crowd.js";
import { makeEpistemicFinding, EpistemicLayer, FindingSubject } from "../schema/epistemics.js";

/**
 * BEHAVIOURAL CONQUEST — MARKET OBSERVATIONS
 *
 * STATUS: INERT. Nothing imports this yet.
 *
 * CONQUEST OBSERVES BEHAVIOUR. HE DOESN'T PRETEND TO KNOW PEOPLE'S
 * INTENTIONS.
 *
 * ---------------------------------------------------------------------
 * OBSERVATIONS, NOT INTERPRETATIONS
 * ---------------------------------------------------------------------
 * Everything here is measurement: how unusual is current participation and
 * movement RELATIVE TO THIS ASSET'S OWN HISTORY. Nothing in this module
 * classifies a regime, names a behaviour, or claims a motive. Every emitted
 * finding is constructed through the locked epistemic factory as
 * OBSERVED_MARKET_BEHAVIOUR / OBSERVATION / MARKET, so an intent claim is
 * a construction error rather than an editorial slip.
 *
 * `volumePercentile: 84` means "current activity sits at the 84th
 * percentile of this asset's own prior activity". It does NOT mean buyers
 * are enthusiastic, sellers are panicking, or anyone is accumulating.
 * Volume is participation, not intent.
 *
 * ---------------------------------------------------------------------
 * WHY THIS IS NOT WAR 2.0
 * ---------------------------------------------------------------------
 * It reads the normalised OHLCV series DIRECTLY and never touches
 * warFactsV2, War's RSI, its moving averages or its direction. It computes
 * no indicator, no level, no trend call. War asks what the market is doing;
 * this asks how unusual today's participation and movement are for this
 * asset. Shared raw data, different question.
 *
 * Movement is measured as ABSOLUTE magnitude, so a +6% day and a -6% day
 * are behaviourally identical here. That is what keeps the layer
 * non-directional by construction rather than by promise.
 */

/* ------------------------------------------------------------------ */
/* GATING — approved Constitution values                               */
/* ------------------------------------------------------------------ */

export const HISTORY_GATES = Object.freeze({
  /** Below this, no percentile is reported at all. */
  INSUFFICIENT_BELOW: 5,
  /** 5–7 comparisons are reported but flagged as a small sample. */
  SMALL_SAMPLE_BELOW: 8,
});

export const ObservationStatus = Object.freeze({
  MEASURED: "MEASURED",
  SMALL_SAMPLE: "SMALL_SAMPLE",
  INSUFFICIENT_HISTORY: "INSUFFICIENT_HISTORY",
  /** The input needed was absent or unusable. Never neutral. */
  UNAVAILABLE: "UNAVAILABLE",
  /** Deliberately withheld because comparing it would mislead. */
  SUPPRESSED_PROVISIONAL: "SUPPRESSED_PROVISIONAL",
});

/**
 * Windows for the participation-ratio statistic: a working week against a
 * working month. These define WHAT IS MEASURED, not how it is judged — no
 * classification threshold exists in this layer.
 */
export const PARTICIPATION_WINDOWS = Object.freeze({ RECENT: 5, BASELINE: 20 });

/**
 * Movement magnitude here is a SINGLE-session measurement. Declaring the
 * horizon keeps it from being treated as the same phenomenon as a
 * multi-session cumulative move, which is a different measurement that can
 * point the other way entirely.
 */
export const MOVEMENT_HORIZON = Object.freeze({ unit: "SESSIONS", length: 1, baselineLength: null });

/**
 * The participation ratio is a COMPARISON: a recent window against a
 * baseline window. Declaring both is the only truthful representation —
 * stamping either 5 or 20 alone would misdescribe the measurement, and a
 * 10-vs-60 comparison is not the same measurement even though both
 * describe participation change.
 */
export const PARTICIPATION_CHANGE_HORIZON = Object.freeze({
  unit: "SESSIONS", length: 5, baselineLength: 20,
});

/* ------------------------------------------------------------------ */
/* PERCENTILE                                                          */
/* ------------------------------------------------------------------ */

/**
 * Mid-rank percentile of `value` within `population`.
 *
 *   percentile = (countBelow + 0.5 x countEqual) / n x 100
 *
 * The half-credit for ties is the deterministic convention chosen here: it
 * is symmetric, so a value equal to every member of a flat population
 * scores 50 rather than 0 or 100, both of which would misrepresent an
 * unremarkable reading as extreme. Returns null for an empty population.
 */
export function midRankPercentile(value, population) {
  if (!Array.isArray(population) || population.length === 0) return null;
  if (!Number.isFinite(value)) return null;
  let below = 0, equal = 0;
  for (const v of population) {
    if (!Number.isFinite(v)) continue;
    if (v < value) below++;
    else if (v === value) equal++;
  }
  const n = population.filter(Number.isFinite).length;
  if (n === 0) return null;
  // Rounded to a whole percentile: finer precision would be false given
  // sample sizes of a few hundred bars at most.
  return Math.round(((below + 0.5 * equal) / n) * 100);
}

function statusForSample(n) {
  if (n < HISTORY_GATES.INSUFFICIENT_BELOW) return ObservationStatus.INSUFFICIENT_HISTORY;
  if (n < HISTORY_GATES.SMALL_SAMPLE_BELOW) return ObservationStatus.SMALL_SAMPLE;
  return ObservationStatus.MEASURED;
}

const isMeasured = s => s === ObservationStatus.MEASURED || s === ObservationStatus.SMALL_SAMPLE;

/* ------------------------------------------------------------------ */
/* DERIVED SERIES                                                      */
/* ------------------------------------------------------------------ */

/** Close-to-close absolute return, in percent. Direction discarded. */
function absoluteReturnsPct(points) {
  const out = [];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1].close, cur = points[i].close;
    if (!Number.isFinite(prev) || !Number.isFinite(cur) || prev === 0) { out.push(null); continue; }
    out.push(Math.abs((cur - prev) / prev) * 100);
  }
  return out;
}

/**
 * Session range normalised by the session's own close, in percent:
 *
 *   range% = (high - low) / close x 100
 *
 * Normalising by price level is what makes the comparison meaningful over
 * years of history: a $2 range on a $20 stock and a $20 range on a $200
 * stock are the same behaviour, and a raw dollar comparison would call the
 * second one extraordinary purely because the price rose.
 */
function normalisedRangesPct(points) {
  return points.map(p => {
    if (!Number.isFinite(p.high) || !Number.isFinite(p.low) || !Number.isFinite(p.close) || p.close === 0) return null;
    if (p.high < p.low) return null;
    return ((p.high - p.low) / p.close) * 100;
  });
}

const finite = arr => arr.filter(v => Number.isFinite(v));

/* ------------------------------------------------------------------ */
/* OBSERVATION ENTRIES                                                 */
/* ------------------------------------------------------------------ */

function entry({ id, status, value = null, percentile = null, sampleSize = 0, statement, correlationGroup, detail = null, horizon = null }) {
  const measured = isMeasured(status);
  return Object.freeze({
    id, status, value, percentile, sampleSize,
    // A finding is only constructed when something was actually observed.
    // An unmeasured observation stays explicitly unmeasured; it never
    // becomes a neutral reading.
    finding: measured
      ? makeEpistemicFinding({
          origin: EvidenceOrigin.OBSERVED_MARKET_BEHAVIOUR,
          layer: EpistemicLayer.OBSERVATION,
          subject: FindingSubject.MARKET,
          id, statement, correlationGroup, horizon,
          detail: detail || { value, percentile, sampleSize, status },
        })
      : null,
    statement: measured ? statement : null,
  });
}

/**
 * Measures participation, movement magnitude, range and participation trend
 * for the latest bar against this asset's own earlier history.
 *
 * NO FUTURE LEAKAGE: every comparison population is drawn strictly from
 * observations EARLIER than the one being measured.
 *
 * @param {object} series normalised OHLCV series (schema/ohlcv.js)
 * @param {object} [options]
 * @param {Date}   [options.now] injected clock, for provisional-bar detection
 */
export function observeMarketBehaviour(series, { now = new Date() } = {}) {
  const points = Array.isArray(series?.points) ? series.points : [];
  const marketMeta = series?.market || series?.meta || null;
  const limitations = [
    "These are measurements of how unusual current participation and movement are for this asset. They describe behaviour, not motive, and are not directional.",
  ];

  const unavailable = (id, correlationGroup) =>
    entry({ id, status: ObservationStatus.UNAVAILABLE, statement: null, correlationGroup });

  if (points.length < 2) {
    limitations.push("The market history supplied was too short to measure anything.");
    return buildResult({
      participation: unavailable("PARTICIPATION_PERCENTILE", CorrelationGroup.MARKET_PARTICIPATION),
      movementMagnitude: unavailable("MOVEMENT_MAGNITUDE_PERCENTILE", CorrelationGroup.MARKET_ACCELERATION),
      rangeExpansion: unavailable("RANGE_PERCENTILE", CorrelationGroup.MARKET_RANGE),
      participationRatio: unavailable("PARTICIPATION_RATIO", CorrelationGroup.MARKET_PARTICIPATION),
      limitations, provisional: false,
    });
  }

  const latest = points[points.length - 1];
  const provisional = isProvisionalBar(latest, marketMeta, now) === true;

  /* ---- 1. PARTICIPATION ------------------------------------------- */
  // A part-formed session's volume compared against settled full sessions
  // would read as unusually low purely because the day is not over. The
  // observation is therefore withheld rather than reported misleadingly.
  let participation;
  if (provisional) {
    participation = entry({
      id: "PARTICIPATION_PERCENTILE", status: ObservationStatus.SUPPRESSED_PROVISIONAL,
      statement: null, correlationGroup: CorrelationGroup.MARKET_PARTICIPATION,
    });
    limitations.push("The latest session is still open, so its volume was not compared against settled sessions: a part-formed bar would read as unusually quiet.");
  } else if (!Number.isFinite(latest.volume) || latest.volume <= 0) {
    participation = unavailable("PARTICIPATION_PERCENTILE", CorrelationGroup.MARKET_PARTICIPATION);
    limitations.push("Volume was unavailable or zero for the latest session, so participation could not be measured.");
  } else {
    const history = finite(points.slice(0, -1).map(p => p.volume)).filter(v => v > 0);
    const status = statusForSample(history.length);
    const pct = isMeasured(status) ? midRankPercentile(latest.volume, history) : null;
    participation = entry({
      id: "PARTICIPATION_PERCENTILE", status, value: latest.volume, percentile: pct,
      sampleSize: history.length, correlationGroup: CorrelationGroup.MARKET_PARTICIPATION,
      statement: pct === null ? null
        : `Trading activity is at the ${pct}th percentile of this asset's own prior ${history.length} sessions.`,
    });
  }

  /* ---- 2. MOVEMENT MAGNITUDE --------------------------------------- */
  // Absolute magnitude only: a rise and a fall of equal size are the same
  // behavioural observation. Current price is semantically valid even on a
  // provisional bar — the price is real, it simply is not final — so unlike
  // volume this is measured rather than suppressed, and flagged instead.
  const absReturns = absoluteReturnsPct(points);
  const latestMove = absReturns[absReturns.length - 1];
  let movementMagnitude;
  if (!Number.isFinite(latestMove)) {
    movementMagnitude = unavailable("MOVEMENT_MAGNITUDE_PERCENTILE", CorrelationGroup.MARKET_ACCELERATION);
    limitations.push("The latest close-to-close movement could not be computed.");
  } else {
    const history = finite(absReturns.slice(0, -1));
    const status = statusForSample(history.length);
    const pct = isMeasured(status) ? midRankPercentile(latestMove, history) : null;
    movementMagnitude = entry({
      id: "MOVEMENT_MAGNITUDE_PERCENTILE", status, value: Number(latestMove.toFixed(4)), percentile: pct,
      sampleSize: history.length, correlationGroup: CorrelationGroup.MARKET_ACCELERATION,
      horizon: MOVEMENT_HORIZON,
      statement: pct === null ? null
        : `Price movement of ${latestMove.toFixed(2)}% over one session is at the ${pct}th percentile of this asset's own prior ${history.length} sessions, measured by magnitude only.`,
    });
    if (provisional) limitations.push("The latest session is still open, so its movement is measured from a price that is current but not final.");
  }

  /* ---- 3. RANGE ---------------------------------------------------- */
  const ranges = normalisedRangesPct(points);
  const latestRange = ranges[ranges.length - 1];
  let rangeExpansion;
  if (!Number.isFinite(latestRange)) {
    rangeExpansion = unavailable("RANGE_PERCENTILE", CorrelationGroup.MARKET_RANGE);
    limitations.push("The latest session's range could not be computed.");
  } else {
    const history = finite(ranges.slice(0, -1));
    const status = statusForSample(history.length);
    const pct = isMeasured(status) ? midRankPercentile(latestRange, history) : null;
    rangeExpansion = entry({
      id: "RANGE_PERCENTILE", status, value: Number(latestRange.toFixed(4)), percentile: pct,
      sampleSize: history.length, correlationGroup: CorrelationGroup.MARKET_RANGE,
      statement: pct === null ? null
        : `The session's trading range of ${latestRange.toFixed(2)}% of price is at the ${pct}th percentile of this asset's own prior ${history.length} sessions.`,
    });
  }

  /* ---- 4. PARTICIPATION RATIO -------------------------------------- */
  // A MEASUREMENT, not a classification. It reports recent activity against
  // a baseline and stops there. Whether a ratio of 1.3 means participation
  // is "increasing" is a behavioural judgement, and judging it here would
  // need a threshold this layer has no evidence to justify. The later
  // interpretation layer owns that decision; Step 3 only measures.
  const settled = provisional ? points.slice(0, -1) : points;
  const volumes = settled.map(p => p.volume);
  const recent = finite(volumes.slice(-PARTICIPATION_WINDOWS.RECENT)).filter(v => v > 0);
  const baseline = finite(
    volumes.slice(-(PARTICIPATION_WINDOWS.RECENT + PARTICIPATION_WINDOWS.BASELINE), -PARTICIPATION_WINDOWS.RECENT)
  ).filter(v => v > 0);

  let participationRatio;
  if (recent.length < PARTICIPATION_WINDOWS.RECENT || baseline.length < HISTORY_GATES.SMALL_SAMPLE_BELOW) {
    participationRatio = entry({
      id: "PARTICIPATION_RATIO", status: ObservationStatus.INSUFFICIENT_HISTORY,
      sampleSize: baseline.length, statement: null,
      correlationGroup: CorrelationGroup.MARKET_PARTICIPATION_CHANGE,
      horizon: PARTICIPATION_CHANGE_HORIZON,
    });
  } else {
    const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
    const recentMean = mean(recent), baselineMean = mean(baseline);
    const ratio = recentMean / baselineMean;
    participationRatio = entry({
      id: "PARTICIPATION_RATIO", status: ObservationStatus.MEASURED,
      value: Number(ratio.toFixed(4)), sampleSize: baseline.length,
      // CHANGE, not LEVEL. Sharing MARKET_PARTICIPATION with the
      // participation percentile would have let today's volume level and a
      // multi-session change in participation count as one phenomenon, so
      // one could silently suppress the other. They are different facts.
      correlationGroup: CorrelationGroup.MARKET_PARTICIPATION_CHANGE,
      horizon: PARTICIPATION_CHANGE_HORIZON,
      statement: `Activity over the last ${recent.length} sessions averaged ${ratio.toFixed(2)}x its average over the preceding ${baseline.length}.`,
      detail: {
        ratio: Number(ratio.toFixed(4)),
        recentMean: Number(recentMean.toFixed(2)), baselineMean: Number(baselineMean.toFixed(2)),
        recentSessions: recent.length, baselineSessions: baseline.length,
      },
    });
  }

  return buildResult({ participation, movementMagnitude, rangeExpansion, participationRatio, limitations, provisional });
}

function buildResult({ participation, movementMagnitude, rangeExpansion, participationRatio, limitations, provisional }) {
  const observations = [participation, movementMagnitude, rangeExpansion, participationRatio];
  return Object.freeze({
    participation, movementMagnitude, rangeExpansion, participationRatio,
    observations: Object.freeze(observations),
    /** Epistemic findings for whatever was genuinely measured. */
    findings: Object.freeze(observations.map(o => o.finding).filter(Boolean)),
    latestBarProvisional: provisional,
    limitations: Object.freeze(limitations),
  });
}
