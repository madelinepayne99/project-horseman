import { MarketDataErrorCodes } from "./MarketDataProvider.js";
import {
  makeUnavailableCrowdEvidence, CrowdAvailability, AssetType, EvidenceOrigin,
} from "../schema/crowd.js";

/**
 * CONQUEST V2 — crowd evidence provider contract.
 *
 * STATUS: INERT. No implementation exists and nothing selects a crowd
 * provider. This defines the seam so a public discussion source can later
 * be added as ONE adapter, exactly as YahooProvider was for War and
 * AlphaVantageProvider for Famine.
 *
 * Reuses MarketDataErrorCodes rather than inventing a third failure
 * vocabulary — the failure modes are identical in kind (provider down,
 * rate limited, we are misconfigured, asset unknown, response unusable),
 * and one vocabulary means Death and Council can eventually reason about
 * provider failure the same way whichever Horseman hit it.
 * MarketDataProvider.js is imported READ-ONLY and is not modified.
 *
 * NOT DECIDED HERE, deliberately: which provider, which API, what terms
 * of service allow. Those are product and legal decisions that must
 * precede any adapter.
 */
export const CrowdErrorCodes = MarketDataErrorCodes;

export class CrowdError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "CrowdError";
    this.code = code;
  }
}

export class CrowdProvider {
  /**
   * Implementations return a normalised structure from src/schema/crowd.js,
   * or throw a CrowdError carrying a classified code.
   *
   * They must NEVER:
   *   - return partially vendor-shaped objects
   *   - substitute 0 or a default for a measure the source did not supply
   *   - infer a stance the source did not provide
   *   - report an outage as quiet activity
   *
   * A provider's job is to observe and normalise. Deciding what the
   * observation MEANS belongs to Conquest's analysis stage, and deciding
   * whether the evidence is strong enough to support a directional claim
   * belongs there too.
   *
   * @param {string} assetId          ticker or asset identifier
   * @param {object} [options]
   * @param {string} [options.assetType] AssetType member; defaults to EQUITY
   * @param {string} [options.since]     ISO timestamp lower bound for the window
   */
  // eslint-disable-next-line no-unused-vars
  async getCrowdEvidence(assetId, options = {}) {
    throw new Error("getCrowdEvidence() must be implemented by a crowd provider");
  }

  /**
   * Identity used in provenance and, later, cache keys. Overridden by
   * implementations; the class name is a stable fallback.
   */
  get providerId() {
    return this.constructor?.name || "crowd-provider";
  }
}

/**
 * Turns a thrown CrowdError into the explicit "we could not obtain this"
 * structure. MALFORMED_RESPONSE maps to MALFORMED; everything else maps to
 * PROVIDER_UNAVAILABLE. Neither is ever NO_RECENT_ACTIVITY — an outage
 * must never be reportable as a quiet crowd.
 */
export function crowdEvidenceFromError(assetId, err, {
  provider = "crowd-provider", assetType = AssetType.EQUITY,
} = {}) {
  return makeUnavailableCrowdEvidence({
    assetId, provider, assetType,
    availability: err && err.code === CrowdErrorCodes.MALFORMED_RESPONSE
      ? CrowdAvailability.MALFORMED
      : CrowdAvailability.PROVIDER_UNAVAILABLE,
    errorCode: (err && err.code) || "UNKNOWN",
    message: (err && err.message) || null,
  });
}

export { CrowdAvailability, AssetType, EvidenceOrigin };
