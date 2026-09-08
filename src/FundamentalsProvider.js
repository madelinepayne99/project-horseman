import { MarketDataErrorCodes } from "./MarketDataProvider.js";

/**
 * FAMINE V2 — fundamentals/earnings provider contract.
 *
 * Deliberately reuses MarketDataErrorCodes rather than inventing a parallel
 * Famine taxonomy. The failure modes are identical in kind (provider down,
 * rate limited, we are misconfigured, symbol unknown, response unusable),
 * and one vocabulary means Death and Council can eventually reason about
 * provider failure the same way regardless of which Horseman hit it.
 *
 * MarketDataProvider.js is imported READ-ONLY and is not modified.
 */
export const FundamentalsErrorCodes = MarketDataErrorCodes;

export class FundamentalsError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "FundamentalsError";
    this.code = code;
  }
}

/**
 * Providers return normalised structures from src/schema/fundamentals.js.
 * They must NEVER return partially-vendor-shaped objects, and must NEVER
 * substitute 0 or a default for a figure the provider did not supply.
 *
 * Both methods either resolve with a normalised snapshot/history, or throw
 * a FundamentalsError carrying a classified code. Callers decide what a
 * failure means for Famine's confidence — the provider never decides that.
 *
 * Caching note: implementations take fetchedAt/cached fields in their
 * normalised output so a cache layer can be introduced later without
 * changing this contract or anything downstream. No caching is implemented
 * in this step.
 */
export class FundamentalsProvider {
  // eslint-disable-next-line no-unused-vars
  async getFundamentals(ticker) {
    throw new Error("getFundamentals() must be implemented by a provider");
  }

  // eslint-disable-next-line no-unused-vars
  async getEarningsHistory(ticker) {
    throw new Error("getEarningsHistory() must be implemented by a provider");
  }
}
