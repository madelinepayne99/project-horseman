import { test } from "node:test";
import assert from "node:assert/strict";
import { AlphaVantageProvider, fundamentalsFromError, earningsFromError } from "../src/providers/AlphaVantageProvider.js";
import { FundamentalsError, FundamentalsErrorCodes } from "../src/providers/FundamentalsProvider.js";
import { isPresent, factValue, EvidenceAvailability } from "../src/schema/fundamentals.js";

function withMockFetch(factory, fn) {
  const original = global.fetch;
  global.fetch = async (...args) => factory(...args);
  return fn().finally(() => { global.fetch = original; });
}
const resp = ({ status = 200, jsonBody, textBody } = {}) => ({
  status, ok: status >= 200 && status < 300,
  text: async () => textBody !== undefined ? textBody : JSON.stringify(jsonBody),
});
const provider = () => new AlphaVantageProvider({ apiKey: "test-key", baseUrl: "https://example.invalid" });

const OVERVIEW_OK = {
  Symbol: "AAPL", Name: "Apple Inc.", Currency: "USD", Exchange: "NASDAQ",
  Sector: "TECHNOLOGY", Industry: "ELECTRONIC COMPUTERS",
  QuarterlyRevenueGrowthYOY: "0.164", QuarterlyEarningsGrowthYOY: "0.287",
  ProfitMargin: "0.276", EPS: "8.71", PERatio: "37.33", LatestQuarter: "2026-06-30",
};
const EARNINGS_OK = {
  symbol: "AAPL",
  annualEarnings: [{ fiscalDateEnding: "2025-09-30", reportedEPS: "6.75" }],
  quarterlyEarnings: [
    { fiscalDateEnding: "2026-06-30", reportedDate: "2026-07-30", reportedEPS: "1.57", estimatedEPS: "1.4618", surprise: "0.1082", surprisePercentage: "7.4" },
    { fiscalDateEnding: "2026-03-31", reportedDate: "2026-05-01", reportedEPS: "1.53", estimatedEPS: "1.50", surprise: "0.03", surprisePercentage: "2.0" },
  ],
};

test("healthy OVERVIEW normalises into the provider-neutral snapshot", async () => {
  await withMockFetch(() => resp({ jsonBody: OVERVIEW_OK }), async () => {
    const snap = await provider().getFundamentals("AAPL");
    assert.equal(snap.availability, EvidenceAvailability.PRESENT);
    assert.equal(snap.ticker, "AAPL");
    assert.equal(snap.companyName, "Apple Inc.");
    assert.equal(factValue(snap.facts.revenueGrowthYoY), 0.164);
    assert.equal(factValue(snap.facts.earningsGrowthYoY), 0.287);
    assert.equal(factValue(snap.facts.profitMargin), 0.276);
    assert.equal(factValue(snap.facts.eps), 8.71);
    assert.equal(factValue(snap.facts.peRatio), 37.33);
    assert.equal(snap.asOf, "2026-06-30");
    assert.equal(snap.source.provider, "alphavantage");
  });
});

test("Alpha Vantage's 'None' values stay MISSING and never become 0", async () => {
  const body = { ...OVERVIEW_OK, QuarterlyEarningsGrowthYOY: "None", PERatio: "None", ProfitMargin: "-" };
  await withMockFetch(() => resp({ jsonBody: body }), async () => {
    const snap = await provider().getFundamentals("AAPL");
    assert.equal(isPresent(snap.facts.earningsGrowthYoY), false);
    assert.equal(snap.facts.earningsGrowthYoY.value, null);
    assert.equal(isPresent(snap.facts.peRatio), false);
    assert.equal(isPresent(snap.facts.profitMargin), false);
    // Present values are unaffected.
    assert.equal(factValue(snap.facts.revenueGrowthYoY), 0.164);
    // The category was still obtained — this is partial, not an outage.
    assert.equal(snap.availability, EvidenceAvailability.PRESENT);
  });
});

test("healthy EARNINGS normalises into provider-neutral periods", async () => {
  await withMockFetch(() => resp({ jsonBody: EARNINGS_OK }), async () => {
    const hist = await provider().getEarningsHistory("AAPL");
    assert.equal(hist.availability, EvidenceAvailability.PRESENT);
    assert.equal(hist.periods.length, 2);
    assert.equal(hist.mostRecentPeriodEnd, "2026-06-30");
    assert.equal(hist.mostRecentReportedDate, "2026-07-30");
    assert.equal(factValue(hist.periods[0].surprisePct), 7.4);
    assert.equal(factValue(hist.periods[0].reportedEps), 1.57);
    assert.equal(factValue(hist.periods[0].estimatedEps), 1.4618);
  });
});

test("an EARNINGS response with an empty quarterly array is EMPTY, not an outage", async () => {
  await withMockFetch(() => resp({ jsonBody: { symbol: "NEWCO", quarterlyEarnings: [] } }), async () => {
    const hist = await provider().getEarningsHistory("NEWCO");
    assert.equal(hist.availability, EvidenceAvailability.EMPTY);
    assert.notEqual(hist.availability, EvidenceAvailability.PROVIDER_UNAVAILABLE);
  });
});

/* ---------------- error classification ---------------- */

test("rate limiting is classified as RATE_LIMITED, distinguishable from any neutral result", async () => {
  // Alpha Vantage's daily-cap message arrives on HTTP 200 in "Information".
  await withMockFetch(
    () => resp({ jsonBody: { Information: "We have detected your API key ... our standard API rate limit is 25 requests per day." } }),
    async () => {
      await assert.rejects(() => provider().getFundamentals("AAPL"), err => {
        assert.ok(err instanceof FundamentalsError);
        assert.equal(err.code, FundamentalsErrorCodes.RATE_LIMITED);
        return true;
      });
    }
  );
  // The legacy per-minute cap arrives in "Note".
  await withMockFetch(
    () => resp({ jsonBody: { Note: "Thank you for using Alpha Vantage! Please consider spreading out your free API requests." } }),
    async () => {
      await assert.rejects(() => provider().getFundamentals("AAPL"),
        err => err.code === FundamentalsErrorCodes.RATE_LIMITED);
    }
  );
});

test("a rate-limited fundamentals request becomes explicitly unavailable, never neutral", async () => {
  const err = new FundamentalsError("daily cap", FundamentalsErrorCodes.RATE_LIMITED);
  const snap = fundamentalsFromError("AAPL", err);
  assert.equal(snap.availability, EvidenceAvailability.PROVIDER_UNAVAILABLE);
  assert.equal(snap.errorCode, "RATE_LIMITED");
  assert.equal(isPresent(snap.facts.revenueGrowthYoY), false);
  assert.equal(snap.facts.revenueGrowthYoY.value, null);
  assert.equal(snap.asOf, null);
});

test("provider unreachable is PROVIDER_UNAVAILABLE", async () => {
  const original = global.fetch;
  global.fetch = async () => { throw new Error("getaddrinfo ENOTFOUND"); };
  try {
    await assert.rejects(() => provider().getFundamentals("AAPL"),
      err => err.code === FundamentalsErrorCodes.PROVIDER_UNAVAILABLE);
  } finally { global.fetch = original; }
});

test("a non-Alpha-Vantage body (proxy/block page) is PROVIDER_UNAVAILABLE, not a data problem", async () => {
  await withMockFetch(
    () => resp({ status: 403, textBody: "Host not in allowlist: www.alphavantage.co" }),
    async () => {
      await assert.rejects(() => provider().getFundamentals("AAPL"),
        err => err.code === FundamentalsErrorCodes.PROVIDER_UNAVAILABLE);
    }
  );
});

test("missing API key is SERVER_MISCONFIGURED, not a provider rejection", async () => {
  const p = new AlphaVantageProvider({ apiKey: null, baseUrl: "https://example.invalid" });
  await assert.rejects(() => p.getFundamentals("AAPL"),
    err => err.code === FundamentalsErrorCodes.SERVER_MISCONFIGURED);
});

test("an unknown symbol is NOT_FOUND — both the empty-object and Error Message forms", async () => {
  await withMockFetch(() => resp({ jsonBody: {} }), async () => {
    await assert.rejects(() => provider().getFundamentals("ZZZZ"),
      err => err.code === FundamentalsErrorCodes.NOT_FOUND);
  });
  await withMockFetch(
    () => resp({ jsonBody: { "Error Message": "Invalid API call." } }),
    async () => {
      await assert.rejects(() => provider().getFundamentals("ZZZZ"),
        err => err.code === FundamentalsErrorCodes.NOT_FOUND);
    }
  );
});

test("a structurally wrong response is MALFORMED_RESPONSE and maps to MALFORMED availability", async () => {
  await withMockFetch(() => resp({ jsonBody: { symbol: "AAPL", note: "no quarterly array" } }), async () => {
    await assert.rejects(() => provider().getEarningsHistory("AAPL"),
      err => err.code === FundamentalsErrorCodes.MALFORMED_RESPONSE);
  });
  const hist = earningsFromError("AAPL", new FundamentalsError("bad", FundamentalsErrorCodes.MALFORMED_RESPONSE));
  assert.equal(hist.availability, EvidenceAvailability.MALFORMED);
  assert.notEqual(hist.availability, EvidenceAvailability.EMPTY);
});

/* ---------------- leakage guards ---------------- */

test("no raw Alpha Vantage field names leak into the normalised contract", async () => {
  await withMockFetch(url => {
    return String(url).includes("EARNINGS") ? resp({ jsonBody: EARNINGS_OK }) : resp({ jsonBody: OVERVIEW_OK });
  }, async () => {
    const snap = await provider().getFundamentals("AAPL");
    const hist = await provider().getEarningsHistory("AAPL");

    // providerMeta is explicitly allowed to carry vendor extras; the
    // normalised surface must not.
    const snapKeys = JSON.stringify({ ...snap, source: { ...snap.source, providerMeta: null } });
    const histKeys = JSON.stringify({ ...hist, source: { ...hist.source, providerMeta: null } });
    for (const vendor of [
      "QuarterlyRevenueGrowthYOY", "QuarterlyEarningsGrowthYOY", "ProfitMargin",
      "PERatio", "LatestQuarter", "quarterlyEarnings", "annualEarnings",
      "reportedEPS", "estimatedEPS", "surprisePercentage", "fiscalDateEnding",
    ]) {
      assert.ok(!snapKeys.includes(vendor), `${vendor} leaked into fundamentals`);
      assert.ok(!histKeys.includes(vendor), `${vendor} leaked into earnings`);
    }
  });
});

test("the provider fabricates no direction, confidence or score", async () => {
  await withMockFetch(() => resp({ jsonBody: OVERVIEW_OK }), async () => {
    const snap = await provider().getFundamentals("AAPL");
    const serialised = JSON.stringify(snap).toLowerCase();
    for (const banned of ["direction", "confidence", "bullish", "bearish", "verdict", "score"]) {
      assert.ok(!serialised.includes(banned), `${banned} must not be produced by the provider layer`);
    }
  });
});
