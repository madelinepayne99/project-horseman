import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

/**
 * Covers the ?warEngine=v2 opt-in added to api/analyse.js.
 *
 * analyse.js is CommonJS and reaches the network, so these tests load it
 * via createRequire and stub global.fetch. Yahoo/Alpha Vantage responses
 * are stubbed; the Twelve Data path is stubbed at the HTTP layer too, so
 * the real provider/normalisation/calculation code still runs end to end.
 *
 * The point of these tests is the WIRING, not the indicator maths — that
 * is already covered by the technicals suites.
 */
const require = createRequire(import.meta.url);
const ANALYSE_PATH = new URL("../api/analyse.js", import.meta.url).pathname;

function yahooCloses(n = 260) {
  // Gentle zig-zag so RSI has both gains and losses to work with.
  const closes = [], vols = [];
  for (let i = 0; i < n; i++) {
    closes.push(300 + i * 0.1 + (i % 3 === 0 ? -0.35 : 0.12));
    vols.push(i === n - 1 ? 28000000 : 40000000);
  }
  return { closes, vols };
}

function twelveDataBody(n = 320) {
  // Twelve Data's documented shape: string fields, newest first.
  const values = [];
  const day = 86400000;
  const start = Date.parse("2026-09-02T00:00:00Z");
  for (let i = 0; i < n; i++) {
    const close = 320 - i * 0.05 + (i % 4 === 0 ? 0.3 : -0.1);
    values.push({
      datetime: new Date(start - i * day).toISOString().slice(0, 10),
      open: close.toFixed(5), high: (close + 1).toFixed(5),
      low: (close - 1).toFixed(5), close: close.toFixed(5),
      volume: String(i === 0 ? 28000000 : 40000000),
    });
  }
  return {
    status: "ok",
    meta: { symbol: "AAPL", interval: "1day", currency: "USD", exchange: "NASDAQ", mic_code: "XNGS", type: "Common Stock", country: "United States", exchange_timezone: "America/New_York" },
    values,
  };
}

function installFetchStub({ twelveData = "ok" } = {}) {
  const original = global.fetch;
  const { closes, vols } = yahooCloses();
  const jr = body => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

  global.fetch = async url => {
    const u = String(url);
    if (u.includes("twelvedata")) {
      if (twelveData === "unavailable") throw new Error("getaddrinfo ENOTFOUND");
      return jr(twelveDataBody());
    }
    if (u.includes("/v8/finance/chart/")) {
      return jr({ chart: { result: [{ meta: { currency: "USD", shortName: "Apple Inc." }, indicators: { quote: [{ close: closes, volume: vols }] } }] } });
    }
    if (u.includes("/v1/finance/search")) return jr({ news: [] });
    return jr({ Symbol: "AAPL", Name: "Apple Inc." });
  };
  return () => { global.fetch = original; };
}

async function callAnalyse(query, opts) {
  const restore = installFetchStub(opts);
  try {
    delete require.cache[ANALYSE_PATH];
    const handler = require(ANALYSE_PATH);
    const res = {
      _status: 200, body: null,
      status(c) { this._status = c; return this; },
      json(b) { this.body = b; return this; },
    };
    await handler({ query }, res);
    return res;
  } finally { restore(); }
}

const warOf = res => res.body.horsemen.find(h => h.name === "WAR");

test("v1 remains the default and its output shape is unchanged", async () => {
  process.env.TWELVE_DATA_API_KEY = "test-key";
  const res = await callAnalyse({ ticker: "AAPL" });
  assert.equal(res._status, 200);
  const war = warOf(res);
  // No provenance block on v1 — the default response must not change shape.
  assert.equal("dataSource" in war, false);
  assert.deepEqual(war.limits, ["Yahoo market data can be delayed."]);
  assert.ok(war.evidence.some(e => e.startsWith("Price ")));
});

test("v2 sources War's facts from the Twelve Data pipeline and records provenance", async () => {
  process.env.TWELVE_DATA_API_KEY = "test-key";
  const res = await callAnalyse({ ticker: "AAPL", warEngine: "v2" });
  assert.equal(res._status, 200);
  const war = warOf(res);

  assert.equal(war.dataSource.engine, "v2");
  assert.equal(war.dataSource.provider, "twelvedata");
  assert.equal(war.dataSource.simulated, false);
  assert.equal(war.dataSource.calculationVersion, "war-technicals-v2");
  assert.ok(war.dataSource.candlesUsed > 200, "should use the full requested history");
  assert.ok(war.evidence.some(e => e.startsWith("Price ")));
  assert.ok(war.evidence.some(e => e.startsWith("RSI ")));
});

test("v2 keeps the v1 scoring vocabulary — only the data source changes", async () => {
  process.env.TWELVE_DATA_API_KEY = "test-key";
  const res = await callAnalyse({ ticker: "AAPL", warEngine: "v2" });
  const war = warOf(res);
  // Same evidence phrasing and same direction vocabulary as v1: this change
  // is about where facts come from, not how War reasons about them.
  assert.ok(["BULLISH", "BEARISH", "NEUTRAL"].includes(war.direction));
  assert.ok(war.evidence.some(e => /^Price (above|below) 20-day average \(/.test(e)));
  assert.ok(war.evidence.some(e => /^20-session change /.test(e)));
});

test("v2 degrades honestly when the provider fails — no silent fallback to Yahoo", async () => {
  process.env.TWELVE_DATA_API_KEY = "test-key";
  const res = await callAnalyse({ ticker: "AAPL", warEngine: "v2" }, { twelveData: "unavailable" });
  assert.equal(res._status, 200, "the analysis as a whole must still return");
  const war = warOf(res);

  assert.equal(war.dataSource.dataStatus, "DATA_UNAVAILABLE");
  assert.equal(war.direction, "NEUTRAL");
  assert.equal(war.confidence, 50);
  // The critical assertion: War must NOT quietly report Yahoo-derived
  // numbers that are sitting right there in the same request.
  assert.ok(!war.evidence.some(e => e.startsWith("Price ")), "must not emit price evidence it could not source");
  assert.ok(!war.evidence.some(e => e.startsWith("RSI ")), "must not emit RSI it could not source");
  // Council continues on the remaining Horsemen.
  assert.ok(res.body.council.verdict);
  assert.equal(res.body.horsemen.length, 4);
});

test("v2 with no API key configured degrades rather than throwing", () => {
  // src/config.js reads process.env once at module load, so this scenario
  // must run in a fresh process with the variable genuinely absent —
  // mirroring a Vercel cold start with the env var unset.
  const script = `
    const jr = b => ({ ok:true, status:200, json: async()=>b, text: async()=>JSON.stringify(b) });
    const closes=[],vols=[];
    for(let i=0;i<260;i++){closes.push(300+i*0.1+(i%3===0?-0.35:0.12));vols.push(40000000)}
    global.fetch = async url => {
      const u = String(url);
      if (u.includes('/v8/finance/chart/')) return jr({chart:{result:[{meta:{currency:'USD',shortName:'Apple Inc.'},indicators:{quote:[{close:closes,volume:vols}]}}]}});
      if (u.includes('/v1/finance/search')) return jr({news:[]});
      return jr({Symbol:'AAPL',Name:'Apple Inc.'});
    };
    const handler = require(${JSON.stringify(ANALYSE_PATH)});
    const res = { _s:200, body:null, status(c){this._s=c;return this}, json(b){this.body=b;return this} };
    handler({query:{ticker:'AAPL',warEngine:'v2'}}, res).then(() => {
      const war = res.body.horsemen.find(h => h.name === 'WAR');
      console.log(JSON.stringify({ status: res._s, dataStatus: war.dataSource.dataStatus, error: war.dataSource.error }));
    });
  `;
  const env = { ...process.env };
  delete env.TWELVE_DATA_API_KEY;
  delete env.HORSEMAN_MODE; // must not silently run in demo mode

  const out = execFileSync(process.execPath, ["-e", script], { env, encoding: "utf8" });
  const result = JSON.parse(out.trim().split("\n").pop());

  assert.equal(result.status, 200, "the analysis as a whole must still return");
  assert.equal(result.dataStatus, "DATA_UNAVAILABLE");
  assert.equal(result.error, "SERVER_MISCONFIGURED", "a missing key must be reported as our misconfiguration, not a provider rejection");
});

test("an unrecognised warEngine value falls through to v1", async () => {
  process.env.TWELVE_DATA_API_KEY = "test-key";
  const res = await callAnalyse({ ticker: "AAPL", warEngine: "v9" });
  assert.equal("dataSource" in warOf(res), false);
});

test("Famine, Conquest and Death are byte-identical across both engines", async () => {
  process.env.TWELVE_DATA_API_KEY = "test-key";
  const v1 = await callAnalyse({ ticker: "AAPL" });
  const v2 = await callAnalyse({ ticker: "AAPL", warEngine: "v2" });
  for (const name of ["FAMINE", "CONQUEST", "DEATH"]) {
    assert.deepEqual(
      v2.body.horsemen.find(h => h.name === name),
      v1.body.horsemen.find(h => h.name === name),
      `${name} must not be affected by the War engine change`
    );
  }
});
