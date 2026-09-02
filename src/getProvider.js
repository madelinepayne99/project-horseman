import { config } from "./config.js";
import { TwelveDataProvider } from "./providers/TwelveDataProvider.js";
import { SimulatedProvider } from "./providers/SimulatedProvider.js";
import { MarketDataError, MarketDataErrorCodes } from "./providers/MarketDataProvider.js";

/**
 * Returns the provider to use for this request, based on configuration
 * alone — never per-request logic, never a fallback triggered by a prior
 * failure. This is called fresh on each request (cheap: just object
 * construction, no network call) rather than once at process startup, so
 * that on a serverless platform (no long-lived startup phase to crash) a
 * missing API key becomes a clean, structured per-request error instead
 * of an unhandled exception.
 *
 * Throws MarketDataError(SERVER_MISCONFIGURED) if HORSEMAN_MODE is "live"
 * (the default) and no TWELVE_DATA_API_KEY is set — deliberately distinct
 * from UNAUTHORISED, which means the provider itself rejected our key.
 * "We forgot to configure the server" and "the provider rejected us" must
 * never be reported as the same thing.
 */
export function getProvider() {
  if (config.mode === "demo") {
    return new SimulatedProvider();
  }
  if (!config.twelveData.apiKey) {
    throw new MarketDataError(
      "TWELVE_DATA_API_KEY is not set on the server. Add it in your deployment's environment variables (see VERCEL_DEPLOYMENT.md), or set HORSEMAN_MODE=demo to explicitly run in labelled simulated mode.",
      MarketDataErrorCodes.SERVER_MISCONFIGURED
    );
  }
  return new TwelveDataProvider(config.twelveData);
}
