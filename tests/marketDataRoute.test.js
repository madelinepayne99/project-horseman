import { test } from "node:test";
import assert from "node:assert/strict";
import { createMarketDataHandler } from "../src/routes/marketDataRoute.js";
import { MarketDataError, MarketDataErrorCodes } from "../src/providers/MarketDataProvider.js";

function fakeRes() {
  const res = {
    statusCode: null,
    body: null,
    writeHead(code) { res.statusCode = code; },
    end(payload) { res.body = payload ? JSON.parse(payload) : null; },
  };
  return res;
}

test("route: missing ticker returns 400", async () => {
  const handler = createMarketDataHandler(() => { throw new Error("should not be called"); });
  const res = fakeRes();
  await handler({}, res, {});
  assert.equal(res.statusCode, 400);
});

test("route: getProvider throwing SERVER_MISCONFIGURED returns 500 with that code, not UNAUTHORISED", async () => {
  const getProvider = () => {
    throw new MarketDataError("TWELVE_DATA_API_KEY is not set on the server.", MarketDataErrorCodes.SERVER_MISCONFIGURED);
  };
  const handler = createMarketDataHandler(getProvider);
  const res = fakeRes();
  await handler({}, res, { ticker: "AAPL" });
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.code, "SERVER_MISCONFIGURED");
  assert.equal(res.body.status, "DATA_UNAVAILABLE");
});

test("route: a provider NOT_FOUND error returns 404", async () => {
  const getProvider = () => ({
    getDailySeries: async () => { throw new MarketDataError("Symbol not found: ZZZZ", MarketDataErrorCodes.NOT_FOUND); },
  });
  const handler = createMarketDataHandler(getProvider);
  const res = fakeRes();
  await handler({}, res, { ticker: "ZZZZ" });
  assert.equal(res.statusCode, 404);
});

test("route: a successful provider call returns 200 with a warInput object", async () => {
  const now = Date.now();
  const points = Array.from({ length: 210 }, (_, i) => ({
    date: new Date(now - (209 - i) * 86400000).toISOString().slice(0, 10),
    timestamp: now - (209 - i) * 86400000,
    open: 100 + i * 0.1,
    high: 100.5 + i * 0.1,
    low: 99.5 + i * 0.1,
    close: 100 + i * 0.1,
    volume: 1000000,
  }));
  const getProvider = () => ({
    getDailySeries: async () => ({
      ticker: "AAPL",
      companyName: "Apple Inc.",
      points,
      source: { provider: "twelvedata", simulated: false, fetchedAt: new Date().toISOString(), exchange: "NASDAQ", country: "United States", exchangeTimezone: "America/New_York", providerMeta: { exchange: "NASDAQ", country: "United States" } },
    }),
  });
  const handler = createMarketDataHandler(getProvider);
  const res = fakeRes();
  await handler({}, res, { ticker: "AAPL" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ticker, "AAPL");
  assert.ok(res.body.warInput);
  assert.equal(res.body.warInput.dataStatus, "COMPLETE");
});
