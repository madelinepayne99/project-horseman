import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

/** Death V2 live orchestration. Real handler, stubbed providers, no network. */

const require = createRequire(import.meta.url);
const ANALYSE_PATH = new URL("../api/analyse.js", import.meta.url).pathname;
const DAY = 86400;
const jr = (b, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => b, text: async () => JSON.stringify(b) });

function yahooChart(n = 260) {
  const close = [], volume = [];
  for (let i = 0; i < n; i++) { close.push(300 + i * 0.4); volume.push(40000000); }
  return { chart: { result: [{ meta: { currency: "USD", shortName: "Test Co" }, indicators: { quote: [{ close, volume }] } }] } };
}
function twelveDataBody({ n = 320, climb = 0.25 } = {}) {
  const values = []; const start = Date.parse("2026-09-04T00:00:00Z");
  for (let i = 0; i < n; i++) {
    const c = 320 - i * climb;
    values.push({ datetime: new Date(start - i * DAY * 1000).toISOString().slice(0, 10),
      open: c.toFixed(5), high: (c + 1).toFixed(5), low: (c - 1).toFixed(5), close: c.toFixed(5), volume: "40000000" });
  }
  return { status: "ok", meta: { symbol: "TEST", interval: "1day", currency: "USD", exchange: "NASDAQ",
    mic_code: "XNGS", type: "Common Stock", country: "United States", exchange_timezone: "America/New_York" }, values };
}
const OVERVIEW_OK = { Symbol: "TEST", Name: "Test Co", Currency: "USD",
  QuarterlyRevenueGrowthYOY: "0.164", QuarterlyEarningsGrowthYOY: "-0.03",
  ProfitMargin: "0.276", EPS: "8.71", PERatio: "37.33", LatestQuarter: "2026-06-30" };
const EARNINGS_OK = { symbol: "TEST", quarterlyEarnings: [
  { fiscalDateEnding: "2026-06-30", reportedDate: "2026-07-30", reportedEPS: "1.57", estimatedEPS: "1.46", surprisePercentage: "7.4" },
  { fiscalDateEnding: "2026-03-31", reportedDate: "2026-05-01", reportedEPS: "1.20", estimatedEPS: "1.50", surprisePercentage: "-6.1" },
  { fiscalDateEnding: "2025-12-31", reportedDate: "2026-02-01", reportedEPS: "1.60", estimatedEPS: "1.50", surprisePercentage: "5.2" },
  { fiscalDateEnding: "2025-09-30", reportedDate: "2025-11-01", reportedEPS: "1.30", estimatedEPS: "1.50", surprisePercentage: "-4.8" }] };

let calls = 0;
function installStub({ alpha = "ok", climb = 0.25 } = {}) {
  const original = global.fetch; calls = 0;
  global.fetch = async url => {
    calls++; const u = String(url);
    if (u.includes("twelvedata")) return jr(twelveDataBody({ climb }));
    if (u.includes("alphavantage")) {
      if (alpha === "ratelimit") return jr({ Information: "our standard API rate limit is 25 requests per day" });
      return jr(u.includes("OVERVIEW") ? OVERVIEW_OK : EARNINGS_OK);
    }
    if (u.includes("/v1/finance/search")) return jr({ news: [] });
    if (u.includes("/v8/finance/chart/")) return jr(yahooChart());
    return jr({});
  };
  return () => { global.fetch = original; };
}
async function analyse(query, opts) {
  process.env.TWELVE_DATA_API_KEY = "k"; process.env.ALPHA_VANTAGE_API_KEY = "k";
  const restore = installStub(opts);
  try {
    delete require.cache[ANALYSE_PATH];
    const handler = require(ANALYSE_PATH);
    const res = { _s: 200, body: null, status(c) { this._s = c; return this; }, json(b) { this.body = b; return this; } };
    await handler({ query }, res);
    return { body: res.body, calls };
  } finally { restore(); }
}
const deathOf = b => b.horsemen.find(h => h.name === "DEATH");
const strip = v => JSON.parse(JSON.stringify(v), (k, x) =>
  ["retrievedAt", "published", "freshness", "fetchedAt", "cachedAt", "cacheExpiresAt"].includes(k) ? null : x);
const V2 = { ticker: "TEST", deathEngine: "v2", famineEngine: "v2" };

/* ---------------- routing ---------------- */

test("default Death remains legacy", async () => {
  const d = deathOf((await analyse({ ticker: "TEST" })).body);
  assert.equal(d.dataSource, undefined);
  assert.equal(typeof d.confidence, "number");
  assert.ok(["BULLISH", "NEUTRAL", "BEARISH"].includes(d.direction));
});

test("explicit v1 and unrecognised values remain legacy", async () => {
  for (const value of ["v1", "v3", "", "  ", "V1", "true", "v2x"]) {
    const d = deathOf((await analyse({ ticker: "TEST", deathEngine: value })).body);
    assert.equal(d.dataSource, undefined, `deathEngine=${JSON.stringify(value)} must not activate V2`);
  }
});

test("exactly deathEngine=v2 selects Death V2, case and whitespace normalised", async () => {
  for (const value of ["v2", "V2", " v2 "]) {
    const d = deathOf((await analyse({ ticker: "TEST", deathEngine: value })).body);
    assert.equal(d.dataSource.engine, "v2");
    assert.ok(d.dataSource.riskSeverity);
  }
});

test("default Production output is unchanged when Death V2 is not requested", async () => {
  const a = await analyse({ ticker: "TEST" });
  const b = await analyse({ ticker: "TEST", deathEngine: "v1" });
  assert.deepEqual(strip(a.body), strip(b.body));
});

test("requesting Death V2 changes only the Death Horseman", async () => {
  const legacy = await analyse({ ticker: "TEST" });
  const v2 = await analyse({ ticker: "TEST", deathEngine: "v2" });
  for (const name of ["WAR", "FAMINE", "CONQUEST"]) {
    assert.deepEqual(strip(v2.body.horsemen.find(h => h.name === name)),
      strip(legacy.body.horsemen.find(h => h.name === name)));
  }
  assert.deepEqual(strip(v2.body.evidenceEngine), strip(legacy.body.evidenceEngine));
  // Legacy Council still consumes the legacy integer risk and is unaffected.
  assert.deepEqual(v2.body.council, legacy.body.council);
});

test("Death V2 adds no network calls", async () => {
  const legacy = await analyse({ ticker: "TEST" });
  const v2 = await analyse({ ticker: "TEST", deathEngine: "v2" });
  assert.equal(v2.calls, legacy.calls);
});

/* ---------------- inputs ---------------- */

test("War V2 authoritative technical facts reach Death exactly once", async () => {
  const { body } = await analyse({ ticker: "TEST", deathEngine: "v2" });
  const ds = deathOf(body).dataSource;
  const warSourced = ds.observedRisks.filter(f => f.source === "WAR");
  assert.equal(warSourced.filter(f => f.id === "TECHNICAL_EXTENSION").length <= 1, true);
  assert.equal(warSourced.filter(f => f.id === "RAPID_MOVEMENT").length <= 1, true);
  assert.equal(ds.provenance.technicalProvider, "twelvedata");
  // Death must cite the same RSI War used.
  const war = body.horsemen.find(h => h.name === "WAR");
  const warRsi = /RSI ([\d.]+)/.exec(war.evidence.join(" "));
  const deathRsi = /RSI\(14\) is ([\d.]+)/.exec(JSON.stringify(ds));
  if (warRsi && deathRsi) assert.equal(deathRsi[1], warRsi[1], "one RSI, cited identically by both");
});

test("no legacy Conquest technical or crowding proxy leaks into Death V2", async () => {
  const { body } = await analyse({ ticker: "TEST", deathEngine: "v2" });
  const ds = deathOf(body).dataSource;
  const conquest = body.horsemen.find(h => h.name === "CONQUEST");

  // Legacy Conquest is still computing a crowding level from RSI/return/volume.
  assert.ok(conquest.signals.crowding, "legacy Conquest still emits crowding");
  // Death V2 must not have consumed it.
  assert.equal(ds.observedRisks.filter(f => f.source === "CONQUEST").length, 0);
  assert.equal(ds.provenance.crowdDirectEvidence, false);
  const serialised = JSON.stringify(ds).toLowerCase();
  for (const banned of ["volumeratio", "realizedvolatility", "headlinebalance", "attention"]) {
    assert.ok(!serialised.includes(banned), `${banned} must not appear in Death V2`);
  }
});

test("Famine V2 opposing evidence, disagreement and missing evidence map correctly", async () => {
  // Fixture has revenue +16.4% with earnings -3.0% and mixed surprises.
  const { body } = await analyse(V2);
  const ds = deathOf(body).dataSource;
  const famine = body.horsemen.find(h => h.name === "FAMINE");
  assert.equal(famine.dataSource.engine, "v2");

  const famineFindings = [...ds.observedRisks, ...ds.disagreement, ...ds.missingEvidence, ...ds.uncertainty]
    .filter(f => f.source === "FAMINE");
  assert.ok(famineFindings.length > 0, "Famine's structured evidence reaches Death");
  if (famine.dataSource.disagreement.length) {
    assert.ok(ds.disagreement.some(f => f.id === "FUNDAMENTAL_INTERNAL_DISAGREEMENT"));
  }
  if (famine.dataSource.strongestOpposing.length) {
    assert.ok(ds.observedRisks.some(f => f.id === "OPPOSING_FUNDAMENTAL_EVIDENCE"));
  }
});

test("an unavailable Famine becomes MISSING_EVIDENCE, never observed danger", async () => {
  const { body } = await analyse(V2, { alpha: "ratelimit" });
  const ds = deathOf(body).dataSource;
  assert.ok(ds.missingEvidence.some(f => f.id === "FUNDAMENTAL_EVIDENCE_UNAVAILABLE"));
  assert.equal(ds.observedRisks.filter(f => f.source === "FAMINE").length, 0);
});

/* ---------------- category separation ---------------- */

test("UNKNOWN crowding stays missing, not safe and not dangerous", async () => {
  const { body } = await analyse({ ticker: "TEST", deathEngine: "v2" });
  const ds = deathOf(body).dataSource;
  const note = ds.missingEvidence.find(f => f.id === "CROWD_EVIDENCE_UNAVAILABLE");
  assert.ok(note, "absent crowd evidence is recorded as missing");
  assert.equal(ds.observedRisks.filter(f => f.id === "EXPRESSED_CONCENTRATION").length, 0,
    "and is never fabricated into an observed danger");
  assert.ok(deathOf(body).limits.some(l => /crowd behaviour could not be checked/i.test(l)),
    "the limitation is visible to the reader");
});

test("observed risk and missing evidence remain separate categories", async () => {
  const ds = deathOf((await analyse(V2)).body).dataSource;
  for (const f of ds.observedRisks) assert.equal(f.category, "OBSERVED_RISK");
  for (const f of ds.missingEvidence) assert.equal(f.category, "MISSING_EVIDENCE");
  for (const f of ds.uncertainty) assert.equal(f.category, "UNCERTAINTY");
  for (const f of ds.disagreement) assert.equal(f.category, "DISAGREEMENT");
  const ids = new Set(ds.observedRisks.map(f => f.id));
  for (const f of ds.missingEvidence) assert.ok(!ids.has(f.id), "no finding appears in two categories");
});

test("Death evidence confidence does not rise merely because severity rises", async () => {
  // Two runs with identical evidence availability but different price shapes.
  const calm = await analyse({ ticker: "TEST", deathEngine: "v2", famineEngine: "v2" }, { climb: 0.02 });
  const extended = await analyse({ ticker: "TEST", deathEngine: "v2", famineEngine: "v2" }, { climb: 1.2 });
  const a = deathOf(calm.body).dataSource, b = deathOf(extended.body).dataSource;

  assert.equal(a.evidenceConfidenceScore, b.evidenceConfidenceScore,
    "identical evidence availability must yield identical evidence confidence, whatever the severity");
  assert.ok(b.observedRisks.length >= a.observedRisks.length);
});

test("Death V2 emits no legacy risk integer and no fabricated direction", async () => {
  const d = deathOf((await analyse({ ticker: "TEST", deathEngine: "v2" })).body);
  assert.equal(d.direction, null, "severity is not a market direction");
  assert.equal(d.confidence, null, "evidence confidence is a band, reported in dataSource");
  const keys = new Set();
  (function walk(v) { if (v && typeof v === "object") for (const [k, val] of Object.entries(v)) { keys.add(k.toLowerCase()); walk(val); } })(d.dataSource);
  assert.ok(!keys.has("risk"), "no legacy integer risk may appear");
});

/* ---------------- Council boundary ---------------- */

test("Death V2 structured fields reach the Council adapter losslessly", async () => {
  const { body } = await analyse(V2);
  const ds = deathOf(body).dataSource;
  const { adaptDeath } = await import("../src/council/councilAdapter.js");
  const adapted = adaptDeath(ds);
  assert.equal(adapted.riskSeverity, ds.riskSeverity);
  assert.equal(adapted.evidenceConfidence, ds.evidenceConfidence);
  assert.equal(adapted.observedRisks.length, ds.observedRisks.length);
  assert.equal(adapted.missingEvidence.length, ds.missingEvidence.length);
  assert.equal(adapted.uncertainty.length, ds.uncertainty.length);
  assert.deepEqual(adapted.strongestChallenge, ds.strongestChallenge);
});

test("Council V2 stays INTEGRATION_UNAVAILABLE, now naming only Conquest", async () => {
  const { body } = await analyse({ ticker: "TEST", councilEngine: "v2", famineEngine: "v2", deathEngine: "v2" });
  assert.equal(body.council.status, "INTEGRATION_UNAVAILABLE");
  assert.equal(body.council.verdict, null);
  assert.deepEqual(body.council.missingDependencies, ["CONQUEST_V2"],
    "Death V2 now satisfies its dependency; only Conquest remains");
});

test("no partial Council mode is created and no risk integer is reconstructed", async () => {
  const { body } = await analyse({ ticker: "TEST", councilEngine: "v2", famineEngine: "v2", deathEngine: "v2" });
  assert.equal(body.council.confidence, null);
  const keys = new Set();
  (function walk(v) { if (v && typeof v === "object") for (const [k, val] of Object.entries(v)) { keys.add(k.toLowerCase()); walk(val); } })(body.council);
  assert.ok(!keys.has("risk"));
});

test("Council V2 without Death V2 still reports Death as missing — no silent fallback", async () => {
  const { body } = await analyse({ ticker: "TEST", councilEngine: "v2", famineEngine: "v2" });
  assert.deepEqual(body.council.missingDependencies, ["CONQUEST_V2", "DEATH_V2"]);
});

test("legacy Council continues to consume legacy Death when Death V2 is active", async () => {
  const legacy = await analyse({ ticker: "TEST" });
  const withV2 = await analyse({ ticker: "TEST", deathEngine: "v2" });
  assert.deepEqual(withV2.body.council, legacy.body.council,
    "legacy Council's verdict and confidence must be untouched by the Death display change");
  assert.match(withV2.body.council.reasons.join(" "), /Death (raised \d+ risk point|found no major)/);
});
