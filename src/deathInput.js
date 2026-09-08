/**
 * DEATH V2 — INPUT CONTRACT
 *
 * STATUS: INERT. Nothing imports this yet.
 *
 * Death is Horseman's risk auditor and cross-examiner: "find the reason not
 * to". It consumes STRUCTURED FACTS from the other Horsemen — never their
 * prose, never their narrative strings — and asks a question none of them
 * asks: what could go wrong, and is waiting safer?
 *
 * ---------------------------------------------------------------------
 * WHAT THIS LAYER DOES NOT DO
 * ---------------------------------------------------------------------
 * It performs no interpretation, assigns no severity and reaches no
 * conclusion. It normalises what was available and — critically — records
 * what was NOT, so the analysis stage can tell three different things
 * apart that legacy Death collapsed into one integer:
 *
 *   a fact that is alarming        (observed risk)
 *   a fact we could not obtain     (missing evidence)
 *   a fact we obtained but cannot read (uncertainty)
 *
 * ---------------------------------------------------------------------
 * TECHNICAL FACTS COME FROM WAR, ONCE
 * ---------------------------------------------------------------------
 * Legacy Death received RSI and the 20-day return TWICE: directly from
 * War, and again laundered through Conquest as "crowding" — which was
 * built from those same statistics. The crowd section below therefore
 * accepts ONLY behavioural fields. There is no parameter through which a
 * technical statistic can enter Death a second time.
 */

export const AssetType = Object.freeze({ EQUITY: "EQUITY", CRYPTO: "CRYPTO" });

/** Explicit tri-state for anything Death must not guess about. */
export const UNKNOWN = "UNKNOWN";

function num(v) { return typeof v === "number" && Number.isFinite(v) ? v : null; }
function str(v) { return typeof v === "string" && v.trim() ? v.trim() : null; }
function arr(v) { return Array.isArray(v) ? Object.freeze([...v]) : Object.freeze([]); }

/**
 * War's authoritative technical facts. `available` is false whenever War
 * could not produce them — which is missing evidence, never a clean bill
 * of health.
 */
function normaliseTechnical(technical) {
  const t = technical || {};
  const dataStatus = str(t.dataStatus) || UNKNOWN;
  const rsi14 = num(t.rsi14);
  const percentChange20d = num(t.percentChange20d ?? t.percentChange?.twentyDay);
  const available = dataStatus !== "DATA_UNAVAILABLE" && (rsi14 !== null || percentChange20d !== null);

  return Object.freeze({
    available,
    dataStatus,
    rsi14,
    percentChange20d,
    volatilityPct: num(t.volatilityPct ?? t.volatility?.annualisedPct),
    freshnessStatus: str(t.freshnessStatus ?? t.freshness?.status) || UNKNOWN,
    latestBarIsProvisional: typeof t.latestBarIsProvisional === "boolean" ? t.latestBarIsProvisional : null,
    provider: str(t.provider ?? t.source?.provider),
  });
}

/** Famine's structured evidence. */
function normaliseFundamental(fundamental) {
  const f = fundamental || {};
  const dataStatus = str(f.dataStatus) || UNKNOWN;
  const available = dataStatus !== UNKNOWN && dataStatus !== "EVIDENCE_UNAVAILABLE";

  return Object.freeze({
    available,
    dataStatus,
    direction: str(f.direction) || UNKNOWN,
    completenessScore: num(f.completenessScore ?? f.completeness?.score),
    freshnessStatus: str(f.freshnessStatus ?? f.freshness?.overall) || UNKNOWN,
    strongestOpposing: arr(f.strongestOpposing),
    disagreement: arr(f.disagreement),
    materialCatalysts: arr(f.materialCatalysts),
    unknownImpactEventCount: num(f.unknownImpactEventCount) ?? 0,
    missingEvidence: arr(f.missingEvidence),
  });
}

/**
 * Conquest V2's behavioural fields ONLY.
 *
 * UNKNOWN is preserved as UNKNOWN throughout. It is never rewritten to
 * zero, never read as "not crowded", and never read as neutral. Note also
 * that no technical field is accepted here — see the file header.
 */
function normaliseCrowd(crowd) {
  const c = crowd || {};
  return Object.freeze({
    available: !!c && (str(c.attentionLevel) !== null || str(c.sentiment) !== null),
    attentionLevel: str(c.attentionLevel) || UNKNOWN,
    sentiment: str(c.sentiment) || UNKNOWN,
    crowding: str(c.crowding) || UNKNOWN,
    polarisation: str(c.polarisation) || UNKNOWN,
    evidenceKind: str(c.evidenceKind) || UNKNOWN,
    // Whether a genuine public-crowd source was observed. Without this,
    // no crowd-risk finding may be raised at all.
    directEvidence: c.directEvidence === true,
    evidenceQualityBand: str(c.evidenceQualityBand ?? c.qualityBand) || UNKNOWN,
    sentimentConfidence: num(c.sentimentConfidence),
  });
}

/**
 * Cross-Horseman consensus.
 *
 * An abstention (direction UNKNOWN) is recorded SEPARATELY and is never
 * counted as agreement. Legacy Death's `disagree` test asked only whether
 * a bull and a bear both existed, so a Horseman that abstained made the
 * picture look more harmonious than it was.
 */
function normaliseConsensus(consensus) {
  const c = consensus || {};
  const directions = c.directions || {};
  const entries = Object.entries(directions)
    .map(([k, v]) => [k, str(v) || UNKNOWN]);

  const bullish = entries.filter(([, v]) => v === "BULLISH").map(([k]) => k);
  const bearish = entries.filter(([, v]) => v === "BEARISH").map(([k]) => k);
  const neutral = entries.filter(([, v]) => v === "NEUTRAL").map(([k]) => k);
  const abstained = entries.filter(([, v]) => v === UNKNOWN || v === "MIXED").map(([k]) => k);

  return Object.freeze({
    directions: Object.freeze(Object.fromEntries(entries)),
    bullish: Object.freeze(bullish),
    bearish: Object.freeze(bearish),
    neutral: Object.freeze(neutral),
    abstained: Object.freeze(abstained),
    // Genuine conflict: both camps occupied by a Horseman that reached a view.
    disagree: bullish.length > 0 && bearish.length > 0,
    participatingCount: entries.length - abstained.length,
    totalCount: entries.length,
  });
}

/**
 * Assembles the structured input Death reasons from.
 * Pure, deterministic, and free of any interpretation.
 */
export function buildDeathInput({
  assetId, assetType = AssetType.EQUITY,
  technical = null, fundamental = null, crowd = null, consensus = null,
} = {}) {
  const id = str(assetId);
  if (!id) throw new Error("buildDeathInput requires an assetId");
  if (!Object.values(AssetType).includes(assetType)) {
    throw new Error(`buildDeathInput received unknown assetType "${assetType}"`);
  }

  return Object.freeze({
    assetId: id,
    assetType,
    technical: normaliseTechnical(technical),
    fundamental: normaliseFundamental(fundamental),
    crowd: normaliseCrowd(crowd),
    consensus: normaliseConsensus(consensus),
  });
}
