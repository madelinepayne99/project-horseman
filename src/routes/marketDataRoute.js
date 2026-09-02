import { buildWarInput } from "../technicals/buildWarInput.js";
import { MarketDataError, MarketDataErrorCodes } from "../providers/MarketDataProvider.js";

const TICKER_PATTERN = /^[A-Za-z0-9.\-]{1,10}$/;

/**
 * Handles GET /api/market-data?ticker=AAPL
 *
 * Contract:
 *   - 200 -> { ticker, warInput: {...} }              (warInput.dataStatus may still be PARTIAL_DATA/STALE_DATA)
 *   - 400 -> { error: "..." }                          (bad request, e.g. missing/invalid ticker)
 *   - 404 -> { status: "DATA_UNAVAILABLE", message }   (symbol not found)
 *   - 429 -> { status: "DATA_UNAVAILABLE", message }   (provider rate limit)
 *   - 500 -> { status: "DATA_UNAVAILABLE", message }   (our server is misconfigured — see SERVER_MISCONFIGURED)
 *   - 502 -> { status: "DATA_UNAVAILABLE", message }   (provider down/network/malformed)
 *
 * A provider failure NEVER falls back to simulated data here.
 *
 * @param {() => import('../providers/MarketDataProvider.js').MarketDataProvider} getProvider
 *   Called fresh on every request (see src/getProvider.js) — not a bound
 *   instance — so this same route works identically whether it's called
 *   from the long-lived native dev server or a fresh serverless invocation.
 */
export function createMarketDataHandler(getProvider) {
  return async function handleMarketData(req, res, query) {
    const ticker = (query.ticker || "").trim().toUpperCase();

    if (!ticker || !TICKER_PATTERN.test(ticker)) {
      sendJson(res, 400, { error: "Query parameter 'ticker' is required and must look like a stock symbol." });
      return;
    }

    let series;
    try {
      const provider = getProvider();
      series = await provider.getDailySeries(ticker);
    } catch (err) {
      if (err instanceof MarketDataError) {
        const httpStatus = mapErrorCodeToHttpStatus(err.code);
        sendJson(res, httpStatus, { status: "DATA_UNAVAILABLE", code: err.code, message: err.message });
        return;
      }
      // Unexpected/programming error — still never fabricate a result.
      sendJson(res, 502, { status: "DATA_UNAVAILABLE", code: "UNKNOWN", message: "Unexpected error retrieving market data." });
      return;
    }

    const warInput = buildWarInput(series);
    sendJson(res, 200, { ticker, warInput });
  };
}

function mapErrorCodeToHttpStatus(code) {
  switch (code) {
    case MarketDataErrorCodes.NOT_FOUND: return 404;
    case MarketDataErrorCodes.RATE_LIMITED: return 429;
    case MarketDataErrorCodes.SERVER_MISCONFIGURED: return 500; // our fault, not the provider's
    case MarketDataErrorCodes.UNAUTHORISED: return 502; // the provider rejected us
    case MarketDataErrorCodes.PROVIDER_UNAVAILABLE: return 502;
    case MarketDataErrorCodes.MALFORMED_RESPONSE: return 502;
    default: return 502;
  }
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}
