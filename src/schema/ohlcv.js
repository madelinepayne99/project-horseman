/**
 * Horseman's internal market-data schema.
 *
 * Every provider adapter must translate its own response format into this
 * shape before anything else in the system touches it. Nothing downstream
 * (technicals, WAR, Council, UI) should ever see a provider-specific field
 * name — that is the entire point of the adapter boundary.
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
 *       providerMeta: object|null // provider's own metadata verbatim (symbol,
 *                                 // name, currency, exchange, mic_code, etc.)
 *                                 // kept ONLY for debugging/provenance — nothing
 *                                 // downstream of the normalisation layer should
 *                                 // read provider-specific field names out of this.
 *     }
 *   }
 *
 * Debugging note: providerMeta is intentionally preserved verbatim (rather
 * than discarded once we've extracted companyName/currency) so that if a
 * War result later looks wrong, it's possible to tell whether the issue
 * came from the provider (e.g. it matched the wrong symbol/exchange),
 * from our normalisation, from a technical calculation, or from data
 * quality — without needing to reproduce the original API call.
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
      providerMeta,
    },
  };
}

function toFiniteNumberOrNull(v) {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}
