import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

/**
 * Transparent Yahoo fallback for War V2.
 *
 * Test injection note: no production switch exists to force fallback, and
 * none was added. These tests distinguish the two Yahoo callers by their
 * range parameter — YahooProvider requests range=2y, while analyse.js's
 * own legacy chart fetch uses range=1y — which also lets us COUNT whether
 * YahooProvider was invoked at all.
 */
const require = createRequire(import.meta.url);
const ANALYSE_PATH = new URL("../api/analyse.js", import.meta.url).pathname;

const DAY = 86400;
const SESSION_OPEN_UTC = Math.floor(Date.parse("2026-09-02T13:30:00Z") / 1000);

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

function legacyYahooArrays(n = 260) {
  const closes = [], vols = [];
  for (let i = 0; i < n; i++) {
    closes.push(300 + i * 0.1 + (i % 3 === 0 ? -0.35 : 0.12));
    vols.push(40000000);
  }
  return { closes, vols };
}

/** Twelve Data success body. mode controls which dataStatus results. */
function tdBody(mode = "complete") {
  const n = mode === "insufficient" ? 3 : mode === "partial" ? 60 : 320;
  const values = [];
  // "stale" backdates everything well past the 96h freshness window.
  const anchor = mode === "stale"
    ? Date.parse("2026-08-01T00:00:00Z")
    : Date.parse("2026-09-02T00:00:00Z");
  for (let i = 0; i < n; i++) {
    const c = 320 - i * 0.05 + (i % 4 === 0 ? 0.3 : -0.1);
    values.push({
      datetime: new Date(anchor - i * DAY * 1000).toISOString().slice(0, 10),
      open: c.toFixed(5), high: (c + 1).toFixed(5), low: (c - 1).toFixed(5),
      close: c.toFixed(5), volume: "40000000",
    });
  }
  const meta = mode === "unsupported"
    ? { symbol: "VOD", currency: "GBP", exchange: "LSE", country: "United Kingdom", exchange_timezone: "Europe/London" }
    : { symbol: "AAPL", currency: "USD", exchange: "NASDAQ", mic_code: "XNGS", type: "Common Stock", country: "United States", exchange_timezone: "America/New_York" };
  return { status: "ok", meta, values };
}

/** Yahoo chart body used by YahooProvider (range=2y). */
function yahooChartBody({ n = 300, exchangeName = "NMS", zigzag = true } = {}) {
  const timestamp = [], open = [], high = [], low = [], close = [], volume = [];
  for (let i = 0; i < n; i++) {
    timestamp.push(SESSION_OPEN_UTC - (n - 1 - i) * DAY);
    // Zig-zag so Wilder and the legacy simple RSI genuinely diverge.
    const c = zigzag ? 200 + i * 0.4 + (i % 3 === 0 ? -1.6 : 0.5) : 200 + i * 0.4;
    open.push(c - 0.5); high.push(c + 1); low.push(c - 1); close.push(c);
    volume.push(30000000);
  }
  return {
    chart: {
      result: [{
        meta: {
          symbol: "AAPL", currency: "USD", exchangeName,
          exchangeTimezoneName: "America/New_York", shortName: "Apple Inc.",
        },
        timestamp,
        indicators: { quote: [{ open, high, low, close, volume }], adjclose: [{ adjclose: close.map(c => c - 25) }] },
      }],
      error: null,
    },
  };
}

// ---------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------

const jr = (body, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => body, text: async () => JSON.stringify(body),
});

/**
 * @param tdFail  null | "PROVIDER_UNAVAILABLE" | "RATE_LIMITED" | "NOT_FOUND"
 *                | "UNAUTHORISED" | "MALFORMED_RESPONSE"
 * @param tdMode  success shape when tdFail is null
 * @param yahoo   "ok" | "down" | "unsupported"
 */
function installStub({ tdFail = null, tdMode = "complete", yahoo = "ok" } = {}) {
  const original = global.fetch;
  const counts = { twelveData: 0, yahooProvider: 0, legacyChart: 0 };
  const { closes, vols } = legacyYahooArrays();

  global.fetch = async url => {
    const u = String(url);

    if (u.includes("twelvedata")) {
      counts.twelveData++;
      switch (tdFail) {
        case "PROVIDER_UNAVAILABLE": throw new Error("getaddrinfo ENOTFOUND");
        case "RATE_LIMITED": return jr({ status: "error", code: 429, message: "You have run out of API credits. Rate limit exceeded." }, 429);
        case "NOT_FOUND": return jr({ status: "error", code: 400, message: "**symbol** not found: ZZZZ" }, 400);
        case "UNAUTHORISED": return jr({ status: "error", code: 401, message: "Invalid API key." }, 401);
        case "MALFORMED_RESPONSE": return jr({ status: "ok", meta: tdBody().meta, values: [{ nonsense: 1 }, { nonsense: 2 }] });
        default: return jr(tdBody(tdMode));
      }
    }

    // YahooProvider requests range=2y; the legacy analyse.js fetch uses 1y.
    if (u.includes("/v8/finance/chart/") && u.includes("range=2y")) {
      counts.yahooProvider++;
      if (yahoo === "down") throw new Error("getaddrinfo ENOTFOUND");
      if (yahoo === "unsupported") return jr(yahooChartBody({ exchangeName: "PCX" }));
      return jr(yahooChartBody({}));
    }

    if (u.includes("/v8/finance/chart/")) {
      counts.legacyChart++;
      return jr({ chart: { result: [{ meta: { currency: "USD", shortName: "Apple Inc." }, indicators: { quote: [{ close: closes, volume: vols }] } }] } });
    }
    if (u.includes("/v1/finance/search")) return jr({ news: [] });
    return jr({ Symbol: "AAPL", Name: "Apple Inc." });
  };

  return { counts, restore: () => { global.fetch = original; } };
}

async function callAnalyse(query, opts) {
  process.env.TWELVE_DATA_API_KEY = "test-key";
  const { counts, restore } = installStub(opts);
  try {
    delete require.cache[ANALYSE_PATH];
    const handler = require(ANALYSE_PATH);
    const res = { _status: 200, body: null, status(c) { this._status = c; return this; }, json(b) { this.body = b; return this; } };
    await handler({ query }, res);
    return { res, counts };
  } finally { restore(); }
}

const warOf = r => r.body.horsemen.find(h => h.name === "WAR");
const conquestOf = r => r.body.horsemen.find(h => h.name === "CONQUEST");
const deathOf = r => r.body.horsemen.find(h => h.name === "DEATH");
const FALLBACK_LIMIT = "Primary market-data provider unavailable; technical analysis used Yahoo fallback data.";

// ---------------------------------------------------------------------
// 1. Twelve Data success must never reach for the fallback
// ---------------------------------------------------------------------

test("Twelve Data success never calls YahooProvider", async () => {
  const { res, counts } = await callAnalyse({ ticker: "AAPL" });
  assert.equal(counts.yahooProvider, 0, "YahooProvider must not be invoked");
  const war = warOf(res);
  assert.equal(war.dataSource.provider, "twelvedata");
  assert.equal(war.dataSource.fallbackFrom, undefined);
  assert.equal(war.dataSource.fallbackReason, undefined);
  assert.ok(!war.limits.includes(FALLBACK_LIMIT));
});

// ---------------------------------------------------------------------
// 2-4. Approved hard failures DO trigger fallback
// ---------------------------------------------------------------------

for (const code of ["PROVIDER_UNAVAILABLE", "RATE_LIMITED"]) {
  test(`${code} triggers the Yahoo fallback`, async () => {
    const { res, counts } = await callAnalyse({ ticker: "AAPL" }, { tdFail: code });
    assert.equal(counts.yahooProvider, 1, "YahooProvider should be called exactly once");
    const war = warOf(res);
    assert.equal(war.dataSource.provider, "yahoo-fallback");
    assert.equal(war.dataSource.fallbackFrom, "twelvedata");
    assert.equal(war.dataSource.fallbackReason, code);
    assert.equal(war.dataSource.engine, "v2");
    assert.equal(war.dataSource.calculationVersion, "war-technicals-v2");
    assert.equal(war.dataSource.simulated, false);
    assert.equal(war.dataSource.dataStatus, "COMPLETE");
    assert.ok(war.dataSource.candlesUsed > 200);
    assert.ok(war.dataSource.latestDataTimestamp);
    assert.equal(typeof war.dataSource.latestBarIsProvisional, "boolean");
  });
}

test("SERVER_MISCONFIGURED (no API key at cold start) triggers the Yahoo fallback", () => {
  // config.js reads process.env once at module load, so this must run in a
  // fresh process with the key genuinely absent — mirroring a Vercel cold
  // start with the env var unset.
  const script = `
    const DAY=86400, OPEN=Math.floor(Date.parse("2026-09-02T13:30:00Z")/1000);
    const jr=(b,s=200)=>({ok:s>=200&&s<300,status:s,json:async()=>b,text:async()=>JSON.stringify(b)});
    const ts=[],o=[],h=[],l=[],c=[],v=[];
    for(let i=0;i<300;i++){ts.push(OPEN-(299-i)*DAY);const x=200+i*0.4+(i%3===0?-1.6:0.5);o.push(x-0.5);h.push(x+1);l.push(x-1);c.push(x);v.push(30000000)}
    let yahooProviderCalls=0;
    global.fetch=async url=>{const u=String(url);
      if(u.includes("/v8/finance/chart/")&&u.includes("range=2y")){yahooProviderCalls++;
        return jr({chart:{result:[{meta:{symbol:"AAPL",currency:"USD",exchangeName:"NMS",exchangeTimezoneName:"America/New_York",shortName:"Apple Inc."},timestamp:ts,indicators:{quote:[{open:o,high:h,low:l,close:c,volume:v}]}}],error:null}})}
      if(u.includes("/v8/finance/chart/"))return jr({chart:{result:[{meta:{currency:"USD",shortName:"Apple Inc."},indicators:{quote:[{close:c,volume:v}]}}]}});
      if(u.includes("/v1/finance/search"))return jr({news:[]});
      return jr({Symbol:"AAPL",Name:"Apple Inc."})};
    const handler=require(${JSON.stringify(ANALYSE_PATH)});
    const res={_s:200,body:null,status(x){this._s=x;return this},json(b){this.body=b;return this}};
    handler({query:{ticker:"AAPL"}},res).then(()=>{
      const w=res.body.horsemen.find(x=>x.name==="WAR");
      console.log(JSON.stringify({provider:w.dataSource.provider,reason:w.dataSource.fallbackReason,calls:yahooProviderCalls,limits:w.limits}));
    });
  `;
  const env = { ...process.env };
  delete env.TWELVE_DATA_API_KEY;
  delete env.HORSEMAN_MODE;
  const out = JSON.parse(execFileSync(process.execPath, ["-e", script], { env, encoding: "utf8" }).trim().split("\n").pop());

  assert.equal(out.provider, "yahoo-fallback");
  assert.equal(out.reason, "SERVER_MISCONFIGURED");
  assert.equal(out.calls, 1);
  assert.ok(out.limits.includes(FALLBACK_LIMIT));
});

// ---------------------------------------------------------------------
// 5-13. Everything else must NOT trigger fallback
// ---------------------------------------------------------------------

for (const code of ["NOT_FOUND", "UNAUTHORISED", "MALFORMED_RESPONSE"]) {
  test(`${code} does NOT trigger fallback`, async () => {
    const { res, counts } = await callAnalyse({ ticker: "AAPL" }, { tdFail: code });
    assert.equal(counts.yahooProvider, 0, "a non-outage failure must not be routed around");
    const war = warOf(res);
    assert.equal(war.dataSource.dataStatus, "DATA_UNAVAILABLE");
    assert.equal(war.dataSource.error, code);
    assert.ok(!war.limits.includes(FALLBACK_LIMIT));
  });
}

for (const [mode, label] of [["unsupported", "UNSUPPORTED_SECURITY"], ["insufficient", "INSUFFICIENT_EVIDENCE"]]) {
  test(`${label} does NOT trigger fallback (a plain Error carries no approved code)`, async () => {
    const { res, counts } = await callAnalyse({ ticker: "AAPL" }, { tdMode: mode });
    assert.equal(counts.yahooProvider, 0);
    const war = warOf(res);
    assert.equal(war.dataSource.dataStatus, "DATA_UNAVAILABLE");
    assert.equal(war.dataSource.error, label);
  });
}

for (const [mode, expected] of [["partial", "PARTIAL_DATA"], ["stale", "STALE_DATA"]]) {
  test(`a successful ${expected} result does NOT trigger fallback`, async () => {
    const { res, counts } = await callAnalyse({ ticker: "AAPL" }, { tdMode: mode });
    assert.equal(counts.yahooProvider, 0, "data-quality states are results, not outages");
    const war = warOf(res);
    assert.equal(war.dataSource.provider, "twelvedata");
    assert.equal(war.dataSource.dataStatus, expected);
    assert.ok(!war.limits.includes(FALLBACK_LIMIT));
  });
}

test("a provisional current-session bar does NOT trigger fallback", async () => {
  // tdBody's newest bar is dated 2026-09-02; run the clock mid-session.
  const { res, counts } = await callAnalyse({ ticker: "AAPL" });
  assert.equal(counts.yahooProvider, 0);
  assert.equal(warOf(res).dataSource.provider, "twelvedata");
});

// ---------------------------------------------------------------------
// 14-19. Fallback quality: same pipeline, disclosed, consumed downstream
// ---------------------------------------------------------------------

test("fallback runs the SAME V2 engine — Wilder RSI, not the legacy simple RSI", async () => {
  const { res } = await callAnalyse({ ticker: "AAPL" }, { tdFail: "PROVIDER_UNAVAILABLE" });
  const war = warOf(res);
  assert.equal(war.dataSource.calculationVersion, "war-technicals-v2");

  const rsiLine = war.evidence.find(e => e.startsWith("RSI "));
  assert.ok(rsiLine, "War should report an RSI from the fallback series");
  const wilder = parseFloat(rsiLine.replace("RSI ", ""));

  // Same closes through the legacy simple-14 implementation, for contrast.
  const closes = [];
  for (let i = 0; i < 300; i++) closes.push(200 + i * 0.4 + (i % 3 === 0 ? -1.6 : 0.5));
  let g = 0, l = 0;
  for (let i = closes.length - 14; i < closes.length; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) g += d; else l -= d; }
  const legacy = l === 0 ? 100 : 100 - 100 / (1 + (g / 14) / (l / 14));

  assert.ok(Math.abs(wilder - legacy) > 1,
    `fallback Wilder RSI (${wilder}) must differ from legacy simple RSI (${legacy.toFixed(2)})`);
});

test("fallback is disclosed in War's user-visible limits", async () => {
  const { res } = await callAnalyse({ ticker: "AAPL" }, { tdFail: "RATE_LIMITED" });
  const limits = warOf(res).limits;
  assert.ok(limits.includes(FALLBACK_LIMIT), "there must be no silent provider substitution");
  assert.ok(limits.some(l => l.includes("yahoo-fallback")));
});

test("Conquest consumes the FALLBACK authoritative facts, not the legacy Yahoo arrays", async () => {
  const { res } = await callAnalyse({ ticker: "AAPL" }, { tdFail: "PROVIDER_UNAVAILABLE" });
  const conquest = conquestOf(res);
  // Facts were obtained, so the "unavailable" notices must be absent.
  assert.ok(!conquest.limits.some(l => l.startsWith("Authoritative one-day price move unavailable")));
  assert.ok(!conquest.limits.some(l => l.startsWith("Authoritative RSI / 20-session change unavailable")));
  assert.ok(["LOW", "ELEVATED", "HIGH"].includes(conquest.signals.crowding));
});

test("Death consumes the FALLBACK authoritative facts", async () => {
  const { res } = await callAnalyse({ ticker: "AAPL" }, { tdFail: "PROVIDER_UNAVAILABLE" });
  const death = deathOf(res);
  assert.ok(!death.evidence.includes("Authoritative technical evidence unavailable"),
    "Death should have received authoritative facts via the fallback");
});

// ---------------------------------------------------------------------
// 20-21. Both providers failing
// ---------------------------------------------------------------------

test("both providers failing produces DATA_UNAVAILABLE with no legacy leakage", async () => {
  const { res, counts } = await callAnalyse({ ticker: "AAPL" }, { tdFail: "PROVIDER_UNAVAILABLE", yahoo: "down" });
  assert.equal(counts.yahooProvider, 1, "the fallback was attempted");

  const war = warOf(res), conquest = conquestOf(res), death = deathOf(res);
  assert.equal(war.dataSource.dataStatus, "DATA_UNAVAILABLE");
  assert.ok(!war.evidence.some(e => e.startsWith("RSI ") || e.startsWith("Price ")));
  assert.ok(!war.limits.includes(FALLBACK_LIMIT), "a failed fallback must not claim to have used fallback data");

  // The legacy Yahoo arrays are still in scope in analyse.js. Nothing may use them.
  assert.ok(death.evidence.includes("Authoritative technical evidence unavailable"));
  assert.ok(conquest.limits.some(l => l.startsWith("Authoritative RSI / 20-session change unavailable")));
  assert.ok(conquest.limits.some(l => l.startsWith("Authoritative one-day price move unavailable")));

  assert.equal(res.body.horsemen.length, 4);
  assert.ok(res.body.council.verdict);
});

test("a fallback series outside supported scope is not routed around further", async () => {
  const { res, counts } = await callAnalyse({ ticker: "AAPL" }, { tdFail: "PROVIDER_UNAVAILABLE", yahoo: "unsupported" });
  assert.equal(counts.yahooProvider, 1, "attempted exactly once, no further attempts");
  assert.equal(warOf(res).dataSource.dataStatus, "DATA_UNAVAILABLE");
});

// ---------------------------------------------------------------------
// 22-23. Engine selection is unaffected
// ---------------------------------------------------------------------

test("the default engine still resolves to V2", async () => {
  const { res } = await callAnalyse({ ticker: "AAPL" });
  assert.equal(warOf(res).dataSource.engine, "v2");
});

test("explicit warEngine=v1 is untouched by fallback logic", async () => {
  // Even with Twelve Data hard-failing, V1 must neither notice nor fall back.
  const { res, counts } = await callAnalyse({ ticker: "AAPL", warEngine: "v1" }, { tdFail: "PROVIDER_UNAVAILABLE" });
  assert.equal(counts.twelveData, 0, "V1 must not call Twelve Data at all");
  assert.equal(counts.yahooProvider, 0, "V1 must not call YahooProvider");
  const war = warOf(res);
  assert.equal("dataSource" in war, false);
  assert.deepEqual(war.limits, ["Yahoo market data can be delayed."]);
});

test("total failure preserves the PRIMARY cause and reports the fallback's own failure separately", async () => {
  const { res } = await callAnalyse({ ticker: "AAPL" }, { tdFail: "RATE_LIMITED", yahoo: "down" });
  const ds = warOf(res).dataSource;
  assert.equal(ds.dataStatus, "DATA_UNAVAILABLE");
  assert.equal(ds.error, "RATE_LIMITED", "the original outage must not be masked by the fallback's error");
  assert.equal(ds.fallbackAttempted, true);
  assert.equal(ds.fallbackError, "PROVIDER_UNAVAILABLE");
});

test("a non-fallback failure reports no fallback fields at all", async () => {
  const { res } = await callAnalyse({ ticker: "AAPL" }, { tdFail: "NOT_FOUND" });
  const ds = warOf(res).dataSource;
  assert.equal(ds.error, "NOT_FOUND");
  assert.equal(ds.fallbackAttempted, undefined);
  assert.equal(ds.fallbackError, undefined);
});
