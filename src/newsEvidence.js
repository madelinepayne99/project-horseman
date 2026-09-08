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
/* RELEVANCE — whose story is this?                                    */
/* ------------------------------------------------------------------ */

/**
 * Relevance is a SEPARATE question from event classification. Classification
 * asks "what kind of thing does this headline describe?"; relevance asks
 * "is this a story about the company we are analysing?".
 *
 * A provider search for one ticker routinely returns market wraps, ETF
 * commentary and stories principally about other companies. Verified live:
 * a TSLA search returned an Aurora Innovation opinion piece and a market
 * digest whose only material content was LULULEMON'S guidance cut — the
 * latter classified GUIDANCE/HIGH. Neither is a Tesla event, and counting
 * them as company evidence is misleading today and dangerous the moment
 * directional news rules widen.
 */
export const Relevance = Object.freeze({
  COMPANY_SPECIFIC: "COMPANY_SPECIFIC",
  CONTEXTUAL: "CONTEXTUAL",
  IRRELEVANT: "IRRELEVANT",
});

// Roundup/digest phrasing. These stories cover several companies, so any
// event they describe usually belongs to one of the OTHERS.
const DIGEST_MARKERS = /\bstock movers\b|\bweekly review\b|\btop midday stories\b|\blive coverage\b|\bin focus\b|\bmarket today\b|\bmovers\b|\broundup\b|\brecap\b|\bwhat to watch\b|\bthings to know\b/i;
const MULTI_SUBJECT_SEPARATORS = /[;|]/;
// Yahoo lists several tickers on roundups; a long list is itself a signal.
const MANY_TICKERS = 4;

function escapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/**
 * The company's distinguishing name token — "Tesla, Inc." -> "Tesla".
 * Legal suffixes are stripped because they never appear in headlines.
 */
export function companyNameToken(companyName) {
  if (!companyName || typeof companyName !== "string") return null;
  const cleaned = companyName
    .replace(/\b(inc|corp|corporation|company|co|plc|ltd|limited|holdings|group|sa|nv|ag)\b\.?/gi, "")
    .replace(/[.,]/g, " ").trim();
  const first = cleaned.split(/\s+/).filter(Boolean)[0];
  return first && first.length >= 3 ? first : null;
}

function mentions(headline, term) {
  if (!term) return false;
  return new RegExp(`\\b${escapeRegExp(term)}\\b`, "i").test(headline);
}

/**
 * Deterministic relevance for one item.
 *
 * AMBIGUOUS COMPANY NAMES — the deliberate design decision here:
 * many company names are ordinary words (Apple, Target, Block, Shell,
 * Match, Visa, Gap, Ford). Without a lexicon there is no way to tell
 * "Apple" the company from "apple" the fruit, and a hand-maintained list
 * of such names was explicitly ruled out. So rather than special-casing
 * names, ONE uniform rule applies to all of them:
 *
 *   a bare company-NAME match is never sufficient on its own; it must be
 *   corroborated by the ticker appearing in the headline or by the ticker
 *   appearing in relatedTickers. Uncorroborated name matches are
 *   CONTEXTUAL, not COMPANY_SPECIFIC.
 *
 * This needs no list and treats every company identically. Its cost is
 * stated plainly in the limitations: when a provider omits relatedTickers
 * AND a headline names the company without its ticker, a genuine company
 * story degrades to CONTEXTUAL. That is the conservative failure — it
 * under-counts company evidence rather than inventing it.
 */
export function classifyRelevance(item, { ticker, companyName } = {}) {
  const headline = String(item && item.headline || "");
  const target = String(ticker || "").trim().toUpperCase();
  const related = (item && item.relatedTickers) || [];
  // An empty array means NO SIGNAL, never "unrelated".
  const hasTickerSignal = related.length > 0;
  const inRelated = related.some(t => String(t).trim().toUpperCase() === target);

  const tickerNamed = target ? mentions(headline, target) : false;
  const nameToken = companyNameToken(companyName);
  const nameNamed = nameToken ? mentions(headline, nameToken) : false;

  const isDigest = DIGEST_MARKERS.test(headline)
    || MULTI_SUBJECT_SEPARATORS.test(headline)
    || related.length >= MANY_TICKERS;

  const reasons = [];
  if (tickerNamed) reasons.push("ticker in headline");
  if (nameNamed) reasons.push("company name in headline");
  if (inRelated) reasons.push("target in relatedTickers");
  if (isDigest) reasons.push("multi-company digest/roundup");
  if (!hasTickerSignal) reasons.push("no relatedTickers supplied");

  // A roundup is never a company-specific event, however it names the company.
  if (isDigest) {
    return Object.freeze({
      relevance: (tickerNamed || nameNamed || inRelated) ? Relevance.CONTEXTUAL : Relevance.IRRELEVANT,
      reasons: Object.freeze(reasons),
    });
  }

  // The ticker itself is unambiguous identification.
  if (tickerNamed) return Object.freeze({ relevance: Relevance.COMPANY_SPECIFIC, reasons: Object.freeze(reasons) });

  // A name match counts only when corroborated (see note above).
  if (nameNamed && inRelated) return Object.freeze({ relevance: Relevance.COMPANY_SPECIFIC, reasons: Object.freeze(reasons) });
  if (nameNamed) return Object.freeze({ relevance: Relevance.CONTEXTUAL, reasons: Object.freeze(reasons) });

  // Named nowhere in the headline, but the provider associates it.
  if (inRelated) return Object.freeze({ relevance: Relevance.CONTEXTUAL, reasons: Object.freeze(reasons) });

  return Object.freeze({ relevance: Relevance.IRRELEVANT, reasons: Object.freeze(reasons) });
}

/* ------------------------------------------------------------------ */
/* ASSEMBLY                                                            */
/* ------------------------------------------------------------------ */

/**
 * Turns normalised news evidence into classified, grouped, freshness-aware
 * event evidence. Emits no direction for Famine as a whole.
 */
export function assessNewsEvidence(news, now = new Date(), { companyName = null } = {}) {
  const availability = news ? news.availability : NewsAvailability.PROVIDER_UNAVAILABLE;

  if (availability !== NewsAvailability.PRESENT) {
    return Object.freeze({
      availability,
      errorCode: (news && news.errorCode) || null,
      eventGroups: Object.freeze([]),
      materialCatalysts: Object.freeze([]),
      unknownImpactEvents: Object.freeze([]),
      contextualEvents: Object.freeze([]),
      irrelevantCount: 0,
      freshness: NewsFreshness.UNKNOWN,
      newestPublishedAt: null,
      itemCount: 0,
      // Only a successful, genuinely quiet result is an observation.
      isObservation: availability === NewsAvailability.NO_RECENT_NEWS,
    });
  }

  // Relevance is applied AFTER per-item event classification but BEFORE
  // grouping, so that stories about other companies can never merge into a
  // target-company event group or inflate its reportCount.
  const scored = news.items.map(item => ({
    item,
    classification: classifyNewsItem(item),
    freshness: classifyNewsFreshness(item.publishedAt, now),
    ...classifyRelevance(item, { ticker: news.ticker, companyName }),
  }));

  const companySpecific = scored.filter(x => x.relevance === Relevance.COMPANY_SPECIFIC);

  // Contextual evidence is RETAINED for the future macro/sector layer, but
  // deliberately WITHOUT its event classification. A digest's GUIDANCE/HIGH
  // classification belongs to whichever other company the digest was about,
  // and keeping it in a consumable shape would let a future directional rule
  // treat another company's guidance cut as this company's evidence.
  const contextualEvents = Object.freeze(scored
    .filter(x => x.relevance === Relevance.CONTEXTUAL)
    .map(x => Object.freeze({
      headline: x.item.headline,
      publisher: x.item.publisher,
      publishedAt: x.item.publishedAt,
      url: x.item.url,
      freshness: x.freshness.status,
      relevance: x.relevance,
      reasons: x.reasons,
      // No category / materiality / directionalImpact by design.
    })));

  const irrelevantCount = scored.filter(x => x.relevance === Relevance.IRRELEVANT).length;

  const groups = groupEvents(companySpecific).map(g => {
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

  const dates = companySpecific.map(x => x.item.publishedAt).filter(Boolean).sort();
  const newestPublishedAt = dates.length ? dates[dates.length - 1] : null;

  // The provider succeeded; there simply is no company-specific news in the
  // results. That is an OBSERVATION ("the company is quiet"), not a provider
  // failure, and it is reported as such. Completeness is computed from the
  // RAW news availability elsewhere, so filtering never costs completeness.
  const companyNewsAvailability = companySpecific.length
    ? NewsAvailability.PRESENT
    : NewsAvailability.NO_RECENT_NEWS;

  return Object.freeze({
    availability: companyNewsAvailability,
    providerAvailability: availability,
    errorCode: null,
    eventGroups: Object.freeze(groups),
    materialCatalysts: Object.freeze(materialCatalysts),
    unknownImpactEvents: Object.freeze(unknownImpactEvents),
    contextualEvents,
    irrelevantCount,
    freshness: classifyNewsFreshness(newestPublishedAt, now).status,
    newestPublishedAt,
    itemCount: companySpecific.length,
    providerItemCount: news.items.length,
    isObservation: true,
  });
}
