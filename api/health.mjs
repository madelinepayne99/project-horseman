// Vercel Node.js Function — GET /api/health
//
// Diagnostic endpoint only. Reports:
//   - ok: the function itself is running
//   - mode: "live" or "demo"
//   - apiKeyConfigured: true/false — NEVER the key itself
//   - (with ?probe=1) providerReachable: whether a real Twelve Data call
//     succeeded, and providerErrorCode if not — never the raw provider
//     error body, which can contain information we don't want to hand to
//     an unauthenticated caller (see the P0 security requirement from an
//     earlier phase: never expose provider error bodies to the browser).
//
// The probe is opt-in (costs one real API call against your Twelve Data
// quota) rather than run on every health check.

import { config } from "../src/config.js";
import { getProvider } from "../src/getProvider.js";
import { MarketDataError } from "../src/providers/MarketDataProvider.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const shouldProbe = url.searchParams.get("probe") === "1";

  const body = {
    ok: true,
    mode: config.mode,
    apiKeyConfigured: !!config.twelveData.apiKey,
    timestamp: new Date().toISOString(),
  };

  if (shouldProbe) {
    if (config.mode === "demo") {
      body.providerReachable = null;
      body.providerNote = "HORSEMAN_MODE=demo — no real provider call is made.";
    } else if (!body.apiKeyConfigured) {
      body.providerReachable = false;
      body.providerErrorCode = "SERVER_MISCONFIGURED";
      body.providerErrorMessage = "TWELVE_DATA_API_KEY is not set on the server.";
    } else {
      try {
        const provider = getProvider();
        const series = await provider.getDailySeries("AAPL");
        body.providerReachable = true;
        body.probeSymbol = "AAPL";
        body.probeCandlesReceived = series.points.length;
        body.probeLatestDate = series.points[series.points.length - 1]?.date || null;
      } catch (err) {
        body.providerReachable = false;
        body.providerErrorCode = err instanceof MarketDataError ? err.code : "UNKNOWN";
        // Our own classified/authored message (e.g. "Symbol not found: AAPL"),
        // consistent with /api/market-data — never the provider's raw
        // response body, which is logged server-side only.
        body.providerErrorMessage = err instanceof MarketDataError ? err.message : "Unexpected error.";
      }
    }
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
