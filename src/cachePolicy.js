/**
 * FAMINE V2 — CACHE POLICY
 *
 * TTLs are per evidence KIND, because the underlying data moves at
 * different speeds. They are cadence-derived judgements, not statistically
 * calibrated, and are stated as such.
 *
 * FUNDAMENTALS (OVERVIEW) — 24 hours
 *   These figures change roughly four times a year. A worst-case one-day
 *   lag on a quarterly number is immaterial, and Famine reports `asOf`
 *   regardless, so the reporting period is never misrepresented.
 *
 * EARNINGS — 12 hours
 *   Also quarterly, but a NEW report is the single most decision-relevant
 *   update Famine can receive. Half a day bounds how long a fresh report
 *   could go unnoticed, at the cost of one extra call per ticker per day.
 *
 * NEWS — NOT CACHED
 *   Deliberate. News freshness bands run to 24 and 72 hours, and only
 *   BREAKING/RECENT items can produce a catalyst. Caching would undermine
 *   the one band that matters.
 *
 * Quota arithmetic against Alpha Vantage's 25 requests/day free tier:
 *   uncached          2 calls per summon      -> ~12 summons/day
 *   24h + 12h TTLs    3 calls per ticker/day  -> ~8 tickers/day, with
 *                                                unlimited repeat summons
 *   24h + 24h TTLs    2 calls per ticker/day  -> ~12 tickers/day
 * If quota proves binding in beta, lengthening the earnings TTL is the lever.
 *
 * A dynamic TTL that shortens around earnings dates would be better, but we
 * only know the most recent reported date, not the NEXT one, so any such
 * rule would be guesswork. Not attempted.
 */

const HOUR_MS = 60 * 60 * 1000;

export const CacheKind = Object.freeze({
  FUNDAMENTALS: "fundamentals",
  EARNINGS: "earnings",
});

export const CACHE_TTL_MS = Object.freeze({
  [CacheKind.FUNDAMENTALS]: 24 * HOUR_MS,
  [CacheKind.EARNINGS]: 12 * HOUR_MS,
});

export function ttlFor(kind) {
  const ttl = CACHE_TTL_MS[kind];
  if (!ttl) throw new Error(`No cache TTL defined for kind "${kind}"`);
  return ttl;
}

/**
 * Key format: `<provider>:<kind>:<TICKER>`
 *
 * The provider identity is part of the key deliberately: if a second
 * fundamentals provider is ever added, its data must not collide with
 * Alpha Vantage's under the same ticker. The ticker is upper-cased and
 * trimmed so "aapl" and " AAPL " share one entry rather than silently
 * spending quota twice.
 */
export function cacheKey({ provider, kind, ticker }) {
  if (!provider) throw new Error("cacheKey requires a provider identity");
  if (!CACHE_TTL_MS[kind]) throw new Error(`cacheKey received unknown kind "${kind}"`);
  const normalised = String(ticker || "").trim().toUpperCase();
  if (!normalised) throw new Error("cacheKey requires a ticker");
  return `${provider}:${kind}:${normalised}`;
}
