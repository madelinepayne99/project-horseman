/**
 * Horseman's internal market-data schema.
 *
 * Every provider adapter must translate its own response format into this
 * shape before anything else in the system touches it. Nothing downstream
 * (technicals, WAR, Council, UI) should ever see a provider-specific field
 * name â€” that is the entire point of the adapter boundary.
 *
 * OhlcvPoint:
 *   {
 *     date: string        // "YYYY-MM-DD"
 *     timestamp: number   // ms since epoch, UTC, derived from date
 *     open: number
 *     high: number
 *     low: number
 *     close: number
 *     volume: number | null   // null if the provider/instrument has no volume
 *   }
 *
 * NormalisedSeries:
 *   {
 *     ticker: string
 *     companyName: string | null
 *     currency: string | null
 *     points: OhlcvPoint[]   // ascending by date, oldest first
 *     source: {
 *       provider: string          // e.g. "twelvedata" or "simulated-demo"
 *       simulated: boolean
 *       fetchedAt: string         // ISO timestamp of when the server fetched this
 *       requestedTicker: string   // exactly what the caller asked for
 *       exchange: string|null           // CANONICAL exchange name, e.g. "NASDAQ"
 *       country: string|null            // CANONICAL country, e.g. "United States"
 *       exchangeTimezone: string|null   // CANONICAL IANA zone, e.g. "America/New_York"
 *       providerMeta: object|null // provider's own metadata verbatim (symbol,
 *                                 // name, currency, exchange, mic_code, etc.)
 *                                 // kept ONLY for debugging/provenance â€” nothing
 *                                 // downstream of the normalisation layer should
 *                                 // read provider-specific field names out of this.
 *     }
 *   }
 *
 * CANONICAL METADATA (exchange / country / exchangeTimezone)
 * ---------------------------------------------------------------------
 * These three fields exist so that downstream code â€” supported-scope
 * checks, market-session/provisional-bar logic â€” never has to know which
 * provider produced the series. Each adapter is responsible for
 * translating its own vendor field names into these once, at the
 * normalisation boundary. For example Twelve Data's `exchange_timezone`
 * becomes `exchangeTimezone` here; a future adapter whose response calls
 * it something else translates it in exactly the same place.
 *
 * They are deliberately separate from providerMeta rather than derived
 * from it on demand: providerMeta is verbatim vendor output kept for
 * debugging, and reading vendor field names out of it downstream is the
 * precise coupling these fields remove.
 * Debugging note: providerMeta is intentionally preserved verbatim (rather
 * than discarded once we've extracted companyName/currency) so that if a
 * War result later looks wrong, it's possible to tell whether the issue
 * came from the provider (e.g. it matched the wrong symbol/exchange),
 * from our normalisation, from a technical calculation, or from data
 * quality â€” without needing to reproduce the original API call.
 */

export function makeOhlcvPoint({ date, open, high, low, close, volume }) {
  const timestamp = Date.parse(date + "T00:00:00Z");
  return {
    date,
    timestamp: Number.isNaN(timestamp) ? null : timestamp,
    open: toFiniteNumberOrNull(open),
    high: toFiniteNumberOrNull(high),
    low: toFiniteNumberOrNull(low),
    close: toFiniteNumberOrNull(close),
    volume: volume === null || volume === undefined ? null : toFiniteNumberOrNull(volume),
  };
}

export function makeNormalisedSeries({
  ticker,
  companyName = null,
  currency = null,
  points,
  provider,
  simulated,
  requestedTicker = ticker,
  providerMeta = null,
  exchange = null,
  country = null,
  exchangeTimezone = null,
}) {
  const sorted = [...points]
    .filter(p => p.close !== null && p.timestamp !== null)
    .sort((a, b) => a.timestamp - b.timestamp);
  return {
    ticker,
    companyName,
    currency,
    points: sorted,
    source: {
      provider,
      simulated: !!simulated,
      fetchedAt: new Date().toISOString(),
      requestedTicker,
      exchange: normaliseMetaString(exchange),
      country: normaliseMetaString(country),
      exchangeTimezone: normaliseMetaString(exchangeTimezone),
      providerMeta,
    },
  };
}

// Canonical metadata is trimmed and empty strings become null, so downstream
// checks only ever see a usable value or nothing at all.
function normaliseMetaString(v) {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed === "" ? null : trimmed;
}

function toFiniteNumberOrNull(v) {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}
