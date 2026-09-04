import {
  makeFundamentalsSnapshot, makeUnavailableFundamentals,
  makeEarningsPeriod, makeEarningsHistory, makeUnavailableEarnings,
  EvidenceAvailability,
} from "../../src/schema/fundamentals.js";

/**
 * Provider-neutral fixtures for Famine V2.
 *
 * These construct normalised structures DIRECTLY. No Alpha Vantage request
 * is made, no HTTP call occurs, and no provider quota is consumed by any
 * Famine V2 test.
 */

export const NOW = new Date("2026-09-03T00:00:00Z");
export const RECENT_QUARTER = "2026-06-30";   // 65 days old at NOW -> CURRENT
export const AGEING_QUARTER = "2026-03-31";   // 156 days -> AGEING
export const STALE_QUARTER = "2025-06-30";    // 430 days -> STALE

export function fundamentals({
  revenueGrowthYoY = "0.164", earningsGrowthYoY = "0.287",
  profitMargin = "0.276", eps = "8.71", peRatio = "37.33",
  asOf = RECENT_QUARTER, ticker = "AAPL",
} = {}) {
  return makeFundamentalsSnapshot({
    ticker, companyName: "Apple Inc.", currency: "USD",
    revenueGrowthYoY, earningsGrowthYoY, profitMargin, eps, peRatio,
    asOf, provider: "alphavantage",
  });
}

export function unavailableFundamentals(errorCode = "RATE_LIMITED", ticker = "AAPL") {
  return makeUnavailableFundamentals({
    ticker, provider: "alphavantage",
    availability: EvidenceAvailability.PROVIDER_UNAVAILABLE,
    errorCode, message: "simulated provider failure (no request made)",
  });
}

/** surprises: array of numbers or "None"; newest first. */
export function earnings({ surprises = [7.4, 2.0, 5.1, 1.2], asOf = RECENT_QUARTER, ticker = "AAPL" } = {}) {
  const periods = surprises.map((s, i) => makeEarningsPeriod({
    fiscalPeriodEnd: i === 0 ? asOf : shiftQuarters(asOf, i),
    reportedDate: i === 0 ? asOf : shiftQuarters(asOf, i),
    reportedEps: "1.50", estimatedEps: "1.45", surprisePct: s,
  }));
  return makeEarningsHistory({ ticker, periods, provider: "alphavantage" });
}

export function emptyEarnings(ticker = "AAPL") {
  return makeEarningsHistory({ ticker, periods: [], provider: "alphavantage" });
}

export function unavailableEarnings(errorCode = "RATE_LIMITED", ticker = "AAPL") {
  return makeUnavailableEarnings({
    ticker, provider: "alphavantage",
    availability: EvidenceAvailability.PROVIDER_UNAVAILABLE,
    errorCode, message: "simulated provider failure (no request made)",
  });
}

function shiftQuarters(iso, quarters) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() - 3 * quarters);
  return d.toISOString().slice(0, 10);
}

/* ---------------- news fixtures (no HTTP, no quota) ---------------- */
import { makeNewsItem, makeNewsEvidence, makeUnavailableNews, NewsAvailability } from "../../src/schema/news.js";

const HOUR = 3600 * 1000;

/** hoursAgo: how old the item is relative to NOW. */
export function newsItem({ headline, publisher = "Test Wire", hoursAgo = 2, id = null, url = "https://example.com/a", contentType = "STORY", tickers = ["AAPL"] } = {}) {
  return makeNewsItem({
    id, headline, publisher, url,
    publishedAt: Math.floor((NOW.getTime() - hoursAgo * HOUR) / 1000),
    contentType, relatedTickers: tickers,
  });
}

export function news(items = [], ticker = "AAPL") {
  return makeNewsEvidence({ ticker, items, provider: "yahoo-news" });
}

/** Provider worked, company is genuinely quiet. */
export function quietNews(ticker = "AAPL") {
  return makeNewsEvidence({ ticker, items: [], provider: "yahoo-news" });
}

export function unavailableNews(errorCode = "PROVIDER_UNAVAILABLE", ticker = "AAPL") {
  return makeUnavailableNews({
    ticker, provider: "yahoo-news",
    availability: errorCode === "MALFORMED_RESPONSE" ? NewsAvailability.MALFORMED : NewsAvailability.PROVIDER_UNAVAILABLE,
    errorCode, message: "simulated provider failure (no request made)",
  });
}

/** A plain, well-formed but directionally unremarkable set of coverage. */
export function ordinaryNews() {
  return news([
    newsItem({ headline: "Apple opens new retail store in Mumbai", hoursAgo: 5, publisher: "Reuters" }),
    newsItem({ headline: "Apple named among most admired employers", hoursAgo: 20, publisher: "Fortune" }),
  ]);
}
