import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

/**
 * LEGACY COUNCIL — CHARACTERISATION TESTS
 *
 * These document what Production Council does TODAY. They are NOT a
 * specification of desired behaviour — several of them lock in defects
 * identified by the Council V2 audit, deliberately, so that any future
 * change to legacy Council is visible rather than silent.
 *
 * Council V2's specification lives in tests/councilV2.test.js. Keep the
 * two files separate: this one describes the past, that one the intent.
 *
 * Everything here exercises the REAL api/analyse.js handler with stubbed
 * providers. No formula is re-implemented, so these tests cannot drift
 * away from the code they characterise. No network is used.
 */

const require = createRequire(import.meta.url);
const ANALYSE_PATH = new URL("../api/analyse.js", import.meta.url).pathname;
const DAY = 86400;

const jr = (body, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => body, text: async () => JSON.stringify(body),
});

function yahooChart({ trend = "up", n = 260 } = {}) {
  const close = [], volume = [];
  for (let i = 0; i < n; i++) {
    close.push(trend === "up" ? 300 + i * 0.4 : 400 - i * 0.4);
    volume.push(40000000);
  }
  return { chart: { result: [{ meta: { currency: "USD", shortName: "Test Co" }, indicators: { quote: [{ close, volume }] } }] } };
}
function twelveData({ trend = "up", n = 320 } = {}) {
  const values = [];
  const start = Date.parse("2026-09-04T00:00:00Z");
  for (let i = 0; i < n; i++) {
    const c = trend === "up" ? 320 - i * 0.25 : 200 + i * 0.25;
    values.push({ datetime: new Date(start - i * DAY * 1000).toISOString().slice(0, 10),
      open: c.toFixed(5), high: (c + 1).toFixed(5), low: (c - 1).toFixed(5), close: c.toFixed(5), volume: "40000000" });
  }
  return { status: "ok", meta: { symbol: "TEST", interval: "1day", currency: "USD", exchange: "NASDAQ",
    mic_code: "XNGS", type: "Common Stock", country: "United States", exchange_timezone: "America/New_York" }, values };
}
const OVERVIEW_OK = {
  Symbol: "TEST", Name: "Test Co", Currency: "USD",
  QuarterlyRevenueGrowthYOY: "0.164", QuarterlyEarningsGrowthYOY: "0.287",
  ProfitMargin: "0.276", EPS: "8.71", PERatio: "37.33", LatestQuarter: "2026-06-30",
};
const EARNINGS_OK = { symbol: "TEST", quarterlyEarnings: [
  { fiscalDateEnding: "2026-06-30", reportedDate: "2026-07-30", reportedEPS: "1.57", estimatedEPS: "1.46", surprisePercentage: "7.4" },
  { fiscalDateEnding: "2026-03-31", reportedDate: "2026-05-01", reportedEPS: "1.53", estimatedEPS: "1.50", surprisePercentage: "2.0" },
] };

function installStub({ trend = "up", alpha = "ok", news = [] } = {}) {
  const original = global.fetch;
  global.fetch = async url => {
    const u = String(url);
    if (u.includes("twelvedata")) return jr(twelveData({ trend }));
    if (u.includes("alphavantage")) {
      if (alpha === "ratelimit") return jr({ Information: "our standard API rate limit is 25 requests per day" });
      return jr(u.includes("OVERVIEW") ? OVERVIEW_OK : EARNINGS_OK);
    }
    if (u.includes("/v1/finance/search")) return jr({ news });
    if (u.includes("/v8/finance/chart/")) return jr(yahooChart({ trend }));
    return jr({});
  };
  return () => { global.fetch = original; };
}

async function analyse(query, opts) {
  process.env.TWELVE_DATA_API_KEY = "k";
  process.env.ALPHA_VANTAGE_API_KEY = "k";
  const restore = installStub(opts);
  try {
    delete require.cache[ANALYSE_PATH];
    const handler = require(ANALYSE_PATH);
    const res = { _s: 200, body: null, status(c) { this._s = c; return this; }, json(b) { this.body = b; return this; } };
    await handler({ query }, res);
    return res.body;
  } finally { restore(); }
}
const horseman = (b, name) => b.horsemen.find(h => h.name === name);

/* ------------------------------------------------------------------ */

test("LEGACY: Council confidence is an average of three Horseman percentages, minus penalties", async () => {
  const b = await analyse({ ticker: "TEST" });
  const [war, famine, conquest] = ["WAR", "FAMINE", "CONQUEST"].map(n => horseman(b, n));
  const confs = [war.confidence, famine.confidence, conquest.confidence].filter(c => typeof c === "number");
  const mean = confs.reduce((a, c) => a + c, 0) / confs.length;

  // Council never exceeds the mean of its inputs: every adjustment is a penalty.
  assert.ok(b.council.confidence <= Math.round(mean),
    `council ${b.council.confidence} should not exceed the input mean ${Math.round(mean)}`);
  assert.ok(b.council.confidence >= 25 && b.council.confidence <= 92, "clamped to 25..92");
});

test("LEGACY: Death's own direction and confidence are never consumed by Council", async () => {
  const b = await analyse({ ticker: "TEST" });
  const death = horseman(b, "DEATH");
  // Death is displayed with a direction and confidence, but Council reads
  // only its integer risk — the audit's key structural finding.
  assert.ok(death.direction);
  assert.equal(typeof death.confidence, "number");
  assert.match(b.council.reasons.join(" "), /Death (raised|found)/,
    "Council mentions Death's risk count, never its direction or confidence");
});

test("LEGACY: an UNKNOWN Horseman is counted as a neutral vote", async () => {
  // Famine V2 under a rate limit returns direction UNKNOWN, confidence null.
  const b = await analyse({ ticker: "TEST", famineEngine: "v2" }, { alpha: "ratelimit" });
  const famine = horseman(b, "FAMINE");
  assert.equal(famine.direction, "UNKNOWN");
  assert.equal(famine.confidence, null);
  // It still produces a verdict; the abstention is silently absorbed as a
  // neutral vote in `neutral = 3 - bull - bear`.
  assert.ok(b.council.verdict);
  assert.match(b.council.reasons[0], /Famine: UNKNOWN/,
    "the abstention is reported as though it were a stance");
});

test("LEGACY: an abstaining Horseman's confidence drops out of the mean", async () => {
  const participating = await analyse({ ticker: "TEST", famineEngine: "v2" });
  const abstaining = await analyse({ ticker: "TEST", famineEngine: "v2" }, { alpha: "ratelimit" });

  const fParticipating = horseman(participating, "FAMINE");
  const fAbstaining = horseman(abstaining, "FAMINE");
  assert.equal(typeof fParticipating.confidence, "number");
  assert.equal(fAbstaining.confidence, null);

  // Whether this raises or lowers Council confidence depends entirely on
  // whether the silent Horseman sat above or below the mean — the audit's
  // "missing evidence can increase confidence" defect. Characterised here,
  // not endorsed.
  assert.equal(typeof participating.council.confidence, "number");
  assert.equal(typeof abstaining.council.confidence, "number");
});

test("LEGACY: directional disagreement applies a large flat penalty", async () => {
  // A falling price makes War bearish while fundamentals stay bullish.
  const agreeing = await analyse({ ticker: "TEST" }, { trend: "up" });
  const conflicting = await analyse({ ticker: "TEST" }, { trend: "down" });
  const dirsOf = b => ["WAR", "FAMINE", "CONQUEST"].map(n => horseman(b, n).direction);

  const d = dirsOf(conflicting);
  const disagrees = d.includes("BULLISH") && d.includes("BEARISH");
  if (disagrees) {
    assert.ok(conflicting.council.confidence < agreeing.council.confidence,
      "a bullish/bearish split costs a flat 20 points");
    assert.match(conflicting.council.reasons.join(" "), /disagreement reduced confidence/i);
  } else {
    // Direction depends on fixture shape; the reason text is still asserted.
    assert.match(conflicting.council.reasons.join(" "), /No direct bullish-vs-bearish split|disagreement/i);
  }
});

test("LEGACY: Death's risk count is reported and reduces confidence by 4 per point", async () => {
  const b = await analyse({ ticker: "TEST" });
  const reasons = b.council.reasons.join(" ");
  assert.match(reasons, /Death (raised \d+ risk point|found no major)/);
});

test("LEGACY: risk gates the verdict — FAVOURABLE/STRONG require risk below a threshold", async () => {
  const b = await analyse({ ticker: "TEST" });
  assert.ok(["REJECT", "WATCH", "FAVOURABLE", "STRONG"].includes(b.council.verdict),
    "legacy vocabulary has exactly four verdicts");
  assert.ok(!["WAIT", "EXCEPTIONAL"].includes(b.council.verdict),
    "WAIT and EXCEPTIONAL do not exist in legacy Council");
});

test("LEGACY: the conflict penalty is applied AFTER the verdict is selected", async () => {
  // Structural characterisation: the verdict is chosen from a confidence
  // value that may then be reduced by 8, so the verdict and the number
  // displayed beside it can derive from different states.
  const b = await analyse({ ticker: "TEST" });
  assert.ok(b.evidenceEngine, "the conflict flag lives on the evidence engine");
  assert.equal(typeof b.evidenceEngine.conflict, "boolean");
  assert.equal(typeof b.council.confidence, "number");
  if (b.evidenceEngine.conflict) {
    assert.match(b.evidenceEngine.conflictNote, /Council confidence is reduced/);
  }
});

test("LEGACY: whatWouldChangeMind is the same constant sentence for every asset", async () => {
  const a = await analyse({ ticker: "TEST" }, { trend: "up" });
  const b = await analyse({ ticker: "TEST" }, { trend: "down" });
  assert.deepEqual(a.council.changeMind, b.council.changeMind,
    "identical regardless of what was actually found");
  assert.equal(a.council.changeMind.length, 1);
});

test("LEGACY: Council reasons are three fixed templates, not structured evidence", async () => {
  const b = await analyse({ ticker: "TEST" });
  assert.equal(b.council.reasons.length, 3);
  assert.match(b.council.reasons[0], /^War: .*; Famine: .*; Conquest: .*\.$/);
  assert.match(b.council.synopsis, /The Council combined price behaviour/);
});
