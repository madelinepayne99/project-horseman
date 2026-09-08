import { makeFact, missingFact, isPresent, factValue, FactState, MissingReason } from "./fundamentals.js";

/**
 * CONQUEST V2 — provider-neutral CROWD EVIDENCE schema.
 *
 * STATUS: INERT. Nothing imports this yet. It exists so a public-crowd
 * source (a forum, a discussion API, a search-trend feed) can later plug
 * in without rebuilding Conquest.
 *
 * ---------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------
 * Today's Conquest has NO crowd source at all. It counts keywords in
 * publisher headlines and reports a direction with high confidence — a
 * live TSLA run produced BEARISH 84 where every point of the "bearish"
 * signal came from two Lululemon headlines and a market wrap. This schema
 * is the seam that lets genuine crowd evidence replace that, and it is
 * deliberately shaped so the DIFFERENCE between real crowd evidence and a
 * proxy is visible in the data rather than buried in a number.
 *
 * ---------------------------------------------------------------------
 * THREE RULES THE SHAPE ENFORCES
 * ---------------------------------------------------------------------
 * 1. MISSING IS NOT ZERO. Numeric measures reuse the fact wrappers from
 *    the fundamentals schema (imported read-only, not modified), so an
 *    absent engagement count cannot silently arithmetic itself into 0.
 *
 * 2. OBSERVED CROWD IS NOT A USER CLAIM. Every structure built here is
 *    stamped origin: OBSERVED_CROWD and the stamp cannot be overridden by
 *    a caller. A tip pasted from WhatsApp is a CLAIM TO INVESTIGATE, not a
 *    measurement of public sentiment, and must never enter this shape.
 *
 * 3. COUNTING IS NOT INTERPRETING. This layer counts what a provider
 *    supplied (how many bullish-classified posts, how many distinct
 *    sources). It computes NO direction, NO sentiment score and NO
 *    confidence. Conquest's analysis stage owns all of that.
 */

/** Extensible by adding a member here; nothing else keys off equities. */
export const AssetType = Object.freeze({
  EQUITY: "EQUITY",
  CRYPTO: "CRYPTO",
});

/**
 * Where a piece of evidence came from, as a first-class field.
 * USER_SUPPLIED_CLAIM and OBSERVED_MARKET_BEHAVIOUR exist so the
 * distinctions are expressible and testable — but no constructor in this
 * file produces either: everything here is stamped OBSERVED_CROWD. When the
 * Tips feature arrives it needs its own schema; it must never be able to
 * enter a crowd measurement.
 */
export const EvidenceOrigin = Object.freeze({
  /**
   * Participant behaviour inferred from observable market history (OHLCV).
   * Supports observations and cautious behavioural interpretations. It can
   * NEVER establish participant identity, motive or intent — price and
   * volume record what happened, not who acted or why.
   */
  OBSERVED_MARKET_BEHAVIOUR: "OBSERVED_MARKET_BEHAVIOUR",
  OBSERVED_CROWD: "OBSERVED_CROWD",
  USER_SUPPLIED_CLAIM: "USER_SUPPLIED_CLAIM",
});

export const CrowdAvailability = Object.freeze({
  PRESENT: "PRESENT",                           // provider answered, activity exists
  NO_RECENT_ACTIVITY: "NO_RECENT_ACTIVITY",     // provider answered, the crowd is quiet — a finding
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE", // we could not look — missing knowledge
  MALFORMED: "MALFORMED",
});

/**
 * A stance a provider (or a classifier) attributed to one observation.
 * UNCLASSIFIED is explicit: "we could not tell" is never NEUTRAL, in the
 * same way that no evidence is never neutral evidence.
 */
export const CrowdStance = Object.freeze({
  BULLISH: "BULLISH",
  BEARISH: "BEARISH",
  NEUTRAL: "NEUTRAL",
  UNCLASSIFIED: "UNCLASSIFIED",
});

const KNOWN_STANCES = new Set(Object.values(CrowdStance));

function normaliseIsoTimestamp(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const ms = raw > 1e11 ? raw : raw * 1000;   // tolerate seconds or milliseconds
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof raw !== "string") return null;
  const t = Date.parse(raw.trim());
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function normaliseString(v) {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * ONE observation — a post, comment, or equivalent unit of public
 * discussion. Returns null when it lacks the minimum needed to be usable
 * (a source and a timestamp), so callers drop whole observations rather
 * than carrying half-formed ones.
 *
 * `stance` is whatever the provider/classifier reported. An unrecognised
 * or absent value becomes UNCLASSIFIED, never NEUTRAL.
 */
export function makeCrowdObservation({
  id = null,
  sourceName,
  authorId = null,
  publishedAt,
  engagement = null,
  stance = null,
  stanceConfidence = null,
  isDuplicate = null,
  isSuspectedAutomated = null,
  url = null,
} = {}) {
  const source = normaliseString(sourceName);
  const at = normaliseIsoTimestamp(publishedAt);
  if (!source || !at) return null;

  const rawStance = normaliseString(stance);
  const resolvedStance = rawStance && KNOWN_STANCES.has(rawStance.toUpperCase())
    ? rawStance.toUpperCase()
    : CrowdStance.UNCLASSIFIED;

  return Object.freeze({
    id: normaliseString(id),
    sourceName: source,
    // Deliberately an opaque identifier, never a display name — this layer
    // has no business carrying personal data it does not need.
    authorId: normaliseString(authorId),
    publishedAt: at,
    engagement: makeFact(engagement),
    stance: resolvedStance,
    // Confidence OF THE CLASSIFICATION, not of any Conquest conclusion.
    stanceConfidence: makeFact(stanceConfidence),
    isDuplicate: typeof isDuplicate === "boolean" ? isDuplicate : null,
    isSuspectedAutomated: typeof isSuspectedAutomated === "boolean" ? isSuspectedAutomated : null,
    url: normaliseString(url),
    origin: EvidenceOrigin.OBSERVED_CROWD,
  });
}

/**
 * Aggregated crowd evidence for one asset over one window.
 *
 * Counts derived here are ARITHMETIC ON SUPPLIED DATA (how many observations
 * carried each stance, how many distinct sources appeared), never inference.
 * Provider-level aggregates that we cannot derive — total post volume when
 * individual items were not returned, an engagement score, a classifier's
 * own confidence — are accepted as facts and stay MISSING when absent.
 */
export function makeCrowdEvidence({
  assetId,
  assetType = AssetType.EQUITY,
  provider,
  observations = [],
  windowStart = null,
  windowEnd = null,
  observedAt = new Date().toISOString(),
  postVolume = null,
  commentVolume = null,
  engagementTotal = null,
  uniqueAuthors = null,
  classifierConfidence = null,
  providerMeta = null,
} = {}) {
  const id = normaliseString(assetId);
  if (!id) throw new Error("makeCrowdEvidence requires an assetId");
  if (!Object.values(AssetType).includes(assetType)) {
    throw new Error(`makeCrowdEvidence received unknown assetType "${assetType}"`);
  }
  if (!normaliseString(provider)) throw new Error("makeCrowdEvidence requires a provider identity");

  const items = Object.freeze(observations.filter(Boolean));

  const stanceCounts = Object.freeze({
    bullish: items.filter(o => o.stance === CrowdStance.BULLISH).length,
    bearish: items.filter(o => o.stance === CrowdStance.BEARISH).length,
    neutral: items.filter(o => o.stance === CrowdStance.NEUTRAL).length,
    unclassified: items.filter(o => o.stance === CrowdStance.UNCLASSIFIED).length,
  });

  const distinctSources = new Set(items.map(o => o.sourceName));
  const distinctAuthors = new Set(items.map(o => o.authorId).filter(Boolean));

  const quality = Object.freeze({
    duplicateCount: items.filter(o => o.isDuplicate === true).length,
    suspectedAutomatedCount: items.filter(o => o.isSuspectedAutomated === true).length,
    // Unknown-quality items are counted so a later stage can discount a
    // feed that tells us nothing about duplication or automation.
    qualityUnknownCount: items.filter(o => o.isDuplicate === null && o.isSuspectedAutomated === null).length,
  });

  return Object.freeze({
    assetId: id,
    assetType,
    availability: items.length ? CrowdAvailability.PRESENT : CrowdAvailability.NO_RECENT_ACTIVITY,
    origin: EvidenceOrigin.OBSERVED_CROWD,
    observations: items,
    observationCount: items.length,
    stanceCounts,
    // Derived, countable facts.
    sourceDiversity: distinctSources.size,
    distinctAuthorCount: distinctAuthors.size,
    quality,
    // Provider-supplied aggregates: MISSING rather than 0 when absent.
    volume: Object.freeze({
      posts: makeFact(postVolume),
      comments: makeFact(commentVolume),
    }),
    engagementTotal: makeFact(engagementTotal),
    uniqueAuthors: makeFact(uniqueAuthors),
    classifierConfidence: makeFact(classifierConfidence),
    window: Object.freeze({
      start: normaliseIsoTimestamp(windowStart),
      end: normaliseIsoTimestamp(windowEnd),
    }),
    source: Object.freeze({
      provider: normaliseString(provider),
      observedAt: normaliseIsoTimestamp(observedAt) || new Date().toISOString(),
      cached: false,
      providerMeta,
    }),
  });
}

/**
 * Crowd evidence we could not obtain. Structurally distinct from
 * NO_RECENT_ACTIVITY: "we looked and the crowd is quiet" is a finding;
 * "we could not look" is an absence of knowledge. Collapsing the two is
 * exactly how a missing source becomes a neutral reading.
 */
export function makeUnavailableCrowdEvidence({
  assetId,
  assetType = AssetType.EQUITY,
  provider,
  availability = CrowdAvailability.PROVIDER_UNAVAILABLE,
  errorCode,
  message = null,
  observedAt = new Date().toISOString(),
} = {}) {
  const id = normaliseString(assetId);
  if (!id) throw new Error("makeUnavailableCrowdEvidence requires an assetId");
  const missing = missingFact(MissingReason.CATEGORY_UNAVAILABLE);

  return Object.freeze({
    assetId: id,
    assetType,
    availability,
    origin: EvidenceOrigin.OBSERVED_CROWD,
    observations: Object.freeze([]),
    observationCount: 0,
    stanceCounts: Object.freeze({ bullish: 0, bearish: 0, neutral: 0, unclassified: 0 }),
    sourceDiversity: 0,
    distinctAuthorCount: 0,
    quality: Object.freeze({ duplicateCount: 0, suspectedAutomatedCount: 0, qualityUnknownCount: 0 }),
    volume: Object.freeze({ posts: missing, comments: missing }),
    engagementTotal: missing,
    uniqueAuthors: missing,
    classifierConfidence: missing,
    window: Object.freeze({ start: null, end: null }),
    errorCode: errorCode || "UNKNOWN",
    message,
    source: Object.freeze({
      provider: normaliseString(provider),
      observedAt: normaliseIsoTimestamp(observedAt) || new Date().toISOString(),
      cached: false,
      providerMeta: null,
    }),
  });
}

/**
 * True only when a structure represents genuinely OBSERVED public crowd
 * activity. Conquest's analysis stage should gate any directional
 * sentiment claim on this, so that proxy-only runs cannot produce one.
 */
export function hasDirectCrowdEvidence(evidence) {
  return !!evidence
    && evidence.origin === EvidenceOrigin.OBSERVED_CROWD
    && evidence.availability === CrowdAvailability.PRESENT
    && evidence.observationCount > 0;
}

// Re-exported so consumers read crowd facts through the same helpers used
// everywhere else, rather than reaching into `.value` directly.
export { isPresent, factValue, FactState, MissingReason };
