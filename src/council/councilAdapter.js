import { buildCouncilInput, Direction, EXPECTED_HORSEMEN } from "./councilInput.js";
import { makeProvenance, EvidenceSource, CorrelationGroup } from "../schema/provenance.js";

/**
 * COUNCIL V2 — PRODUCTION ADAPTER
 *
 * Converts the Horsemen's structured outputs into the CouncilInput
 * contract, and decides whether a Council V2 judgment can be produced at
 * all.
 *
 * ---------------------------------------------------------------------
 * THE RULE THIS FILE EXISTS TO ENFORCE
 * ---------------------------------------------------------------------
 * A Horseman's DISPLAYED confidence is directional conviction. Council V2's
 * `evidenceConfidence` is something entirely different: how well-supported,
 * complete, fresh and trustworthy that Horseman's evidence is.
 *
 * War makes the distinction starkest. Its displayed confidence is
 * `55 + |score| * 7` — a function purely of how strongly the indicators
 * lean, with no quality term whatsoever. A stock with a decisive chart and
 * a broken data feed would report 90. Passing that in as evidence quality
 * would reintroduce the exact confusion Council V2 was built to remove, so
 * War's Council-facing quality is derived ONLY from structured quality
 * fields and never from its score.
 *
 * Nothing here modifies any Horseman's own output.
 */

/** Dependencies Council V2 requires before it may issue a judgment. */
export const REQUIRED_DEPENDENCIES = Object.freeze(["WAR_V2", "FAMINE_V2", "CONQUEST_V2", "DEATH_V2"]);

export const ADAPTER_MAPPING = Object.freeze({
  calibrated: false,

  // War: structured quality only. NEVER its displayed confidence.
  WAR_DATA_STATUS: Object.freeze({
    COMPLETE: 1, PARTIAL_DATA: 0.6, STALE_DATA: 0.5, DATA_UNAVAILABLE: 0, UNKNOWN: 0.4,
  }),
  WAR_FULL_HISTORY_BARS: 200,          // enough to compute the 200-day average
  WAR_PROVISIONAL_BAR_FACTOR: 0.9,     // today's bar is not yet settled
  WAR_FALLBACK_PROVIDER_FACTOR: 0.9,   // a substituted provider is weaker evidence

  // Famine: structured completeness/freshness/status.
  FAMINE_DATA_STATUS: Object.freeze({
    COMPLETE: 1, PARTIAL_EVIDENCE: 0.7, STALE_EVIDENCE: 0.5, EVIDENCE_UNAVAILABLE: 0, UNKNOWN: 0.4,
  }),
  FAMINE_FRESHNESS: Object.freeze({ CURRENT: 1, AGEING: 0.8, STALE: 0.5, UNKNOWN: 0.6 }),

  // Conquest: evidence-quality band, never attention.
  CONQUEST_QUALITY_BAND: Object.freeze({ STRONG: 85, MODERATE: 60, WEAK: 35, INSUFFICIENT: null, UNKNOWN: null }),
});

function pct(n) { return n === null ? null : Math.round(Math.max(0, Math.min(1, n)) * 100); }

/* ------------------------------------------------------------------ */
/* WAR                                                                 */
/* ------------------------------------------------------------------ */

/**
 * War's Council-facing evidence quality, from `war.dataSource` only.
 *
 * Returns null when War produced no structured quality information at all —
 * Council then weights it as unquantified rather than assuming quality.
 */
export function warEvidenceConfidence(dataSource) {
  if (!dataSource || dataSource.engine !== "v2") return null;
  // Simulated data is never evidence about a real company.
  if (dataSource.simulated === true) return 0;

  const M = ADAPTER_MAPPING;
  const statusFactor = M.WAR_DATA_STATUS[dataSource.dataStatus] ?? M.WAR_DATA_STATUS.UNKNOWN;
  if (statusFactor === 0) return 0;

  const factors = [statusFactor];
  if (typeof dataSource.candlesUsed === "number" && Number.isFinite(dataSource.candlesUsed)) {
    factors.push(Math.min(1, dataSource.candlesUsed / M.WAR_FULL_HISTORY_BARS));
  }

  let score = factors.reduce((a, v) => a + v, 0) / factors.length;
  if (dataSource.latestBarIsProvisional === true) score *= M.WAR_PROVISIONAL_BAR_FACTOR;
  if (dataSource.fallbackReason) score *= M.WAR_FALLBACK_PROVIDER_FACTOR;
  return pct(score);
}

/** War freshness, expressed in the vocabulary Council understands. */
export function warFreshnessStatus(dataSource) {
  if (!dataSource || dataSource.engine !== "v2") return "UNKNOWN";
  if (dataSource.dataStatus === "STALE_DATA") return "STALE";
  if (dataSource.dataStatus === "DATA_UNAVAILABLE") return "UNKNOWN";
  if (!dataSource.latestDataTimestamp) return "UNKNOWN";
  return "CURRENT";
}

export function adaptWar(war) {
  const ds = war && war.dataSource;
  const structured = !!(ds && ds.engine === "v2");
  return Object.freeze({
    direction: (war && war.direction) || Direction.UNKNOWN,
    // Deliberately NOT war.confidence.
    evidenceConfidence: warEvidenceConfidence(ds),
    completeness: structured && typeof ds.candlesUsed === "number"
      ? Number(Math.min(1, ds.candlesUsed / ADAPTER_MAPPING.WAR_FULL_HISTORY_BARS).toFixed(4))
      : null,
    freshnessStatus: warFreshnessStatus(ds),
    dataStatus: structured ? (ds.dataStatus || "UNKNOWN") : "UNKNOWN",
    internalDisagreement: [],
    missingEvidence: [],
    strongestSupporting: [],
    strongestOpposing: [],
    // War's DIRECTION is a composite: three moving-average comparisons, an
    // RSI band and a 20-session return. Acceleration is one of five inputs,
    // so stamping the whole conclusion MARKET_ACCELERATION would be false —
    // and would wrongly suppress War's legitimate technical view whenever
    // behavioural Conquest reported acceleration. A composite correlates
    // with nothing; the ACCELERATION phenomenon is tagged where it actually
    // occurs, on Death's RAPID_MOVEMENT finding.
    directionalProvenance: makeProvenance(
      EvidenceSource.MARKET_HISTORY, null,
      ["war.movingAverages", "war.rsi14", "war.percentChange20d"],
      { composite: true, contributingSources: [EvidenceSource.MARKET_HISTORY] }),
  });
}

/* ------------------------------------------------------------------ */
/* FAMINE                                                              */
/* ------------------------------------------------------------------ */

/**
 * Famine already reports structured completeness and freshness, so those
 * are used directly rather than its displayed directional confidence.
 */
export function famineEvidenceConfidence(dataSource) {
  if (!dataSource || dataSource.engine !== "v2") return null;
  const M = ADAPTER_MAPPING;
  const statusFactor = M.FAMINE_DATA_STATUS[dataSource.dataStatus] ?? M.FAMINE_DATA_STATUS.UNKNOWN;
  if (statusFactor === 0) return 0;

  const factors = [statusFactor];
  const completeness = dataSource.completeness && typeof dataSource.completeness.score === "number"
    ? dataSource.completeness.score : null;
  if (completeness !== null) factors.push(completeness);

  const freshnessKey = dataSource.freshness && dataSource.freshness.overall;
  factors.push(M.FAMINE_FRESHNESS[freshnessKey] ?? M.FAMINE_FRESHNESS.UNKNOWN);

  return pct(factors.reduce((a, v) => a + v, 0) / factors.length);
}

export function adaptFamine(famine) {
  const ds = famine && famine.dataSource;
  const structured = !!(ds && ds.engine === "v2");
  return Object.freeze({
    direction: (famine && famine.direction) || Direction.UNKNOWN,
    evidenceConfidence: famineEvidenceConfidence(ds),
    completeness: structured && ds.completeness && typeof ds.completeness.score === "number"
      ? ds.completeness.score : null,
    freshnessStatus: structured && ds.freshness ? (ds.freshness.overall || "UNKNOWN") : "UNKNOWN",
    dataStatus: structured ? (ds.dataStatus || "UNKNOWN") : "UNKNOWN",
    internalDisagreement: structured ? (ds.disagreement || []) : [],
    missingEvidence: structured ? (ds.missingEvidence || []) : [],
    strongestSupporting: structured ? (ds.strongestSupporting || []) : [],
    strongestOpposing: structured ? (ds.strongestOpposing || []) : [],
    // Famine's DIRECTION is also composite, and spans two sources: revenue
    // and earnings growth (fundamentals), earnings surprises, and current
    // material catalysts (news). Collapsing that to COMPANY_FUNDAMENTALS
    // would misdescribe it and could wrongly correlate it with a purely
    // fundamental finding.
    directionalProvenance: makeProvenance(
      EvidenceSource.FUNDAMENTAL_FEED, null,
      ["famine.revenueGrowthYoY", "famine.earningsGrowthYoY", "famine.earningsSurprises", "famine.currentCatalysts"],
      { composite: true, contributingSources: [EvidenceSource.FUNDAMENTAL_FEED, EvidenceSource.NEWS_FEED] }),
  });
}

/* ------------------------------------------------------------------ */
/* CONQUEST (prepared seam — Conquest V2 is not wired live yet)         */
/* ------------------------------------------------------------------ */

/**
 * Maps an approved Conquest V2 result.
 *
 * ATTENTION IS NEVER A DIRECTION AND NEVER A CONFIDENCE. Conquest may
 * legitimately observe VERY_HIGH attention while its sentiment is UNKNOWN;
 * in that case it abstains, and its attention contributes nothing to the
 * directional evidence. `sentiment: MIXED` is participation — a genuine
 * split crowd — and maps to NEUTRAL.
 */
export function adaptConquest(conquestV2) {
  if (!conquestV2) {
    return Object.freeze({
      direction: Direction.UNKNOWN, evidenceConfidence: null, completeness: null,
      freshnessStatus: "UNKNOWN", dataStatus: "UNKNOWN",
      internalDisagreement: [], missingEvidence: [], strongestSupporting: [], strongestOpposing: [],
      directionalProvenance: makeProvenance(EvidenceSource.CROWD_FEED, CorrelationGroup.CROWD_BEHAVIOUR),
    });
  }

  const sentiment = conquestV2.sentiment;
  const direction =
    sentiment === "BULLISH" ? Direction.BULLISH :
    sentiment === "BEARISH" ? Direction.BEARISH :
    sentiment === "NEUTRAL" || sentiment === "MIXED" ? Direction.NEUTRAL :
    Direction.UNKNOWN;   // UNKNOWN sentiment abstains

  // Quality band first; sentimentConfidence only corroborates it. Neither
  // is ever taken from attentionLevel.
  const band = ADAPTER_MAPPING.CONQUEST_QUALITY_BAND[conquestV2.evidenceQualityBand] ?? null;
  const evidenceConfidence = band !== null ? band
    : (typeof conquestV2.sentimentConfidence === "number" ? conquestV2.sentimentConfidence : null);

  return Object.freeze({
    direction,
    evidenceConfidence,
    completeness: null,
    freshnessStatus: conquestV2.newsFreshness === "STALE" ? "STALE" : "UNKNOWN",
    dataStatus: conquestV2.directEvidence === true ? "DIRECT_CROWD" : "PROXY_ONLY",
    internalDisagreement: conquestV2.polarisation === "HIGH" ? [{ type: "CROWD_POLARISED" }] : [],
    missingEvidence: [],
    strongestSupporting: [], strongestOpposing: [],
    // Conquest may only vote directionally on genuine crowd evidence
    // (founder decision: behavioural market evidence is non-directional),
    // so its directional provenance is always CROWD_FEED — independent of
    // the price series War reads.
    directionalProvenance: makeProvenance(
      EvidenceSource.CROWD_FEED, CorrelationGroup.CROWD_BEHAVIOUR, ["conquest.crowdObservations"]),
  });
}

/* ------------------------------------------------------------------ */
/* DEATH (prepared seam — Death V2 is not wired live yet)               */
/* ------------------------------------------------------------------ */

/**
 * Passes Death V2's structured assessment through losslessly.
 * The legacy integer `risk` is NEVER read, computed or reconstructed here.
 */
export function adaptDeath(deathV2) {
  if (!deathV2) return null;
  return Object.freeze({
    riskSeverity: deathV2.riskSeverity,
    evidenceConfidence: deathV2.evidenceConfidence,
    observedRisks: deathV2.observedRisks || [],
    missingEvidence: deathV2.missingEvidence || [],
    uncertainty: deathV2.uncertainty || [],
    disagreement: deathV2.disagreement || [],
    strongestChallenge: deathV2.strongestChallenge || null,
  });
}

/* ------------------------------------------------------------------ */
/* READINESS                                                           */
/* ------------------------------------------------------------------ */

/**
 * Decides whether Council V2 may issue a judgment, and builds the input
 * when it may.
 *
 * ---------------------------------------------------------------------
 * WHY THIS FAILS CLOSED
 * ---------------------------------------------------------------------
 * Council V2 cannot safely judge War V2 + Famine V2 + LEGACY Conquest +
 * LEGACY Death, because the two legacy Horsemen carry semantics Council V2
 * was explicitly designed to reject:
 *
 *   - Legacy Conquest's direction comes from headline keyword counting, and
 *     its crowding is built from RSI, the 20-day return and volume. Feeding
 *     it in would let technical statistics vote twice and let another
 *     company's headlines become this company's sentiment.
 *   - Legacy Death exposes only an integer `risk`. Council V2 consumes
 *     riskSeverity, evidenceConfidence and a structured challenge; inventing
 *     a severity from the integer would fabricate exactly the precision the
 *     redesign removed.
 *
 * So rather than produce a plausible-looking but semantically mixed
 * verdict, the boundary reports INTEGRATION_UNAVAILABLE and names what is
 * missing. A wrong verdict that looks right is worse than no verdict.
 */
export function assessCouncilV2Readiness({ war, famine, conquestV2 = null, deathV2 = null } = {}) {
  const missing = [];
  if (!(war && war.dataSource && war.dataSource.engine === "v2")) missing.push("WAR_V2");
  if (!(famine && famine.dataSource && famine.dataSource.engine === "v2")) missing.push("FAMINE_V2");
  if (!conquestV2) missing.push("CONQUEST_V2");
  if (!deathV2) missing.push("DEATH_V2");
  return Object.freeze({ ready: missing.length === 0, missingDependencies: Object.freeze(missing) });
}

export function buildCouncilInputFromHorsemen({
  assetId, assetType = "EQUITY", war, famine, conquestV2 = null, deathV2 = null,
} = {}) {
  const readiness = assessCouncilV2Readiness({ war, famine, conquestV2, deathV2 });
  if (!readiness.ready) return Object.freeze({ ...readiness, input: null });

  return Object.freeze({
    ...readiness,
    input: buildCouncilInput({
      assetId, assetType,
      horsemen: { WAR: adaptWar(war), FAMINE: adaptFamine(famine), CONQUEST: adaptConquest(conquestV2) },
      death: adaptDeath(deathV2),
    }),
  });
}

/**
 * The explicit unavailable state surfaced when Council V2 is requested but
 * its dependencies are not present. No verdict, no confidence — nothing is
 * fabricated to make the endpoint look like it answered.
 */
export function councilV2Unavailable(missingDependencies) {
  return Object.freeze({
    engine: "v2",
    status: "INTEGRATION_UNAVAILABLE",
    verdict: null,
    confidence: null,
    missingDependencies: Object.freeze([...missingDependencies]),
    reasons: Object.freeze([
      `Council V2 requires ${missingDependencies.join(", ")}, which are not yet wired into the live analysis route.`,
      "No verdict is produced rather than mixing legacy and V2 evidence semantics.",
    ]),
    limitations: Object.freeze([
      "The legacy Evidence Engine is deliberately not consumed by Council V2: its evidence is partly news-derived and still carries contamination the Horseman V2 pipelines removed.",
      "Council V2 judges the structured Horseman evidence directly.",
    ]),
  });
}

export { EXPECTED_HORSEMEN };
