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
 * The point of these tests is the WIRING, not the indicator maths â€” that
 * is already covered by the technicals suites.
 */
const require = createRequire(import.meta.url);
const ANALYSE_PATH = new URL("../api/analyse.js", import.meta.url).pathname;

function yahooCloses(n = 260, mode = "default") {
  const closes = [], vols = [];
  for (let i = 0; i < n; i++) {
    if (mode === "spikeLastDay") {
      // Flat history with a sharp +5% final session: the legacy Yahoo
      // lastMove clears Conquest's >=3% short-term-move trigger.
      closes.push(i === n - 1 ? 300 * 1.05 : 300 + i * 0.02);
    } else if (mode === "rampUp") {
      // Strictly monotonic: the legacy simple-average RSI sees zero losses
      // in its 14-bar window and returns 100 â€” comfortably above Death's
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
    if (mode === "spikeLastDay") {
      // Newest bar (i = 0) jumps +5% versus the prior session, so the
      // authoritative one-day change clears the same trigger.
      close = i === 0 ? (320 - 0.05) * 1.05 : 320 - i * 0.05;
    } else if (mode === "steadyGains") {
      // Uninterrupted gains -> Wilder RSI 100 (fires crowding's >=75 bound)
      // while the 20-session change stays ~1.9% (does not fire >=15%).
      // Isolates the RSI crowding signal.
      close = 320 - i * 0.3;
    } else if (mode === "crashThenDrift") {
      // Sharp drop ~20 sessions ago, then a mild recovery: 20-session
      // change ~ -16.7% (fires) while Wilder RSI lands ~29.9, inside both
      // crowding bounds (does not fire). Isolates the 20-session signal.
      close = i < 14 ? 275 - i * 1.0 : (i <= 20 ? 262 + (i - 14) * 11.333 : 330 + (i - 20) * 0.05);
    } else if (mode === "bigMove") {
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
  // No provenance block on v1 â€” the default response must not change shape.
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

test("v2 keeps the v1 scoring vocabulary â€” only the data source changes", async () => {
  process.env.TWELVE_DATA_API_KEY = "test-key";
  const res = await callAnalyse({ ticker: "AAPL", warEngine: "v2" });
  const war = warOf(res);
  // Same evidence phrasing and same direction vocabulary as v1: this change
  // is about where facts come from, not how War reasons about them.
  assert.ok(["BULLISH", "BEARISH", "NEUTRAL"].includes(war.direction));
  assert.ok(war.evidence.some(e => /^Price (above|below) 20-day average \(/.test(e)));
  assert.ok(war.evidence.some(e => /^20-session change /.test(e)));
});

test("v2 degrades honestly when the provider fails â€” no silent fallback to Yahoo", async () => {
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
  // must run in a fresh process with the variable genuinely absent â€”
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

test("Famine is byte-identical across both engines", async () => {
  // NOTE: Death and Conquest are deliberately NOT asserted here any more.
  // Since M2, Death consumes the authoritative V2 RSI/20-session change;
  // since M3, Conquest consumes the authoritative one-day change. Both MAY
  // therefore differ between engines when the legacy and authoritative
  // values straddle a threshold â€” that is the intended behaviour, covered
  // by the M2 and M3 boundary tests below. Famine touches no market data
  // and remains genuinely invariant.
  process.env.TWELVE_DATA_API_KEY = "test-key";
  const v1 = await callAnalyse({ ticker: "AAPL" });
  const v2 = await callAnalyse({ ticker: "AAPL", warEngine: "v2" });
  for (const name of ["FAMINE"]) {
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

test("M2 boundary: legacy RSI 100 vs Wilder RSI ~65.8 â€” Death follows the V2 value, not Yahoo's", async () => {
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

test("M2: V1 Death is completely unaffected â€” no new flag, legacy inputs retained", async () => {
  process.env.TWELVE_DATA_API_KEY = "test-key";
  const v1 = await callAnalyse({ ticker: "AAPL" }, { yahooMode: "rampUp", tdMode: "calm" });
  const death = deathOf(v1);
  assert.ok(death.evidence.includes(RSI_FLAG), "V1 must still use the legacy Yahoo RSI");
  assert.ok(!death.evidence.includes(MISSING_FLAG),
    "the M2 missing-facts flag must never appear on the V1 default path");
});

test("M2: Famine and Council logic untouched by the Death migration", async () => {
  process.env.TWELVE_DATA_API_KEY = "test-key";
  // CONQUEST is no longer asserted invariant here: since M4 its crowding
  // signals consume the authoritative RSI / 20-session change, so this
  // dataset (legacy RSI 100 vs Wilder 65.8) intentionally moves crowding.
  // That is covered by the M4 straddle tests. Famine touches no market
  // data and remains genuinely invariant.
  const opts = { yahooMode: "rampUp", tdMode: "calm" };
  const v1 = await callAnalyse({ ticker: "AAPL" }, opts);
  const v2 = await callAnalyse({ ticker: "AAPL", warEngine: "v2" }, opts);

  for (const name of ["FAMINE"]) {
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

// ---------------------------------------------------------------------
// M3: Conquest consumes the authoritative one-day change under v2 rather
// than recomputing it from Yahoo. Volume, volatility, crowding and news
// logic are deliberately unchanged by this step.
// ---------------------------------------------------------------------

const conquestOf = res => res.body.horsemen.find(h => h.name === "CONQUEST");
const MOVE_UNAVAILABLE = "Authoritative one-day price move unavailable on this run; the short-term move signal was not applied.";

test("M3: Conquest follows the V2 one-day change when the legacy Yahoo move would have fired", async () => {
  process.env.TWELVE_DATA_API_KEY = "test-key";
  // Yahoo's final session jumps +3.22% (clears Conquest's >=3% trigger).
  // The authoritative Twelve Data one-day change is +0.14% (does not).
  const opts = { yahooMode: "spikeLastDay", tdMode: "calm" };

  const v1 = await callAnalyse({ ticker: "AAPL" }, opts);
  const v2 = await callAnalyse({ ticker: "AAPL", warEngine: "v2" }, opts);

  // Every other Conquest input is identical, so the attention point from
  // the short-term-move trigger is worth exactly 5 confidence points.
  assert.equal(v1.body.horsemen.find(h => h.name === "CONQUEST").confidence
             - v2.body.horsemen.find(h => h.name === "CONQUEST").confidence, 5,
    "V1 should score the move trigger and V2 should not");
});

test("M3: Conquest follows the V2 one-day change when only the authoritative value fires", async () => {
  process.env.TWELVE_DATA_API_KEY = "test-key";
  // The mirror image: Yahoo is flat (+0.18%), Twelve Data jumps +5.00%.
  const opts = { yahooMode: "default", tdMode: "spikeLastDay" };

  const v1 = await callAnalyse({ ticker: "AAPL" }, opts);
  const v2 = await callAnalyse({ ticker: "AAPL", warEngine: "v2" }, opts);

  assert.equal(conquestOf(v2).confidence - conquestOf(v1).confidence, 5,
    "V2 must act on the authoritative move that Yahoo did not see");
});

test("M3: V1 Conquest is unchanged â€” legacy lastMove still drives the trigger", async () => {
  process.env.TWELVE_DATA_API_KEY = "test-key";
  const fired = await callAnalyse({ ticker: "AAPL" }, { yahooMode: "spikeLastDay" });
  const notFired = await callAnalyse({ ticker: "AAPL" }, { yahooMode: "default" });

  assert.equal(conquestOf(fired).confidence - conquestOf(notFired).confidence, 5,
    "the legacy Yahoo lastMove must still drive V1's short-term-move trigger");
  // The M3 unavailability note must never appear on the default path.
  assert.ok(!conquestOf(fired).limits.includes(MOVE_UNAVAILABLE));
  assert.ok(!conquestOf(notFired).limits.includes(MOVE_UNAVAILABLE));
});

test("M3: no silent Yahoo fallback when the authoritative one-day change is unavailable", async () => {
  process.env.TWELVE_DATA_API_KEY = "test-key";
  // Yahoo's +3.22% move is in scope and would fire the trigger. It must not.
  const v2 = await callAnalyse(
    { ticker: "AAPL", warEngine: "v2" },
    { twelveData: "unavailable", yahooMode: "spikeLastDay" }
  );
  const baseline = await callAnalyse({ ticker: "AAPL" }, { yahooMode: "default" });

  assert.equal(conquestOf(v2).confidence, conquestOf(baseline).confidence,
    "Conquest must not inherit the Yahoo move it did not authoritatively receive");
  assert.ok(conquestOf(v2).limits.includes(MOVE_UNAVAILABLE),
    "the missing value must be stated explicitly, not silently skipped");
});

test("M3: Conquest's volume, volatility and news inputs are untouched", async () => {
  process.env.TWELVE_DATA_API_KEY = "test-key";
  const opts = { yahooMode: "spikeLastDay", tdMode: "calm" };
  const v1 = conquestOf(await callAnalyse({ ticker: "AAPL" }, opts));
  const v2 = conquestOf(await callAnalyse({ ticker: "AAPL", warEngine: "v2" }, opts));

  // These remain Yahoo-derived by design â€” the volume source is a separate,
  // still-open decision and M3 must not have moved it.
  assert.equal(v2.signals.volumeRatio, v1.signals.volumeRatio);
  assert.equal(v2.signals.realizedVolatility, v1.signals.realizedVolatility);
  // NOTE: signals.crowding is deliberately NOT asserted equal any more â€”
  // since M4 it derives from the authoritative RSI / 20-session change and
  // may legitimately differ between engines (see the M4 straddle tests).
  assert.equal(v2.signals.news24, v1.signals.news24);
  assert.equal(v2.signals.news72, v1.signals.news72);
  assert.deepEqual(v2.signals.headlineBalance, v1.signals.headlineBalance);
  // The volume evidence line still cites the Yahoo-derived ratio.
  assert.deepEqual(
    v2.evidence.filter(e => e.startsWith("Trading attention:")),
    v1.evidence.filter(e => e.startsWith("Trading attention:"))
  );
});

test("M3: Famine is unchanged and War still reports V2 provenance", async () => {
  process.env.TWELVE_DATA_API_KEY = "test-key";
  const opts = { yahooMode: "spikeLastDay", tdMode: "calm" };
  const v1 = await callAnalyse({ ticker: "AAPL" }, opts);
  const v2 = await callAnalyse({ ticker: "AAPL", warEngine: "v2" }, opts);

  assert.deepEqual(
    v2.body.horsemen.find(h => h.name === "FAMINE"),
    v1.body.horsemen.find(h => h.name === "FAMINE")
  );
  assert.equal(warOf(v2).dataSource.provider, "twelvedata");
  assert.equal("dataSource" in warOf(v1), false);
});

// ---------------------------------------------------------------------
// M4: Conquest's CROWDING signals consume the authoritative V2 RSI and
// 20-session change. Thresholds, volume, volatility and news untouched.
// ---------------------------------------------------------------------

const CROWD_UNAVAILABLE = "Authoritative RSI / 20-session change unavailable on this run; the related crowding signals were not applied.";

test("M4 straddle: legacy RSI 100 vs Wilder 65.8 â€” crowding follows the V2 value", async () => {
  process.env.TWELVE_DATA_API_KEY = "test-key";
  const opts = { yahooMode: "rampUp", tdMode: "calm" };

  const v1 = await callAnalyse({ ticker: "AAPL" }, opts);
  const v2 = await callAnalyse({ ticker: "AAPL", warEngine: "v2" }, opts);

  assert.equal(conquestOf(v1).signals.crowding, "ELEVATED",
    "precondition: legacy Yahoo RSI of 100 must trigger the crowding bound");
  assert.equal(conquestOf(v2).signals.crowding, "LOW",
    "authoritative Wilder RSI is inside both bounds, so crowding must not fire");
});

test("M4 reverse straddle: legacy RSI 63.7 vs Wilder 100 â€” crowding follows the V2 value", async () => {
  process.env.TWELVE_DATA_API_KEY = "test-key";
  const opts = { yahooMode: "default", tdMode: "steadyGains" };

  const v1 = await callAnalyse({ ticker: "AAPL" }, opts);
  const v2 = await callAnalyse({ ticker: "AAPL", warEngine: "v2" }, opts);

  assert.equal(conquestOf(v1).signals.crowding, "LOW",
    "precondition: legacy Yahoo RSI sits inside both crowding bounds");
  assert.equal(conquestOf(v2).signals.crowding, "ELEVATED",
    "authoritative Wilder RSI of 100 must trigger crowding under v2");
});

test("M4: crowding's 20-session signal uses the authoritative value (isolated from RSI)", async () => {
  process.env.TWELVE_DATA_API_KEY = "test-key";
  // crashThenDrift: authoritative RSI ~29.9 (fires neither bound) with a
  // 20-session change of ~ -16.7% (fires). Yahoo's is +0.62% (does not).
  const opts = { yahooMode: "default", tdMode: "crashThenDrift" };

  const v1 = await callAnalyse({ ticker: "AAPL" }, opts);
  const v2 = await callAnalyse({ ticker: "AAPL", warEngine: "v2" }, opts);

  assert.equal(conquestOf(v1).signals.crowding, "LOW");
  assert.equal(conquestOf(v2).signals.crowding, "ELEVATED",
    "only the authoritative 20-session change can explain this difference");
});

test("M4: V1 crowding is unchanged â€” legacy Yahoo r14/ret20 still drive it", async () => {
  process.env.TWELVE_DATA_API_KEY = "test-key";
  const fires = await callAnalyse({ ticker: "AAPL" }, { yahooMode: "rampUp" });
  const quiet = await callAnalyse({ ticker: "AAPL" }, { yahooMode: "default" });

  assert.equal(conquestOf(fires).signals.crowding, "ELEVATED");
  assert.equal(conquestOf(quiet).signals.crowding, "LOW");
  assert.ok(!conquestOf(fires).limits.includes(CROWD_UNAVAILABLE));
  assert.ok(!conquestOf(quiet).limits.includes(CROWD_UNAVAILABLE));
});

test("M4: no silent Yahoo fallback for crowding inputs when V2 facts are unavailable", async () => {
  process.env.TWELVE_DATA_API_KEY = "test-key";
  // Yahoo's legacy RSI of 100 is in scope and would fire crowding. It must not.
  const v2 = await callAnalyse(
    { ticker: "AAPL", warEngine: "v2" },
    { twelveData: "unavailable", yahooMode: "rampUp" }
  );
  const c = conquestOf(v2);
  assert.equal(c.signals.crowding, "LOW",
    "crowding must not inherit the legacy Yahoo RSI still in scope");
  assert.ok(c.limits.includes(CROWD_UNAVAILABLE),
    "the missing crowding inputs must be stated explicitly");
  assert.ok(c.limits.includes(MOVE_UNAVAILABLE),
    "the M3 one-day-move note must still appear alongside it");
});

test("M4: volume, realizedVolatility, absMoveAvg-based move trigger and news inputs untouched", async () => {
  process.env.TWELVE_DATA_API_KEY = "test-key";
  const opts = { yahooMode: "rampUp", tdMode: "calm" };
  const v1 = conquestOf(await callAnalyse({ ticker: "AAPL" }, opts));
  const v2 = conquestOf(await callAnalyse({ ticker: "AAPL", warEngine: "v2" }, opts));

  assert.equal(v2.signals.volumeRatio, v1.signals.volumeRatio);
  assert.equal(v2.signals.realizedVolatility, v1.signals.realizedVolatility);
  assert.equal(v2.signals.news24, v1.signals.news24);
  assert.equal(v2.signals.news72, v1.signals.news72);
  assert.deepEqual(v2.signals.headlineBalance, v1.signals.headlineBalance);
  assert.deepEqual(
    v2.evidence.filter(e => e.startsWith("Trading attention:") || e.startsWith("Recent volatility:")),
    v1.evidence.filter(e => e.startsWith("Trading attention:") || e.startsWith("Recent volatility:"))
  );
});

test("M4: Death still follows approved M2 behaviour and Famine is unchanged", async () => {
  process.env.TWELVE_DATA_API_KEY = "test-key";
  const opts = { yahooMode: "rampUp", tdMode: "calm" };
  const v1 = await callAnalyse({ ticker: "AAPL" }, opts);
  const v2 = await callAnalyse({ ticker: "AAPL", warEngine: "v2" }, opts);

  // M2 invariant: Death must not cite the legacy RSI of 100 under v2.
  assert.ok(deathOf(v1).evidence.includes(RSI_FLAG));
  assert.ok(!deathOf(v2).evidence.includes(RSI_FLAG));
  assert.deepEqual(
    v2.body.horsemen.find(h => h.name === "FAMINE"),
    v1.body.horsemen.find(h => h.name === "FAMINE")
  );
});
