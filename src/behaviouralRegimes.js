import { CorrelationGroup } from "../schema/provenance.js";
import { EvidenceOrigin } from "../schema/crowd.js";
import {
  makeEpistemicFinding, EpistemicLayer, FindingSubject, usesResemblanceLanguage,
} from "../schema/epistemics.js";
import { ObservationStatus, PARTICIPATION_CHANGE_HORIZON } from "./marketObservations.js";

/**
 * BEHAVIOURAL CONQUEST — REGIME CLASSIFICATION
 *
 * STATUS: INERT. Nothing imports this yet.
 *
 * CONQUEST OBSERVES BEHAVIOUR. HE DOESN'T PRETEND TO KNOW PEOPLE'S
 * INTENTIONS.
 *
 * Step 3 answered "what did we measure?". This answers "what does that
 * observable behaviour RESEMBLE?" — and nothing further. It does not say
 * why participants acted, what happens next, or whether a trade is wise.
 * Death judges risk; the Council judges the trade.
 *
 * ---------------------------------------------------------------------
 * WHAT THE EVIDENCE DOES AND DOES NOT ALLOW
 * ---------------------------------------------------------------------
 * The locked observation layer emits four things: a participation
 * percentile, an ABSOLUTE one-session movement percentile, a normalised
 * range percentile, and a participation ratio. It deliberately discards
 * the SIGN of the return.
 *
 * Every regime in the Constitution containing ADVANCE, DECLINE or SELLING
 * therefore cannot be built here: they require a direction the evidence
 * does not carry. They are deferred rather than approximated, and no
 * measurement was reverse-engineered to unlock them. Evidence upward, not
 * vocabulary downward.
 *
 * SELLING_SURGE is rejected on a stronger ground than availability: even
 * with a sign, a falling price on heavy volume does not establish
 * seller-initiated trade. Every trade has both sides, and OHLCV records no
 * initiation. The label would claim something the data cannot show.
 */

export const BehaviouralRegime = Object.freeze({
  /** Participation, movement and range all subdued for this asset. */
  QUIET: "QUIET",
  /** Both participation and movement unusually high for this asset. */
  ELEVATED_ACTIVITY: "ELEVATED_ACTIVITY",
  /** The same, at a markedly higher intensity. */
  EXTREME_ACTIVITY: "EXTREME_ACTIVITY",
  /** Recent participation materially below its own recent baseline. */
  FADING_PARTICIPATION: "FADING_PARTICIPATION",
  /**
   * Recent participation materially above its own recent baseline.
   *
   * The epistemic counterpart of FADING_PARTICIPATION. Leaving the
   * dimension one-sided would have meant Conquest could report activity
   * falling but never rising — a structural negative bias that has nothing
   * to do with the evidence.
   */
  RISING_PARTICIPATION: "RISING_PARTICIPATION",
  /** Evidence exists but supports no regime. NOT a neutral market reading. */
  UNKNOWN: "UNKNOWN",
  /** Too little history to classify. NOT a neutral market reading. */
  INSUFFICIENT_HISTORY: "INSUFFICIENT_HISTORY",
});

/**
 * ALL THRESHOLDS ARE PROVISIONAL AND UNCALIBRATED.
 *
 * They are percentile boundaries on the asset's OWN history, which is what
 * keeps them asset-relative rather than universal claims about markets.
 * They were chosen as round, defensible boundaries — a quarter of sessions
 * at each tail, a top-fifth for "unusual", a top-twentieth for "extreme" —
 * and NOT tuned to make any fixture pass. They have not been validated
 * against outcomes and must not be described as though they had been.
 */
export const REGIME_THRESHOLDS = Object.freeze({
  calibrated: false,

  QUIET_MAX_PERCENTILE: 25,        // participation, movement AND range all at or below
  ELEVATED_MIN_PERCENTILE: 80,     // participation AND movement both at or above
  EXTREME_MIN_PERCENTILE: 95,      // the same, markedly higher

  /**
   * MULTIPLICATIVE SYMMETRY.
   *
   * The participation ratio is multiplicative, so its natural symmetry is
   * reciprocal, not additive. A naive pairing of 0.70 with 1.30 would be
   * biased: on a log scale |ln(0.70)| = 0.357 but |ln(1.30)| = 0.262, so
   * "rising" would trigger on a materially SMALLER change than "fading" —
   * exactly the one-sidedness this pairing exists to remove.
   *
   * Both boundaries are therefore derived from ONE constant so they can
   * never drift apart:
   *
   *   FADING_MAX_RATIO   = 1 / MATERIAL_CHANGE_FACTOR = 0.70
   *   RISING_MIN_RATIO   =     MATERIAL_CHANGE_FACTOR ≈ 1.4286
   *
   * and |ln(0.70)| = |ln(1.4286)| exactly.
   *
   * The 0.70 boundary itself is preserved from Step 4 and remains an
   * uncalibrated judgement, not a validated figure.
   */
  MATERIAL_CHANGE_FACTOR: 1 / 0.7,
  FADING_MAX_RATIO: 0.7,
  RISING_MIN_RATIO: 1 / 0.7,
});

/** Observation ids this module consumes. Used to validate what it was given. */
export const REQUIRED_OBSERVATIONS = Object.freeze({
  [BehaviouralRegime.QUIET]: Object.freeze(["PARTICIPATION_PERCENTILE", "MOVEMENT_MAGNITUDE_PERCENTILE", "RANGE_PERCENTILE"]),
  [BehaviouralRegime.ELEVATED_ACTIVITY]: Object.freeze(["PARTICIPATION_PERCENTILE", "MOVEMENT_MAGNITUDE_PERCENTILE"]),
  [BehaviouralRegime.EXTREME_ACTIVITY]: Object.freeze(["PARTICIPATION_PERCENTILE", "MOVEMENT_MAGNITUDE_PERCENTILE"]),
  [BehaviouralRegime.FADING_PARTICIPATION]: Object.freeze(["PARTICIPATION_RATIO"]),
  [BehaviouralRegime.RISING_PARTICIPATION]: Object.freeze(["PARTICIPATION_RATIO"]),
});

/**
 * Regimes named in the Constitution that are NOT implemented, with the
 * reason, so the gap is inspectable rather than silently absent.
 */
export const DEFERRED_REGIMES = Object.freeze({
  ADVANCE_ON_RISING_PARTICIPATION: "Requires the sign of the return; the observation layer measures movement magnitude only.",
  DECLINE_ON_RISING_PARTICIPATION: "Requires the sign of the return; the observation layer measures movement magnitude only.",
  SHARP_DECLINE_ON_HIGH_PARTICIPATION: "Requires the sign of the return.",
  RAPID_DECLINE_PARTICIPATION_SURGE: "Requires the sign of the return.",
  ACCELERATION_WITH_EXPANDING_PARTICIPATION: "Requires an acceleration measurement (rate of change of movement), which was deliberately deferred in Step 3.",
  EXTREME_ACCELERATION: "Requires an acceleration measurement, which was deliberately deferred in Step 3.",
  SELLING_SURGE: "Rejected as defined: OHLCV records no trade initiation, so heavy volume on a falling price does not establish seller-initiated activity.",
});

const measured = o => o && (o.status === ObservationStatus.MEASURED || o.status === ObservationStatus.SMALL_SAMPLE);
const pct = o => (measured(o) && Number.isFinite(o.percentile) ? o.percentile : null);

function interpretation({ id, statement, basedOn, correlationGroup = null, composite = false, detail = null, horizon = null }) {
  const finding = makeEpistemicFinding({
    origin: EvidenceOrigin.OBSERVED_MARKET_BEHAVIOUR,
    layer: EpistemicLayer.BEHAVIOURAL_INTERPRETATION,
    subject: FindingSubject.MARKET,
    id, statement, basedOn, correlationGroup, composite, detail, horizon,
  });
  // Structural safety is origin/layer/subject/basedOn above; this is an
  // additional check that the wording keeps interpretation distinguishable
  // from observation, never the mechanism relied upon.
  if (!usesResemblanceLanguage(statement)) {
    throw new Error(`Interpretation ${id} must be phrased as resemblance, not asserted as fact.`);
  }
  return Object.freeze({ regime: id, statement, basedOn: finding.basedOn, finding, detail });
}

/**
 * Classifies behavioural regimes from the locked Step 3 observations.
 *
 * Contradictory evidence produces NO regime rather than a forced label:
 * a quiet-volume session with an extreme price move is neither QUIET nor
 * ELEVATED, and saying either would be dishonest.
 *
 * @param {object} observations result of observeMarketBehaviour()
 */
export function classifyBehaviouralRegimes(observations) {
  const limitations = [
    "Behavioural regimes describe what observable market activity resembles. They do not explain why participants acted, predict what follows, or judge whether a trade is wise.",
    "Regime thresholds are provisional percentile boundaries on this asset's own history and have not been calibrated against outcomes.",
  ];

  const participation = observations?.participation;
  const movement = observations?.movementMagnitude;
  const range = observations?.rangeExpansion;
  const ratio = observations?.participationRatio;

  if (!observations || (!participation && !movement && !range && !ratio)) {
    return build({ status: BehaviouralRegime.UNKNOWN, regimes: [],
      limitations: [...limitations, "No behavioural observations were supplied, so no regime could be assessed."] });
  }

  // Insufficient history is a distinct state, never a quiet market.
  const anyInsufficient = [participation, movement, range]
    .some(o => o && o.status === ObservationStatus.INSUFFICIENT_HISTORY);
  const noneMeasured = ![participation, movement, range, ratio].some(measured);
  if (noneMeasured) {
    return build({
      status: anyInsufficient ? BehaviouralRegime.INSUFFICIENT_HISTORY : BehaviouralRegime.UNKNOWN,
      regimes: [],
      limitations: [...limitations, anyInsufficient
        ? "There is too little history to classify behaviour. This is not evidence that behaviour is ordinary."
        : "The observations needed to classify behaviour were unavailable. This is not evidence that behaviour is ordinary."],
    });
  }

  const pParticipation = pct(participation);
  const pMovement = pct(movement);
  const pRange = pct(range);
  const T = REGIME_THRESHOLDS;
  const regimes = [];

  /* ---- ACTIVITY LEVEL: needs the whole declared combination ---------- */
  // Participation alone is never enough. A low-volume session with an
  // extreme price move is not a quiet market, and treating it as one would
  // be exactly the kind of convenient half-truth this layer exists to avoid.
  const activityAvailable = pParticipation !== null && pMovement !== null;

  if (pParticipation === null && participation?.status === ObservationStatus.SUPPRESSED_PROVISIONAL) {
    limitations.push("The latest session is still open, so its participation was not measured and no activity-level regime could be assessed.");
  }

  if (activityAvailable && pRange !== null
      && pParticipation <= T.QUIET_MAX_PERCENTILE
      && pMovement <= T.QUIET_MAX_PERCENTILE
      && pRange <= T.QUIET_MAX_PERCENTILE) {
    regimes.push(interpretation({
      id: BehaviouralRegime.QUIET,
      statement: `Activity, movement and trading range are all at or below the ${T.QUIET_MAX_PERCENTILE}th percentile for this asset, which resembles a quiet behavioural regime.`,
      basedOn: REQUIRED_OBSERVATIONS[BehaviouralRegime.QUIET],
      // Combines three distinct phenomena, so it is genuinely composite and
      // claims no single correlation group.
      composite: true,
      detail: { participationPercentile: pParticipation, movementPercentile: pMovement, rangePercentile: pRange },
    }));
  } else if (activityAvailable
      && pParticipation >= T.EXTREME_MIN_PERCENTILE && pMovement >= T.EXTREME_MIN_PERCENTILE) {
    regimes.push(interpretation({
      id: BehaviouralRegime.EXTREME_ACTIVITY,
      statement: `Both participation and price movement are at or above the ${T.EXTREME_MIN_PERCENTILE}th percentile for this asset, which is consistent with unusually intense market activity.`,
      basedOn: REQUIRED_OBSERVATIONS[BehaviouralRegime.EXTREME_ACTIVITY],
      composite: true,
      detail: { participationPercentile: pParticipation, movementPercentile: pMovement },
    }));
  } else if (activityAvailable
      && pParticipation >= T.ELEVATED_MIN_PERCENTILE && pMovement >= T.ELEVATED_MIN_PERCENTILE) {
    regimes.push(interpretation({
      id: BehaviouralRegime.ELEVATED_ACTIVITY,
      statement: `Both participation and price movement are at or above the ${T.ELEVATED_MIN_PERCENTILE}th percentile for this asset, which resembles a period of heightened activity.`,
      basedOn: REQUIRED_OBSERVATIONS[BehaviouralRegime.ELEVATED_ACTIVITY],
      composite: true,
      detail: { participationPercentile: pParticipation, movementPercentile: pMovement },
    }));
  }

  /* ---- PARTICIPATION RATIO ------------------------------------------ */
  // Orthogonal to the activity level: it compares recent participation with
  // its own baseline rather than with the asset's full history, so it may
  // legitimately co-occur with any activity regime.
  // NOT composite: this rests on ONE observation describing ONE phenomenon
  // (participation change). Composite means a conclusion drawn from several
  // DIFFERENT phenomena, as War's direction is. The two windows are internal
  // to the measurement and are declared in the horizon, so another finding
  // about the same participation change correlates correctly rather than
  // earning false independence.
  const participationChange = { correlationGroup: CorrelationGroup.MARKET_PARTICIPATION_CHANGE,
    composite: false, horizon: PARTICIPATION_CHANGE_HORIZON };

  if (measured(ratio) && Number.isFinite(ratio.value) && ratio.value <= T.FADING_MAX_RATIO) {
    regimes.push(interpretation({
      id: BehaviouralRegime.FADING_PARTICIPATION,
      statement: `Recent activity is ${ratio.value.toFixed(2)}x its preceding baseline, which resembles fading participation.`,
      basedOn: REQUIRED_OBSERVATIONS[BehaviouralRegime.FADING_PARTICIPATION],
      ...participationChange,
      detail: { ratio: ratio.value },
    }));
    limitations.push("Fading participation means fewer people are trading than recently. It does not indicate selling, loss of interest, weakness, or what happens next.");
  } else if (measured(ratio) && Number.isFinite(ratio.value) && ratio.value >= T.RISING_MIN_RATIO) {
    regimes.push(interpretation({
      id: BehaviouralRegime.RISING_PARTICIPATION,
      statement: `Recent activity is ${ratio.value.toFixed(2)}x its preceding baseline, which resembles rising participation.`,
      basedOn: REQUIRED_OBSERVATIONS[BehaviouralRegime.RISING_PARTICIPATION],
      ...participationChange,
      detail: { ratio: ratio.value },
    }));
    limitations.push("Rising participation means more people are trading than recently. It does not indicate buying, enthusiasm, accumulation, or what happens next.");
  }

  const status = regimes.length ? "CLASSIFIED"
    : (anyInsufficient ? BehaviouralRegime.INSUFFICIENT_HISTORY : BehaviouralRegime.UNKNOWN);

  if (!regimes.length && status === BehaviouralRegime.UNKNOWN) {
    limitations.push("The observed measurements did not resemble any regime this layer can honestly name.");
  }

  return build({ status, regimes, limitations });
}

function build({ status, regimes, limitations }) {
  return Object.freeze({
    status,
    /** The regimes observed. May be empty; may contain more than one. */
    regimes: Object.freeze(regimes),
    regimeIds: Object.freeze(regimes.map(r => r.regime)),
    findings: Object.freeze(regimes.map(r => r.finding)),
    deferredRegimes: DEFERRED_REGIMES,
    thresholds: REGIME_THRESHOLDS,
    limitations: Object.freeze(limitations),
  });
}
