import { observeMarketBehaviour, ObservationStatus, HISTORY_GATES } from "./marketObservations.js";
import { classifyBehaviouralRegimes, BehaviouralRegime } from "./behaviouralRegimes.js";
import { EvidenceOrigin } from "../schema/crowd.js";
import { EvidenceSource, CorrelationGroup } from "../schema/provenance.js";
import { makeEpistemicFinding, EpistemicLayer, FindingSubject } from "../schema/epistemics.js";

/**
 * BEHAVIOURAL CONQUEST — HISTORICAL ANALOGUES
 *
 * STATUS: INERT. Nothing imports this yet.
 *
 * CONQUEST OBSERVES BEHAVIOUR. HE DOESN'T PRETEND TO KNOW PEOPLE'S
 * INTENTIONS.
 *
 * The question: when this asset previously showed genuinely comparable
 * observable behaviour, what behaviour followed?
 *
 * That is a DESCRIPTION OF THE PAST, not a forecast. This module reports
 * no expected return, no win rate, no probability of a price move, and no
 * bullish or bearish reading. Turning "6 of 9 comparable episodes settled
 * within a week" into "this will probably settle" is precisely the step it
 * refuses to take.
 *
 * ---------------------------------------------------------------------
 * ANTI-LEAKAGE: PREFIX RECONSTRUCTION
 * ---------------------------------------------------------------------
 * A candidate at index t is described by replaying the LOCKED Step 3 and
 * Step 4 machinery over `points[0..t]` only. Nothing after t can reach its
 * percentiles, its ratio, its regime, its eligibility or its similarity —
 * not because the code is careful, but because the later bars are not in
 * the array it is given.
 *
 * Computing percentiles once over the whole series and indexing into them
 * would have been far faster and quietly wrong: today's extreme session
 * would change where a candidate from two years ago ranked. Correctness
 * first, as instructed.
 *
 * Future bars are read ONLY after a candidate has been accepted, and only
 * to describe what behaviour followed.
 */

/**
 * ALL CONSTANTS PROVISIONAL AND UNCALIBRATED.
 * None was chosen by looking at outcomes — that would be fitting the
 * similarity rule to the answer it is supposed to describe.
 */
export const ANALOGUE_CONSTANTS = Object.freeze({
  calibrated: false,

  /** Mean normalised distance at or below which a candidate is comparable. */
  SIMILARITY_TOLERANCE: 0.15,

  /** Dimensions that must be genuinely comparable on both sides. */
  MIN_COMPARED_DIMENSIONS: 3,

  /**
   * Bars a candidate needs behind it before Step 3 can describe it at all:
   * the participation ratio needs 5 recent + 20 baseline sessions.
   */
  MIN_FEATURE_HISTORY_BARS: 26,

  /**
   * How many CONSECUTIVE non-matching sessions constitute a genuine return
   * to different behaviour, ending an episode.
   *
   * This replaces a fixed minimum gap between analogues. A gap is arbitrary:
   * it asks "how far apart must two analogues be?", which has no answer in
   * the evidence. The right question is "did the behaviour actually end and
   * begin again?", and that IS answerable — an episode continues while the
   * asset keeps exhibiting comparable behaviour, and ends when it stops.
   *
   * A one- or two-session interruption inside an otherwise continuous
   * elevated period is a fluctuation, not the end of the episode; three
   * consecutive sessions of materially different behaviour is a genuine
   * resolution. That is the only judgement in this parameter, and it is a
   * judgement about behavioural continuity rather than about how many
   * analogues we would like to have.
   */
  EPISODE_BREAK_SESSIONS: 3,

  /**
   * The participation ratio is multiplicative, so distance is measured on a
   * log scale and normalised by ln(3): a threefold change in either
   * direction is treated as a full unit of difference.
   */
  RATIO_LOG_SCALE: Math.log(3),

  /** Outcome horizons in sessions. Small and explicit. */
  OUTCOME_HORIZONS: Object.freeze([1, 5, 20]),
});

/** Sample gating reuses the locked Step 3 values (5 / 8). */
export const SampleStatus = Object.freeze({
  INSUFFICIENT_ANALOGUES: "INSUFFICIENT_ANALOGUES",
  SMALL_SAMPLE: "SMALL_SAMPLE",
  MEASURED: "MEASURED",
});

function sampleStatus(n) {
  if (n < HISTORY_GATES.INSUFFICIENT_BELOW) return SampleStatus.INSUFFICIENT_ANALOGUES;
  if (n < HISTORY_GATES.SMALL_SAMPLE_BELOW) return SampleStatus.SMALL_SAMPLE;
  return SampleStatus.MEASURED;
}

const usable = o => o && (o.status === ObservationStatus.MEASURED || o.status === ObservationStatus.SMALL_SAMPLE);

/**
 * Describes the behaviour at index t using ONLY points[0..t].
 *
 * The clock is set well after that session's close so the historical bar is
 * never treated as provisional — a live-clock comparison would make every
 * reconstruction depend on when the analysis happened to run.
 */
export function describeBehaviourAt(series, index) {
  const points = Array.isArray(series?.points) ? series.points : [];
  if (index < 0 || index >= points.length) return null;
  return describeAt(points, index);
}

function describeAt(points, t) {
  const prefix = points.slice(0, t + 1);
  const asOf = new Date((points[t].timestamp || 0) + 36 * 3600 * 1000);
  const observations = observeMarketBehaviour({ ...prefixSeries(points), points: prefix }, { now: asOf });
  const regimes = classifyBehaviouralRegimes(observations);
  return {
    index: t,
    date: points[t].date || null,
    features: featuresOf(observations),
    regimeIds: regimes.regimeIds,
    regimeStatus: regimes.status,
  };
}
function prefixSeries(points) {
  return { market: { exchangeTimezone: "America/New_York" }, source: { provider: "reconstructed" }, points };
}

/**
 * The four continuous dimensions. A dimension absent for a candidate is
 * `null` and is EXCLUDED from comparison — never substituted with zero,
 * which would read as "identical at the bottom of the range".
 */
function featuresOf(observations) {
  return Object.freeze({
    participationPercentile: usable(observations.participation) ? observations.participation.percentile : null,
    movementPercentile: usable(observations.movementMagnitude) ? observations.movementMagnitude.percentile : null,
    rangePercentile: usable(observations.rangeExpansion) ? observations.rangeExpansion.percentile : null,
    participationRatio: usable(observations.participationRatio) ? observations.participationRatio.value : null,
  });
}

/**
 * Per-dimension normalised distance, 0 (identical) to 1 (opposite ends).
 * Percentiles are already 0–100 and scale directly. The ratio is
 * multiplicative and uses log distance, so 0.5x and 2x are equally far
 * from 1.0 — an absolute difference would treat them as 0.5 and 1.0 apart.
 */
function dimensionDistance(key, a, b) {
  if (a === null || b === null || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (key === "participationRatio") {
    if (a <= 0 || b <= 0) return null;
    return Math.min(1, Math.abs(Math.log(a) - Math.log(b)) / ANALOGUE_CONSTANTS.RATIO_LOG_SCALE);
  }
  return Math.min(1, Math.abs(a - b) / 100);
}

/**
 * Similarity between two feature sets. Deterministic, inspectable, and
 * blind to price direction — every dimension is magnitude or participation.
 *
 * Coverage is enforced BEFORE distance: a candidate comparable on only one
 * or two dimensions is rejected rather than scored on what happens to be
 * present, which would reward missingness with an easy match.
 */
export function compareFeatures(target, candidate, constants = ANALOGUE_CONSTANTS) {
  const keys = ["participationPercentile", "movementPercentile", "rangePercentile", "participationRatio"];
  const compared = [], missing = [], distances = {};

  for (const key of keys) {
    const d = dimensionDistance(key, target[key], candidate[key]);
    if (d === null) { missing.push(key); continue; }
    compared.push(key);
    distances[key] = Number(d.toFixed(4));
  }

  if (compared.length < constants.MIN_COMPARED_DIMENSIONS) {
    return Object.freeze({
      comparable: false, matched: false, distance: null,
      comparedDimensions: Object.freeze(compared), missingDimensions: Object.freeze(missing),
      dimensionDistances: Object.freeze(distances),
      rejectedFor: "INSUFFICIENT_COVERAGE",
    });
  }

  const distance = Number((compared.reduce((a, k) => a + distances[k], 0) / compared.length).toFixed(4));
  return Object.freeze({
    comparable: true,
    matched: distance <= constants.SIMILARITY_TOLERANCE,
    distance,
    comparedDimensions: Object.freeze(compared), missingDimensions: Object.freeze(missing),
    dimensionDistances: Object.freeze(distances),
    rejectedFor: distance <= constants.SIMILARITY_TOLERANCE ? null : "SIMILARITY",
  });
}

/**
 * Finds historical behavioural analogues and describes what behaviour
 * followed them.
 *
 * @param {object} series normalised OHLCV series
 * @param {object} [options]
 * @param {Date}   [options.now] clock for the TARGET observation only
 */
export function findBehaviouralAnalogues(series, { now = new Date(), constants = ANALOGUE_CONSTANTS } = {}) {
  const points = Array.isArray(series?.points) ? series.points : [];
  const limitations = [
    "Historical analogues describe what behaviour followed comparable past conditions. They are not a forecast, and say nothing about future prices or returns.",
    "Similarity thresholds are provisional and have not been calibrated; they were not chosen by reference to outcomes.",
  ];

  const searched = {
    candidatesConsidered: 0, withSufficientFeatureHistory: 0,
    rejectedForCoverage: 0, rejectedForSimilarity: 0,
    matchingSessions: 0, distinctEpisodes: 0, sessionsDeduplicatedIntoEpisodes: 0,
  };

  if (points.length < ANALOGUE_CONSTANTS.MIN_FEATURE_HISTORY_BARS + 2) {
    return build({ status: SampleStatus.INSUFFICIENT_ANALOGUES, analogues: [], searched,
      target: null, horizons: {},
      limitations: [...limitations, "There is too little history to look for comparable behavioural conditions."] });
  }

  const latest = points.length - 1;
  const targetObservations = observeMarketBehaviour(series, { now });
  const target = {
    index: latest, date: points[latest].date || null,
    features: featuresOf(targetObservations),
    regimeIds: classifyBehaviouralRegimes(targetObservations).regimeIds,
  };

  const comparableTargetDims = Object.values(target.features).filter(v => v !== null).length;
  if (comparableTargetDims < ANALOGUE_CONSTANTS.MIN_COMPARED_DIMENSIONS) {
    return build({ status: SampleStatus.INSUFFICIENT_ANALOGUES, analogues: [], searched, target, horizons: {},
      limitations: [...limitations,
        "The current behaviour could not be described on enough dimensions to look for comparable conditions."] });
  }

  /* ---- pass 1: describe every historical session, leakage-safe -------- */
  // Strictly less than `latest`: the target can never match itself.
  const scored = [];
  for (let t = constants.MIN_FEATURE_HISTORY_BARS; t < latest; t++) {
    searched.candidatesConsidered++;
    const candidate = describeAt(points, t);
    const dims = Object.values(candidate.features).filter(v => v !== null).length;
    if (dims === 0) { scored.push({ index: t, matched: false, candidate: null, comparison: null }); continue; }
    searched.withSufficientFeatureHistory++;

    const comparison = compareFeatures(target.features, candidate.features, constants);
    if (!comparison.comparable) { searched.rejectedForCoverage++; }
    else if (!comparison.matched) { searched.rejectedForSimilarity++; }
    scored.push({ index: t, matched: comparison.comparable && comparison.matched, candidate, comparison });
  }
  searched.matchingSessions = scored.filter(s => s.matched).length;

  /* ---- pass 2: segment history into distinct behavioural EPISODES ----- */
  // An analogue must be a distinct behavioural EPISODE, not another
  // timestamp inside one.
  //
  // Continuity is judged against the EPISODE ITSELF, not against the target.
  // That distinction matters: inside a twelve-session elevated run, each
  // session's percentiles drift as the run enters its own history, so
  // sessions in the middle can stop matching the target while the episode
  // is plainly still under way. Judging against the target would split one
  // run into several "analogues" — exactly the failure this replaces.
  //
  // An episode therefore opens when a session matches the target, extends
  // while sessions remain comparable to that episode's anchor, and closes
  // only after the behaviour has genuinely resolved for
  // EPISODE_BREAK_SESSIONS consecutive sessions.
  const episodes = [];
  let current = null;
  let consecutiveResolved = 0;

  for (const s of scored) {
    const inEpisode = current !== null;

    if (!inEpisode) {
      if (s.matched) {
        current = { anchor: s, members: [s], startIndex: s.index, endIndex: s.index, resolvedAtIndex: null };
        consecutiveResolved = 0;
      }
      continue;
    }

    // Is this session still part of the same behavioural period?
    const continues = s.candidate
      ? compareFeatures(current.anchor.candidate.features, s.candidate.features, constants).matched
      : false;

    if (continues) {
      current.members.push(s);
      current.endIndex = s.index;
      consecutiveResolved = 0;
    } else {
      consecutiveResolved++;
      if (consecutiveResolved >= constants.EPISODE_BREAK_SESSIONS) {
        // This session is the LAST bar consulted to establish that the
        // episode had ended. Outcomes must begin strictly after it.
        current.resolvedAtIndex = s.index;
        episodes.push(current); current = null; consecutiveResolved = 0;
      }
    }
  }
  // An episode still open at the end of the available history has not been
  // observed to end, so "what followed it" is undefined. It is retained for
  // inspection but contributes to no outcome horizon.
  if (current !== null) episodes.push(current);

  // Each episode contributes exactly ONE analogue: the session within it
  // that is closest to the target, among those that actually matched the
  // target. Ties resolve to the earliest index so the choice is
  // deterministic.
  const accepted = episodes.map(ep => {
    const eligible = ep.members.filter(m => m.matched);
    const best = eligible.reduce((a, b) =>
      (b.comparison.distance < a.comparison.distance
        || (b.comparison.distance === a.comparison.distance && b.index < a.index)) ? b : a);
    return Object.freeze({
      ...best.candidate,
      comparison: best.comparison,
      episode: Object.freeze({
        startIndex: ep.startIndex,
        /** Last session that was PART of the episode. */
        endIndex: ep.endIndex,
        /** Last session CONSULTED to establish the episode had ended. */
        resolvedAtIndex: ep.resolvedAtIndex,
        resolved: ep.resolvedAtIndex !== null,
        sessionCount: ep.members.length,
        sessionsMatchingTarget: eligible.length,
        spanSessions: ep.endIndex - ep.startIndex + 1,
        /** Session best representing the similarity. NOT the episode end. */
        representativeIndex: best.index,
        /**
         * Where "what followed" begins. Strictly after every bar used to
         * define, extend or resolve the episode — never the representative,
         * which may sit near the episode's start.
         */
        outcomeBaseIndex: ep.resolvedAtIndex,
      }),
    });
  });
  searched.distinctEpisodes = episodes.length;
  searched.sessionsDeduplicatedIntoEpisodes = searched.matchingSessions - episodes.length;

  /* ---- outcomes: future read ONLY after acceptance ------------------- */
  const horizons = {};
  for (const h of constants.OUTCOME_HORIZONS) {
    // Outcomes are anchored on the episode's resolution, NOT on the
    // representative session. Measuring from the representative would let
    // a +5 outcome land inside the very episode that defined the analogue —
    // sessions 40-50 with a representative at 43 would report session 48 as
    // "what followed", which is still the same episode and would inflate
    // apparent persistence.
    //
    // An episode contributes only if it resolved AND its complete
    // post-episode window exists.
    const withOutcome = accepted.filter(c =>
      c.episode.outcomeBaseIndex !== null && c.episode.outcomeBaseIndex + h <= latest);
    const excludedIncomplete = accepted.length - withOutcome.length;
    const excludedUnresolved = accepted.filter(c => c.episode.outcomeBaseIndex === null).length;

    const outcomes = withOutcome.map(c => {
      const outcomeIndex = c.episode.outcomeBaseIndex + h;
      const after = describeAt(points, outcomeIndex);
      return Object.freeze({
        candidateIndex: c.index, candidateDate: c.date,
        episodeStartIndex: c.episode.startIndex, episodeEndIndex: c.episode.endIndex,
        outcomeBaseIndex: c.episode.outcomeBaseIndex,
        outcomeIndex, outcomeDate: after.date,
        regimeIds: after.regimeIds, regimeStatus: after.regimeStatus,
        // Did the candidate's own regimes still hold at the horizon?
        persisted: Object.freeze(c.regimeIds.filter(r => after.regimeIds.includes(r))),
        resolved: Object.freeze(c.regimeIds.filter(r => !after.regimeIds.includes(r))),
      });
    });

    horizons[`+${h}`] = Object.freeze({
      horizonSessions: h,
      analogueCount: outcomes.length,
      status: sampleStatus(outcomes.length),
      excludedForIncompleteOutcome: excludedIncomplete,
      excludedForUnresolvedEpisode: excludedUnresolved,
      // Full distribution, not a summary. Regimes can co-occur, so counts
      // sum to more than the analogue count and that is reported honestly.
      regimeDistribution: distributionOf(outcomes),
      outcomes: Object.freeze(outcomes),
    });
  }

  const overall = sampleStatus(accepted.length);
  // Reporting few episodes is the correct answer when few exist. The
  // deduplication is never relaxed to raise the count: a feature that looks
  // well-evidenced because one episode was counted eight times is worse
  // than one that honestly says three.
  if (overall === SampleStatus.INSUFFICIENT_ANALOGUES) {
    limitations.push(`Limited history: only ${accepted.length} comparable historical episode(s) were found, which is too few to describe what followed.`);
  } else if (overall === SampleStatus.SMALL_SAMPLE) {
    limitations.push(`Limited history: only ${accepted.length} comparable historical episodes were found, which is a small sample.`);
  }
  if (searched.sessionsDeduplicatedIntoEpisodes > 0) {
    limitations.push(`${searched.matchingSessions} individual sessions matched, but they represent ${episodes.length} distinct behavioural episode(s); each episode is counted once.`);
  }

  return build({ status: overall, analogues: accepted, searched, target, horizons, limitations });
}

/**
 * Counts every behavioural state observed at a horizon, including the
 * explicit absence of one. Regimes co-occur, so this is a count per regime
 * rather than a partition — pretending they are mutually exclusive would
 * misrepresent the data.
 */
function distributionOf(outcomes) {
  const counts = {};
  for (const key of Object.values(BehaviouralRegime)) counts[key] = 0;
  for (const o of outcomes) {
    if (o.regimeIds.length === 0) {
      // No regime is not a neutral outcome; it is recorded as what it is.
      counts[o.regimeStatus] = (counts[o.regimeStatus] || 0) + 1;
      continue;
    }
    for (const r of o.regimeIds) counts[r] = (counts[r] || 0) + 1;
  }
  const total = outcomes.length;
  const distribution = {};
  for (const [k, n] of Object.entries(counts)) {
    if (n === 0) continue;
    distribution[k] = Object.freeze({ count: n, percentOfAnalogues: total ? Math.round((n / total) * 100) : 0 });
  }
  return Object.freeze(distribution);
}

/* ------------------------------------------------------------------ */
/* EPISTEMIC FINDINGS                                                  */
/* ------------------------------------------------------------------ */

/**
 * Two findings at two different layers, because they are two different
 * kinds of statement:
 *
 *   OBSERVATION — "N historical conditions met the declared similarity
 *   rule." That is a count, and it is measured.
 *
 *   BEHAVIOURAL_INTERPRETATION — "Current behaviour resembles those
 *   conditions." That is a reading of the count, and it says so.
 *
 * Neither describes what will happen. Both declare MARKET_HISTORY as their
 * source: analogues are a different CALCULATION over the same evidence, not
 * a new evidence source, so they cannot earn independence merely by being
 * produced elsewhere.
 *
 * CORRELATION — corrected after review. These were previously stamped
 * composite, which under the locked contract means "correlates with
 * nothing" — so two findings resting on the same similarity rule would each
 * have counted. But historical resemblance IS one phenomenon, measured from
 * four dimensions, in exactly the way the participation ratio is one
 * phenomenon measured from two windows. They therefore declare
 * MARKET_HISTORICAL_ANALOGUE and are not composite, so any other finding
 * making a historical-resemblance claim correlates with them.
 */
export function analogueFindings(result) {
  if (!result || !result.analogues.length) return Object.freeze([]);

  const n = result.analogues.length;
  const observation = makeEpistemicFinding({
    origin: EvidenceOrigin.OBSERVED_MARKET_BEHAVIOUR,
    layer: EpistemicLayer.OBSERVATION,
    subject: FindingSubject.MARKET,
    id: "HISTORICAL_ANALOGUE_COUNT",
    statement: `${n} distinct behavioural episode(s) in this asset's own history met the declared similarity rule.`,
    correlationGroup: CorrelationGroup.MARKET_HISTORICAL_ANALOGUE,
    detail: { episodeCount: n, matchingSessions: result.search.matchingSessions,
      tolerance: ANALOGUE_CONSTANTS.SIMILARITY_TOLERANCE, status: result.status },
  });

  const interpretation = makeEpistemicFinding({
    origin: EvidenceOrigin.OBSERVED_MARKET_BEHAVIOUR,
    layer: EpistemicLayer.BEHAVIOURAL_INTERPRETATION,
    subject: FindingSubject.MARKET,
    id: "RESEMBLES_HISTORICAL_CONDITIONS",
    statement: `Current observable behaviour resembles ${n} earlier behavioural episode(s) in this asset's own history.`,
    basedOn: ["HISTORICAL_ANALOGUE_COUNT", "PARTICIPATION_PERCENTILE",
      "MOVEMENT_MAGNITUDE_PERCENTILE", "RANGE_PERCENTILE", "PARTICIPATION_RATIO"],
    correlationGroup: CorrelationGroup.MARKET_HISTORICAL_ANALOGUE,
    detail: { episodeCount: n, status: result.status },
  });

  return Object.freeze([observation, interpretation]);
}

/**
 * DIAGNOSTIC ONLY — NOT CALIBRATION.
 *
 * Reports how many distinct episodes would be found at nearby hypothetical
 * tolerances, so the sensitivity of the count is inspectable. It changes no
 * production constant and returns no recommendation: choosing a tolerance
 * by looking at these counts, or at what followed them, would be fitting
 * the similarity rule to the answer it is supposed to describe.
 */
export function inspectToleranceSensitivity(series, tolerances = [0.10, 0.125, 0.15, 0.175, 0.20], { now = new Date() } = {}) {
  const production = ANALOGUE_CONSTANTS.SIMILARITY_TOLERANCE;
  const rows = tolerances.map(tolerance => {
    const patched = Object.freeze({ ...ANALOGUE_CONSTANTS, SIMILARITY_TOLERANCE: tolerance });
    const result = findBehaviouralAnalogues(series, { now, constants: patched });
    return Object.freeze({
      tolerance,
      isProductionValue: tolerance === production,
      matchingSessions: result.search.matchingSessions,
      distinctEpisodes: result.analogueCount,
      status: result.status,
    });
  });
  return Object.freeze({
    productionTolerance: production,
    note: "Diagnostic only. No tolerance was selected using these counts or using what followed them.",
    rows: Object.freeze(rows),
  });
}

function build({ status, analogues, searched, target, horizons, limitations }) {
  return Object.freeze({
    status,
    target: target ? Object.freeze(target) : null,
    analogueCount: analogues.length,
    episodeCount: analogues.length,
    analogues: Object.freeze(analogues),
    horizons: Object.freeze(horizons),
    search: Object.freeze({ ...searched, accepted: analogues.length }),
    method: Object.freeze({
      description: "Each historical candidate is described by replaying the observation and regime layers over that asset's history up to and including that session only.",
      similarity: "Mean normalised distance across the comparable dimensions; percentiles on a 0-100 scale, the participation ratio on a log scale.",
      episodes: "Matching sessions are segmented into distinct behavioural episodes; an episode ends only after the behaviour has genuinely resolved, and each episode contributes exactly one analogue, represented by its closest-matching session.",
      outcomes: "Outcomes are measured from the session at which the episode was established to have resolved, so no bar used to define, extend or resolve an episode can also be reported as what followed it.",
      constants: ANALOGUE_CONSTANTS,
    }),
    limitations: Object.freeze(limitations),
  });
}
