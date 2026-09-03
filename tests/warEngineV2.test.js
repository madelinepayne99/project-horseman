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

function yahooCloses(n = 260, mode = "default") {
  const closes = [], vols = [];
  for (let i = 0; i < n; i++) {
    if (mode === "rampUp") {
      // Strictly monotonic: the legacy simple-average RSI sees zero losses
      // in its 14-bar window and returns 100 — comfortably above Death's
      // >75 threshold. Used to build the methodology boundary case.
      closes.push(300 + i * 0.1);
    } else {
      closes.push(300 + i * 0.1 + (i % 3 === 0 ? -0.35 : 0.12));
    }
    vols.push(i === n - 1 ? 28000000 : 40000000);
  }
  return { closes, vols };
}

function twelveDataBody(n = 320, mode = "calm") {
  // Twelve Data's documented shape: string fields, newest first (i = age).
  const values = [];
  const day = 86400000;
  const start = Date.parse("2026-09-02T00:00:00Z");
  for (let i = 0; i < n; i++) {
    let close;
    if (mode === "bigMove") {
      // Steep recent ramp so the authoritative 20-session change exceeds
      // Death's >15% threshold, while Yahoo's stays near flat.
      close = i < 20 ? 320 - i * 2.6 : 270.55 - (i - 20) * 0.05;
    } else {
      // Mild uptrend with regular pullbacks -> Wilder RSI well under 75.
      close = 320 - i * 0.05 + (i % 4 === 0 ? 0.3 : -0.1);
    }
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

function installFetchStub({ twelveData = "ok", yahooMode = "default", tdMode = "calm" } = {}) {
  const original = global.fetch;
  const { closes, vols } = yahooCloses(260, yahooMode);
  const jr = body => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

  global.fetch = async url => {
    const u = String(url);
    if (u.includes("twelvedata")) {
      if (twelveData === "unavailable") throw new Error("getaddrinfo ENOTFOUND");
      return jr(twelveDataBody(320, tdMode));
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

test("Famine and Conquest are byte-identical across both engines", async () => {
  // NOTE: Death is deliberately NOT asserted here any more. Since M2 it
  // consumes the authoritative V2 facts, so it MAY differ between engines
  // whenever the two RSI methodologies straddle its threshold — that is
  // the intended behaviour, covered by the M2 boundary test below.
  process.env.TWELVE_DATA_API_KEY = "test-key";
  const v1 = await callAnalyse({ ticker: "AAPL" });
  const v2 = await callAnalyse({ ticker: "AAPL", warEngine: "v2" });
  for (const name of ["FAMINE", "CONQUEST"]) {
    assert.deepEqual(
      v2.body.horsemen.find(h => h.name === name),
      v1.body.horsemen.find(h => h.name === name),
      `${name} must not be affected by the War engine change`
    );
  }
});

// ---------------------------------------------------------------------
// M2: Death cross-examines the SAME authoritative technical facts that
// War V2 interpreted, instead of the legacy Yahoo-derived values.
// ---------------------------------------------------------------------

const deathOf = res => res.body.horsemen.find(h => h.name === "DEATH");
const RSI_FLAG = "RSI is very high";
const MOVE_FLAG = "Large recent price move";
const MISSING_FLAG = "Authoritative technical evidence unavailable";

test("M2 boundary: legacy RSI 100 vs Wilder RSI ~65.8 — Death follows the V2 value, not Yahoo's", async () => {
  process.env.TWELVE_DATA_API_KEY = "test-key";
  const opts = { yahooMode: "rampUp", tdMode: "calm" };

  // V1: the legacy simple-average RSI sees no losses -> 100 -> flag fires.
  const v1 = await callAnalyse({ ticker: "AAPL" }, opts);
  assert.ok(deathOf(v1).evidence.includes(RSI_FLAG),
    "precondition: legacy Yahoo RSI must exceed Death's >75 threshold");

  // V2: authoritative Wilder RSI is ~65.8 -> below 75 -> flag must NOT fire.
  const v2 = await callAnalyse({ ticker: "AAPL", warEngine: "v2" }, opts);
  assert.ok(!deathOf(v2).evidence.includes(RSI_FLAG),
    "Death must follow the authoritative V2 RSI, not the legacy Yahoo value");

  // And War must be reporting that same sub-75 RSI in the same response,
  // which is the contradiction this migration exists to make impossible.
  const war = warOf(v2);
  const rsiLine = war.evidence.find(e => e.startsWith("RSI "));
  assert.ok(rsiLine, "War should still report an RSI under v2");
  assert.ok(parseFloat(rsiLine.replace("RSI ", "")) < 75);
});

test("M2: Death uses the authoritative 20-session change, not Yahoo's", async () => {
  process.env.TWELVE_DATA_API_KEY = "test-key";
  const opts = { yahooMode: "default", tdMode: "bigMove" };

  // Yahoo's 20-session change is ~0.6% -> below Death's >15% threshold.
  const v1 = await callAnalyse({ ticker: "AAPL" }, opts);
  assert.ok(!deathOf(v1).evidence.includes(MOVE_FLAG),
    "precondition: legacy Yahoo 20-session change must be below threshold");

  // The authoritative V2 value is ~18.3% -> above threshold -> flag fires.
  const v2 = await callAnalyse({ ticker: "AAPL", warEngine: "v2" }, opts);
  assert.ok(deathOf(v2).evidence.includes(MOVE_FLAG),
    "Death must act on the authoritative V2 20-session change");
});

test("M2: Death's RSI matches the exact value War reports under v2", async () => {
  process.env.TWELVE_DATA_API_KEY = "test-key";
  // Single-source proof: only one RSI value can exist in a v2 response.
  const v2 = await callAnalyse({ ticker: "AAPL", warEngine: "v2" }, { yahooMode: "rampUp", tdMode: "bigMove" });
  const warRsi = parseFloat(warOf(v2).evidence.find(e => e.startsWith("RSI ")).replace("RSI ", ""));
  // War reports >75 here, so Death's flag must agree with War's number.
  assert.ok(warRsi > 75, "precondition: this dataset should push Wilder RSI above 75");
  assert.ok(deathOf(v2).evidence.includes(RSI_FLAG),
    "Death must agree with the RSI War reported from the same facts object");
});

test("M2: no silent Yahoo fallback for Death when the provider fails", async () => {
  process.env.TWELVE_DATA_API_KEY = "test-key";
  // Yahoo's legacy RSI would be 100 and would fire Death's flag. It must not.
  const v2 = await callAnalyse(
    { ticker: "AAPL", warEngine: "v2" },
    { twelveData: "unavailable", yahooMode: "rampUp" }
  );
  const death = deathOf(v2);
  assert.ok(!death.evidence.includes(RSI_FLAG),
    "Death must not reuse the legacy Yahoo RSI that is still in scope");
  assert.ok(death.evidence.includes(MISSING_FLAG),
    "missing authoritative facts must be stated explicitly, not passed over silently");
});

test("M2: missing authoritative facts are handled safely and raise a risk point", async () => {
  process.env.TWELVE_DATA_API_KEY = "test-key";
  const v2 = await callAnalyse({ ticker: "AAPL", warEngine: "v2" }, { twelveData: "unavailable" });
  const death = deathOf(v2);
  assert.equal(typeof death.confidence, "number");
  assert.ok(["BULLISH", "NEUTRAL", "BEARISH"].includes(death.direction));
  assert.ok(death.evidence.includes(MISSING_FLAG));
  assert.equal(warOf(v2).dataSource.dataStatus, "DATA_UNAVAILABLE");
});

test("M2: V1 Death is completely unaffected — no new flag, legacy inputs retained", async () => {
  process.env.TWELVE_DATA_API_KEY = "test-key";
  const v1 = await callAnalyse({ ticker: "AAPL" }, { yahooMode: "rampUp", tdMode: "calm" });
  const death = deathOf(v1);
  assert.ok(death.evidence.includes(RSI_FLAG), "V1 must still use the legacy Yahoo RSI");
  assert.ok(!death.evidence.includes(MISSING_FLAG),
    "the M2 missing-facts flag must never appear on the V1 default path");
});

test("M2: only WAR and DEATH differ between engines — Famine, Conquest and Council logic untouched", async () => {
  process.env.TWELVE_DATA_API_KEY = "test-key";
  const opts = { yahooMode: "rampUp", tdMode: "calm" };
  const v1 = await callAnalyse({ ticker: "AAPL" }, opts);
  const v2 = await callAnalyse({ ticker: "AAPL", warEngine: "v2" }, opts);

  for (const name of ["FAMINE", "CONQUEST"]) {
    assert.deepEqual(
      v2.body.horsemen.find(h => h.name === name),
      v1.body.horsemen.find(h => h.name === name),
      `${name} must be byte-identical across engines`
    );
  }
  // Council still produces a verdict from the same fields; any difference
  // must be attributable to Death's corrected facts, not to Council logic.
  assert.ok(v2.body.council.verdict);
  assert.equal(typeof v2.body.council.confidence, "number");
  assert.equal(v2.body.evidenceEngine.items.length, v1.body.evidenceEngine.items.length);
});
