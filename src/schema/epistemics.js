import { EvidenceOrigin } from "./crowd.js";
import { makeProvenance, EvidenceSource, CorrelationGroup } from "./provenance.js";

/**
 * HORSEMAN — EPISTEMIC LAYER SCHEMA
 *
 * STATUS: INERT. Nothing computes behavioural signals yet.
 *
 * CONQUEST OBSERVES BEHAVIOUR. HE DOESN'T PRETEND TO KNOW PEOPLE'S
 * INTENTIONS.
 *
 * ---------------------------------------------------------------------
 * WHAT THIS PREVENTS
 * ---------------------------------------------------------------------
 * Three statements that are NOT equivalent:
 *
 *   "Price movement and participation are unusually high for this stock."
 *      -> OBSERVATION, and OHLCV supports it.
 *   "The move resembles chasing behaviour."
 *      -> BEHAVIOURAL_INTERPRETATION, which OHLCV may cautiously support
 *         when it names the observations it rests on.
 *   "Investors are buying because of FOMO."
 *      -> INTENT, which OHLCV can NEVER support. Price and volume record
 *         what happened, not who acted or why.
 *
 * The drift from the first to the third is gradual and easy to make one
 * plausible sentence at a time. This module makes it a construction error
 * rather than an editorial judgement: the forbidden combination throws.
 *
 * ---------------------------------------------------------------------
 * THIS IS NOT A SECOND PROVENANCE SYSTEM
 * ---------------------------------------------------------------------
 * It reuses both existing vocabularies rather than competing with them:
 *
 *   EvidenceOrigin (schema/crowd.js)  WHAT KIND of evidence this is
 *   EvidenceSource (schema/provenance.js) WHICH FEED it came from, used by
 *                                     the locked correlation contract
 *
 * The two are related but answer different questions, so every finding
 * built here derives its EvidenceSource from its EvidenceOrigin through
 * one mapping (ORIGIN_TO_SOURCE) — there is exactly one correlation system,
 * and it is the locked one.
 *
 * On `derivedFrom`: it is deliberately NOT introduced as a field. Its role
 * — "what kind of source does this rest on" — is already carried by
 * `provenance.source`. Adding it would duplicate the locked contract.
 * `basedOn` remains distinct and necessary: it names the concrete
 * observations an interpretation is built from.
 */

/** Closed vocabulary. Anything outside it is rejected at construction. */
export const EpistemicLayer = Object.freeze({
  /** Directly measurable or literally observed. */
  OBSERVATION: "OBSERVATION",
  /** A cautious reading of one or more observations. Must cite them. */
  BEHAVIOURAL_INTERPRETATION: "BEHAVIOURAL_INTERPRETATION",
  /**
   * A claim about expressed participant motive or psychology.
   *
   * Named INTENT, matching the Constitution's "INTENT / CAUSATION" layer;
   * causation claims belong here too. Strongly gated — see LAYER_PERMISSIONS.
   */
  INTENT: "INTENT",
});

/**
 * What a finding is ABOUT. Prevents a second drift the layer alone cannot
 * catch: market data being used to describe the crowd, or a pasted message
 * being used to describe the market.
 */
export const FindingSubject = Object.freeze({
  MARKET: "MARKET",
  CROWD: "CROWD",
  SUPPLIED_MESSAGE: "SUPPLIED_MESSAGE",
});

/**
 * Which layers each origin may reach, and what it may speak about.
 *
 * OBSERVED_MARKET_BEHAVIOUR — observations and cautious interpretations
 *   about the MARKET. Never intent; never the crowd's state of mind.
 * OBSERVED_CROWD — may reach INTENT, but only for what the sampled
 *   evidence literally shows ("FOMO language is present in the sampled
 *   posts"), never a claim about the wider market.
 * USER_SUPPLIED_CLAIM — may only describe the SUPPLIED MESSAGE. It proves
 *   nothing about the market, the crowd, or the truth of the claim.
 */
export const LAYER_PERMISSIONS = Object.freeze({
  [EvidenceOrigin.OBSERVED_MARKET_BEHAVIOUR]: Object.freeze({
    layers: Object.freeze([EpistemicLayer.OBSERVATION, EpistemicLayer.BEHAVIOURAL_INTERPRETATION]),
    subjects: Object.freeze([FindingSubject.MARKET]),
  }),
  [EvidenceOrigin.OBSERVED_CROWD]: Object.freeze({
    layers: Object.freeze([
      EpistemicLayer.OBSERVATION, EpistemicLayer.BEHAVIOURAL_INTERPRETATION, EpistemicLayer.INTENT]),
    subjects: Object.freeze([FindingSubject.CROWD]),
  }),
  [EvidenceOrigin.USER_SUPPLIED_CLAIM]: Object.freeze({
    layers: Object.freeze([EpistemicLayer.OBSERVATION, EpistemicLayer.BEHAVIOURAL_INTERPRETATION]),
    subjects: Object.freeze([FindingSubject.SUPPLIED_MESSAGE]),
  }),
});

/** One mapping into the locked correlation vocabulary. */
export const ORIGIN_TO_SOURCE = Object.freeze({
  [EvidenceOrigin.OBSERVED_MARKET_BEHAVIOUR]: EvidenceSource.MARKET_HISTORY,
  [EvidenceOrigin.OBSERVED_CROWD]: EvidenceSource.CROWD_FEED,
  [EvidenceOrigin.USER_SUPPLIED_CLAIM]: EvidenceSource.USER_CLAIM,
});

/** Language required when a statement exceeds literal observation. */
export const RESEMBLANCE_MARKERS = /\bresembles?\b|\bis consistent with\b|\bhas the shape of\b|\blooks like\b/i;

export class EpistemicViolation extends Error {
  constructor(message) { super(message); this.name = "EpistemicViolation"; }
}

/**
 * The only sanctioned way to construct a Conquest finding.
 *
 * Origin and layer are established here and validated against
 * LAYER_PERMISSIONS, so a caller cannot relabel a user's pasted tip as
 * crowd evidence to gain epistemic privileges, and cannot derive intent
 * from a price series. Violations throw — deterministically, not as a
 * warning, and not left to UI wording.
 *
 * @param {object} args
 * @param {string} args.origin   an EvidenceOrigin member
 * @param {string} args.layer    an EpistemicLayer member
 * @param {string} args.subject  a FindingSubject member
 * @param {string} args.id       stable identifier
 * @param {string} args.statement the finding itself
 * @param {string[]} args.basedOn ids of the observations it rests on
 * @param {string} args.correlationGroup phenomenon key, where applicable
 * @param {object} args.horizon measurement window, e.g. { unit: "SESSIONS", length: 1 }
 */
export function makeEpistemicFinding({
  origin, layer, subject, id, statement,
  basedOn = [], correlationGroup = null, composite = false, detail = null, horizon = null,
} = {}) {
  const permitted = LAYER_PERMISSIONS[origin];
  if (!permitted) {
    throw new EpistemicViolation(
      `Unknown evidence origin "${origin}". Permitted: ${Object.keys(LAYER_PERMISSIONS).join(", ")}.`);
  }
  if (!Object.values(EpistemicLayer).includes(layer)) {
    throw new EpistemicViolation(
      `Unknown epistemic layer "${layer}". Permitted: ${Object.values(EpistemicLayer).join(", ")}.`);
  }
  if (!permitted.layers.includes(layer)) {
    throw new EpistemicViolation(
      `${origin} may not produce a ${layer} finding. ` +
      (layer === EpistemicLayer.INTENT
        ? "Intent requires direct evidence that literally expresses it."
        : `Permitted layers: ${permitted.layers.join(", ")}.`));
  }
  if (!permitted.subjects.includes(subject)) {
    throw new EpistemicViolation(
      `${origin} may only describe ${permitted.subjects.join(", ")}, not ${subject}.`);
  }
  if (!id || typeof id !== "string") throw new EpistemicViolation("A finding requires a stable id.");
  if (!statement || typeof statement !== "string") {
    throw new EpistemicViolation("A finding requires a statement.");
  }

  const observations = Array.isArray(basedOn) ? basedOn.filter(x => typeof x === "string" && x.trim()) : [];

  // An interpretation that cites nothing is not cautious, it is assertion.
  if (layer === EpistemicLayer.BEHAVIOURAL_INTERPRETATION && observations.length === 0) {
    throw new EpistemicViolation(
      `A ${EpistemicLayer.BEHAVIOURAL_INTERPRETATION} must name the observations it is based on (basedOn).`);
  }

  return Object.freeze({
    id,
    origin,
    layer,
    subject,
    statement,
    detail,
    /** Concrete observations supporting this finding. */
    basedOn: Object.freeze(observations),
    /** The LOCKED correlation contract, derived from the origin. */
    // `horizon` is forwarded so a finding can declare the measurement
    // window its phenomenon belongs to — see provenance.sameHorizon().
    provenance: makeProvenance(
      ORIGIN_TO_SOURCE[origin], correlationGroup, observations, { composite, horizon }),
  });
}

/**
 * True when an interpretation uses evidence-honest resemblance language.
 * Exposed for the behavioural modules to assert against; not enforced at
 * construction, because a statement may legitimately be phrased in ways a
 * regular expression cannot anticipate.
 */
export function usesResemblanceLanguage(statement) {
  return RESEMBLANCE_MARKERS.test(String(statement || ""));
}

export { EvidenceOrigin, EvidenceSource, CorrelationGroup };
