import { UNKNOWN } from "./deathInput.js";
import {
  EvidenceSource, CorrelationGroup, makeProvenance, groupByCorrelation,
  isIndependenceEligible, assessProvenanceIntegrity,
} from "../schema/provenance.js";

/**
 * DEATH V2 — ANALYSIS
 *
 * STATUS: INERT. Nothing imports this yet.
 *
 * ---------------------------------------------------------------------
 * FOUR CATEGORIES, NEVER ONE INTEGER
 * ---------------------------------------------------------------------
 *   OBSERVED_RISK    evidence genuinely indicates danger
 *   MISSING_EVIDENCE something important could not be checked
 *   UNCERTAINTY      evidence exists but does not support a conclusion
 *   DISAGREEMENT     available evidence conflicts
 *
 * Legacy Death added all four into a single `risk` counter, so "the RSI is
 * 82" and "we could not reach the fundamentals provider" were the same
 * fact. They are not. Only OBSERVED_RISK contributes to severity; the
 * other three reduce evidence confidence instead.
 *
 * ---------------------------------------------------------------------
 * SEVERITY AND CONFIDENCE ARE INDEPENDENT
 * ---------------------------------------------------------------------
 * Legacy Death used `confidence = 58 + risk*6`, which made it MORE
 * confident the more alarming its findings were. Those are different
 * questions:
 *
 *   riskSeverity      how serious are the risks actually identified?
 *   evidenceConfidence how well-evidenced is this assessment?
 *
 * A severe risk seen through thin evidence is severe AND poorly evidenced.
 * A modest risk seen through complete, fresh, direct evidence is modest AND
 * well evidenced. Both combinations are expressible here.
 *
 * ---------------------------------------------------------------------
 * MISSING IS NOT DANGEROUS, AND NOT SAFE
 * ---------------------------------------------------------------------
 * An unavailable provider never fabricates a risk finding, and never
 * counts as reassurance. It is recorded as MISSING_EVIDENCE, which lowers
 * confidence in the assessment without pretending to know anything.
 */

export const FindingCategory = Object.freeze({
  OBSERVED_RISK: "OBSERVED_RISK",
  MISSING_EVIDENCE: "MISSING_EVIDENCE",
  UNCERTAINTY: "UNCERTAINTY",
  DISAGREEMENT: "DISAGREEMENT",
});

export const Severity = Object.freeze({
  LOW: "LOW", MODERATE: "MODERATE", HIGH: "HIGH",
});

export const RiskSeverity = Object.freeze({
  NONE_OBSERVED: "NONE_OBSERVED",
  LOW: "LOW", MODERATE: "MODERATE", HIGH: "HIGH", SEVERE: "SEVERE",
});

export const EvidenceConfidence = Object.freeze({
  WEAK: "WEAK", MODERATE: "MODERATE", STRONG: "STRONG",
});

/**
 * PROVISIONAL LEGACY THRESHOLDS.
 *
 * Carried across from legacy Death unchanged so this step introduces no
 * behavioural drift beyond the structural change. They are NOT calibrated
 * and are explicitly flagged for a later calibration pass — in particular
 * `RSI_EXTENDED: 75` was tuned against a simple-average RSI and now meets
 * War's Wilder RSI, which reads materially lower for the same stock.
 */
export const PROVISIONAL_THRESHOLDS = Object.freeze({
  RSI_EXTENDED: 75,
  RAPID_MOVE_PCT: 15,
  calibrated: false,
});

const SEVERITY_RANK = { [Severity.LOW]: 1, [Severity.MODERATE]: 2, [Severity.HIGH]: 3 };

function finding(category, id, severity, detail, source, provenance = null) {
  return Object.freeze({
    category, id, severity, detail, source,
    // Where this rests and which phenomenon it describes, so Council and
    // Death can tell one fact seen twice from two independent facts.
    provenance: provenance || makeProvenance(EvidenceSource.UNDECLARED),
  });
}

/* ------------------------------------------------------------------ */
/* FINDINGS                                                            */
/* ------------------------------------------------------------------ */

function technicalFindings(t) {
  const out = [];
  if (!t.available) {
    out.push(finding(FindingCategory.MISSING_EVIDENCE, "TECHNICAL_EVIDENCE_UNAVAILABLE", null,
      `Technical facts could not be obtained (status ${t.dataStatus}), so technical risk could not be checked.`, "WAR",
      makeProvenance(EvidenceSource.MARKET_HISTORY, CorrelationGroup.EVIDENCE_AVAILABILITY)));
    return out;
  }

  // Consumed DIRECTLY from War, exactly once. Never via Conquest.
  if (t.rsi14 !== null && t.rsi14 > PROVISIONAL_THRESHOLDS.RSI_EXTENDED) {
    out.push(finding(FindingCategory.OBSERVED_RISK, "TECHNICAL_EXTENSION", Severity.MODERATE,
      `RSI(14) is ${t.rsi14.toFixed(1)}, above the provisional ${PROVISIONAL_THRESHOLDS.RSI_EXTENDED} threshold: price is extended and a pullback would not be surprising.`, "WAR",
      makeProvenance(EvidenceSource.MARKET_HISTORY, CorrelationGroup.MARKET_EXTENSION, ["war.rsi14"])));
  } else if (t.rsi14 === null) {
    out.push(finding(FindingCategory.MISSING_EVIDENCE, "RSI_UNAVAILABLE", null,
      "RSI was not available, so technical extension could not be assessed.", "WAR",
      makeProvenance(EvidenceSource.MARKET_HISTORY, CorrelationGroup.EVIDENCE_AVAILABILITY)));
  }

  if (t.percentChange20d !== null && Math.abs(t.percentChange20d) > PROVISIONAL_THRESHOLDS.RAPID_MOVE_PCT) {
    out.push(finding(FindingCategory.OBSERVED_RISK, "RAPID_MOVEMENT", Severity.MODERATE,
      `Price has moved ${t.percentChange20d.toFixed(1)}% over 20 sessions; rapid moves can reverse sharply.`, "WAR",
      // A TWENTY-session cumulative move. The horizon is declared because
      // MARKET_ACCELERATION is only the same phenomenon at the same window:
      // a Conquest observation of today's single session is a different
      // measurement and must not suppress this one, or be suppressed by it.
      makeProvenance(EvidenceSource.MARKET_HISTORY, CorrelationGroup.MARKET_ACCELERATION,
        ["war.percentChange20d"], { horizon: { unit: "SESSIONS", length: 20 } })));
  } else if (t.percentChange20d === null) {
    out.push(finding(FindingCategory.MISSING_EVIDENCE, "TWENTY_DAY_RETURN_UNAVAILABLE", null,
      "The 20-session change was not available, so rapid-movement risk could not be assessed.", "WAR",
      makeProvenance(EvidenceSource.MARKET_HISTORY, CorrelationGroup.EVIDENCE_AVAILABILITY)));
  }

  if (t.freshnessStatus === "stale" || t.freshnessStatus === "STALE") {
    out.push(finding(FindingCategory.UNCERTAINTY, "STALE_TECHNICAL_EVIDENCE", Severity.LOW,
      "The technical evidence is stale and may not describe the current market.", "WAR",
      makeProvenance(EvidenceSource.MARKET_HISTORY, CorrelationGroup.EVIDENCE_AVAILABILITY)));
  }
  return out;
}

function fundamentalFindings(f) {
  const out = [];
  if (!f.available) {
    out.push(finding(FindingCategory.MISSING_EVIDENCE, "FUNDAMENTAL_EVIDENCE_UNAVAILABLE", null,
      `Company evidence could not be obtained (status ${f.dataStatus}), so fundamental risk could not be checked.`, "FAMINE",
      makeProvenance(EvidenceSource.FUNDAMENTAL_FEED, CorrelationGroup.EVIDENCE_AVAILABILITY)));
    return out;
  }

  // Genuine evidence AGAINST the opportunity — the core of cross-examination.
  if (f.strongestOpposing.length > 0) {
    const severity = f.strongestOpposing.length >= 2 ? Severity.HIGH : Severity.MODERATE;
    out.push(finding(FindingCategory.OBSERVED_RISK, "OPPOSING_FUNDAMENTAL_EVIDENCE", severity,
      `${f.strongestOpposing.length} piece(s) of company evidence point against the opportunity: ${f.strongestOpposing.map(o => o.claim || o).slice(0, 2).join("; ")}`, "FAMINE",
      makeProvenance(EvidenceSource.FUNDAMENTAL_FEED, CorrelationGroup.COMPANY_FUNDAMENTALS)));
  }

  // A catalyst whose direction is explicitly negative is observed risk.
  const negativeCatalysts = f.materialCatalysts.filter(c => c && c.impact === "NEGATIVE");
  if (negativeCatalysts.length > 0) {
    out.push(finding(FindingCategory.OBSERVED_RISK, "NEGATIVE_CATALYST", Severity.HIGH,
      `A current material catalyst points against the trade: ${negativeCatalysts[0].headline || "negative catalyst"}`, "FAMINE",
      makeProvenance(EvidenceSource.NEWS_FEED, CorrelationGroup.COMPANY_EVENT)));
  }

  // A catalyst we cannot read is uncertainty, not danger and not safety.
  if (f.unknownImpactEventCount > 0) {
    out.push(finding(FindingCategory.UNCERTAINTY, "UNRESOLVED_EVENT_IMPACT", Severity.LOW,
      `${f.unknownImpactEventCount} recent event(s) could not be assigned a direction, so their effect is unresolved.`, "FAMINE",
      makeProvenance(EvidenceSource.NEWS_FEED, CorrelationGroup.COMPANY_EVENT)));
  }

  if (f.disagreement.length > 0) {
    out.push(finding(FindingCategory.DISAGREEMENT, "FUNDAMENTAL_INTERNAL_DISAGREEMENT", Severity.MODERATE,
      `Company evidence disagrees with itself: ${f.disagreement.map(d => d.detail || d.type || d).slice(0, 2).join("; ")}`, "FAMINE",
      makeProvenance(EvidenceSource.FUNDAMENTAL_FEED, CorrelationGroup.COMPANY_FUNDAMENTALS)));
  }

  if (f.completenessScore !== null && f.completenessScore < 1) {
    out.push(finding(FindingCategory.MISSING_EVIDENCE, "INCOMPLETE_FUNDAMENTAL_EVIDENCE", null,
      `Company evidence is ${Math.round(f.completenessScore * 100)}% complete; ${f.missingEvidence.length} item(s) were unavailable.`, "FAMINE",
      makeProvenance(EvidenceSource.FUNDAMENTAL_FEED, CorrelationGroup.EVIDENCE_AVAILABILITY)));
  }

  if (f.freshnessStatus === "STALE") {
    out.push(finding(FindingCategory.UNCERTAINTY, "STALE_FUNDAMENTAL_EVIDENCE", Severity.LOW,
      "The most recent company figures are stale and may no longer describe the business.", "FAMINE",
      makeProvenance(EvidenceSource.FUNDAMENTAL_FEED, CorrelationGroup.EVIDENCE_AVAILABILITY)));
  }
  return out;
}

function crowdFindings(c) {
  const out = [];

  // No crowd source at all: missing evidence. Never "not crowded".
  if (!c.available) {
    out.push(finding(FindingCategory.MISSING_EVIDENCE, "CROWD_EVIDENCE_UNAVAILABLE", null,
      "No crowd evidence was available, so crowd behaviour could not be checked.", "CONQUEST",
      makeProvenance(EvidenceSource.CROWD_FEED, CorrelationGroup.EVIDENCE_AVAILABILITY)));
    return out;
  }

  // A crowd risk may ONLY be raised from genuinely observed crowd evidence.
  // Without a direct source, crowding UNKNOWN stays UNKNOWN — it is neither
  // reassurance nor a manufactured danger.
  if (c.crowding === UNKNOWN) {
    out.push(finding(FindingCategory.MISSING_EVIDENCE, "CROWDING_UNKNOWN", null,
      "Crowding could not be determined. This is not evidence that the trade is uncrowded.", "CONQUEST",
      makeProvenance(EvidenceSource.CROWD_FEED, CorrelationGroup.EVIDENCE_AVAILABILITY)));
  } else if (c.directEvidence && (c.crowding === "HIGH" || c.crowding === "ELEVATED")) {
    // EXPRESSED_CONCENTRATION, not "crowded positioning".
    //
    // The underlying evidence measures how concentrated and repetitive the
    // OBSERVED OPINION is — few sources, few authors, repeated narrative,
    // one-sided stance. It records nothing about who holds what. A lot of
    // people saying the same thing is not proof they own the position, and
    // the old identifier claimed exactly that.
    //
    // Trigger, severity and provenance are unchanged: this is a correction
    // of what the finding CLAIMS, not of what it detects.
    out.push(finding(FindingCategory.OBSERVED_RISK, "EXPRESSED_CONCENTRATION",
      c.crowding === "HIGH" ? Severity.HIGH : Severity.MODERATE,
      `Directly observed crowd evidence shows ${c.crowding.toLowerCase()} concentration of expressed opinion. This describes what is being said, not what anyone holds.`, "CONQUEST",
      // CROWD_FEED, not MARKET_HISTORY: a real crowd reading is independent
      // evidence even when it describes the same price move War saw.
      makeProvenance(EvidenceSource.CROWD_FEED, CorrelationGroup.CROWD_BEHAVIOUR)));
  }

  if (c.sentiment === UNKNOWN) {
    // High attention with unreadable sentiment is a genuine unresolved state.
    const detail = c.attentionLevel === "HIGH" || c.attentionLevel === "VERY_HIGH"
      ? `Attention is ${c.attentionLevel} but crowd sentiment could not be read, so the direction of that interest is unknown.`
      : "Crowd sentiment could not be determined.";
    out.push(finding(FindingCategory.UNCERTAINTY, "CROWD_SENTIMENT_UNKNOWN", Severity.LOW, detail, "CONQUEST",
      makeProvenance(EvidenceSource.CROWD_FEED, CorrelationGroup.EVIDENCE_AVAILABILITY)));
  }

  if (c.directEvidence && c.polarisation === "HIGH") {
    out.push(finding(FindingCategory.DISAGREEMENT, "CROWD_POLARISED", Severity.MODERATE,
      "The observed crowd is sharply split, so there is no settled view to rely on.", "CONQUEST",
      makeProvenance(EvidenceSource.CROWD_FEED, CorrelationGroup.CROWD_BEHAVIOUR)));
  }
  return out;
}

function consensusFindings(k) {
  const out = [];
  if (k.disagree) {
    out.push(finding(FindingCategory.DISAGREEMENT, "HORSEMEN_DISAGREE", Severity.HIGH,
      `Horsemen conflict: ${k.bullish.join(", ")} bullish against ${k.bearish.join(", ")} bearish.`, "CONSENSUS",
      makeProvenance(EvidenceSource.CROSS_HORSEMAN, CorrelationGroup.HORSEMAN_CONSENSUS)));
  }
  if (k.abstained.length > 0) {
    // Explicitly NOT agreement. Legacy Death's disagree test treated an
    // abstention as harmony, which made a thinner picture look calmer.
    out.push(finding(FindingCategory.UNCERTAINTY, "HORSEMAN_ABSTAINED", Severity.LOW,
      `${k.abstained.join(", ")} reached no view. An abstention is not agreement.`, "CONSENSUS",
      makeProvenance(EvidenceSource.CROSS_HORSEMAN, CorrelationGroup.HORSEMAN_CONSENSUS)));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* SEVERITY AND CONFIDENCE                                             */
/* ------------------------------------------------------------------ */

/**
 * Severity is derived from OBSERVED RISK ONLY, and each PHENOMENON is
 * counted once.
 *
 * Without this, War's "price moved 25% in 20 sessions" and a future
 * behavioural Conquest finding about that same acceleration would both
 * raise severity, doubling the weight of one fact. Correlated findings are
 * collapsed to their most severe member for scoring; all members remain in
 * the output so the case file can show both perspectives.
 */
function riskSeverityFor(observedGroups) {
  const observed = observedGroups.map(g => g.representative);
  if (observed.length === 0) return RiskSeverity.NONE_OBSERVED;
  const highs = observed.filter(f => f.severity === Severity.HIGH).length;
  const moderates = observed.filter(f => f.severity === Severity.MODERATE).length;
  if (highs >= 2) return RiskSeverity.SEVERE;
  if (highs === 1) return RiskSeverity.HIGH;
  if (moderates >= 2) return RiskSeverity.MODERATE;
  if (moderates === 1) return RiskSeverity.MODERATE;
  return RiskSeverity.LOW;
}

/**
 * Confidence in the ASSESSMENT, computed only from how much of the
 * evidence base was actually available and usable. It never reads
 * severity, so an alarming finding cannot make Death sound more certain.
 */
function evidenceConfidenceFor(input, findings) {
  // NOTE: `fundamentalAvailable` is EXCLUDED whenever a completeness score
  // exists, because completeness already expresses availability and does so
  // more precisely. Counting both let a 30%-complete source score full
  // marks on one factor and pulled a thin evidence base up to MODERATE.
  const factors = {
    technicalAvailable: input.technical.available ? 1 : 0,
    fundamentalAvailable: input.fundamental.completenessScore === null
      ? (input.fundamental.available ? 1 : 0)
      : null,
    fundamentalCompleteness: input.fundamental.completenessScore,
    crowdDirect: input.crowd.directEvidence ? 1 : 0,
    consensusParticipation: input.consensus.totalCount
      ? input.consensus.participatingCount / input.consensus.totalCount
      : null,
    freshness: (input.technical.freshnessStatus === "stale" || input.fundamental.freshnessStatus === "STALE") ? 0.4 : 1,
  };
  const present = Object.entries(factors).filter(([, v]) => typeof v === "number");
  const score = present.length
    ? Number((present.reduce((a, [, v]) => a + v, 0) / present.length).toFixed(4))
    : null;
  const band = score === null ? EvidenceConfidence.WEAK
    : score >= 0.75 ? EvidenceConfidence.STRONG
    : score >= 0.45 ? EvidenceConfidence.MODERATE
    : EvidenceConfidence.WEAK;
  return { score, band, factors: Object.freeze(factors) };
}

/**
 * The single most important reason not to proceed, chosen deterministically
 * from OBSERVED RISK only: highest severity first, then a fixed category
 * order, then finding id. Never invented — when nothing is sufficiently
 * supported, that is stated plainly rather than manufacturing an objection.
 */
const CHALLENGE_PRIORITY = [
  "NEGATIVE_CATALYST", "OPPOSING_FUNDAMENTAL_EVIDENCE", "EXPRESSED_CONCENTRATION",
  "TECHNICAL_EXTENSION", "RAPID_MOVEMENT",
];

function selectStrongestChallenge(observedGroups, missing, uncertainty) {
  const observed = observedGroups.map(g => g.representative);
  if (observed.length === 0) {
    return Object.freeze({
      hasObservedChallenge: false,
      // The honest middle ground legacy Death could not express.
      statement: missing.length || uncertainty.length
        ? "No major observed red flag was found, but the evidence is incomplete, so this is not a clean bill of health."
        : "No major observed red flag was found in the evidence available.",
      finding: null,
    });
  }
  const sorted = [...observed].sort((a, b) => {
    const bySeverity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (bySeverity !== 0) return bySeverity;
    const byPriority = CHALLENGE_PRIORITY.indexOf(a.id) - CHALLENGE_PRIORITY.indexOf(b.id);
    if (byPriority !== 0) return byPriority;
    return a.id.localeCompare(b.id);
  });
  const top = sorted[0];
  // One coherent challenge, citing every angle the same phenomenon was seen
  // from rather than presenting them as separate risks.
  const group = observedGroups.find(g => g.representative === top);
  const corroborating = group ? group.members.filter(m => m !== top) : [];
  return Object.freeze({
    hasObservedChallenge: true,
    statement: top.detail,
    finding: top,
    corroboratingObservations: Object.freeze(corroborating.map(m => ({ id: m.id, source: m.source, detail: m.detail }))),
    correlationGroup: group ? group.correlationGroup : null,
  });
}

/**
 * Death V2 assessment. Pure and deterministic.
 * Emits no verdict, no recommendation and no probability — Council judges.
 */
export function deathAnalysis(input) {
  const all = [
    ...technicalFindings(input.technical),
    ...fundamentalFindings(input.fundamental),
    ...crowdFindings(input.crowd),
    ...consensusFindings(input.consensus),
  ];

  const observedRisks = all.filter(f => f.category === FindingCategory.OBSERVED_RISK);
  const missingEvidence = all.filter(f => f.category === FindingCategory.MISSING_EVIDENCE);
  const uncertainty = all.filter(f => f.category === FindingCategory.UNCERTAINTY);
  const disagreement = all.filter(f => f.category === FindingCategory.DISAGREEMENT);

  // Group by phenomenon before scoring. Findings that describe one fact
  // from several angles are ONE piece of evidence.
  //
  // Findings with undeclared or malformed provenance are quarantined into a
  // single group rather than each claiming to be a distinct phenomenon. A
  // future producer that forgets to declare therefore cannot escalate
  // severity by contributing several unattributed findings. Their details
  // are fully retained — this withholds an unearned independence claim, not
  // evidence, and adds no severity penalty for missing metadata.
  const declaredRisks = observedRisks.filter(f => isIndependenceEligible(f.provenance));
  const undeclaredRisks = observedRisks.filter(f => !isIndependenceEligible(f.provenance));
  const bySeverity = (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];

  const observedGroups = groupByCorrelation(declaredRisks, bySeverity);
  if (undeclaredRisks.length) {
    const members = [...undeclaredRisks].sort(bySeverity);
    observedGroups.push(Object.freeze({
      source: EvidenceSource.UNDECLARED,
      correlationGroup: null,
      representative: members[0],
      members: Object.freeze(undeclaredRisks),
      memberCount: undeclaredRisks.length,
      correlated: undeclaredRisks.length > 1,
      provenanceUndeclared: true,
    }));
  }

  const provenanceIntegrity = assessProvenanceIntegrity(
    [...observedRisks, ...missingEvidence, ...uncertainty, ...disagreement], f => f.id);

  const { score, band, factors } = evidenceConfidenceFor(input, all);

  return Object.freeze({
    assetId: input.assetId,
    assetType: input.assetType,
    // Four categories, never summed together.
    observedRisks: Object.freeze(observedRisks),
    missingEvidence: Object.freeze(missingEvidence),
    uncertainty: Object.freeze(uncertainty),
    disagreement: Object.freeze(disagreement),
    // Derived from observed risk ONLY.
    riskSeverity: riskSeverityFor(observedGroups),
    // Inspectable correlation handling: which phenomena were observed, and
    // where several Horsemen described the same one.
    correlationGroups: Object.freeze(observedGroups.map(g => Object.freeze({
      correlationGroup: g.correlationGroup, source: g.source,
      findingIds: Object.freeze(g.members.map(m => m.id)),
      memberCount: g.memberCount, correlated: g.correlated,
      provenanceUndeclared: g.provenanceUndeclared === true,
    }))),
    distinctPhenomenaCount: observedGroups.length,
    // Provenance completeness is explicitly inspectable rather than absorbed.
    provenanceIntegrity,
    // Derived from evidence availability ONLY.
    evidenceConfidence: band,
    evidenceConfidenceScore: score,
    evidenceFactors: factors,
    strongestChallenge: selectStrongestChallenge(observedGroups, missingEvidence, uncertainty),
    provenance: Object.freeze({
      contributingHorsemen: Object.freeze([...new Set(all.map(f => f.source))]),
      technicalProvider: input.technical.provider,
      crowdEvidenceKind: input.crowd.evidenceKind,
      crowdDirectEvidence: input.crowd.directEvidence,
      thresholds: PROVISIONAL_THRESHOLDS,
    }),
    limitations: Object.freeze([
      "Death identifies risks and unresolved questions. It does not issue a verdict — the Council judges.",
      "Risk severity and evidence confidence are separate: a severe risk may rest on thin evidence, and a modest risk on strong evidence.",
      "Missing evidence is recorded as missing. It is never treated as safety, and never fabricated into danger.",
      "Technical thresholds are provisional legacy values and have not been calibrated.",
      "Findings describing the same underlying phenomenon are counted once, however many Horsemen observed it.",
    ]),
  });
}
