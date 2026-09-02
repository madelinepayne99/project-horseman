import { MarketDataProvider, MarketDataError, MarketDataErrorCodes } from "./MarketDataProvider.js";
import { makeOhlcvPoint, makeNormalisedSeries } from "../schema/ohlcv.js";

/**
 * TwelveDataProvider — real adapter over Twelve Data's /time_series endpoint.
 *
 * Free tier limits (as documented at time of writing — verify before
 * relying on these in production, they are Twelve Data's numbers, not ours):
 *   - 800 API calls / day
 *   - 8 API calls / minute
 *   - up to 5,000 data points per request
 *   - data delayed roughly 1–15 minutes depending on exchange; irrelevant
 *     for daily-bar technicals but this provider must never be used for
 *     anything claiming to be real-time/intraday.
 *   - international (non-US) exchange coverage is documented as expanding
 *     on paid tiers — LSE-style symbols are NOT confirmed to resolve on
 *     the free Basic plan. Treat non-US tickers as unsupported until
 *     verified against a real account (see utils/supportedScope.js).
 *
 * DAILY_HISTORY_OUTPUTSIZE is 320 rather than the bare 200 a 200DMA needs,
 * for resilience through weekends/holidays/provider gaps — one HTTP
 * request either way, no extra cost against the limits above.
 *
 * Twelve Data returns errors as a JSON body with {status:"error", code,
 * message} — sometimes on a 200, sometimes on a non-2xx status. Values in
 * `values[]` are documented as STRINGS (e.g. "open": "275.23001"), which
 * schema/ohlcv.js's makeOhlcvPoint() already parses defensively.
 *
 * IMPORTANT (found via live debugging of this exact code — see the
 * diagnostic report for this phase): a 401/403 status code is NOT proof
 * the response actually came from Twelve Data — a network intermediary
 * (corporate proxy, sandboxed egress guard, CDN block page) can return a
 * 401/403 of its own before the request ever reaches Twelve Data. This
 * adapter therefore always reads and attempts to parse the body FIRST,
 * and only classifies a 401/403 as "Twelve Data rejected the key" if the
 * body actually looks like Twelve Data's documented shape. Otherwise it's
 * reported as PROVIDER_UNAVAILABLE with the raw (truncated) body logged
 * server-side only — never sent to the browser — so a misconfigured
 * network path is never confused with a real credential problem.
 */
export const DAILY_HISTORY_OUTPUTSIZE = 320;

export class TwelveDataProvider extends MarketDataProvider {
  constructor({ apiKey, baseUrl }) {
    super();
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  async getDailySeries(ticker) {
    if (!this.apiKey) {
      throw new MarketDataError("Twelve Data API key is not configured", MarketDataErrorCodes.UNAUTHORISED);
    }

    const url = new URL("/time_series", this.baseUrl);
    url.searchParams.set("symbol", ticker);
    url.searchParams.set("interval", "1day");
    url.searchParams.set("outputsize", String(DAILY_HISTORY_OUTPUTSIZE));
    url.searchParams.set("apikey", this.apiKey);

    let res;
    try {
      res = await fetch(url.toString(), { method: "GET" });
    } catch (networkErr) {
      throw new MarketDataError(
        `Could not reach Twelve Data: ${networkErr.message}`,
        MarketDataErrorCodes.PROVIDER_UNAVAILABLE
      );
    }

    // Always read the raw body BEFORE branching on status code. This is
    // the fix: previously a 401/403 short-circuited straight to
    // UNAUTHORISED without ever looking at what actually came back.
    const rawText = await res.text();
    let body = null;
    try {
      body = JSON.parse(rawText);
    } catch (e) {
      // leave body null; handled by looksLikeTwelveData below
    }

    const looksLikeTwelveData = body && typeof body === "object" &&
      (("status" in body) || ("meta" in body) || ("values" in body));

    if (!looksLikeTwelveData) {
      // Log server-side only — this is exactly the diagnostic a network/
      // proxy misconfiguration needs, and it must never reach the browser.
      console.error(
        `[TwelveDataProvider] Unexpected non-Twelve-Data response (HTTP ${res.status}) for ${ticker}. ` +
        `First 300 chars of body: ${rawText.slice(0, 300)}`
      );
      throw new MarketDataError(
        `Received an HTTP ${res.status} response that does not look like a Twelve Data response ` +
        `(possible network/proxy issue between this server and Twelve Data). See server logs for the raw body.`,
        MarketDataErrorCodes.PROVIDER_UNAVAILABLE
      );
    }

    if (res.status === 429 || (body.status === "error" && /limit/i.test(String(body.message || "")))) {
      throw new MarketDataError(String(body.message || "Twelve Data rate limit exceeded"), MarketDataErrorCodes.RATE_LIMITED);
    }
    if ((res.status === 401 || res.status === 403) && body.status === "error") {
      throw new MarketDataError(String(body.message || "Twelve Data rejected the API key"), MarketDataErrorCodes.UNAUTHORISED);
    }
    if (res.status >= 500) {
      throw new MarketDataError(`Twelve Data server error (${res.status})`, MarketDataErrorCodes.PROVIDER_UNAVAILABLE);
    }

    if (body.status === "error") {
      const msg = String(body.message || "Unknown Twelve Data error");
      if (/not found|invalid symbol/i.test(msg)) {
        throw new MarketDataError(`Symbol not found: ${ticker}`, MarketDataErrorCodes.NOT_FOUND);
      }
      throw new MarketDataError(msg, MarketDataErrorCodes.PROVIDER_UNAVAILABLE);
    }

    if (!res.ok) {
      throw new MarketDataError(`Twelve Data returned HTTP ${res.status}`, MarketDataErrorCodes.PROVIDER_UNAVAILABLE);
    }

    if (!Array.isArray(body.values) || body.values.length === 0) {
      throw new MarketDataError(`No time series data returned for ${ticker}`, MarketDataErrorCodes.NOT_FOUND);
    }

    const points = body.values
      .filter(v => v && v.datetime && v.close !== undefined)
      .map(v =>
        makeOhlcvPoint({
          date: String(v.datetime).slice(0, 10),
          open: v.open,
          high: v.high,
          low: v.low,
          close: v.close,
          volume: v.volume,
        })
      );

    if (points.length === 0) {
      throw new MarketDataError(`Twelve Data response had no usable rows for ${ticker}`, MarketDataErrorCodes.MALFORMED_RESPONSE);
    }

    return makeNormalisedSeries({
      ticker: (body.meta && body.meta.symbol) || ticker,
      companyName: (body.meta && body.meta.name) || null,
      currency: (body.meta && body.meta.currency) || null,
      points,
      provider: "twelvedata",
      simulated: false,
      requestedTicker: ticker,
      providerMeta: body.meta || null,
    });
  }
}
