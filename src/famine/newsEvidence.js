import { NewsAvailability } from "../schema/news.js";
import { classifyNewsItem, Materiality, DirectionalImpact, EvidenceType } from "./eventClassification.js";

/**
 * FAMINE V2 — NEWS EVIDENCE ASSEMBLY
 *
 * Classification, freshness, and grouping of repeated reports into single
 * events. Produces no direction of its own; famineAnalysis decides what,
 * if anything, the catalysts mean.
 */

/* ------------------------------------------------------------------ */
/* FRESHNESS — a different clock from quarterly fundamentals           */
/* ------------------------------------------------------------------ */

export const NewsFreshness = Object.freeze({
  BREAKING: "BREAKING", RECENT: "RECENT", AGEING: "AGEING", STALE: "STALE", UNKNOWN: "UNKNOWN",
});

/**
 * News decays far faster than financial statements. A quarterly figure two
 * months old is current; a catalyst two months old has already been priced
 * and is context, not news.
 *
 * BREAKING <= 24h    plausibly not yet fully absorbed
 * RECENT   <= 72h    still the current story
 * AGEING   <= 14d    context for the present situation
 * STALE     > 14d    background only
 *
 * Cadence-derived judgements for a trade-decision horizon, NOT statistically
 * calibrated, and stated as such.
 */
export const NEWS_FRESHNESS_THRESHOLDS = Object.freeze({
  BREAKING_MAX_HOURS: 24,
  RECENT_MAX_HOURS: 72,
  AGEING_MAX_DAYS: 14,
});

export function classifyNewsFreshness(publishedAt, now = new Date()) {
  if (!publishedAt) return { status: NewsFreshness.UNKNOWN, ageHours: null };
  const t = Date.parse(publishedAt);
  if (Number.isNaN(t)) return { status: NewsFreshness.UNKNOWN, ageHours: null };
  const ageHours = (now.getTime() - t) / 3600000;
  if (ageHours <= NEWS_FRESHNESS_THRESHOLDS.BREAKING_MAX_HOURS) return { status: NewsFreshness.BREAKING, ageHours };
  if (ageHours <= NEWS_FRESHNESS_THRESHOLDS.RECENT_MAX_HOURS) return { status: NewsFreshness.RECENT, ageHours };
  if (ageHours <= NEWS_FRESHNESS_THRESHOLDS.AGEING_MAX_DAYS * 24) return { status: NewsFreshness.AGEING, ageHours };
  return { status: NewsFreshness.STALE, ageHours };
}

/** Only a genuinely current catalyst may influence Famine's direction. */
const DIRECTIONAL_FRESHNESS = new Set([NewsFreshness.BREAKING, NewsFreshness.RECENT]);

/* ------------------------------------------------------------------ */
/* GROUPING — repeated reports are one event, not many catalysts       */
/* ------------------------------------------------------------------ */

const STOPWORDS = new Set(["the","a","an","of","to","in","on","for","and","is","as","at","by","its","it","with","after","from","that","this","says","said","amid","over","new","up","down"]);

function significantTokens(headline) {
  return new Set(
    String(headline).toLowerCase().replace(/[^a-z0-9$%\s]/g, " ").split(/\s+/)
      .filter(w => w.length > 2 && !STOPWORDS.has(w))
  );
}

/** Jaccard overlap of significant tokens. Deterministic and inspectable. */
export function headlineSimilarity(a, b) {
  const ta = significantTokens(a), tb = significantTokens(b);
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

export const SIMILARITY_THRESHOLD = 0.6;

/**
 * Groups items that appear to describe the same event.
 *
 * IMPORTANT: matching headlines are evidence that several outlets covered
 * the same story — NOT that the story was independently confirmed. Wire
 * copy is frequently republished verbatim. The output therefore records
 * `distinctPublishers` and an explicitly named `apparentCorroboration`
 * flag, and never asserts confirmation.
 */
export function groupEvents(classifiedItems) {
  const groups = [];
  for (const entry of classifiedItems) {
    const match = groups.find(g =>
      (entry.item.id && g.items.some(i => i.item.id === entry.item.id)) ||
      headlineSimilarity(g.representative.headline, entry.item.headline) >= SIMILARITY_THRESHOLD
    );
    if (match) match.items.push(entry);
    else groups.push({ representative: entry.item, classification: entry.classification, items: [entry] });
  }

  return groups.map(g => {
    const publishers = [...new Set(g.items.map(i => i.item.publisher).filter(Boolean))];
    // Represent the group by its earliest report — the first to carry it.
    const dated = g.items.filter(i => i.item.publishedAt).sort((a, b) => Date.parse(a.item.publishedAt) - Date.parse(b.item.publishedAt));
    const representative = dated.length ? dated[0].item : g.representative;
    const classification = dated.length ? dated[0].classification : g.classification;
    return Object.freeze({
      representative, classification,
      reportCount: g.items.length,
      distinctPublishers: Object.freeze(publishers),
      // "Apparent" is doing real work here: several outlets running the
      // same wire story is not independent confirmation.
      apparentCorroboration: publishers.length >= 2,
      allHeadlines: Object.freeze(g.items.map(i => i.item.headline)),
    });
  });
}

/* ------------------------------------------------------------------ */
/* ASSEMBLY                                                            */
/* ------------------------------------------------------------------ */

/**
 * Turns normalised news evidence into classified, grouped, freshness-aware
 * event evidence. Emits no direction for Famine as a whole.
 */
export function assessNewsEvidence(news, now = new Date()) {
  const availability = news ? news.availability : NewsAvailability.PROVIDER_UNAVAILABLE;

  if (availability !== NewsAvailability.PRESENT) {
    return Object.freeze({
      availability,
      errorCode: (news && news.errorCode) || null,
      eventGroups: Object.freeze([]),
      materialCatalysts: Object.freeze([]),
      unknownImpactEvents: Object.freeze([]),
      freshness: NewsFreshness.UNKNOWN,
      newestPublishedAt: null,
      itemCount: 0,
      // Only a successful, genuinely quiet result is an observation.
      isObservation: availability === NewsAvailability.NO_RECENT_NEWS,
    });
  }

  const classified = news.items.map(item => ({
    item,
    classification: classifyNewsItem(item),
    freshness: classifyNewsFreshness(item.publishedAt, now),
  }));

  const groups = groupEvents(classified).map(g => {
    const fresh = classifyNewsFreshness(g.representative.publishedAt, now);
    return Object.freeze({ ...g, freshness: fresh.status, ageHours: fresh.ageHours });
  });

  // A material catalyst must be material AND current AND directionally
  // explicit. All three, or it is context rather than a catalyst.
  const materialCatalysts = groups.filter(g =>
    (g.classification.materiality === Materiality.HIGH || g.classification.materiality === Materiality.MEDIUM) &&
    DIRECTIONAL_FRESHNESS.has(g.freshness) &&
    g.classification.directionalImpact !== DirectionalImpact.UNKNOWN
  );

  const unknownImpactEvents = groups.filter(g =>
    g.classification.directionalImpact === DirectionalImpact.UNKNOWN &&
    g.classification.materiality !== Materiality.LOW
  );

  const dates = news.items.map(i => i.publishedAt).filter(Boolean).sort();
  const newestPublishedAt = dates.length ? dates[dates.length - 1] : null;

  return Object.freeze({
    availability,
    errorCode: null,
    eventGroups: Object.freeze(groups),
    materialCatalysts: Object.freeze(materialCatalysts),
    unknownImpactEvents: Object.freeze(unknownImpactEvents),
    freshness: classifyNewsFreshness(newestPublishedAt, now).status,
    newestPublishedAt,
    itemCount: news.items.length,
    isObservation: true,
  });
}
