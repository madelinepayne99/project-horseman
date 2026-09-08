import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  adaptWar, adaptFamine, adaptConquest, adaptDeath,
  warEvidenceConfidence, famineEvidenceConfidence, warFreshnessStatus,
  assessCouncilV2Readiness, buildCouncilInputFromHorsemen, councilV2Unavailable,
  REQUIRED_DEPENDENCIES, ADAPTER_MAPPING,
} from "../src/council/councilAdapter.js";
import { Direction } from "../src/council/councilInput.js";
import { councilAnalysis } from "../src/council/councilAnalysis.js";

/**
 * Council V2 integration boundary.
 *
 * The adapter tests are pure. The routing tests exercise the REAL
 * api/analyse.js handler with stubbed providers — no network anywhere.
 */

const require = createRequire(import.meta.url);
const ANALYSE_PATH = new URL("../api/analyse.js", import.meta.url).pathname;
const DAY = 86400;
const jr = (body, status = 200) => ({
  ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body),
});

/* ---------------- fixtures ---------------- */

const warV2Meta = (over = {}) => ({
  engine: "v2", provider: "twelvedata", simulated: false, dataStatus: "COMPLETE",
  latestDataTimestamp: "2026-09-03", latestBarIsProvisional: false,
  candlesUsed: 320, calculationVersion: "war-technicals-v2", ...over,
});
const warHorseman = (over = {}) => ({
  name: "WAR", direction: "BULLISH",
  confidence: 90,               // displayed conviction — must never be reused
  dataSource: warV2Meta(over),
});

const famineV2Source = (over = {}) => ({
  engine: "v2", providers: ["alphavantage", "yahoo-news"], dataStatus: "COMPLETE",
  completeness: { score: 1, missing: [] }, freshness: { overall: "CURRENT", fundamentals: { status: "CURRENT" } },
  missingEvidence: [], disagreement: [], strongestSupporting: [{ claim: "Revenue grew 16.4%" }],
  strongestOpposing: [], ...over,
});
const famineHorseman = (over = {}) => ({
  name: "FAMINE", direction: "BULLISH", confidence: 70, dataSource: famineV2Source(over),
});

const conquestV2 = (over = {}) => ({
  attentionLevel: "VERY_HIGH", sentiment: "UNKNOWN", crowding: "UNKNOWN", polarisation: "UNKNOWN",
  evidenceQualityBand: "INSUFFICIENT", directEvidence: false, sentimentConfidence: null, ...over,
});
const deathV2 = (over = {}) => ({
  assetId: "TEST", riskSeverity: "MODERATE", evidenceConfidence: "STRONG",
  observedRisks: [{ id: "TECHNICAL_EXTENSION", severity: "MODERATE" }],
  missingEvidence: [{ id: "CROWDING_UNKNOWN" }], uncertainty: [{ id: "CROWD_SENTIMENT_UNKNOWN" }],
  disagreement: [], strongestChallenge: { hasObservedChallenge: true, statement: "RSI is 82", finding: { id: "TECHNICAL_EXTENSION", severity: "MODERATE" } },
  ...over,
});

/* ================================================================== */
/* WAR MAPPING                                                        */
/* ================================================================== */

test("War's displayed confidence is NEVER passed through as Council evidence confidence", () => {
  const war = warHorseman();
  const adapted = adaptWar(war);
  assert.equal(war.confidence, 90, "War still reports its own directional conviction");
  assert.notEqual(adapted.evidenceConfidence, 90,
    "the 55 + |score|*7 conviction figure must not become an evidence-quality score");

  // Proof it is independent: change ONLY the displayed confidence.
  const louder = adaptWar({ ...war, confidence: 50 });
  assert.equal(louder.evidenceConfidence, adapted.evidenceConfidence,
    "evidence quality must not move when directional conviction moves");
});

test("War evidence confidence derives only from structured quality fields", () => {
  // Perfect quality: COMPLETE status, full history, settled bar, primary provider.
  assert.equal(warEvidenceConfidence(warV2Meta()), 100);
  // Each quality field independently moves it.
  assert.ok(warEvidenceConfidence(warV2Meta({ dataStatus: "PARTIAL_DATA" })) < 100);
  assert.ok(warEvidenceConfidence(warV2Meta({ candlesUsed: 60 })) < 100);
  assert.ok(warEvidenceConfidence(warV2Meta({ latestBarIsProvisional: true })) < 100);
  assert.ok(warEvidenceConfidence(warV2Meta({ fallbackReason: "PROVIDER_UNAVAILABLE" })) < 100);
});

test("degraded, incomplete and stale War evidence each lower its Council-facing quality", () => {
  const pristine = warEvidenceConfidence(warV2Meta());
  const stale = warEvidenceConfidence(warV2Meta({ dataStatus: "STALE_DATA" }));
  const partial = warEvidenceConfidence(warV2Meta({ dataStatus: "PARTIAL_DATA", candlesUsed: 80 }));
  const provisional = warEvidenceConfidence(warV2Meta({ latestBarIsProvisional: true }));
  const fallback = warEvidenceConfidence(warV2Meta({ fallbackReason: "RATE_LIMITED" }));

  for (const [label, v] of [["stale", stale], ["partial", partial], ["provisional", provisional], ["fallback", fallback]]) {
    assert.ok(v < pristine, `${label} (${v}) should be below pristine (${pristine})`);
  }
  assert.equal(warEvidenceConfidence(warV2Meta({ dataStatus: "DATA_UNAVAILABLE" })), 0);
  assert.equal(warFreshnessStatus(warV2Meta({ dataStatus: "STALE_DATA" })), "STALE");
});

test("simulated War data is never treated as evidence about a real company", () => {
  assert.equal(warEvidenceConfidence(warV2Meta({ simulated: true })), 0);
});

test("a legacy (non-v2) War produces no quality figure rather than a guessed one", () => {
  const adapted = adaptWar({ name: "WAR", direction: "BULLISH", confidence: 88 });
  assert.equal(adapted.evidenceConfidence, null, "unquantified, not assumed good");
  assert.equal(adapted.completeness, null);
  assert.equal(adapted.dataStatus, "UNKNOWN");
});

/* ================================================================== */
/* FAMINE MAPPING                                                     */
/* ================================================================== */

test("Famine mapping uses structured V2 quality fields, not its displayed confidence", () => {
  const famine = famineHorseman();
  const adapted = adaptFamine(famine);
  assert.equal(adapted.evidenceConfidence, 100);
  assert.notEqual(adapted.evidenceConfidence, famine.confidence);

  const quieter = adaptFamine({ ...famine, confidence: 42 });
  assert.equal(quieter.evidenceConfidence, adapted.evidenceConfidence,
    "evidence quality is independent of displayed conviction");
});

test("Famine completeness, freshness and status each lower its Council-facing quality", () => {
  const full = famineEvidenceConfidence(famineV2Source());
  assert.ok(famineEvidenceConfidence(famineV2Source({ completeness: { score: 0.5, missing: [] } })) < full);
  assert.ok(famineEvidenceConfidence(famineV2Source({ freshness: { overall: "STALE" } })) < full);
  assert.ok(famineEvidenceConfidence(famineV2Source({ dataStatus: "PARTIAL_EVIDENCE" })) < full);
  assert.equal(famineEvidenceConfidence(famineV2Source({ dataStatus: "EVIDENCE_UNAVAILABLE" })), 0);
});

test("Famine's structured evidence arrays carry through to Council", () => {
  const adapted = adaptFamine(famineHorseman({
    disagreement: [{ type: "REVENUE_UP_EARNINGS_DOWN" }],
    missingEvidence: [{ field: "peRatio" }],
    strongestOpposing: [{ claim: "Earnings fell 3.0%" }],
  }));
  assert.equal(adapted.internalDisagreement.length, 1);
  assert.equal(adapted.missingEvidence.length, 1);
  assert.equal(adapted.strongestOpposing[0].claim, "Earnings fell 3.0%");
});

/* ================================================================== */
/* CONQUEST MAPPING                                                   */
/* ================================================================== */

test("Conquest sentiment UNKNOWN maps to abstention", () => {
  const adapted = adaptConquest(conquestV2({ sentiment: "UNKNOWN" }));
  assert.equal(adapted.direction, Direction.UNKNOWN);

  const input = buildCouncilInputFromHorsemen({
    assetId: "TEST", war: warHorseman(), famine: famineHorseman(),
    conquestV2: conquestV2({ sentiment: "UNKNOWN" }), deathV2: deathV2(),
  }).input;
  assert.deepEqual(input.coverage.abstained, ["CONQUEST"]);
  assert.equal(input.horsemen.CONQUEST.participated, false);
});

test("Conquest attention alone can never become directional evidence or confidence", () => {
  const loud = adaptConquest(conquestV2({ attentionLevel: "VERY_HIGH", sentiment: "UNKNOWN" }));
  const quiet = adaptConquest(conquestV2({ attentionLevel: "NONE_OBSERVED", sentiment: "UNKNOWN" }));

  assert.equal(loud.direction, Direction.UNKNOWN);
  assert.equal(quiet.direction, Direction.UNKNOWN);
  assert.deepEqual(loud, quiet, "attention level must change nothing Council consumes");

  // And in a full judgment it contributes zero.
  const r = councilAnalysis(buildCouncilInputFromHorsemen({
    assetId: "TEST", war: warHorseman(), famine: famineHorseman(),
    conquestV2: conquestV2({ attentionLevel: "VERY_HIGH" }), deathV2: deathV2(),
  }).input);
  const contribution = r.directional.contributions.find(c => c.horseman === "CONQUEST");
  assert.equal(contribution.contribution, 0);
  assert.equal(contribution.weight, 0);
});

test("Conquest MIXED sentiment participates as NEUTRAL; BULLISH/BEARISH map through", () => {
  assert.equal(adaptConquest(conquestV2({ sentiment: "MIXED" })).direction, Direction.NEUTRAL);
  assert.equal(adaptConquest(conquestV2({ sentiment: "NEUTRAL" })).direction, Direction.NEUTRAL);
  assert.equal(adaptConquest(conquestV2({ sentiment: "BULLISH" })).direction, Direction.BULLISH);
  assert.equal(adaptConquest(conquestV2({ sentiment: "BEARISH" })).direction, Direction.BEARISH);
});

test("Conquest evidence confidence comes from its quality band, and direct evidence is recorded", () => {
  assert.equal(adaptConquest(conquestV2({ evidenceQualityBand: "STRONG" })).evidenceConfidence,
    ADAPTER_MAPPING.CONQUEST_QUALITY_BAND.STRONG);
  assert.equal(adaptConquest(conquestV2({ evidenceQualityBand: "INSUFFICIENT" })).evidenceConfidence, null,
    "no band means unquantified, not zero-quality");
  assert.equal(adaptConquest(conquestV2({ directEvidence: true })).dataStatus, "DIRECT_CROWD");
  assert.equal(adaptConquest(conquestV2({ directEvidence: false })).dataStatus, "PROXY_ONLY");
  assert.equal(adaptConquest(conquestV2({ polarisation: "HIGH" })).internalDisagreement.length, 1);
});

/* ================================================================== */
/* DEATH MAPPING                                                      */
/* ================================================================== */

test("Death V2 structured fields map losslessly", () => {
  const d = deathV2();
  const adapted = adaptDeath(d);
  assert.equal(adapted.riskSeverity, "MODERATE");
  assert.equal(adapted.evidenceConfidence, "STRONG");
  assert.equal(adapted.observedRisks.length, 1);
  assert.equal(adapted.missingEvidence.length, 1);
  assert.equal(adapted.uncertainty.length, 1);
  assert.equal(adapted.strongestChallenge.statement, "RSI is 82");

  const input = buildCouncilInputFromHorsemen({
    assetId: "TEST", war: warHorseman(), famine: famineHorseman(),
    conquestV2: conquestV2(), deathV2: d,
  }).input;
  assert.equal(input.death.riskSeverity, "MODERATE");
  assert.equal(input.death.strongestChallenge.findingId, "TECHNICAL_EXTENSION");
});

test("the legacy integer risk is never mapped into Council V2", () => {
  // A Death object carrying BOTH legacy and V2 shapes: the integer is ignored.
  const adapted = adaptDeath({ ...deathV2(), risk: 4, confidence: 82, direction: "BEARISH" });
  assert.ok(!("risk" in adapted));
  assert.ok(!("direction" in adapted));
  assert.equal(adapted.riskSeverity, "MODERATE", "severity comes from Death V2, not from the integer");

  const r = councilAnalysis(buildCouncilInputFromHorsemen({
    assetId: "TEST", war: warHorseman(), famine: famineHorseman(),
    conquestV2: conquestV2(), deathV2: { ...deathV2(), risk: 4 },
  }).input);
  const keys = new Set();
  (function walk(v) { if (v && typeof v === "object") for (const [k, val] of Object.entries(v)) { keys.add(k.toLowerCase()); walk(val); } })(r);
  assert.ok(!keys.has("risk"), "no legacy risk integer may appear anywhere in a Council V2 result");
});

/* ================================================================== */
/* READINESS / FAIL-CLOSED                                            */
/* ================================================================== */

test("readiness requires all four V2 dependencies", () => {
  assert.deepEqual(REQUIRED_DEPENDENCIES, ["WAR_V2", "FAMINE_V2", "CONQUEST_V2", "DEATH_V2"]);
  const complete = assessCouncilV2Readiness({
    war: warHorseman(), famine: famineHorseman(), conquestV2: conquestV2(), deathV2: deathV2() });
  assert.equal(complete.ready, true);
  assert.deepEqual(complete.missingDependencies, []);
});

test("REGRESSION: mixed legacy/V2 dependencies fail closed rather than producing a misleading verdict", () => {
  // The transitional live shape: War V2 + Famine V2, but legacy Conquest and Death.
  const readiness = assessCouncilV2Readiness({ war: warHorseman(), famine: famineHorseman() });
  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.missingDependencies, ["CONQUEST_V2", "DEATH_V2"]);

  const built = buildCouncilInputFromHorsemen({ assetId: "TEST", war: warHorseman(), famine: famineHorseman() });
  assert.equal(built.input, null, "no CouncilInput is fabricated from incompatible semantics");

  const state = councilV2Unavailable(readiness.missingDependencies);
  assert.equal(state.verdict, null, "no verdict is invented to make the endpoint look answered");
  assert.equal(state.confidence, null);
  assert.equal(state.status, "INTEGRATION_UNAVAILABLE");
});

test("a legacy War or legacy Famine is also detected as a missing dependency", () => {
  assert.deepEqual(
    assessCouncilV2Readiness({ war: { name: "WAR", direction: "BULLISH" }, famine: famineHorseman(),
      conquestV2: conquestV2(), deathV2: deathV2() }).missingDependencies, ["WAR_V2"]);
  assert.deepEqual(
    assessCouncilV2Readiness({ war: warHorseman(), famine: { name: "FAMINE", direction: "BULLISH" },
      conquestV2: conquestV2(), deathV2: deathV2() }).missingDependencies, ["FAMINE_V2"]);
});

test("with all four dependencies present, a real judgment is produced", () => {
  const built = buildCouncilInputFromHorsemen({
    assetId: "TEST", war: warHorseman(), famine: famineHorseman(),
    conquestV2: conquestV2({ sentiment: "BULLISH", evidenceQualityBand: "STRONG", directEvidence: true }),
    deathV2: deathV2({ riskSeverity: "NONE_OBSERVED", observedRisks: [] }),
  });
  assert.equal(built.ready, true);
  const r = councilAnalysis(built.input);
  assert.ok(["REJECT", "WATCH", "WAIT", "FAVOURABLE", "STRONG", "EXCEPTIONAL"].includes(r.verdict));
  assert.equal(typeof r.confidence, "number");
});

test("the legacy Evidence Engine never enters Council V2", () => {
  const built = buildCouncilInputFromHorsemen({
    assetId: "TEST", war: warHorseman(), famine: famineHorseman(),
    conquestV2: conquestV2(), deathV2: deathV2(),
  });
  const keys = new Set();
  (function walk(v) { if (v && typeof v === "object") for (const [k, val] of Object.entries(v)) { keys.add(k.toLowerCase()); walk(val); } })(built.input);
  for (const banned of ["evidenceengine", "reliabilityscore", "conflictnote", "newsitems", "supports"]) {
    assert.ok(!keys.has(banned), `${banned} must not reach Council V2`);
  }
  assert.ok(councilV2Unavailable(["DEATH_V2"]).limitations.some(l => /Evidence Engine is deliberately not consumed/.test(l)));
});

/* ================================================================== */
/* LIVE ROUTING                                                       */
/* ================================================================== */

function yahooChart(n = 260) {
  const close = [], volume = [];
  for (let i = 0; i < n; i++) { close.push(300 + i * 0.4); volume.push(40000000); }
  return { chart: { result: [{ meta: { currency: "USD", shortName: "Test Co" }, indicators: { quote: [{ close, volume }] } }] } };
}
function twelveDataBody(n = 320) {
  const values = []; const start = Date.parse("2026-09-04T00:00:00Z");
  for (let i = 0; i < n; i++) { const c = 320 - i * 0.25;
    values.push({ datetime: new Date(start - i * DAY * 1000).toISOString().slice(0, 10),
      open: c.toFixed(5), high: (c + 1).toFixed(5), low: (c - 1).toFixed(5), close: c.toFixed(5), volume: "40000000" }); }
  return { status: "ok", meta: { symbol: "TEST", interval: "1day", currency: "USD", exchange: "NASDAQ",
    mic_code: "XNGS", type: "Common Stock", country: "United States", exchange_timezone: "America/New_York" }, values };
}
const OVERVIEW_OK = { Symbol: "TEST", Name: "Test Co", Currency: "USD",
  QuarterlyRevenueGrowthYOY: "0.164", QuarterlyEarningsGrowthYOY: "0.287",
  ProfitMargin: "0.276", EPS: "8.71", PERatio: "37.33", LatestQuarter: "2026-06-30" };
const EARNINGS_OK = { symbol: "TEST", quarterlyEarnings: [
  { fiscalDateEnding: "2026-06-30", reportedDate: "2026-07-30", reportedEPS: "1.57", estimatedEPS: "1.46", surprisePercentage: "7.4" }] };

let fetchCallCount = 0;
function installStub() {
  const original = global.fetch;
  fetchCallCount = 0;
  global.fetch = async url => {
    fetchCallCount++;
    const u = String(url);
    if (u.includes("twelvedata")) return jr(twelveDataBody());
    if (u.includes("alphavantage")) return jr(u.includes("OVERVIEW") ? OVERVIEW_OK : EARNINGS_OK);
    if (u.includes("/v1/finance/search")) return jr({ news: [] });
    if (u.includes("/v8/finance/chart/")) return jr(yahooChart());
    return jr({});
  };
  return () => { global.fetch = original; };
}
/**
 * Removes wall-clock timestamps so two runs can be compared structurally.
 * The Evidence Engine stamps each item with Date.now(), which differs by a
 * millisecond or two between runs and is not a behavioural difference.
 */
function stripTimestamps(value) {
  return JSON.parse(JSON.stringify(value), (k, v) =>
    (k === "retrievedAt" || k === "published" || k === "freshness") ? null : v);
}

async function analyse(query) {
  process.env.TWELVE_DATA_API_KEY = "k"; process.env.ALPHA_VANTAGE_API_KEY = "k";
  const restore = installStub();
  try {
    delete require.cache[ANALYSE_PATH];
    const handler = require(ANALYSE_PATH);
    const res = { _s: 200, body: null, status(c) { this._s = c; return this; }, json(b) { this.body = b; return this; } };
    await handler({ query }, res);
    return { body: res.body, calls: fetchCallCount };
  } finally { restore(); }
}

test("default request keeps legacy Council", async () => {
  const { body } = await analyse({ ticker: "TEST" });
  assert.ok(body.council.verdict, "legacy Council always produces a verdict");
  assert.equal(body.council.engine, undefined);
  assert.ok(body.council.synopsis);
});

test("councilEngine=v1 keeps legacy Council", async () => {
  const { body } = await analyse({ ticker: "TEST", councilEngine: "v1" });
  assert.ok(body.council.verdict);
  assert.equal(body.council.status, undefined);
});

test("unknown councilEngine values keep legacy Council — V2 is opt-in only", async () => {
  for (const value of ["v3", "", "  ", "V1", "true", "v2x", "legacy"]) {
    const { body } = await analyse({ ticker: "TEST", councilEngine: value });
    assert.ok(body.council.verdict, `councilEngine=${JSON.stringify(value)} must not activate V2`);
    assert.equal(body.council.status, undefined);
  }
});

test("exactly councilEngine=v2 routes to the new boundary and fails closed", async () => {
  for (const value of ["v2", "V2", " v2 "]) {
    const { body } = await analyse({ ticker: "TEST", councilEngine: value });
    assert.equal(body.council.engine, "v2");
    assert.equal(body.council.status, "INTEGRATION_UNAVAILABLE");
    assert.equal(body.council.verdict, null, "no fabricated verdict");
    assert.equal(body.council.confidence, null);
    // Famine V2 is itself opt-in, so with councilEngine=v2 alone it is
    // correctly reported as missing too — the boundary names every
    // dependency it lacks rather than assuming any of them.
    assert.deepEqual(body.council.missingDependencies, ["FAMINE_V2", "CONQUEST_V2", "DEATH_V2"]);
    assert.ok(body.council.limitations.some(l => /Evidence Engine is deliberately not consumed/.test(l)));
  }
});

test("with Famine V2 also enabled, only Conquest and Death remain outstanding", async () => {
  const { body } = await analyse({ ticker: "TEST", councilEngine: "v2", famineEngine: "v2" });
  assert.equal(body.council.status, "INTEGRATION_UNAVAILABLE");
  assert.deepEqual(body.council.missingDependencies, ["CONQUEST_V2", "DEATH_V2"],
    "War V2 and Famine V2 satisfy their requirements; the two unwired Horsemen do not");
  assert.equal(body.council.verdict, null);
});

test("legacy output is byte-identical when Council V2 is not requested", async () => {
  const a = await analyse({ ticker: "TEST" });
  const b = await analyse({ ticker: "TEST", councilEngine: "v1" });
  assert.deepEqual(stripTimestamps(a.body), stripTimestamps(b.body),
    "v1 and default must be identical");
});

test("requesting Council V2 changes only the council block, never the Horsemen", async () => {
  const legacy = await analyse({ ticker: "TEST" });
  const v2 = await analyse({ ticker: "TEST", councilEngine: "v2" });
  assert.deepEqual(stripTimestamps(v2.body.horsemen), stripTimestamps(legacy.body.horsemen),
    "Horsemen are untouched");
  assert.deepEqual(stripTimestamps(v2.body.evidenceEngine), stripTimestamps(legacy.body.evidenceEngine),
    "the legacy Evidence Engine is preserved unchanged for legacy Council");
  assert.deepEqual(v2.body.asset, legacy.body.asset);
});

test("the Council V2 boundary makes no additional network calls", async () => {
  const legacy = await analyse({ ticker: "TEST" });
  const v2 = await analyse({ ticker: "TEST", councilEngine: "v2" });
  assert.equal(v2.calls, legacy.calls, "routing must not add a single request");
});
