import { FundamentalsProvider, FundamentalsError, FundamentalsErrorCodes } from "./FundamentalsProvider.js";
import {
  makeFundamentalsSnapshot, makeUnavailableFundamentals,
  makeEarningsPeriod, makeEarningsHistory, makeUnavailableEarnings,
  EvidenceAvailability,
} from "../schema/fundamentals.js";

/**
 * AlphaVantageProvider — the ONLY file permitted to know Alpha Vantage's
 * response shape and field names.
 *
 * Verified characteristics (checked against Alpha Vantage's documentation
 * and multiple independent client implementations, not assumed):
 *
 *  - All numeric values arrive as STRINGS ("0.164", "37.33").
 *  - Absent numerics arrive as the literal string "None", not null. Passing
 *    that to Number() yields NaN, so the schema's makeFact() maps it to a
 *    MISSING fact rather than 0.
 *  - Errors arrive with HTTP 200 and a JSON body carrying one of:
 *      "Error Message" — malformed call / unknown symbol
 *      "Note"          — rate limiting (historically the per-minute cap)
 *      "Information"   — used for the daily cap AND for premium-endpoint
 *                        notices, so it is classified by content, not blindly
 *  - OVERVIEW for an unknown symbol returns an EMPTY OBJECT {} with HTTP 200.
 *  - EARNINGS returns { symbol, annualEarnings[], quarterlyEarnings[] },
 *    quarterly newest-first, each with fiscalDateEnding, reportedDate,
 *    reportedEPS, estimatedEPS, surprise, surprisePercentage.
 *
 * Free tier is 25 requests/day. Each Famine analysis currently costs two of
 * them, so rate limiting is a ROUTINE state here, not an exceptional one.
 *
 * As in TwelveDataProvider, the body is read and parsed BEFORE any decision
 * is made from the status code: a 4xx/5xx from a proxy or block page is not
 * evidence that Alpha Vantage answered.
 */

const QUARTERS_KEPT = 8; // ~2 years, enough for later surprise-trend work

export class AlphaVantageProvider extends FundamentalsProvider {
  constructor({ apiKey, baseUrl = "https://www.alphavantage.co" } = {}) {
    super();
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  async #query(fn, ticker) {
    if (!this.apiKey) {
      throw new FundamentalsError(
        "ALPHA_VANTAGE_API_KEY is not set on the server.",
        FundamentalsErrorCodes.SERVER_MISCONFIGURED
      );
    }

    const url = new URL("/query", this.baseUrl);
    url.searchParams.set("function", fn);
    url.searchParams.set("symbol", ticker);
    url.searchParams.set("apikey", this.apiKey);

    let res;
    try {
      res = await fetch(url.toString(), { method: "GET", headers: { Accept: "application/json" } });
    } catch (networkErr) {
      throw new FundamentalsError(
        `Could not reach Alpha Vantage: ${networkErr.message}`,
        FundamentalsErrorCodes.PROVIDER_UNAVAILABLE
      );
    }

    const rawText = await res.text();
    let body = null;
    try { body = JSON.parse(rawText); } catch { /* handled below */ }

    if (!body || typeof body !== "object") {
      // Server-side only. Never returned to the browser.
      console.error(
        `[AlphaVantageProvider] Unexpected non-JSON response (HTTP ${res.status}) for ${fn}/${ticker}. ` +
        `First 300 chars: ${rawText.slice(0, 300)}`
      );
      throw new FundamentalsError(
        `Received an HTTP ${res.status} response that does not look like an Alpha Vantage response ` +
        `(possible network/proxy issue). See server logs.`,
        FundamentalsErrorCodes.PROVIDER_UNAVAILABLE
      );
    }

    if (res.status === 429) {
      throw new FundamentalsError("Alpha Vantage rate limit exceeded", FundamentalsErrorCodes.RATE_LIMITED);
    }

    // Alpha Vantage's own in-body signalling (usually on HTTP 200).
    const note = typeof body.Note === "string" ? body.Note : null;
    const info = typeof body.Information === "string" ? body.Information : null;
    const errMsg = typeof body["Error Message"] === "string" ? body["Error Message"] : null;

    if (note) {
      throw new FundamentalsError(note, FundamentalsErrorCodes.RATE_LIMITED);
    }
    if (info) {
      // "Information" covers both quota messages and premium-endpoint
      // notices. Classify from the text rather than assuming either.
      const isQuota = /rate limit|requests per day|higher api call|premium|subscribe/i.test(info);
      throw new FundamentalsError(
        info,
        isQuota ? FundamentalsErrorCodes.RATE_LIMITED : FundamentalsErrorCodes.PROVIDER_UNAVAILABLE
      );
    }
    if (errMsg) {
      throw new FundamentalsError(errMsg, FundamentalsErrorCodes.NOT_FOUND);
    }

    if (res.status >= 500) {
      throw new FundamentalsError(`Alpha Vantage server error (${res.status})`, FundamentalsErrorCodes.PROVIDER_UNAVAILABLE);
    }
    if (!res.ok) {
      throw new FundamentalsError(`Alpha Vantage returned HTTP ${res.status}`, FundamentalsErrorCodes.PROVIDER_UNAVAILABLE);
    }

    return body;
  }

  async getFundamentals(ticker) {
    const body = await this.#query("OVERVIEW", ticker);

    // An empty object is Alpha Vantage's "unknown symbol" answer.
    if (!body.Symbol) {
      if (Object.keys(body).length === 0) {
        throw new FundamentalsError(`No fundamentals found for ${ticker}`, FundamentalsErrorCodes.NOT_FOUND);
      }
      throw new FundamentalsError(
        `Alpha Vantage OVERVIEW response for ${ticker} had no Symbol field`,
        FundamentalsErrorCodes.MALFORMED_RESPONSE
      );
    }

    // Vendor field names appear here and NOWHERE else in the codebase.
    return makeFundamentalsSnapshot({
      ticker: body.Symbol || ticker,
      companyName: body.Name || null,
      currency: body.Currency || null,
      revenueGrowthYoY: body.QuarterlyRevenueGrowthYOY,
      earningsGrowthYoY: body.QuarterlyEarningsGrowthYOY,
      profitMargin: body.ProfitMargin,
      eps: body.EPS,
      peRatio: body.PERatio,
      asOf: body.LatestQuarter,
      provider: "alphavantage",
      providerMeta: { exchange: body.Exchange || null, sector: body.Sector || null, industry: body.Industry || null },
    });
  }

  async getEarningsHistory(ticker) {
    const body = await this.#query("EARNINGS", ticker);

    if (!Array.isArray(body.quarterlyEarnings)) {
      if (body.symbol) {
        // Answered about the right symbol, but with no quarterly array.
        throw new FundamentalsError(
          `Alpha Vantage EARNINGS response for ${ticker} had no quarterlyEarnings array`,
          FundamentalsErrorCodes.MALFORMED_RESPONSE
        );
      }
      throw new FundamentalsError(`No earnings history found for ${ticker}`, FundamentalsErrorCodes.NOT_FOUND);
    }

    const periods = body.quarterlyEarnings.slice(0, QUARTERS_KEPT).map(q =>
      makeEarningsPeriod({
        fiscalPeriodEnd: q.fiscalDateEnding,
        reportedDate: q.reportedDate,
        reportedEps: q.reportedEPS,
        estimatedEps: q.estimatedEPS,
        surprisePct: q.surprisePercentage,
      })
    );

    // A successful response with zero usable quarters is EMPTY, not
    // unavailable — makeEarningsHistory decides that from the content.
    return makeEarningsHistory({
      ticker: body.symbol || ticker,
      periods,
      provider: "alphavantage",
      providerMeta: { annualPeriodsAvailable: Array.isArray(body.annualEarnings) ? body.annualEarnings.length : null },
    });
  }
}

/**
 * Helpers turning a thrown FundamentalsError into the explicit
 * "we could not obtain this" structures. Kept here so the mapping from
 * error code to availability lives beside the provider that raises it.
 *
 * MALFORMED_RESPONSE maps to MALFORMED; everything else maps to
 * PROVIDER_UNAVAILABLE. Neither is ever NEUTRAL.
 */
export function fundamentalsFromError(ticker, err, provider = "alphavantage") {
  return makeUnavailableFundamentals({
    ticker, provider,
    availability: err && err.code === FundamentalsErrorCodes.MALFORMED_RESPONSE
      ? EvidenceAvailability.MALFORMED
      : EvidenceAvailability.PROVIDER_UNAVAILABLE,
    errorCode: (err && err.code) || "UNKNOWN",
    message: (err && err.message) || null,
  });
}

export function earningsFromError(ticker, err, provider = "alphavantage") {
  return makeUnavailableEarnings({
    ticker, provider,
    availability: err && err.code === FundamentalsErrorCodes.MALFORMED_RESPONSE
      ? EvidenceAvailability.MALFORMED
      : EvidenceAvailability.PROVIDER_UNAVAILABLE,
    errorCode: (err && err.code) || "UNKNOWN",
    message: (err && err.message) || null,
  });
}
