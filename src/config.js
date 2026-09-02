// Central place that reads process.env. Nothing here is ever sent to the
// browser — routes only ever return the normalised data objects built in
// src/technicals, never this config object itself.
//
// Misconfiguration (missing API key in live mode) is handled per-request
// in src/getProvider.js, not by crashing at startup here — see that file
// for why (serverless platforms have no long-lived startup phase to fail
// loudly during; a clean per-request error is the honest equivalent).

export const config = {
  port: parseInt(process.env.PORT || "8787", 10),
  twelveData: {
    apiKey: process.env.TWELVE_DATA_API_KEY || null,
    // Overridable for diagnostics/testing (e.g. pointing at a local mock
    // server that mirrors Twelve Data's response shape). Defaults to the
    // real Twelve Data endpoint in every normal deployment.
    baseUrl: process.env.TWELVE_DATA_BASE_URL || "https://api.twelvedata.com",
  },
  // "live" (default) never falls back to simulated data on failure.
  // "demo" forces the simulated provider and labels every response as such.
  mode: (process.env.HORSEMAN_MODE || "live").toLowerCase(),
};
