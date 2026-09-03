import { MarketDataProvider, MarketDataError, MarketDataErrorCodes } from "./MarketDataProvider.js";
import { makeOhlcvPoint, makeNormalisedSeries } from "../schema/ohlcv.js";

/**
 * YahooProvider — adapter over Yahoo Finance's v8 chart endpoint.
 *
 * STATUS: built but NOT WIRED. Nothing selects this provider yet; it exists
 * so a transparent fallback can later feed the SAME normalised series into
 * the SAME technical pipeline. No technical calculation lives here.
 *
 * COMMERCIAL CAVEAT: this is an undocumented, unofficial endpoint with no
 * SLA, no versioning and no support, and its use in a paid product is not
 * clearly licensed. It is acceptable as a prototype/beta resilience
 * mechanism only. Everything vendor-specific is confined to this file, so
 * replacing it with a licensed secondary provider means writing one new
 * adapter and changing nothing else.
 *
 * Response shape (verified against multiple independent public sources,
 * not assumed):
 *   chart.result[0].meta.{symbol, currency, exchangeName, fullExchangeName,
 *                         exchangeTimezoneName, shortName, longName}
 *   chart.result[0].timestamp[]                 // epoch SECONDS
 *   chart.result[0].indicators.quote[0].{open,high,low,close,volume}[]
 *   chart.result[0].indicators.adjclose[0].adjclose[]
 *   chart.error                                  // {code, description} on failure
 *
 * Yahoo emits nulls inside the quote arrays for holidays/halts/missing
 * bars, and meta carries NO country field — hence the exchange mapping below.
 */

// ~2 years of daily bars (~500 sessions), comfortably above the 320 the
// primary provider requests and well clear of the 200 a 200DMA needs.
export const DEFAULT_RANGE = "2y";

/**
 * Yahoo reports exchanges as short codes, not the canonical names
 * supportedScope.js expects. Only codes actually evidenced in this
 * project's research are mapped:
 *   NMS -> NASDAQ  (documented for AAPL, FB)
 *   NYQ -> NYSE    (documented for GME)
 *
 * Deliberately NOT guessed: NGM/NCM (other Nasdaq tiers), ASE (NYSE
 * American), PCX (NYSE Arca), BTS, IEX and similar. They are plausible but
 * unverified, and an unverified mapping here would silently widen the
 * supported-security policy — the one thing this layer must never do.
 *
 * Anything unmapped yields a null canonical exchange, which
 * isSupportedUsEquity() treats as unsupported. Fail closed, never guess.
 */
export const YAHOO_EXCHANGE_MAP = Object.freeze({
  NMS: "NASDAQ",
  NYQ: "NYSE",
});

export function mapYahooExchange(exchangeName) {
  if (typeof exchangeName !== "string") return null;
  return YAHOO_EXCHANGE_MAP[exchangeName.trim().toUpperCase()] || null;
}

/**
 * Converts an epoch-seconds timestamp into the "YYYY-MM-DD" trading date
 * as observed at the exchange, matching how the primary provider already
 * labels its daily bars. Falls back to UTC if the zone is unusable.
 */
export function tradingDateFromEpoch(epochSeconds, timeZone) {
  const ms = epochSeconds * 1000;
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  if (timeZone) {
    try {
      // en-CA renders as YYYY-MM-DD.
      return new Intl.DateTimeFormat("en-CA", {
        timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      }).format(d);
    } catch {
      // unusable zone -> fall through to UTC
    }
  }
  return d.toISOString().slice(0, 10);
}

export class YahooProvider extends MarketDataProvider {
  constructor({ baseUrl = "https://query1.finance.yahoo.com", range = DEFAULT_RANGE } = {}) {
    super();
    this.baseUrl = baseUrl;
    this.range = range;
  }

  async getDailySeries(ticker) {
    const url = new URL(`/v8/finance/chart/${encodeURIComponent(ticker)}`, this.baseUrl);
    url.searchParams.set("range", this.range);
    url.searchParams.set("interval", "1d");

    let res;
    try {
      res = await fetch(url.toString(), {
        method: "GET",
        headers: {
          Accept: "application/json",
          // The endpoint is documented as rejecting default library
          // user-agents. Harmless where it isn't required.
          "User-Agent": "Mozilla/5.0 (compatible; Horseman/1.0)",
        },
      });
    } catch (networkErr) {
      throw new MarketDataError(
        `Could not reach Yahoo: ${networkErr.message}`,
        MarketDataErrorCodes.PROVIDER_UNAVAILABLE
      );
    }

    // Read and parse the body BEFORE branching on status, for the same
    // reason as the Twelve Data adapter: a 4xx from a proxy or block page
    // is not evidence that Yahoo itself answered.
    const rawText = await res.text();
    let body = null;
    try {
      body = JSON.parse(rawText);
    } catch {
      // handled by the shape check below
    }

    const looksLikeYahoo = body && typeof body === "object" && "chart" in body;
    if (!looksLikeYahoo) {
      console.error(
        `[YahooProvider] Unexpected non-Yahoo response (HTTP ${res.status}) for ${ticker}. ` +
        `First 300 chars of body: ${rawText.slice(0, 300)}`
      );
      throw new MarketDataError(
        `Received an HTTP ${res.status} response that does not look like a Yahoo chart response ` +
        `(possible network/proxy issue between this server and Yahoo). See server logs for the raw body.`,
        MarketDataErrorCodes.PROVIDER_UNAVAILABLE
      );
    }

    if (res.status === 429) {
      throw new MarketDataError("Yahoo rate limit exceeded", MarketDataErrorCodes.RATE_LIMITED);
    }

    const chartError = body.chart && body.chart.error;
    if (chartError) {
      const code = String(chartError.code || "");
      const description = String(chartError.description || "Unknown Yahoo error");
      if (/not\s*found/i.test(code) || /no data found|not found/i.test(description)) {
        throw new MarketDataError(`Symbol not found: ${ticker}`, MarketDataErrorCodes.NOT_FOUND);
      }
      throw new MarketDataError(description, MarketDataErrorCodes.PROVIDER_UNAVAILABLE);
    }

    if (res.status === 404) {
      throw new MarketDataError(`Symbol not found: ${ticker}`, MarketDataErrorCodes.NOT_FOUND);
    }
    if (res.status >= 500) {
      throw new MarketDataError(`Yahoo server error (${res.status})`, MarketDataErrorCodes.PROVIDER_UNAVAILABLE);
    }
    if (!res.ok) {
      throw new MarketDataError(`Yahoo returned HTTP ${res.status}`, MarketDataErrorCodes.PROVIDER_UNAVAILABLE);
    }

    const result = body.chart && Array.isArray(body.chart.result) ? body.chart.result[0] : null;
    if (!result) {
      throw new MarketDataError(`No chart data returned for ${ticker}`, MarketDataErrorCodes.NOT_FOUND);
    }

    const meta = result.meta || null;
    const timestamps = Array.isArray(result.timestamp) ? result.timestamp : null;
    const quote = result.indicators && Array.isArray(result.indicators.quote)
      ? result.indicators.quote[0]
      : null;

    if (!timestamps || !quote) {
      throw new MarketDataError(
        `Yahoo response for ${ticker} was missing timestamp or quote arrays`,
        MarketDataErrorCodes.MALFORMED_RESPONSE
      );
    }

    const exchangeTimezone = (meta && meta.exchangeTimezoneName) || null;

    // INDEX ALIGNMENT: iterate by index and treat each index as ONE bar.
    // The arrays are never filtered independently — a bar missing a usable
    // timestamp or close is dropped whole, so no value can slide into a
    // neighbouring bar's slot. A missing volume alone does NOT drop the
    // bar; it is recorded as null, which the schema and the volume
    // calculations already handle.
    const open = quote.open || [], high = quote.high || [],
          low = quote.low || [], close = quote.close || [], volume = quote.volume || [];

    const points = [];
    for (let i = 0; i < timestamps.length; i++) {
      const ts = timestamps[i];
      const c = close[i];
      if (!Number.isFinite(ts) || !Number.isFinite(c)) continue; // drop the whole bar
      const date = tradingDateFromEpoch(ts, exchangeTimezone);
      if (!date) continue;
      points.push(makeOhlcvPoint({
        date,
        open: open[i],
        high: high[i],
        low: low[i],
        close: c,
        // Yahoo's raw quote close is used deliberately, NOT
        // indicators.adjclose — the primary provider's series is
        // unadjusted, and mixing the two would make fallback history
        // silently diverge from primary across any split or dividend.
        volume: volume[i] === null || volume[i] === undefined ? null : volume[i],
      }));
    }

    if (points.length === 0) {
      throw new MarketDataError(
        `Yahoo response had no usable rows for ${ticker}`,
        MarketDataErrorCodes.MALFORMED_RESPONSE
      );
    }

    return makeNormalisedSeries({
      ticker: (meta && meta.symbol) || ticker,
      companyName: (meta && (meta.longName || meta.shortName)) || null,
      currency: (meta && meta.currency) || null,
      points,
      provider: "yahoo",
      simulated: false,
      requestedTicker: ticker,
      // Canonical metadata translated here, at the adapter boundary.
      // Yahoo's chart meta carries no country field, so country stays null
      // and scope eligibility rests on the mapped exchange alone.
      exchange: mapYahooExchange(meta && meta.exchangeName),
      country: null,
      exchangeTimezone,
      providerMeta: meta,
    });
  }
}
