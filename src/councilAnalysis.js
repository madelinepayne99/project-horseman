import { Direction, EXPECTED_HORSEMEN } from "./councilInput.js";
import {
  groupByCorrelation, EvidenceSource, isIndependenceEligible, assessProvenanceIntegrity,
} from "../schema/provenance.js";

/**
 * COUNCIL V2 — JUDGMENT
 *
 * STATUS: INERT. Nothing imports this yet.
 *
 * Council reasons across three separate questions and never collapses them:
 *
 *   1. What does the available evidence say?      -> directional score
 *   2. How complete and reliable is that evidence? -> evidence strength
 *   3. What is the strongest unresolved objection? -> Death's challenge
 *
 * It is not majority voting, not an average of Horseman percentages, and
 * not a probability of profit. Council confidence answers only: how
 * strongly does the available evidence support THIS assessment?
 *
 * ---------------------------------------------------------------------
 * THE GUARANTEE THAT ABSTENTION CANNOT HELP
 * ---------------------------------------------------------------------
 * Every quality weight is divided by the number of EXPECTED Horsemen, not
 * the number that answered. So a Horseman falling silent removes its
 * weight from the numerator while the denominator stays fixed — evidence
 * strength can only fall. Legacy Council averaged over responders, which
 * is why dropping a weak Horseman could raise its confidence by 8 points.
 * That is now impossible by construction, not by intention.
 *
 * ALL THRESHOLDS BELOW ARE PROVISIONAL AND UNVALIDATED. They are reasoned
 * from the decision they support, not calibrated against outcomes.
 */

export const Verdict = Object.freeze({
  REJECT: "REJECT",
  WATCH: "WATCH",
  WAIT: "WAIT",
  FAVOURABLE: "FAVOURABLE",
  STRONG: "STRONG",
  EXCEPTIONAL: "EXCEPTIONAL",
});

/** Provisional, uncalibrated. Every value is inspectable and testable. */
export const COUNCIL_THRESHOLDS = Object.freeze({
  calibrated: false,

  // Directional score bands (-1..+1), computed from quality-weighted stances.
  BEARISH_REJECT: -0.4,
  BALANCED_BAND: 0.2,          // |score| below this is genuinely balanced
  FAVOURABLE_SCORE: 0.35,
  STRONG_SCORE: 0.6,
  EXCEPTIONAL_SCORE: 0.8,

  // Evidence strength floors (0..1). Nothing positive is claimed below these.
  MIN_EVIDENCE_FOR_DIRECTION: 0.35,
  FAVOURABLE_EVIDENCE: 0.5,
  STRONG_EVIDENCE: 0.68,
  EXCEPTIONAL_EVIDENCE: 0.85,

  // Quality weight used when a Horseman reports no quality information at
  // all. Deliberately low: unquantified evidence is not strong evidence,
  // and must never score as though it were complete.
  WEIGHT_WITHOUT_QUALITY_INFO: 0.25,

  // Freshness multipliers applied to a Horseman's quality weight.
  FRESHNESS: Object.freeze({ CURRENT: 1, fresh: 1, AGEING: 0.8, STALE: 0.5, stale: 0.5, UNKNOWN: 0.7 }),

  // How much a Death challenge discounts confidence, scaled by how well
  // evidenced that challenge is.
  DEATH_SEVERITY_FACTOR: Object.freeze({ SEVERE: 0.6, HIGH: 0.72, MODERATE: 0.88, LOW: 0.95, NONE_OBSERVED: 1, UNKNOWN: 0.9 }),
  DEATH_CONFIDENCE_WEIGHT: Object.freeze({ STRONG: 1, MODERATE: 0.6, WEAK: 0.3, INSUFFICIENT: 0.2, UNKNOWN: 0.3 }),

  // Absence of observed risk is only reassuring to the extent that Death
  // could actually look. Without this, a Death that checked nothing scored
  // identically to a Death that checked everything and found nothing clean —
  // the same "missing becomes safe" failure this project exists to remove.
  UNVERIFIED_REASSURANCE_DISCOUNT: 0.15,

  // Per-item penalties, jointly capped so bookkeeping cannot dominate.
  INTERNAL_DISAGREEMENT_PENALTY: 0.03,
  MISSING_EVIDENCE_PENALTY: 0.02,
  MAX_PENALTY: 0.25,
});

/** Severities that constitute a MATERIAL unresolved challenge. */
const MATERIAL_SEVERITIES = new Set(["HIGH", "SEVERE"]);
/** Death evidence-confidence bands strong enough to make a challenge binding. */
const SUPPORTED_CONFIDENCE = new Set(["MODERATE", "STRONG"]);

const STANCE_VALUE = { [Direction.BULLISH]: 1, [Direction.BEARISH]: -1, [Direction.NEUTRAL]: 0 };

/**
 * A Horseman's quality weight (0..1): how much its stance should count.
 * Built only from factors it actually reported. A Horseman reporting no
 * quality information receives WEIGHT_WITHOUT_QUALITY_INFO rather than a
 * default of 1 — missing factors must never become perfect scores.
 */
function qualityWeight(h) {
  const factors = [];
  if (h.evidenceConfidence !== null) factors.push(Math.max(0, Math.min(1, h.evidenceConfidence / 100)));
  if (h.completeness !== null) factors.push(Math.max(0, Math.min(1, h.completeness)));

  const base = factors.length
    ? factors.reduce((a, v) => a + v, 0) / factors.length
    : COUNCIL_THRESHOLDS.WEIGHT_WITHOUT_QUALITY_INFO;

  const freshness = COUNCIL_THRESHOLDS.FRESHNESS[h.freshnessStatus] ?? COUNCIL_THRESHOLDS.FRESHNESS.UNKNOWN;
  return Number((base * freshness).toFixed(4));
}

/**
 * Directional evidence: quality-weighted, NOT a vote count.
 * A high-quality bearish Horseman can outweigh a weak bullish one, and an
 * abstention contributes nothing at all.
 */
function directionalEvidence(input) {
  const contributions = EXPECTED_HORSEMEN.map(name => {
    const h = input.horsemen[name];
    const weight = h.participated ? qualityWeight(h) : 0;
    const stance = h.participated ? STANCE_VALUE[h.direction] : null;
    return Object.freeze({
      horseman: name, direction: h.direction, participated: h.participated,
      weight, stance,
      contribution: h.participated ? Number((weight * stance).toFixed(4)) : 0,
      // Carried through so correlation grouping can judge independence from
      // DECLARED provenance rather than from the Horseman's name.
      provenance: h.directionalProvenance,
    });
  });

  const participating = contributions.filter(c => c.participated);

  // ---- CORRELATION: one phenomenon, one contribution -------------------
  // Two Horsemen describing the SAME phenomenon from the SAME kind of
  // source are one piece of evidence, not two confirmations. Each group
  // contributes once, at its strongest member's weight — never the sum —
  // so Council cannot gain confidence from duplicated evidence.
  //
  // Independence is judged from declared provenance, so War's chart
  // structure and a genuine crowd reading remain independent even when
  // they describe the same move. No new threshold is introduced: this is a
  // set operation on declared facts.
  const correlationGroups = groupByCorrelation(participating, (a, b) => b.weight - a.weight);
  const effective = correlationGroups.map(g => g.representative);
  const suppressed = participating.filter(c => !effective.includes(c));

  // Undeclared provenance earns no independence benefit. The stance is kept
  // and remains visible; what is withheld is coverage credit, so a Horseman
  // that forgets to declare cannot silently recreate double-counting.
  const integrity = assessProvenanceIntegrity(participating, c => c.horseman);

  const totalWeight = effective.reduce((a, c) => a + c.weight, 0);
  const score = totalWeight > 0
    ? Number((effective.reduce((a, c) => a + c.contribution, 0) / totalWeight).toFixed(4))
    : 0;

  const bullWeight = effective.filter(c => c.stance === 1).reduce((a, c) => a + c.weight, 0);
  const bearWeight = effective.filter(c => c.stance === -1).reduce((a, c) => a + c.weight, 0);
  const directionalWeight = bullWeight + bearWeight;
  // 0 = one-sided, 1 = evenly opposed. Weighted, so a strong Horseman
  // disagreeing matters more than a weak one.
  const disagreementIndex = directionalWeight > 0
    ? Number((2 * Math.min(bullWeight, bearWeight) / directionalWeight).toFixed(4))
    : 0;

  return Object.freeze({
    score, contributions: Object.freeze(contributions),
    // Inspectable correlation handling for the case file / debug output.
    correlation: Object.freeze({
      groups: Object.freeze(correlationGroups.map(g => Object.freeze({
        source: g.source, correlationGroup: g.correlationGroup,
        horsemen: Object.freeze(g.members.map(m => m.horseman)),
        countedOnce: g.correlated,
      }))),
      independentContributors: effective.filter(c => isIndependenceEligible(c.provenance)).length,
      provenanceIntegrity: integrity,
      suppressedForCorrelation: Object.freeze(suppressed.map(c => c.horseman)),
      hasCorrelatedEvidence: suppressed.length > 0,
    }),
    bullWeight: Number(bullWeight.toFixed(4)), bearWeight: Number(bearWeight.toFixed(4)),
    disagreementIndex,
    hasDirectionalConflict: bullWeight > 0 && bearWeight > 0,
  });
}

/**
 * Evidence strength (0..1): quality-weighted coverage.
 * Divided by EXPECTED Horsemen, so silence always costs.
 */
function evidenceStrength(input, evidence) {
  // Two exclusions, both about EARNED coverage:
  //   - correlated contributors count once, so duplicated evidence cannot
  //     raise coverage any more than it raises the directional score;
  //   - undeclared contributors count for nothing, because evidence of
  //     unknown origin cannot be shown to be independent.
  const counted = new Set(evidence.correlation.groups.flatMap(g => g.horsemen.slice(0, 1)));
  const total = evidence.contributions
    .filter(c => c.participated && counted.has(c.horseman) && isIndependenceEligible(c.provenance))
    .reduce((a, c) => a + c.weight, 0);
  return Number((total / EXPECTED_HORSEMEN.length).toFixed(4));
}

function deathFactors(death) {
  const severityFactor = COUNCIL_THRESHOLDS.DEATH_SEVERITY_FACTOR[death.riskSeverity]
    ?? COUNCIL_THRESHOLDS.DEATH_SEVERITY_FACTOR.UNKNOWN;
  const confidenceWeight = COUNCIL_THRESHOLDS.DEATH_CONFIDENCE_WEIGHT[death.evidenceConfidence]
    ?? COUNCIL_THRESHOLDS.DEATH_CONFIDENCE_WEIGHT.UNKNOWN;
  // A severe challenge on thin evidence discounts less than the same
  // challenge on strong evidence — severity and support are separate.
  const severityAdjusted = 1 - (1 - severityFactor) * confidenceWeight;

  // Where Death reports little or no observed risk, that reassurance is
  // discounted by how well evidenced Death's own assessment was.
  const reassuranceIsUnverified = ["NONE_OBSERVED", "LOW", "UNKNOWN"].includes(death.riskSeverity);
  const reassuranceFactor = reassuranceIsUnverified
    ? 1 - (1 - confidenceWeight) * COUNCIL_THRESHOLDS.UNVERIFIED_REASSURANCE_DISCOUNT
    : 1;

  const factor = severityAdjusted * reassuranceFactor;
  const material = MATERIAL_SEVERITIES.has(death.riskSeverity)
    && SUPPORTED_CONFIDENCE.has(death.evidenceConfidence)
    && !!(death.strongestChallenge && death.strongestChallenge.hasObservedChallenge);
  return {
    severityFactor, confidenceWeight,
    severityAdjusted: Number(severityAdjusted.toFixed(4)),
    reassuranceFactor: Number(reassuranceFactor.toFixed(4)),
    factor: Number(factor.toFixed(4)), material,
  };
}

export function councilAnalysis(input) {
  const evidence = directionalEvidence(input);
  const strength = evidenceStrength(input, evidence);
  const death = deathFactors(input.death);

  const internalDisagreementCount = EXPECTED_HORSEMEN
    .reduce((a, n) => a + input.horsemen[n].internalDisagreement.length, 0)
    + input.death.disagreement.length;
  const missingEvidenceCount = EXPECTED_HORSEMEN
    .reduce((a, n) => a + input.horsemen[n].missingEvidence.length, 0)
    + input.death.missingEvidence.length;

  const penalty = Math.min(COUNCIL_THRESHOLDS.MAX_PENALTY,
    internalDisagreementCount * COUNCIL_THRESHOLDS.INTERNAL_DISAGREEMENT_PENALTY
    + missingEvidenceCount * COUNCIL_THRESHOLDS.MISSING_EVIDENCE_PENALTY);

  const agreementFactor = Number((1 - 0.5 * evidence.disagreementIndex).toFixed(4));

  const factors = Object.freeze({
    evidenceStrength: strength,
    agreementFactor,
    deathFactor: death.factor,
    penalty: Number(penalty.toFixed(4)),
    internalDisagreementCount,
    missingEvidenceCount,
    participationRatio: input.coverage.participationRatio,
  });

  // Confidence is computed BEFORE the verdict, and the verdict is selected
  // from this same final value — so the two can never derive from different
  // states, which legacy Council allowed when the conflict penalty landed
  // after verdict selection.
  const confidenceScore = Number(Math.max(0, Math.min(1,
    strength * agreementFactor * death.factor - penalty)).toFixed(4));
  const confidence = Math.round(confidenceScore * 100);

  const verdictResult = selectVerdict({ input, evidence, strength, death, confidenceScore });

  return Object.freeze({
    assetId: input.assetId,
    assetType: input.assetType,
    verdict: verdictResult.verdict,
    confidence,
    confidenceScore,
    factors,
    coverage: input.coverage,
    provenanceIntegrity: evidence.correlation.provenanceIntegrity,
    directional: evidence,
    deathChallenge: Object.freeze({
      riskSeverity: input.death.riskSeverity,
      evidenceConfidence: input.death.evidenceConfidence,
      material: death.material,
      statement: input.death.strongestChallenge ? input.death.strongestChallenge.statement : null,
      findingId: input.death.strongestChallenge ? input.death.strongestChallenge.findingId : null,
      observedRiskCount: input.death.observedRisks.length,
      missingEvidenceCount: input.death.missingEvidence.length,
      uncertaintyCount: input.death.uncertainty.length,
    }),
    proceededDespiteDeathChallenge: verdictResult.proceededDespiteDeathChallenge,
    strongestSupportingCase: strongestCase(input, evidence, "strongestSupporting"),
    strongestOpposingCase: strongestCase(input, evidence, "strongestOpposing"),
    whatWouldChangeMind: whatWouldChangeMind(input, evidence, death),
    verdictReasons: verdictResult.reasons,
    limitations: Object.freeze([
      "Council confidence describes how strongly the available evidence supports this assessment. It is not a probability that the trade will make money.",
      "Council judges the Horsemen's evidence; it does not gather evidence of its own.",
      "All Council thresholds are provisional and have not been calibrated against outcomes.",
    ]),
  });
}

/**
 * Verdict semantics, evaluated in order:
 *
 *   REJECT       evidence materially points against, with enough of it to say so
 *   WAIT         the case may be interesting, but evidence is too incomplete,
 *                stale or unresolved to act — waiting is materially safer
 *   WATCH        evidence is genuinely balanced, and adequately covered
 *   FAVOURABLE   evidence points for, with adequate strength
 *   STRONG       as FAVOURABLE, with high strength and no material challenge
 *   EXCEPTIONAL  unusually strong, complete, unanimous, unchallenged
 *
 * WAIT is a first-class outcome, not a fallback: it is what "promising but
 * unproven" should produce. WATCH is reserved for genuinely balanced
 * evidence, so it does not become the bucket for everything unclassified.
 */
function selectVerdict({ input, evidence, strength, death, confidenceScore }) {
  const T = COUNCIL_THRESHOLDS;
  const reasons = [];
  let proceededDespiteDeathChallenge = null;

  const enoughEvidence = strength >= T.MIN_EVIDENCE_FOR_DIRECTION;
  const stale = EXPECTED_HORSEMEN.some(n => /stale/i.test(input.horsemen[n].freshnessStatus));
  const incomplete = input.coverage.abstained.length > 0
    || EXPECTED_HORSEMEN.some(n => input.horsemen[n].completeness !== null && input.horsemen[n].completeness < 1);

  // --- REJECT ---
  if (evidence.score <= T.BEARISH_REJECT && enoughEvidence) {
    reasons.push(`Weighted evidence points against at ${evidence.score.toFixed(2)} with evidence strength ${strength.toFixed(2)}.`);
    return { verdict: Verdict.REJECT, reasons: Object.freeze(reasons), proceededDespiteDeathChallenge };
  }

  // --- Not enough evidence to claim anything positive ---
  if (!enoughEvidence) {
    reasons.push(`Evidence strength ${strength.toFixed(2)} is below the ${T.MIN_EVIDENCE_FOR_DIRECTION} floor required to draw a directional conclusion.`);
    if (input.coverage.abstained.length) reasons.push(`${input.coverage.abstained.join(", ")} could not reach a conclusion.`);
    // Promising direction but unusable evidence is WAIT, not WATCH.
    return { verdict: evidence.score > 0 ? Verdict.WAIT : Verdict.WATCH, reasons: Object.freeze(reasons), proceededDespiteDeathChallenge };
  }

  // --- Genuinely balanced evidence ---
  if (Math.abs(evidence.score) < T.BALANCED_BAND) {
    reasons.push(`Weighted evidence is balanced at ${evidence.score.toFixed(2)}.`);
    if (evidence.hasDirectionalConflict) reasons.push(`Horsemen conflict directly (disagreement index ${evidence.disagreementIndex.toFixed(2)}).`);
    return { verdict: Verdict.WATCH, reasons: Object.freeze(reasons), proceededDespiteDeathChallenge };
  }

  // --- Positive territory, but is the case actionable yet? ---
  if (evidence.score >= T.BALANCED_BAND && evidence.score < T.FAVOURABLE_SCORE) {
    reasons.push(`Weighted evidence leans positive at ${evidence.score.toFixed(2)} but does not reach the ${T.FAVOURABLE_SCORE} threshold.`);
    return { verdict: Verdict.WAIT, reasons: Object.freeze(reasons), proceededDespiteDeathChallenge };
  }
  if (evidence.score < 0) {
    reasons.push(`Weighted evidence leans negative at ${evidence.score.toFixed(2)} without reaching the rejection threshold.`);
    return { verdict: Verdict.WATCH, reasons: Object.freeze(reasons), proceededDespiteDeathChallenge };
  }

  // --- FAVOURABLE and above ---
  if (strength < T.FAVOURABLE_EVIDENCE) {
    reasons.push(`Direction is positive at ${evidence.score.toFixed(2)}, but evidence strength ${strength.toFixed(2)} is below the ${T.FAVOURABLE_EVIDENCE} required to act on it.`);
    return { verdict: Verdict.WAIT, reasons: Object.freeze(reasons), proceededDespiteDeathChallenge };
  }

  reasons.push(`Weighted evidence supports the case at ${evidence.score.toFixed(2)} with evidence strength ${strength.toFixed(2)}.`);

  // A material, well-supported Death challenge blocks STRONG/EXCEPTIONAL
  // outright. Death is not a veto — FAVOURABLE remains reachable — but
  // proceeding must be declared, with a reason built from actual figures.
  if (death.material) {
    proceededDespiteDeathChallenge = Object.freeze({
      severity: input.death.riskSeverity,
      deathEvidenceConfidence: input.death.evidenceConfidence,
      challenge: input.death.strongestChallenge ? input.death.strongestChallenge.statement : null,
      findingId: input.death.strongestChallenge ? input.death.strongestChallenge.findingId : null,
      // Derived from the computed state, never fabricated prose.
      basis: `Directional evidence ${evidence.score.toFixed(2)} at strength ${strength.toFixed(2)} was judged to outweigh a ${input.death.riskSeverity} challenge supported by ${input.death.evidenceConfidence} evidence.`,
    });
    reasons.push(`A ${input.death.riskSeverity} unresolved challenge remains, so no verdict above FAVOURABLE is available.`);
    return { verdict: Verdict.FAVOURABLE, reasons: Object.freeze(reasons), proceededDespiteDeathChallenge };
  }

  // --- EXCEPTIONAL: unusually strong, complete, unanimous, unchallenged ---
  const noObservedRisk = input.death.observedRisks.length === 0;
  const unanimous = evidence.contributions.every(c => c.participated && c.stance === 1);
  if (evidence.score >= T.EXCEPTIONAL_SCORE && strength >= T.EXCEPTIONAL_EVIDENCE
      && !incomplete && !stale && unanimous && noObservedRisk
      && input.death.evidenceConfidence === "STRONG") {
    reasons.push("Evidence is complete, current, unanimous and unchallenged.");
    return { verdict: Verdict.EXCEPTIONAL, reasons: Object.freeze(reasons), proceededDespiteDeathChallenge };
  }

  // --- STRONG ---
  if (evidence.score >= T.STRONG_SCORE && strength >= T.STRONG_EVIDENCE && !stale) {
    reasons.push("Evidence strength and agreement are high with no material unresolved challenge.");
    return { verdict: Verdict.STRONG, reasons: Object.freeze(reasons), proceededDespiteDeathChallenge };
  }

  return { verdict: Verdict.FAVOURABLE, reasons: Object.freeze(reasons), proceededDespiteDeathChallenge };
}

/**
 * The strongest case for or against, taken from whichever contributing
 * Horseman carried the most weight. Never fabricated — when no Horseman
 * supplied structured evidence, that is stated.
 */
function strongestCase(input, evidence, key) {
  const candidates = EXPECTED_HORSEMEN
    .map(name => ({ name, h: input.horsemen[name], weight: evidence.contributions.find(c => c.horseman === name).weight }))
    .filter(c => c.h[key].length > 0)
    .sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name));

  if (!candidates.length) {
    return Object.freeze({ available: false, source: null, claims: Object.freeze([]),
      statement: "No Horseman supplied structured evidence on this side." });
  }
  const top = candidates[0];
  const claims = top.h[key].map(c => (typeof c === "string" ? c : c.claim || c.detail || JSON.stringify(c)));
  return Object.freeze({
    available: true, source: top.name, weight: top.weight,
    claims: Object.freeze(claims),
    statement: claims[0],
  });
}

/**
 * Derived entirely from unresolved conditions actually present. Legacy
 * Council returned one constant sentence for every asset and every
 * verdict; this returns a different list depending on what is genuinely
 * unresolved, and an explicit note when nothing is.
 */
function whatWouldChangeMind(input, evidence, death) {
  const items = [];

  for (const name of input.coverage.abstained) {
    items.push(`A directional conclusion from ${name}, which could not reach one on this evidence.`);
  }
  for (const name of EXPECTED_HORSEMEN) {
    const h = input.horsemen[name];
    if (h.completeness !== null && h.completeness < 1) {
      items.push(`More complete ${name} evidence (currently ${Math.round(h.completeness * 100)}%).`);
    }
    if (/stale/i.test(h.freshnessStatus)) {
      items.push(`Fresher ${name} evidence; the current evidence is stale.`);
    }
    if (h.internalDisagreement.length) {
      items.push(`Resolution of ${name}'s internal disagreement (${h.internalDisagreement.length} item(s)).`);
    }
  }
  if (death.material && input.death.strongestChallenge) {
    items.push(`Resolution of Death's ${input.death.riskSeverity} challenge: ${input.death.strongestChallenge.statement}`);
  }
  for (const u of input.death.uncertainty) {
    if (u && u.detail) items.push(`Resolution of an open question: ${u.detail}`);
  }
  if (evidence.hasDirectionalConflict) {
    items.push("Agreement between the Horsemen that currently point in opposite directions.");
  }

  if (!items.length) {
    items.push("New price action, company results, verified news, or a material new risk.");
  }
  // De-duplicate deterministically while preserving order.
  return Object.freeze([...new Set(items)]);
}
