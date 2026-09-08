/**
 * COUNCIL V2 — INPUT CONTRACT
 *
 * STATUS: INERT. Nothing imports this yet.
 *
 * "The Horsemen investigate. The Council judges. The user decides."
 *
 * ---------------------------------------------------------------------
 * THE CENTRAL CORRECTION: UNKNOWN IS NOT NEUTRAL
 * ---------------------------------------------------------------------
 * Legacy Council computed `neutral = 3 - bull - bear`, so a Horseman that
 * could not reach a conclusion cast a neutral VOTE and cost a flat 8
 * confidence points. Worse, once its confidence was filtered out of the
 * average, an abstention could RAISE Council confidence — measured at +8
 * when the silent Horseman would have scored below the mean.
 *
 *   NEUTRAL  the Horseman participated and found genuinely balanced evidence
 *   UNKNOWN  the Horseman could not justify any directional conclusion
 *
 * Here an abstention casts no vote at all. It is recorded as a COVERAGE
 * fact, and coverage can only ever reduce Council's evidence strength —
 * never increase it. See councilAnalysis.js for the mechanism that makes
 * that mathematically guaranteed rather than merely intended.
 *
 * Structured facts only. Horseman prose is never read.
 */

import { makeProvenance, EvidenceSource, CorrelationGroup } from "../schema/provenance.js";

export const AssetType = Object.freeze({ EQUITY: "EQUITY", CRYPTO: "CRYPTO" });

export const Direction = Object.freeze({
  BULLISH: "BULLISH", BEARISH: "BEARISH", NEUTRAL: "NEUTRAL", UNKNOWN: "UNKNOWN",
});

/** The Horsemen Council expects to hear from. Absence is a coverage gap. */
export const EXPECTED_HORSEMEN = Object.freeze(["WAR", "FAMINE", "CONQUEST"]);

function num(v) { return typeof v === "number" && Number.isFinite(v) ? v : null; }
function str(v) { return typeof v === "string" && v.trim() ? v.trim() : null; }
function arr(v) { return Array.isArray(v) ? Object.freeze([...v]) : Object.freeze([]); }

/**
 * A Horseman's DIRECTIONAL evidence provenance. Declared by the adapter,
 * never inferred from the Horseman's name — guessing correlation from
 * identity is exactly what this contract exists to avoid.
 */
function normaliseProvenance(src) {
  const p = src && src.directionalProvenance;
  return makeProvenance(
    p && p.source, p && p.correlationGroup, p && p.basedOn);
}

function normaliseHorseman(name, h) {
  const src = h || {};
  const direction = str(src.direction) || Direction.UNKNOWN;
  const known = [Direction.BULLISH, Direction.BEARISH, Direction.NEUTRAL].includes(direction);

  return Object.freeze({
    name,
    direction: known ? direction : Direction.UNKNOWN,
    // Participation is derived, never supplied: a Horseman participates
    // exactly when it reached a stance it could justify. NEUTRAL counts as
    // participation — it is a genuine finding.
    participated: known,
    // Confidence in THAT Horseman's own evidence. Null when it abstained
    // or never reported one — never defaulted to a number.
    evidenceConfidence: num(src.evidenceConfidence ?? src.confidence),
    completeness: num(src.completeness ?? src.completenessScore),
    freshnessStatus: str(src.freshnessStatus) || "UNKNOWN",
    dataStatus: str(src.dataStatus) || "UNKNOWN",
    internalDisagreement: arr(src.internalDisagreement ?? src.disagreement),
    missingEvidence: arr(src.missingEvidence),
    strongestSupporting: arr(src.strongestSupporting),
    strongestOpposing: arr(src.strongestOpposing),
    // Where this Horseman's DIRECTIONAL conclusion came from.
    directionalProvenance: normaliseProvenance(src),
  });
}

/** Death V2, consumed directly. riskSeverity is NEVER mapped back to 0–4. */
function normaliseDeath(d) {
  const src = d || {};
  return Object.freeze({
    available: !!d,
    riskSeverity: str(src.riskSeverity) || "UNKNOWN",
    evidenceConfidence: str(src.evidenceConfidence) || "UNKNOWN",
    observedRisks: arr(src.observedRisks),
    missingEvidence: arr(src.missingEvidence),
    uncertainty: arr(src.uncertainty),
    disagreement: arr(src.disagreement),
    strongestChallenge: src.strongestChallenge
      ? Object.freeze({
          hasObservedChallenge: src.strongestChallenge.hasObservedChallenge === true,
          statement: str(src.strongestChallenge.statement),
          findingId: src.strongestChallenge.finding ? str(src.strongestChallenge.finding.id) : null,
          severity: src.strongestChallenge.finding ? str(src.strongestChallenge.finding.severity) : null,
        })
      : null,
  });
}

export function buildCouncilInput({
  assetId, assetType = AssetType.EQUITY, horsemen = {}, death = null,
} = {}) {
  const id = str(assetId);
  if (!id) throw new Error("buildCouncilInput requires an assetId");
  if (!Object.values(AssetType).includes(assetType)) {
    throw new Error(`buildCouncilInput received unknown assetType "${assetType}"`);
  }

  const normalised = Object.fromEntries(
    EXPECTED_HORSEMEN.map(name => [name, normaliseHorseman(name, horsemen[name])]));

  const participating = EXPECTED_HORSEMEN.filter(n => normalised[n].participated);
  const abstained = EXPECTED_HORSEMEN.filter(n => !normalised[n].participated);

  return Object.freeze({
    assetId: id,
    assetType,
    horsemen: Object.freeze(normalised),
    death: normaliseDeath(death),
    // Coverage is a first-class fact, not an implicit consequence of voting.
    coverage: Object.freeze({
      expected: EXPECTED_HORSEMEN,
      participating: Object.freeze(participating),
      abstained: Object.freeze(abstained),
      participationRatio: Number((participating.length / EXPECTED_HORSEMEN.length).toFixed(4)),
    }),
  });
}
