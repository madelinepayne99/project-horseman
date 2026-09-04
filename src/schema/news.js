/**
 * FAMINE V2 — provider-neutral company news/event evidence.
 *
 * WHAT THE PROVIDER ACTUALLY GIVES US
 * ---------------------------------------------------------------------
 * Yahoo's /v1/finance/search news[] entries carry, verified against the
 * endpoint's observed output and multiple independent client libraries:
 *
 *   uuid                 stable per-article id  -> exact-duplicate detection
 *   title                headline text          -> the ONLY content we get
 *   publisher            e.g. "Reuters"
 *   link                 article URL
 *   providerPublishTime  unix SECONDS
 *   type                 "STORY" | "VIDEO"
 *   relatedTickers       string[]               -> relevance to this company
 *   thumbnail            image resolutions      -> not useful to Famine
 *
 * There is NO summary, description or article body. Everything Famine can
 * infer must come from a headline, a publisher name and a timestamp. That
 * is a severe limitation and the reason the classification in
 * eventClassification.js is deliberately cautious: with no article text,
 * confident interpretation would be invention.
 *
 * We do not scrape article bodies and we never fabricate content.
 */

export const NewsAvailability = Object.freeze({
  PRESENT: "PRESENT",                           // provider worked, relevant items exist
  NO_RECENT_NEWS: "NO_RECENT_NEWS",             // provider worked, nothing relevant/recent — a real finding
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE", // we could not look — missing knowledge
  MALFORMED: "MALFORMED",
});

/** A single normalised item. No vendor field names survive this boundary. */
export function makeNewsItem({ id = null, headline, publisher = null, url = null, publishedAt = null, contentType = null, relatedTickers = [] }) {
  const title = typeof headline === "string" ? headline.trim() : "";
  if (!title) return null;

  let iso = null;
  if (typeof publishedAt === "number" && Number.isFinite(publishedAt)) {
    // Providers report seconds; tolerate milliseconds without guessing.
    const ms = publishedAt > 1e11 ? publishedAt : publishedAt * 1000;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) iso = d.toISOString();
  } else if (typeof publishedAt === "string") {
    const t = Date.parse(publishedAt);
    if (!Number.isNaN(t)) iso = new Date(t).toISOString();
  }

  return Object.freeze({
    id: id || null,
    headline: title,
    publisher: publisher || null,
    url: url || null,
    publishedAt: iso,                   // null when undateable — never invented
    contentType: contentType || null,   // e.g. STORY / VIDEO, as reported
    relatedTickers: Object.freeze(Array.isArray(relatedTickers) ? relatedTickers.filter(t => typeof t === "string") : []),
  });
}

export function makeNewsEvidence({ ticker, items = [], provider, fetchedAt = new Date().toISOString(), availability = null }) {
  const clean = items.filter(Boolean);
  return Object.freeze({
    ticker,
    availability: availability || (clean.length ? NewsAvailability.PRESENT : NewsAvailability.NO_RECENT_NEWS),
    items: Object.freeze(clean),
    source: Object.freeze({ provider, fetchedAt, cached: false }),
  });
}

/**
 * News we could not obtain. Structurally distinct from NO_RECENT_NEWS:
 * "we looked and the company is quiet" is evidence, "we could not look" is
 * an absence of knowledge, and the two must never collapse together.
 */
export function makeUnavailableNews({ ticker, provider, availability, errorCode, message = null, fetchedAt = new Date().toISOString() }) {
  return Object.freeze({
    ticker,
    availability,
    items: Object.freeze([]),
    errorCode,
    message,
    source: Object.freeze({ provider, fetchedAt, cached: false }),
  });
}
