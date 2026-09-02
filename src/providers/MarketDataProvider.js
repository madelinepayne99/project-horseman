/**
 * MarketDataProvider — the contract every market-data adapter must satisfy.
 *
 * This is the ONLY boundary the rest of Horseman is allowed to depend on.
 * Swapping Twelve Data for a different provider later means writing a new
 * class that implements this same method and changing one line of wiring
 * in server.js — nothing in technicals/, WAR, Death or the Council should
 * need to change.
 *
 * Implementations must:
 *   - return a NormalisedSeries (see src/schema/ohlcv.js), never a raw
 *     provider response
 *   - throw one of the typed errors below on failure, never fabricate data
 */

export class MarketDataError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "MarketDataError";
    this.code = code; // one of the CODES below
  }
}

export const MarketDataErrorCodes = Object.freeze({
  NOT_FOUND: "NOT_FOUND",           // ticker/symbol unknown to the provider
  RATE_LIMITED: "RATE_LIMITED",     // provider quota/rate limit hit
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE", // network/5xx/timeout, or a
                                                 // response that doesn't look
                                                 // like it came from the
                                                 // provider at all (e.g. a
                                                 // network/proxy block)
  UNAUTHORISED: "UNAUTHORISED",     // the PROVIDER rejected our key (confirmed
                                     // from a provider-shaped error body —
                                     // never inferred from status code alone)
  MALFORMED_RESPONSE: "MALFORMED_RESPONSE", // provider returned something we can't parse
  SERVER_MISCONFIGURED: "SERVER_MISCONFIGURED", // OUR server has no key configured —
                                                 // deliberately distinct from UNAUTHORISED
                                                 // so "we forgot to set an env var" is never
                                                 // reported as "the provider rejected us"
});

/**
 * @abstract
 */
export class MarketDataProvider {
  /**
   * @param {string} ticker
   * @returns {Promise<import('../schema/ohlcv.js').NormalisedSeries>}
   */
  // eslint-disable-next-line no-unused-vars
  async getDailySeries(ticker) {
    throw new Error("getDailySeries() must be implemented by a MarketDataProvider subclass");
  }
}
