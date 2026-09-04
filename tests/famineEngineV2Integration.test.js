import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

/**
 * Famine V2 opt-in integration, exercised through the REAL api/analyse.js.
 *
 * Every provider is stubbed at the fetch layer. NO live Alpha Vantage or
 * Yahoo request is made anywhere in this file, so no provider quota is
 * consumed. The stub counts calls per upstream so we can prove which
 * provider path actually ran.
 */
const require = createRequire(import.meta.url);
const ANALYSE_PATH = new URL("../api/analyse.js", import.meta.url).pathname;

const DAY = 86400;
const SESSION_OPEN = Math.floor(Date.parse("2026-09-03T13:30:00Z") / 1000);

const jr = (body, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => body, text: async () => JSON.stringify(body),
});

/* ---------------- upstream fixtures ---------------- */

function yahooChart(n = 260) {
  const close = [], volume = [];
  for (let i = 0; i < n; i++) { close.push(300 + i * 0.1 + (i % 3 === 0 ? -0.35 : 0.12)); volume.push(40000000); }
  return { chart: { result: [{ meta: { currency: "USD", shortName: "Apple Inc." }, indicators: { quote: [{ close, volume }] } }] } };
}
function twelveData(n = 320) {
  const values = [];
  const start = Date.parse("2026-09-03T00:00:00Z");
  for (let i = 0; i < n; i++) {
    const c = 320 - i * 0.05 + (i % 4 === 0 ? 0.3 : -0.1);
    values.push({ datetime: new Date(start - i * DAY * 1000).toISOString().slice(0, 10),
      open: c.toFixed(5), high: (c + 1).toFixed(5), low: (c - 1).toFixed(5), close: c.toFixed(5), volume: "40000000" });
  }
  return { status: "ok", meta: { symbol: "AAPL", interval: "1day", currency: "USD", exchange: "NASDAQ",
    mic_code: "XNGS", type: "Common Stock", country: "United States", exchange_timezone: "America/New_York" }, values };
}
const OVERVIEW_OK = {
  Symbol: "AAPL", Name: "Apple Inc.", Currency: "USD", Exchange: "NASDAQ",
  QuarterlyRevenueGrowthYOY: "0.164", QuarterlyEarningsGrowthYOY: "0.287",
  ProfitMargin: "0.276", EPS: "8.71", PERatio: "37.33", LatestQuarter: "2026-06-30",
};
const EARNINGS_OK = { symbol: "AAPL", annualEarnings: [], quarterlyEarnings: [
  { fiscalDateEnding: "2026-06-30", reportedDate: "2026-07-30", reportedEPS: "1.57", estimatedEPS: "1.46", surprisePercentage: "7.4" },
  { fiscalDateEnding: "2026-03-31", reportedDate: "2026-05-01", reportedEPS: "1.53", estimatedEPS: "1.50", surprisePercentage: "2.0" },
] };
function yahooNews(items) {
  return { news: (items || [{ uuid: "n1", title: "Apple opens new retail store in Mumbai", publisher: "Reuters",
    link: "https://example.com/1", providerPublishTime: SESSION_OPEN - 3600, type: "STORY", relatedTickers: ["AAPL"] }]) };
}

/**
 * @param overview  "ok" | "ratelimit" | "notfound" | object
 * @param earnings  "ok" | "ratelimit" | object
 * @param news      "ok" | "empty" | "fail"
 */
function installStub({ overview = "ok", earnings = "ok", news = "ok" } = {}) {
  const original = global.fetch;
  const counts = { alphaOverview: 0, alphaEarnings: 0, yahooNews: 0, yahooChart: 0, twelveData: 0 };

  global.fetch = async url => {
    const u = String(url);
    if (u.includes("twelvedata")) { counts.twelveData++; return jr(twelveData()); }
    if (u.includes("alphavantage")) {
      const isOverview = u.includes("function=OVERVIEW");
      if (isOverview) counts.alphaOverview++; else counts.alphaEarnings++;
      const mode = isOverview ? overview : earnings;
      if (mode === "ratelimit") return jr({ Information: "our standard API rate limit is 25 requests per day" });
      if (mode === "notfound") return jr({});
      if (typeof mode === "object") return jr(mode);
      return jr(isOverview ? OVERVIEW_OK : EARNINGS_OK);
    }
    if (u.includes("/v1/finance/search")) {
      counts.yahooNews++;
      if (news === "fail") throw new Error("ENOTFOUND");
      if (news === "empty") return jr({ news: [] });
      return jr(yahooNews());
    }
    if (u.includes("/v8/finance/chart/")) { counts.yahooChart++; return jr(yahooChart()); }
    return jr({});
  };
  return { counts, restore: () => { global.fetch = original; } };
}

async function callAnalyse(query, opts) {
  process.env.TWELVE_DATA_API_KEY = "test-key";
  process.env.ALPHA_VANTAGE_API_KEY = "test-av-key";
  const { counts, restore } = installStub(opts);
  try {
    // Fresh module each time so the module-scope Famine V2 cache does not
    // leak between tests.
    delete require.cache[ANALYSE_PATH];
    const handler = require(ANALYSE_PATH);
    const res = { _status: 200, body: null, status(c) { this._status = c; return this; }, json(b) { this.body = b; return this; } };
    await handler({ query }, res);
    return { res, counts };
  } finally { restore(); }
}

const famineOf = r => r.body.horsemen.find(h => h.name === "FAMINE");
const warOf = r => r.body.horsemen.find(h => h.name === "WAR");
const deathOf = r => r.body.horsemen.find(h => h.name === "DEATH");
const conquestOf = r => r.body.horsemen.find(h => h.name === "CONQUEST");

/* ---------------- engine switch ---------------- */

test("default request uses the legacy Famine path", async () => {
  const { res } = await callAnalyse({ ticker: "AAPL" });
  const famine = famineOf(res);
  assert.equal("dataSource" in famine, false, "legacy Famine carries no V2 provenance");
  assert.deepEqual(famine.checked, ["Alpha Vantage fundamentals", "earnings history", "recent news"]);
});

test("famineEngine=v1 uses the legacy Famine path", async () => {
  const { res } = await callAnalyse({ ticker: "AAPL", famineEngine: "v1" });
  assert.equal("dataSource" in famineOf(res), false);
});

test("unknown and blank engine values keep the legacy path — V2 is opt-in only", async () => {
  for (const value of ["v9", "", "  ", "V1", "true", "v2x", "legacy"]) {
    const { res } = await callAnalyse({ ticker: "AAPL", famineEngine: value });
    assert.equal("dataSource" in famineOf(res), false,
      `famineEngine=${JSON.stringify(value)} must NOT activate V2`);
  }
});

test("exactly famineEngine=v2 activates Famine V2, case and whitespace normalised", async () => {
  for (const value of ["v2", "V2", " v2 "]) {
    const { res } = await callAnalyse({ ticker: "AAPL", famineEngine: value });
    const famine = famineOf(res);
    assert.equal(famine.dataSource.engine, "v2", `famineEngine=${JSON.stringify(value)} should activate V2`);
  }
});

/* ---------------- healthy V2 ---------------- */

test("a healthy V2 result reaches /api/analyse with full provenance", async () => {
  const { res } = await callAnalyse({ ticker: "AAPL", famineEngine: "v2" });
  const famine = famineOf(res);

  assert.equal(res._status, 200);
  assert.equal(famine.direction, "BULLISH");
  assert.equal(typeof famine.confidence, "number");
  assert.equal(famine.dataSource.dataStatus, "COMPLETE");
  assert.equal(famine.dataSource.completeness.score, 1);
  assert.ok(famine.dataSource.providers.includes("alphavantage"));
  assert.ok(famine.dataSource.providers.includes("yahoo-news"));
  assert.ok(famine.dataSource.freshness.fundamentals.status);
  assert.ok(famine.dataSource.strongestSupporting.length >= 1);
  assert.ok(famine.limits.some(l => /macroeconomic/i.test(l)), "macro still declared unchecked");
  // Legacy compatibility fields survive for downstream consumers.
  for (const k of ["icon", "name", "label", "simple", "direction", "confidence", "checked", "evidence", "limits"]) {
    assert.ok(k in famine, `${k} must remain present for the existing API contract`);
  }
});

test("V2 uses the CACHED provider — a repeat call does not re-hit Alpha Vantage", async () => {
  process.env.TWELVE_DATA_API_KEY = "test-key";
  process.env.ALPHA_VANTAGE_API_KEY = "test-av-key";
  const { counts, restore } = installStub({});
  try {
    delete require.cache[ANALYSE_PATH];
    const handler = require(ANALYSE_PATH);
    const mk = () => ({ _status: 200, body: null, status(c) { this._status = c; return this; }, json(b) { this.body = b; return this; } });

    await handler({ query: { ticker: "AAPL", famineEngine: "v2" } }, mk());
    assert.equal(counts.alphaOverview, 1);
    assert.equal(counts.alphaEarnings, 1);

    // Same module instance, so the module-scope cache is still warm.
    await handler({ query: { ticker: "AAPL", famineEngine: "v2" } }, mk());
    assert.equal(counts.alphaOverview, 1, "fundamentals served from cache, not refetched");
    assert.equal(counts.alphaEarnings, 1, "earnings served from cache, not refetched");
  } finally { restore(); }
});

test("V2 does not double-spend quota: the legacy Alpha Vantage calls are skipped", async () => {
  const { counts } = await callAnalyse({ ticker: "AAPL", famineEngine: "v2" });
  assert.equal(counts.alphaOverview, 1, "exactly one OVERVIEW call, not two");
  assert.equal(counts.alphaEarnings, 1, "exactly one EARNINGS call, not two");
});

/* ---------------- degradation, with no legacy fallback ---------------- */

test("an Alpha Vantage rate limit surfaces as a degraded V2 result, never legacy Famine", async () => {
  const { res } = await callAnalyse({ ticker: "AAPL", famineEngine: "v2" }, { overview: "ratelimit", earnings: "ratelimit" });
  const famine = famineOf(res);

  assert.equal(famine.dataSource.engine, "v2", "must still be V2, not silently swapped for legacy");
  assert.equal(famine.direction, "UNKNOWN", "no evidence must not become NEUTRAL");
  assert.equal(famine.confidence, null, "there is no assessment to be confident about");
  assert.equal(famine.dataSource.dataStatus, "EVIDENCE_UNAVAILABLE");
  assert.ok(famine.dataSource.statusReasons.some(r => r.includes("RATE_LIMITED")));
  assert.equal(res._status, 200, "the analysis as a whole still returns");
});

test("missing fundamentals do not become neutral evidence", async () => {
  const { res } = await callAnalyse({ ticker: "AAPL", famineEngine: "v2" }, { overview: "ratelimit" });
  const famine = famineOf(res);
  assert.notEqual(famine.direction, "NEUTRAL");
  assert.equal(famine.dataSource.fundamentalsAvailability, "PROVIDER_UNAVAILABLE");
  assert.ok(famine.dataSource.missingEvidence.some(m => m.field === "revenueGrowthYoY"));
});

test("missing earnings do not become neutral evidence and do not destroy the assessment", async () => {
  const { res } = await callAnalyse({ ticker: "AAPL", famineEngine: "v2" }, { earnings: "ratelimit" });
  const famine = famineOf(res);
  assert.equal(famine.dataSource.earningsAvailability, "PROVIDER_UNAVAILABLE");
  assert.ok(famine.dataSource.completeness.score < 1, "completeness must drop");
  assert.equal(famine.direction, "BULLISH", "fundamentals alone still support a view");
  assert.ok(famine.dataSource.completeness.unavailableCategories.some(c => c.category === "earnings"));
});

test("partial evidence reaches the API honestly", async () => {
  const partial = { ...OVERVIEW_OK, PERatio: "None", ProfitMargin: "None" };
  const { res } = await callAnalyse({ ticker: "AAPL", famineEngine: "v2" }, { overview: partial });
  const famine = famineOf(res);
  assert.equal(famine.dataSource.dataStatus, "PARTIAL_EVIDENCE");
  assert.ok(famine.dataSource.missingEvidence.some(m => m.field === "peRatio"));
  assert.equal(typeof famine.confidence, "number");
});

test("quiet news is distinguishable from a news provider failure", async () => {
  const quiet = await callAnalyse({ ticker: "AAPL", famineEngine: "v2" }, { news: "empty" });
  const failed = await callAnalyse({ ticker: "AAPL", famineEngine: "v2" }, { news: "fail" });

  assert.equal(famineOf(quiet.res).dataSource.newsAvailability, "NO_RECENT_NEWS");
  assert.equal(famineOf(failed.res).dataSource.newsAvailability, "PROVIDER_UNAVAILABLE");
  assert.ok(famineOf(quiet.res).dataSource.completeness.score >
            famineOf(failed.res).dataSource.completeness.score,
    "looking and finding nothing is evidence; failing to look is not");
});

test("cache provenance survives into the public V2 result", async () => {
  process.env.TWELVE_DATA_API_KEY = "test-key";
  process.env.ALPHA_VANTAGE_API_KEY = "test-av-key";
  const { restore } = installStub({});
  try {
    delete require.cache[ANALYSE_PATH];
    const handler = require(ANALYSE_PATH);
    const mk = () => ({ _status: 200, body: null, status(c) { this._status = c; return this; }, json(b) { this.body = b; return this; } });

    const first = mk(); await handler({ query: { ticker: "AAPL", famineEngine: "v2" } }, first);
    assert.equal(first.body.horsemen.find(h => h.name === "FAMINE").dataSource.cache.fundamentals.cached, false);

    const second = mk(); await handler({ query: { ticker: "AAPL", famineEngine: "v2" } }, second);
    const cache = second.body.horsemen.find(h => h.name === "FAMINE").dataSource.cache;
    assert.equal(cache.fundamentals.cached, true, "a cache hit must say so");
    assert.equal(cache.fundamentals.cacheState, "FRESH");
    assert.ok(cache.fundamentals.fetchedAt, "the original provider fetch time survives");
  } finally { restore(); }
});

test("ticker integrity: a second ticker is fetched separately, never served from the first", async () => {
  process.env.TWELVE_DATA_API_KEY = "test-key";
  process.env.ALPHA_VANTAGE_API_KEY = "test-av-key";
  const { counts, restore } = installStub({});
  try {
    delete require.cache[ANALYSE_PATH];
    const handler = require(ANALYSE_PATH);
    const mk = () => ({ _status: 200, body: null, status(c) { this._status = c; return this; }, json(b) { this.body = b; return this; } });
    await handler({ query: { ticker: "AAPL", famineEngine: "v2" } }, mk());
    await handler({ query: { ticker: "TSLA", famineEngine: "v2" } }, mk());
    assert.equal(counts.alphaOverview, 2, "a different ticker must trigger its own fetch");
  } finally { restore(); }
});

/* ---------------- downstream safety ---------------- */

test("War, Conquest and Death are unaffected on the default path", async () => {
  const a = await callAnalyse({ ticker: "AAPL" });
  const b = await callAnalyse({ ticker: "AAPL" });
  for (const name of ["WAR", "CONQUEST", "DEATH"]) {
    assert.deepEqual(
      a.res.body.horsemen.find(h => h.name === name),
      b.res.body.horsemen.find(h => h.name === name));
  }
  assert.deepEqual(a.res.body.council, b.res.body.council);
});

test("War V2 behaviour is identical whichever Famine engine is selected", async () => {
  const legacy = await callAnalyse({ ticker: "AAPL" });
  const v2 = await callAnalyse({ ticker: "AAPL", famineEngine: "v2" });
  assert.deepEqual(warOf(v2.res), warOf(legacy.res), "Famine's engine must not touch War");
  assert.equal(warOf(v2.res).dataSource.engine, "v2");
  assert.equal(warOf(v2.res).dataSource.provider, "twelvedata");
});

test("Conquest is identical whichever Famine engine is selected", async () => {
  const legacy = await callAnalyse({ ticker: "AAPL" });
  const v2 = await callAnalyse({ ticker: "AAPL", famineEngine: "v2" });
  assert.deepEqual(conquestOf(v2.res), conquestOf(legacy.res));
});

test("Death does not crash and reports fundamentals truthfully under V2", async () => {
  const healthy = await callAnalyse({ ticker: "AAPL", famineEngine: "v2" });
  assert.ok(!deathOf(healthy.res).evidence.includes("Structured fundamentals unavailable"),
    "V2 obtained fundamentals, so Death must not claim otherwise");

  const degraded = await callAnalyse({ ticker: "AAPL", famineEngine: "v2" }, { overview: "ratelimit" });
  assert.ok(deathOf(degraded.res).evidence.includes("Structured fundamentals unavailable"),
    "V2 could not obtain fundamentals, and Death should say so");
});

test("Council survives a null Famine confidence without silently treating it as zero", async () => {
  const degraded = await callAnalyse({ ticker: "AAPL", famineEngine: "v2" }, { overview: "ratelimit", earnings: "ratelimit" });
  const council = degraded.res.body.council;
  assert.equal(famineOf(degraded.res).confidence, null);
  assert.equal(typeof council.confidence, "number");
  assert.ok(Number.isFinite(council.confidence), "must not be NaN");
  assert.ok(council.confidence >= 25 && council.confidence <= 92);
  assert.ok(council.verdict);
  assert.equal(degraded.res.body.horsemen.length, 4);
});

test("the response envelope is unchanged in shape under V2", async () => {
  const legacy = await callAnalyse({ ticker: "AAPL" });
  const v2 = await callAnalyse({ ticker: "AAPL", famineEngine: "v2" });
  assert.deepEqual(Object.keys(v2.res.body).sort(), Object.keys(legacy.res.body).sort());
  assert.equal(v2.res.body.asset.name, "Apple Inc.", "company name resolves without the legacy overview");
  assert.equal(v2.res.body.horsemen.length, 4);
});
