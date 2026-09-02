import { test } from "node:test";
import assert from "node:assert/strict";
import { TwelveDataProvider } from "../src/providers/TwelveDataProvider.js";
import { MarketDataError, MarketDataErrorCodes } from "../src/providers/MarketDataProvider.js";

function withMockFetch(responseFactory, fn) {
  const original = global.fetch;
  global.fetch = async (...args) => responseFactory(...args);
  return fn().finally(() => { global.fetch = original; });
}

function fakeResponse({ status, jsonBody, textBody }) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => textBody !== undefined ? textBody : JSON.stringify(jsonBody),
  };
}

test("TwelveDataProvider: a non-JSON 401/403 (e.g. a network/proxy block) is PROVIDER_UNAVAILABLE, never UNAUTHORISED", async () => {
  // This is the exact bug found via live debugging: this sandbox's own
  // egress proxy returns a 403 with a plain-text body when a host isn't
  // allowlisted — that must never be reported to the user as "Twelve Data
  // rejected the API key", because Twelve Data never saw the request.
  await withMockFetch(
    () => fakeResponse({ status: 403, textBody: "Host not in allowlist: api.twelvedata.com. Add this host to your network egress settings to allow access." }),
    async () => {
      const provider = new TwelveDataProvider({ apiKey: "any-key", baseUrl: "https://example.invalid" });
      await assert.rejects(
        () => provider.getDailySeries("AAPL"),
        (err) => {
          assert.ok(err instanceof MarketDataError);
          assert.equal(err.code, MarketDataErrorCodes.PROVIDER_UNAVAILABLE);
          return true;
        }
      );
    }
  );
});

test("TwelveDataProvider: a genuine Twelve-Data-shaped 401 error body IS classified as UNAUTHORISED", async () => {
  await withMockFetch(
    () => fakeResponse({ status: 401, jsonBody: { status: "error", code: 401, message: "Invalid API key." } }),
    async () => {
      const provider = new TwelveDataProvider({ apiKey: "bad-key", baseUrl: "https://example.invalid" });
      await assert.rejects(
        () => provider.getDailySeries("AAPL"),
        (err) => {
          assert.equal(err.code, MarketDataErrorCodes.UNAUTHORISED);
          return true;
        }
      );
    }
  );
});

test("TwelveDataProvider: a Twelve-Data-shaped 'symbol not found' error is classified as NOT_FOUND", async () => {
  await withMockFetch(
    () => fakeResponse({ status: 400, jsonBody: { status: "error", code: 400, message: "**symbol** not found: ZZZZINVALID" } }),
    async () => {
      const provider = new TwelveDataProvider({ apiKey: "k", baseUrl: "https://example.invalid" });
      await assert.rejects(
        () => provider.getDailySeries("ZZZZINVALID"),
        (err) => {
          assert.equal(err.code, MarketDataErrorCodes.NOT_FOUND);
          return true;
        }
      );
    }
  );
});

test("TwelveDataProvider: a rate-limit error is classified as RATE_LIMITED", async () => {
  await withMockFetch(
    () => fakeResponse({ status: 429, jsonBody: { status: "error", code: 429, message: "You have run out of API credits for the day. Rate limit exceeded." } }),
    async () => {
      const provider = new TwelveDataProvider({ apiKey: "k", baseUrl: "https://example.invalid" });
      await assert.rejects(
        () => provider.getDailySeries("AAPL"),
        (err) => {
          assert.equal(err.code, MarketDataErrorCodes.RATE_LIMITED);
          return true;
        }
      );
    }
  );
});

test("TwelveDataProvider: a successful response is normalised correctly, including out-of-order (descending) input", async () => {
  await withMockFetch(
    () => fakeResponse({
      status: 200,
      jsonBody: {
        status: "ok",
        meta: { symbol: "AAPL", currency: "USD", exchange: "NASDAQ", country: "United States" },
        values: [
          // Twelve Data's documented default order is descending (newest first).
          { datetime: "2026-01-03", open: "102.0", high: "103.0", low: "101.0", close: "102.5", volume: "1000" },
          { datetime: "2026-01-02", open: "101.0", high: "102.0", low: "100.0", close: "101.5", volume: "1100" },
          { datetime: "2026-01-01", open: "100.0", high: "101.0", low: "99.0", close: "100.5", volume: "1200" },
        ],
      },
    }),
    async () => {
      const provider = new TwelveDataProvider({ apiKey: "k", baseUrl: "https://example.invalid" });
      const series = await provider.getDailySeries("AAPL");
      assert.equal(series.points.length, 3);
      // Must come out ascending regardless of the provider's own order.
      assert.equal(series.points[0].date, "2026-01-01");
      assert.equal(series.points[2].date, "2026-01-03");
      // String-typed provider values must be parsed to numbers.
      assert.equal(typeof series.points[0].close, "number");
      assert.equal(series.points[0].close, 100.5);
      assert.equal(series.source.providerMeta.exchange, "NASDAQ");
      assert.equal(series.source.simulated, false);
    }
  );
});

test("TwelveDataProvider: a network-level failure (fetch throws) is PROVIDER_UNAVAILABLE", async () => {
  const original = global.fetch;
  global.fetch = async () => { throw new Error("getaddrinfo ENOTFOUND"); };
  try {
    const provider = new TwelveDataProvider({ apiKey: "k", baseUrl: "https://example.invalid" });
    await assert.rejects(
      () => provider.getDailySeries("AAPL"),
      (err) => {
        assert.equal(err.code, MarketDataErrorCodes.PROVIDER_UNAVAILABLE);
        return true;
      }
    );
  } finally {
    global.fetch = original;
  }
});
