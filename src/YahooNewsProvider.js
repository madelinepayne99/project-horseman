import { MarketDataErrorCodes } from "./MarketDataProvider.js";
import { makeNewsItem, makeNewsEvidence, makeUnavailableNews, NewsAvailability } from "../schema/news.js";

/**
 * FAMINE V2 — news provider contract + Yahoo adapter.
 *
 * Reuses MarketDataErrorCodes for the same reason FundamentalsProvider does:
 * one failure vocabulary across the system. MarketDataProvider.js is
 * imported read-only and not modified.
 *
 * COMMERCIAL CAVEAT: Yahoo's search endpoint is undocumented and unofficial,
 * with no SLA and unclear licensing for a paid product. Acceptable for
 * prototype/beta only. All vendor knowledge is confined to this file, so
 * replacing it later means writing one adapter.
 */
export const NewsErrorCodes = MarketDataErrorCodes;

export class NewsError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "NewsError";
    this.code = code;
  }
}

export class NewsProvider {
  // eslint-disable-next-line no-unused-vars
  async getCompanyNews(ticker) {
    throw new Error("getCompanyNews() must be implemented by a provider");
  }
}

const DEFAULT_COUNT = 20; // headroom for de-duplication and relevance filtering

export class YahooNewsProvider extends NewsProvider {
  constructor({ baseUrl = "https://query1.finance.yahoo.com", newsCount = DEFAULT_COUNT } = {}) {
    super();
    this.baseUrl = baseUrl;
    this.newsCount = newsCount;
  }

  async getCompanyNews(ticker) {
    const url = new URL("/v1/finance/search", this.baseUrl);
    url.searchParams.set("q", ticker);
    url.searchParams.set("quotesCount", "1");
    url.searchParams.set("newsCount", String(this.newsCount));

    let res;
    try {
      res = await fetch(url.toString(), {
        method: "GET",
        headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (compatible; Horseman/1.0)" },
      });
    } catch (networkErr) {
      throw new NewsError(`Could not reach the news provider: ${networkErr.message}`, NewsErrorCodes.PROVIDER_UNAVAILABLE);
    }

    const rawText = await res.text();
    let body = null;
    try { body = JSON.parse(rawText); } catch { /* handled below */ }

    if (!body || typeof body !== "object") {
      console.error(
        `[YahooNewsProvider] Unexpected non-JSON response (HTTP ${res.status}) for ${ticker}. ` +
        `First 300 chars: ${rawText.slice(0, 300)}`
      );
      throw new NewsError(
        `Received an HTTP ${res.status} response that does not look like a news response ` +
        `(possible network/proxy issue). See server logs.`,
        NewsErrorCodes.PROVIDER_UNAVAILABLE
      );
    }

    if (res.status === 429) throw new NewsError("News provider rate limit exceeded", NewsErrorCodes.RATE_LIMITED);
    if (res.status >= 500) throw new NewsError(`News provider server error (${res.status})`, NewsErrorCodes.PROVIDER_UNAVAILABLE);
    if (!res.ok) throw new NewsError(`News provider returned HTTP ${res.status}`, NewsErrorCodes.PROVIDER_UNAVAILABLE);

    if (!Array.isArray(body.news)) {
      throw new NewsError(`News response for ${ticker} had no news array`, NewsErrorCodes.MALFORMED_RESPONSE);
    }

    // Vendor field names appear here and nowhere else.
    const items = body.news.map(n => n && makeNewsItem({
      id: n.uuid,
      headline: n.title,
      publisher: n.publisher,
      url: n.link,
      publishedAt: n.providerPublishTime,
      contentType: n.type,
      relatedTickers: n.relatedTickers,
    })).filter(Boolean);

    // An empty-but-successful search is NO_RECENT_NEWS, decided by
    // makeNewsEvidence from the content — never confused with a failure.
    return makeNewsEvidence({ ticker, items, provider: "yahoo-news" });
  }
}

export function newsFromError(ticker, err, provider = "yahoo-news") {
  return makeUnavailableNews({
    ticker, provider,
    availability: err && err.code === NewsErrorCodes.MALFORMED_RESPONSE
      ? NewsAvailability.MALFORMED
      : NewsAvailability.PROVIDER_UNAVAILABLE,
    errorCode: (err && err.code) || "UNKNOWN",
    message: (err && err.message) || null,
  });
}
