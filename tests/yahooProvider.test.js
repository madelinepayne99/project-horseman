import { test } from "node:test";
import assert from "node:assert/strict";
import { YahooProvider, mapYahooExchange, tradingDateFromEpoch } from "../src/providers/YahooProvider.js";
import { MarketDataError, MarketDataErrorCodes } from "../src/providers/MarketDataProvider.js";
import { buildWarInput } from "../src/technicals/buildWarInput.js";
import { deriveTechnicalFacts } from "../src/technicals/deriveTechnicalFacts.js";

/**
 * YahooProvider is built but UNWIRED. These tests cover the adapter in
 * isolation: normalisation, index alignment, canonical metadata, and that
 * its output feeds the existing War V2 pipeline with no provider-specific
 * handling anywhere downstream.
 */

const DAY = 86400;
// 2026-09-02 14:30 UTC == 09:30 America/New_York (a regular session open).
const SESSION_OPEN_UTC = Math.floor(Date.parse("2026-09-02T13:30:00Z") / 1000);

function withMockFetch(responseFactory, fn) {
  const original = global.fetch;
  global.fetch = async (...args) => responseFactory(...args);
  return fn().finally(() => { global.fetch = original; });
}

function fakeResponse({ status = 200, jsonBody, textBody } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => textBody !== undefined ? textBody : JSON.stringify(jsonBody),
  };
}

function chartBody({ n = 5, meta = {}, mutate = null } = {}) {
  const timestamp = [], open = [], high = [], low = [], close = [], volume = [];
  for (let i = 0; i < n; i++) {
    // Oldest first, matching Yahoo's own ordering.
    timestamp.push(SESSION_OPEN_UTC - (n - 1 - i) * DAY);
    const c = 100 + i;
    open.push(c - 0.5); high.push(c + 1); low.push(c - 1); close.push(c);
    volume.push(1000 + i);
  }
  const result = {
    meta: {
      symbol: "AAPL", currency: "USD", exchangeName: "NMS",
      fullExchangeName: "NasdaqGS", exchangeTimezoneName: "America/New_York",
      shortName: "Apple Inc.", instrumentType: "EQUITY",
      ...meta,
    },
    timestamp,
    indicators: {
      quote: [{ open, high, low, close, volume }],
      // Deliberately different values so a switch to adjclose is detectable.
      adjclose: [{ adjclose: close.map(c => c - 10) }],
    },
  };
  if (mutate) mutate(result);
  return { chart: { result: [result], error: null } };
}

const provider = () => new YahooProvider({ baseUrl: "https://example.invalid" });

test("mapYahooExchange(): maps only the evidenced US codes and refuses to guess", () => {
  assert.equal(mapYahooExchange("NMS"), "NASDAQ");
  assert.equal(mapYahooExchange("NYQ"), "NYSE");
  assert.equal(mapYahooExchange("nms"), "NASDAQ", "case-insensitive");
  // Plausible but unverified codes must NOT be reclassified as supported.
  for (const unknown of ["NGM", "NCM", "ASE", "PCX", "BTS", "IEX", "LSE", "GER", "CCC", "", null, undefined]) {
    assert.equal(mapYahooExchange(unknown), null, `${unknown} must not be silently mapped`);
  }
});

test("tradingDateFromEpoch(): renders the exchange-local trading date", () => {
  assert.equal(tradingDateFromEpoch(SESSION_OPEN_UTC, "America/New_York"), "2026-09-02");
  // An unusable zone falls back to UTC rather than throwing.
  assert.equal(tradingDateFromEpoch(SESSION_OPEN_UTC, "Not/AZone"), "2026-09-02");
});

test("valid Yahoo chart data normalises into the shared series contract", async () => {
  await withMockFetch(() => fakeResponse({ jsonBody: chartBody({ n: 5 }) }), async () => {
    const series = await provider().getDailySeries("AAPL");

    assert.equal(series.ticker, "AAPL");
    assert.equal(series.companyName, "Apple Inc.");
    assert.equal(series.currency, "USD");
    assert.equal(series.points.length, 5);
    assert.equal(series.source.provider, "yahoo");
    assert.equal(series.source.simulated, false);
    assert.equal(series.source.requestedTicker, "AAPL");
    // Numeric, not strings.
    for (const k of ["open", "high", "low", "close", "volume"]) {
      assert.equal(typeof series.points[0][k], "number", `${k} must be numeric`);
    }
  });
});

test("canonical metadata is produced; Yahoo-specific names stay in providerMeta", async () => {
  await withMockFetch(() => fakeResponse({ jsonBody: chartBody({}) }), async () => {
    const series = await provider().getDailySeries("AAPL");
    assert.equal(series.source.exchange, "NASDAQ");
    assert.equal(series.source.exchangeTimezone, "America/New_York");
    // Yahoo's chart meta has no country field — null, never invented.
    assert.equal(series.source.country, null);
    // Vendor names remain available for debugging only.
    assert.equal(series.source.providerMeta.exchangeName, "NMS");
    assert.equal(series.source.providerMeta.fullExchangeName, "NasdaqGS");
  });
});

test("an unknown exchange yields a null canonical exchange and stays unsupported", async () => {
  await withMockFetch(
    () => fakeResponse({ jsonBody: chartBody({ n: 210, meta: { exchangeName: "PCX" } }) }),
    async () => {
      const series = await provider().getDailySeries("SPY");
      assert.equal(series.source.exchange, null);
      // And the pipeline must reject it rather than assume eligibility.
      const war = buildWarInput(series);
      assert.equal(war.dataStatus, "UNSUPPORTED_SECURITY");
    }
  );
});

test("index alignment: a null close drops the WHOLE bar, shifting nothing", async () => {
  const body = chartBody({ n: 5, mutate: r => {
    r.indicators.quote[0].close[2] = null; // the 102 bar
  }});
  await withMockFetch(() => fakeResponse({ jsonBody: body }), async () => {
    const series = await provider().getDailySeries("AAPL");
    assert.equal(series.points.length, 4, "the incomplete bar is dropped");
    // The remaining bars keep their own values — nothing slid across.
    assert.deepEqual(series.points.map(p => p.close), [100, 101, 103, 104]);
    assert.deepEqual(series.points.map(p => p.volume), [1000, 1001, 1003, 1004]);
    assert.deepEqual(series.points.map(p => p.open), [99.5, 100.5, 102.5, 103.5]);
  });
});

test("index alignment: a null volume keeps its bar and does not pull another bar's volume in", async () => {
  const body = chartBody({ n: 5, mutate: r => {
    r.indicators.quote[0].volume[1] = null;
  }});
  await withMockFetch(() => fakeResponse({ jsonBody: body }), async () => {
    const series = await provider().getDailySeries("AAPL");
    assert.equal(series.points.length, 5, "a missing volume must not drop the bar");
    assert.equal(series.points[1].close, 101, "the bar keeps its own close");
    assert.equal(series.points[1].volume, null, "the missing volume is null, not a neighbour's value");
    assert.equal(series.points[2].volume, 1002, "the following bar is untouched");
  });
});

test("index alignment: a null timestamp drops the whole bar", async () => {
  const body = chartBody({ n: 5, mutate: r => { r.timestamp[0] = null; } });
  await withMockFetch(() => fakeResponse({ jsonBody: body }), async () => {
    const series = await provider().getDailySeries("AAPL");
    assert.equal(series.points.length, 4);
    assert.deepEqual(series.points.map(p => p.close), [101, 102, 103, 104]);
  });
});

test("raw quote close is used, never adjclose", async () => {
  // The fixture's adjclose is deliberately 10 lower than close.
  await withMockFetch(() => fakeResponse({ jsonBody: chartBody({ n: 5 }) }), async () => {
    const series = await provider().getDailySeries("AAPL");
    assert.deepEqual(series.points.map(p => p.close), [100, 101, 102, 103, 104]);
    assert.ok(!series.points.some(p => p.close <= 94), "adjclose values must not appear");
  });
});

test("bars are returned ascending by date", async () => {
  // Feed them newest-first to prove the contract is enforced, not inherited.
  const body = chartBody({ n: 5, mutate: r => {
    r.timestamp.reverse();
    for (const k of ["open", "high", "low", "close", "volume"]) r.indicators.quote[0][k].reverse();
  }});
  await withMockFetch(() => fakeResponse({ jsonBody: body }), async () => {
    const series = await provider().getDailySeries("AAPL");
    const ts = series.points.map(p => p.timestamp);
    assert.deepEqual(ts, [...ts].sort((a, b) => a - b), "points must be ascending");
  });
});

test("output feeds buildWarInput and deriveTechnicalFacts with no provider-specific handling", async () => {
  await withMockFetch(() => fakeResponse({ jsonBody: chartBody({ n: 260 }) }), async () => {
    const series = await provider().getDailySeries("AAPL");

    const facts = deriveTechnicalFacts(series, { now: new Date("2026-09-02T21:00:00Z") });
    assert.ok(typeof facts.latestPrice === "number");
    assert.ok(typeof facts.movingAverages.ma200 === "number", "260 bars is enough for a 200DMA");

    const war = buildWarInput(series, { now: new Date("2026-09-02T21:00:00Z") });
    assert.equal(war.dataStatus, "COMPLETE");
    assert.equal(war.source.provider, "yahoo");
    assert.equal(war.dataPointsUsed, 260);
    assert.ok(typeof war.rsi14 === "number");
    assert.ok(typeof war.supportResistance.support === "number");
  });
});

test("a Yahoo-sourced series runs the SAME calculation engine — Wilder RSI, not the legacy simple RSI", async () => {
  await withMockFetch(() => fakeResponse({ jsonBody: chartBody({ n: 260 }) }), async () => {
    const series = await provider().getDailySeries("AAPL");
    const war = buildWarInput(series, { now: new Date("2026-09-02T21:00:00Z") });

    assert.equal(war.debug.calculationVersion, "war-technicals-v2");
    // This fixture rises monotonically, so BOTH methods return 100 — which
    // proves nothing on its own. Compare against the legacy implementation
    // on a series with real pullbacks instead.
    const legacySimpleRsi = (a, k = 14) => {
      let g = 0, l = 0;
      for (let i = a.length - k; i < a.length; i++) { const d = a[i] - a[i - 1]; if (d > 0) g += d; else l -= d; }
      if (!l) return 100;
      return 100 - 100 / (1 + (g / k) / (l / k));
    };
    const closes = series.points.map(p => p.close);
    assert.equal(legacySimpleRsi(closes), 100);
    assert.equal(war.rsi14, 100, "monotonic series: both agree, so use the zig-zag case below");
  });

  // Zig-zag series: the two methods genuinely diverge, proving which ran.
  const zig = chartBody({ n: 260 });
  const q = zig.chart.result[0].indicators.quote[0];
  for (let i = 0; i < q.close.length; i++) {
    const c = 100 + i * 0.4 + (i % 3 === 0 ? -1.6 : 0.5);
    q.close[i] = c; q.open[i] = c - 0.5; q.high[i] = c + 1; q.low[i] = c - 1;
  }
  await withMockFetch(() => fakeResponse({ jsonBody: zig }), async () => {
    const series = await provider().getDailySeries("AAPL");
    const war = buildWarInput(series, { now: new Date("2026-09-02T21:00:00Z") });
    const closes = series.points.map(p => p.close);
    const legacySimpleRsi = (a, k = 14) => {
      let g = 0, l = 0;
      for (let i = a.length - k; i < a.length; i++) { const d = a[i] - a[i - 1]; if (d > 0) g += d; else l -= d; }
      if (!l) return 100;
      return 100 - 100 / (1 + (g / k) / (l / k));
    };
    const legacy = legacySimpleRsi(closes);
    assert.ok(Math.abs(war.rsi14 - legacy) > 1,
      `Wilder RSI (${war.rsi14.toFixed(2)}) must differ from the legacy simple RSI (${legacy.toFixed(2)})`);
  });
});

test("errors: a non-Yahoo response body is PROVIDER_UNAVAILABLE, not a symbol problem", async () => {
  await withMockFetch(
    () => fakeResponse({ status: 403, textBody: "Host not in allowlist: query1.finance.yahoo.com" }),
    async () => {
      await assert.rejects(() => provider().getDailySeries("AAPL"), err => {
        assert.ok(err instanceof MarketDataError);
        assert.equal(err.code, MarketDataErrorCodes.PROVIDER_UNAVAILABLE);
        return true;
      });
    }
  );
});

test("errors: Yahoo's own chart.error for an unknown symbol is NOT_FOUND", async () => {
  await withMockFetch(
    () => fakeResponse({ status: 404, jsonBody: { chart: { result: null, error: { code: "Not Found", description: "No data found, symbol may be delisted" } } } }),
    async () => {
      await assert.rejects(() => provider().getDailySeries("ZZZZ"), err => {
        assert.equal(err.code, MarketDataErrorCodes.NOT_FOUND);
        return true;
      });
    }
  );
});

test("errors: a rate limit is RATE_LIMITED and a network failure is PROVIDER_UNAVAILABLE", async () => {
  await withMockFetch(
    () => fakeResponse({ status: 429, jsonBody: { chart: { result: null, error: null } } }),
    async () => {
      await assert.rejects(() => provider().getDailySeries("AAPL"),
        err => err.code === MarketDataErrorCodes.RATE_LIMITED);
    }
  );

  const original = global.fetch;
  global.fetch = async () => { throw new Error("getaddrinfo ENOTFOUND"); };
  try {
    await assert.rejects(() => provider().getDailySeries("AAPL"),
      err => err.code === MarketDataErrorCodes.PROVIDER_UNAVAILABLE);
  } finally { global.fetch = original; }
});

test("errors: missing timestamp/quote arrays are MALFORMED_RESPONSE", async () => {
  await withMockFetch(
    () => fakeResponse({ jsonBody: { chart: { result: [{ meta: { symbol: "AAPL" } }], error: null } } }),
    async () => {
      await assert.rejects(() => provider().getDailySeries("AAPL"),
        err => err.code === MarketDataErrorCodes.MALFORMED_RESPONSE);
    }
  );
});

test("the provider requests enough history for a 200DMA", async () => {
  let requestedUrl = null;
  await withMockFetch(
    url => { requestedUrl = String(url); return fakeResponse({ jsonBody: chartBody({ n: 5 }) }); },
    async () => {
      await provider().getDailySeries("AAPL");
      assert.match(requestedUrl, /range=2y/);
      assert.match(requestedUrl, /interval=1d/);
    }
  );
});
