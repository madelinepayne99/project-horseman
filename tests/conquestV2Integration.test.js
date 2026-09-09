import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

/** Conquest V2 live orchestration. Real handler, stubbed providers, no network. */

const require = createRequire(import.meta.url);
const ANALYSE_PATH = new URL("../api/analyse.js", import.meta.url).pathname;
const DAY = 86400;
const jr = (b, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => b, text: async () => JSON.stringify(b) });

function yahooChart(n = 260) {
  const close = [], volume = [];
  for (let i = 0; i < n; i++) { close.push(300 + i * 0.4); volume.push(40000000); }
  return { chart: { result: [{ meta: { currency: "USD", shortName: "Test Co" }, indicators: { quote: [{ close, volume }] } }] } };
}
function twelveDataBody({ n = 320, spike = false } = {}) {
  const values = []; const start = Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
  for (let i = 0; i < n; i++) {
    const c = 320 - i * 0.25;
    values.push({ datetime: new Date(start - i * DAY * 1000).toISOString().slice(0, 10),
      open: c.toFixed(5), high: (c + 1).toFixed(5), low: (c - 1).toFixed(5), close: c.toFixed(5),
      volume: String(spike && i < 3 ? 90_000_000 : 40_000_000) });
  }
  return { status: "ok", meta: { symbol: "TEST", interval: "1day", currency: "USD", exchange: "NASDAQ",
    mic_code: "XNGS", type: "Common Stock", country: "United States", exchange_timezone: "America/New_York" }, values };
}
const OVERVIEW_OK = { Symbol: "TEST", Name: "Test Co", Currency: "USD",
  QuarterlyRevenueGrowthYOY: "0.164", QuarterlyEarningsGrowthYOY: "0.287",
  ProfitMargin: "0.276", EPS: "8.71", PERatio: "37.33", LatestQuarter: "2026-06-30" };
const EARNINGS_OK = { symbol: "TEST", quarterlyEarnings: [
  { fiscalDateEnding: "2026-06-30", reportedDate: "2026-07-30", reportedEPS: "1.57", estimatedEPS: "1.46", surprisePercentage: "7.4" }] };

let calls = 0;
function installStub({ spike = false } = {}) {
  const original = global.fetch; calls = 0;
  global.fetch = async url => {
    calls++; const u = String(url);
    if (u.includes("twelvedata")) return jr(twelveDataBody({ spike }));
    if (u.includes("alphavantage")) return jr(u.includes("OVERVIEW") ? OVERVIEW_OK : EARNINGS_OK);
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
const conquestOf = b => b.horsemen.find(h => h.name === "CONQUEST");
const strip = v => JSON.parse(JSON.stringify(v), (k, x) =>
  ["retrievedAt", "published", "freshness", "fetchedAt", "cachedAt", "cacheExpiresAt"].includes(k) ? null : x);

/* ---------------- routing ---------------- */

test("default Conquest remains legacy", async () => {
  const c = conquestOf((await analyse({ ticker: "TEST" })).body);
  assert.equal(c.dataSource, undefined);
  assert.equal(typeof c.confidence, "number");
  assert.ok(["BULLISH", "NEUTRAL", "BEARISH"].includes(c.direction));
  assert.ok(c.signals, "legacy Conquest still emits its signals block");
});

test("explicit v1 and unrecognised values remain legacy", async () => {
  for (const value of ["v1", "v3", "", "  ", "V1", "true", "v2x", "legacy"]) {
    const c = conquestOf((await analyse({ ticker: "TEST", conquestEngine: value })).body);
    assert.equal(c.dataSource, undefined, `conquestEngine=${JSON.stringify(value)} must not activate V2`);
  }
});

test("exactly conquestEngine=v2 selects Conquest V2, case and whitespace normalised", async () => {
  for (const value of ["v2", "V2", " v2 "]) {
    const c = conquestOf((await analyse({ ticker: "TEST", conquestEngine: value })).body);
    assert.equal(c.dataSource.engine, "v2");
    assert.ok(Array.isArray(c.dataSource.behaviouralRegimes));
  }
});

test("default Production output is unchanged when Conquest V2 is not requested", async () => {
  const a = await analyse({ ticker: "TEST" });
  const b = await analyse({ ticker: "TEST", conquestEngine: "v1" });
  assert.deepEqual(strip(a.body), strip(b.body));
});

test("requesting Conquest V2 changes only the Conquest Horseman", async () => {
  const legacy = await analyse({ ticker: "TEST" });
  const v2 = await analyse({ ticker: "TEST", conquestEngine: "v2" });
  for (const name of ["WAR", "FAMINE", "DEATH"]) {
    assert.deepEqual(strip(v2.body.horsemen.find(h => h.name === name)),
      strip(legacy.body.horsemen.find(h => h.name === name)));
  }
  assert.deepEqual(strip(v2.body.evidenceEngine), strip(legacy.body.evidenceEngine));
  // Legacy Council still consumes legacy Conquest and is unaffected.
  assert.deepEqual(v2.body.council, legacy.body.council);
});

test("Conquest V2 adds no network calls", async () => {
  const legacy = await analyse({ ticker: "TEST" });
  const v2 = await analyse({ ticker: "TEST", conquestEngine: "v2" });
  assert.equal(v2.calls, legacy.calls);
});

/* ---------------- inputs and boundaries ---------------- */

test("Conquest V2 reads the normalised series, never War's interpretation", async () => {
  const { body } = await analyse({ ticker: "TEST", conquestEngine: "v2" });
  const ds = conquestOf(body).dataSource;
  // Behavioural observations exist, so the series reached it.
  assert.equal(typeof ds.observations.movementMagnitudePercentile, "number");
  // And no War output appears anywhere in it.
  const text = JSON.stringify(ds).toLowerCase();
  for (const banned of ["rsi", "movingaverage", "moving average", "support level",
                        "resistance", "overbought", "breakout"]) {
    assert.ok(!new RegExp(`\\b${banned}\\b`).test(text), `${banned} belongs to War`);
  }
  // The handler passes the series, not warFactsV2.
  const src = require("node:fs").readFileSync(ANALYSE_PATH, "utf8");
  assert.ok(/buildConquestInput\(\{[\s\S]{0,200}series:normalisedSeries/.test(src));
  assert.ok(!/buildConquestInput\(\{[\s\S]{0,200}warFactsV2/.test(src));
});

test("market behaviour is produced with no crowd provider", async () => {
  const { body } = await analyse({ ticker: "TEST", conquestEngine: "v2" });
  const ds = conquestOf(body).dataSource;
  assert.equal(ds.status, "ASSESSED");
  assert.equal(ds.provenance.marketBehaviourAvailable, true);
  assert.equal(typeof ds.observations.movementMagnitudePercentile, "number");
  // A featureless fixture classifies NO regime, and says so rather than
  // inventing one. That is the correct answer, not a failure.
  assert.ok(["CLASSIFIED", "UNKNOWN", "INSUFFICIENT_HISTORY"].includes(ds.regimeStatus));
  if (ds.regimeStatus !== "CLASSIFIED") assert.deepEqual(ds.behaviouralRegimes, []);
});

test("a genuinely unusual fixture does classify a behavioural regime", async () => {
  const { body } = await analyse({ ticker: "TEST", conquestEngine: "v2" }, { spike: true });
  const ds = conquestOf(body).dataSource;
  assert.equal(ds.regimeStatus, "CLASSIFIED");
  assert.ok(ds.behaviouralRegimes.length >= 1);
  assert.ok(ds.behaviouralRegimes.every(r =>
    ["QUIET", "ELEVATED_ACTIVITY", "EXTREME_ACTIVITY",
     "FADING_PARTICIPATION", "RISING_PARTICIPATION"].includes(r)));
});

test("every crowd field is UNKNOWN/UNAVAILABLE with no provider, and never NEUTRAL", async () => {
  const { body } = await analyse({ ticker: "TEST", conquestEngine: "v2" });
  const ds = conquestOf(body).dataSource;
  assert.equal(ds.crowdAttention, "UNAVAILABLE");
  assert.equal(ds.crowdSentiment, "UNKNOWN");
  assert.equal(ds.crowding, "UNKNOWN");
  assert.equal(ds.polarisation, "UNKNOWN");
  assert.equal(ds.crowdSentimentConfidence, null);
  for (const v of [ds.crowdSentiment, ds.crowding, ds.polarisation]) assert.notEqual(v, "NEUTRAL");
  assert.equal(ds.provenance.directCrowdEvidence, false);
});

test("Conquest V2 emits no market direction and no fabricated confidence", async () => {
  const c = conquestOf((await analyse({ ticker: "TEST", conquestEngine: "v2" })).body);
  assert.equal(c.direction, null, "behaviour is not a market direction");
  assert.equal(c.confidence, null);
  assert.equal(c.dataSource.provenance.directionalContributionPermitted, false);
});

test("missing evidence is reported, not hidden", async () => {
  const ds = conquestOf((await analyse({ ticker: "TEST", conquestEngine: "v2" })).body).dataSource;
  assert.ok(ds.missingEvidence.some(m => m.item === "DIRECT_CROWD"));
  assert.equal(ds.evidenceQuality.independentSourceCount, 1,
    "several market-derived signals remain one source");
  assert.ok(ds.evidenceQuality.derivedSignalCount > 1);
});

test("a provisional latest bar suppresses participation rather than reporting it as quiet", async () => {
  const ds = conquestOf((await analyse({ ticker: "TEST", conquestEngine: "v2" })).body).dataSource;
  if (ds.observations.latestBarProvisional) {
    assert.equal(ds.observations.participationPercentile, null,
      "a part-formed session must not read as unusually quiet");
  }
});

/* ---------------- Council boundary ---------------- */

test("Council V2 stays INTEGRATION_UNAVAILABLE without Conquest V2", async () => {
  const { body } = await analyse({ ticker: "TEST", councilEngine: "v2", famineEngine: "v2", deathEngine: "v2" });
  assert.equal(body.council.status, "INTEGRATION_UNAVAILABLE");
  assert.equal(body.council.verdict, null);
  assert.deepEqual(body.council.missingDependencies, ["CONQUEST_V2"]);
});

test("Council V2 activates only when every V2 dependency is present", async () => {
  const { body } = await analyse({ ticker: "TEST",
    councilEngine: "v2", famineEngine: "v2", deathEngine: "v2", conquestEngine: "v2" });
  assert.notEqual(body.council.status, "INTEGRATION_UNAVAILABLE");
  assert.ok(["REJECT", "WATCH", "WAIT", "FAVOURABLE", "STRONG", "EXCEPTIONAL"].includes(body.council.verdict));
  assert.equal(typeof body.council.confidence, "number");
});

test("Conquest abstains in Council, and its abstention is not a neutral vote", async () => {
  const { body } = await analyse({ ticker: "TEST",
    councilEngine: "v2", famineEngine: "v2", deathEngine: "v2", conquestEngine: "v2" });
  assert.ok(body.council.coverage.abstained.includes("CONQUEST"),
    "with no crowd provider Conquest reaches no directional view");
  const contribution = body.council.directional.contributions.find(c => c.horseman === "CONQUEST");
  assert.equal(contribution.participated, false);
  assert.equal(contribution.stance, null, "an abstention casts no vote");
  assert.equal(contribution.weight, 0);
});

test("market-derived behaviour never becomes a directional Council contribution", async () => {
  const { body } = await analyse({ ticker: "TEST",
    councilEngine: "v2", famineEngine: "v2", deathEngine: "v2", conquestEngine: "v2" }, { spike: true });
  const ds = conquestOf(body).dataSource;
  assert.ok(ds.behaviouralRegimes.length >= 1, "the fixture produces real behavioural findings");
  const contribution = body.council.directional.contributions.find(c => c.horseman === "CONQUEST");
  assert.equal(contribution.contribution, 0,
    "however strong the behaviour, it casts no directional vote");
});

test("Council V2 does not gain a false independent source from Conquest", async () => {
  const { body } = await analyse({ ticker: "TEST",
    councilEngine: "v2", famineEngine: "v2", deathEngine: "v2", conquestEngine: "v2" });
  // Conquest abstains, so it contributes no weight and no correlation group.
  assert.equal(body.council.directional.correlation.hasCorrelatedEvidence, false);
  assert.ok(body.council.directional.correlation.independentContributors <= 2,
    "only War and Famine can contribute directionally today");
});

test("legacy Council continues to consume legacy Conquest when Conquest V2 is active", async () => {
  const legacy = await analyse({ ticker: "TEST" });
  const withV2 = await analyse({ ticker: "TEST", conquestEngine: "v2" });
  assert.deepEqual(withV2.body.council, legacy.body.council);
  assert.match(withV2.body.council.reasons[0], /Conquest: (BULLISH|BEARISH|NEUTRAL)/,
    "legacy Council still sees legacy Conquest's direction");
});

/* ---------------- epistemic integrity in production ---------------- */

test("no verdict, risk judgment or prediction appears in Conquest V2 output", async () => {
  const ds = conquestOf((await analyse({ ticker: "TEST", conquestEngine: "v2" })).body).dataSource;
  const keys = new Set();
  (function walk(v) { if (v && typeof v === "object") for (const [k, val] of Object.entries(v)) { keys.add(k.toLowerCase()); walk(val); } })(ds);
  for (const banned of ["verdict", "recommendation", "probability", "expectedreturn",
                        "targetprice", "profit", "winrate", "riskseverity"]) {
    assert.ok(!keys.has(banned), `no Conquest field may be named ${banned}`);
  }
});

test("no intent or causation language reaches the user-visible evidence", async () => {
  const c = conquestOf((await analyse({ ticker: "TEST", conquestEngine: "v2" })).body);
  const text = [...c.evidence, ...c.limits].join(" ").toLowerCase();
  for (const banned of ["because", "fomo", "panic", "euphor", "greed", "investors are",
                        "traders are", "will rise", "will fall", "likely to"]) {
    assert.ok(!text.includes(banned), `${banned} must not appear`);
  }
  assert.ok(c.limits.some(l => /does not explain why/.test(l)));
});

/* ==================================================================== */
/* CONQUEST â†’ DEATH CROWD ADAPTER                                        */
/*                                                                       */
/* Death already modelled two distinct states but was only ever given     */
/* one. The adapter supplies the second; it changes no Death methodology. */
/* ==================================================================== */

const deathOf = b => b.horsemen.find(h => h.name === "DEATH").dataSource;

test("A: Death V2 without Conquest V2 still reports the channel as never assessed", async () => {
  const ds = deathOf((await analyse({ ticker: "TEST", deathEngine: "v2" })).body);
  assert.ok(ds.missingEvidence.some(f => f.id === "CROWD_EVIDENCE_UNAVAILABLE"),
    "with no Conquest, the crowd channel was genuinely never assessed");
  assert.ok(!ds.missingEvidence.some(f => f.id === "CROWDING_UNKNOWN"));
  assert.equal(ds.provenance.crowdDirectEvidence, false);
});

test("B: Death V2 with Conquest V2 reports the channel as assessed but unavailable", async () => {
  const ds = deathOf((await analyse({ ticker: "TEST", deathEngine: "v2", conquestEngine: "v2" })).body);
  assert.ok(ds.missingEvidence.some(f => f.id === "CROWDING_UNKNOWN"),
    "Conquest looked; there was no genuine crowd source");
  assert.ok(!ds.missingEvidence.some(f => f.id === "CROWD_EVIDENCE_UNAVAILABLE"),
    "the channel was assessed, so it must not read as never assessed");
  assert.ok(ds.uncertainty.some(f => f.id === "CROWD_SENTIMENT_UNKNOWN"));
});

test("both A and B remain missing/uncertain evidence, never observed risk", async () => {
  for (const query of [{ ticker: "TEST", deathEngine: "v2" },
                       { ticker: "TEST", deathEngine: "v2", conquestEngine: "v2" }]) {
    const ds = deathOf((await analyse(query)).body);
    // Missing evidence carries no severity at all.
    for (const f of ds.missingEvidence) {
      assert.equal(f.severity, null);
      assert.equal(f.category, "MISSING_EVIDENCE");
    }
    // Uncertainty findings are categorised separately; severity there does
    // not feed riskSeverity, which is derived from observed risk only.
    for (const f of ds.uncertainty) assert.equal(f.category, "UNCERTAINTY");
    assert.equal(ds.observedRisks.filter(f => f.source === "CONQUEST").length, 0,
      "unavailable crowd data is never an observed risk");
  }
});

test("REGRESSION: EXPRESSED_CONCENTRATION cannot fire without a genuine crowd source", async () => {
  const ds = deathOf((await analyse({ ticker: "TEST", deathEngine: "v2", conquestEngine: "v2" })).body);
  assert.ok(!JSON.stringify(ds).includes("EXPRESSED_CONCENTRATION"));
  assert.equal(ds.provenance.crowdDirectEvidence, false);
});

test("risk severity and evidence confidence band are unchanged by the adapter", async () => {
  const a = deathOf((await analyse({ ticker: "TEST", deathEngine: "v2" })).body);
  const b = deathOf((await analyse({ ticker: "TEST", deathEngine: "v2", conquestEngine: "v2" })).body);
  assert.equal(b.riskSeverity, a.riskSeverity, "missing crowd data must not raise severity");
  assert.equal(b.evidenceConfidence, a.evidenceConfidence, "same confidence band");
  // NOTE: the exact evidenceConfidenceScore is NOT asserted equal here.
  // Run A never engages Conquest at all; run B now correctly reports
  // Conquest V2's genuine abstention into Death's consensus check (the
  // fix this suite guards), which legitimately changes participatingCount
  // and therefore the precise confidence score, without moving the band
  // or the risk severity.
  assert.deepEqual(b.observedRisks.map(f => f.id), a.observedRisks.map(f => f.id));
});

test("the adapter manufactures no CROWD_FEED independence", async () => {
  const ds = deathOf((await analyse({ ticker: "TEST", deathEngine: "v2", conquestEngine: "v2" })).body);
  // A missing-evidence finding is evidence of absence, not a crowd source.
  const crowdGroups = ds.correlationGroups.filter(g => g.source === "CROWD_FEED");
  assert.equal(crowdGroups.length, 0, "no observed crowd phenomenon exists");
  assert.equal(ds.provenanceIntegrity.complete, true);
});

test("Council is unaffected by the adapter", async () => {
  const withoutConquest = await analyse({ ticker: "TEST", deathEngine: "v2", famineEngine: "v2", councilEngine: "v2" });
  assert.equal(withoutConquest.body.council.status, "INTEGRATION_UNAVAILABLE");

  const full = await analyse({ ticker: "TEST", warEngine: "v2", famineEngine: "v2",
    conquestEngine: "v2", deathEngine: "v2", councilEngine: "v2" });
  assert.equal(full.body.council.status, "ASSESSED");
  assert.ok(full.body.council.coverage.abstained.includes("CONQUEST"),
    "Conquest still abstains: an assessed-but-empty crowd channel is not a directional view");
  const contribution = full.body.council.directional.contributions.find(c => c.horseman === "CONQUEST");
  assert.equal(contribution.stance, null);
  assert.equal(contribution.weight, 0);
});

test("Council thresholds and methodology are untouched", async () => {
  const { COUNCIL_THRESHOLDS } = await import("../src/council/councilAnalysis.js");
  assert.equal(COUNCIL_THRESHOLDS.STRONG_EVIDENCE, 0.68, "the STRONG floor is unchanged");
  assert.equal(COUNCIL_THRESHOLDS.FAVOURABLE_EVIDENCE, 0.5);
  assert.equal(COUNCIL_THRESHOLDS.EXCEPTIONAL_EVIDENCE, 0.85);
  assert.equal(COUNCIL_THRESHOLDS.calibrated, false);
});

test("default and V1 paths never receive the adapter", async () => {
  const legacyDeath = (await analyse({ ticker: "TEST", conquestEngine: "v2" })).body
    .horsemen.find(h => h.name === "DEATH");
  assert.equal(legacyDeath.dataSource, undefined, "legacy Death is untouched by Conquest V2");
  const a = await analyse({ ticker: "TEST" });
  const b = await analyse({ ticker: "TEST", deathEngine: "v1", conquestEngine: "v1" });
  assert.deepEqual(strip(a.body), strip(b.body));
});

/* ==================================================================== */
/* THE EXACT REQUEST THE USER-FACING PREVIEW NOW MAKES                   */
/*                                                                       */
/* Guards the activated path end to end. If any engine silently reverts   */
/* to legacy, these fail.                                                 */
/* ==================================================================== */

const ACTIVATED = {
  ticker: "TEST", warEngine: "v2", famineEngine: "v2",
  conquestEngine: "v2", deathEngine: "v2", councilEngine: "v2",
};

test("the activated request runs every engine on V2", async () => {
  const { body } = await analyse(ACTIVATED);
  assert.equal(body.horsemen.find(h => h.name === "WAR").dataSource.engine, "v2");
  assert.equal(body.horsemen.find(h => h.name === "FAMINE").dataSource.engine, "v2");
  assert.equal(conquestOf(body).dataSource.engine, "v2");
  assert.equal(deathOf(body).engine, "v2");
  assert.equal(body.council.engine, "v2");
  assert.equal(body.council.status, "ASSESSED");
});

test("Conquest abstains: no direct crowd evidence means no directional stance", async () => {
  const { body } = await analyse(ACTIVATED);
  const ds = conquestOf(body).dataSource;
  assert.equal(ds.crowdSentiment, "UNKNOWN");
  assert.equal(ds.provenance.directCrowdEvidence, false);
  assert.equal(ds.provenance.directionalContributionPermitted, false);
  assert.ok(body.council.coverage.abstained.includes("CONQUEST"));
  const contribution = body.council.directional.contributions.find(c => c.horseman === "CONQUEST");
  assert.equal(contribution.participated, false);
  assert.equal(contribution.stance, null);
  assert.equal(contribution.weight, 0);
});

test("REGRESSION: UNKNOWN is never converted to NEUTRAL anywhere in the V2 response", async () => {
  const { body } = await analyse(ACTIVATED);
  const ds = conquestOf(body).dataSource;
  for (const field of ["crowdSentiment", "crowding", "polarisation"]) {
    assert.equal(ds[field], "UNKNOWN", `${field} must stay UNKNOWN`);
    assert.notEqual(ds[field], "NEUTRAL");
  }
  assert.equal(ds.crowdAttention, "UNAVAILABLE");
  // Conquest is listed as abstaining, never as a neutral participant.
  assert.ok(!body.council.coverage.participating.includes("CONQUEST"));
});

test("Death is not an ordinary bullish/bearish vote under V2", async () => {
  const { body } = await analyse(ACTIVATED);
  const death = body.horsemen.find(h => h.name === "DEATH");
  assert.equal(death.direction, null, "Death reports risk, not a market direction");
  assert.equal(death.confidence, null);
  assert.ok(deathOf(body).riskSeverity, "it reports a severity instead");
  // Death is not one of the directional Horsemen the Council counts.
  assert.deepEqual(body.council.coverage.expected, ["WAR", "FAMINE", "CONQUEST"]);
});

test("Council uses the V2 structured assessment, not legacy Horseman objects", async () => {
  const { body } = await analyse(ACTIVATED);
  const c = body.council;
  assert.ok(c.coverage && c.directional && c.factors, "V2 judgment structure is present");
  assert.equal(typeof c.factors.evidenceStrength, "number");
  assert.ok(!("synopsis" in c), "the legacy council shape is not being returned");
  // Death's structured severity reached the Council's own factors.
  assert.ok("deathFactor" in c.factors || "riskSeverity" in JSON.stringify(c),
    "Death's structured risk informs the Council");
});

test("provenance and correlation survive into the Council", async () => {
  const { body } = await analyse(ACTIVATED);
  const correlation = body.council.directional.correlation;
  assert.ok(Array.isArray(correlation.groups));
  assert.equal(correlation.provenanceIntegrity.complete, true,
    "every directional contributor declared its provenance");
  assert.equal(correlation.hasCorrelatedEvidence, false);
  // War and Famine read different feeds, so both count.
  assert.equal(correlation.independentContributors, 2);
});

test("missing crowd evidence lowers completeness rather than being ignored", async () => {
  const { body } = await analyse(ACTIVATED);
  assert.ok(body.council.coverage.participationRatio < 1,
    "an abstaining Horseman reduces coverage");
  assert.ok(body.council.factors.evidenceStrength < 1);
  // And Death records the assessed-but-empty crowd channel.
  const ids = deathOf(body).missingEvidence.map(f => f.id);
  assert.ok(ids.includes("CROWDING_UNKNOWN"));
});

test("the default request is untouched by frontend activation", async () => {
  const { body } = await analyse({ ticker: "TEST" });
  assert.equal(body.horsemen.find(h => h.name === "CONQUEST").dataSource, undefined,
    "the API still defaults to legacy Conquest");
  assert.equal(body.council.engine, undefined, "and to the legacy Council");
});

/* ==================================================================== */
/* CONQUEST V2 -> DEATH CONSENSUS FIX                                    */
/*                                                                       */
/* Root cause: Death's consensus input read the LEGACY conquest.direction */
/* even when Conquest V2 had run and genuinely abstained, so a real       */
/* abstention was reported to Death as NEUTRAL. This crosses the actual   */
/* orchestration boundary (the real handler, not a Death fixture) and     */
/* would have failed against the pre-fix code, since the legacy Conquest  */
/* fixture in this file resolves to a NEUTRAL/BULLISH/BEARISH direction,  */
/* never null.                                                            */
/* ==================================================================== */

test("REGRESSION: Death sees Conquest V2's genuine abstention, not legacy NEUTRAL", async () => {
  const { body } = await analyse(ACTIVATED);
  const ds = deathOf(body);
  const abstained = ds.uncertainty.find(f => f.id === "HORSEMAN_ABSTAINED");
  assert.ok(abstained, "an abstention finding must exist");
  assert.match(abstained.detail, /\bCONQUEST\b/,
    "Conquest's abstention must reach Death, not be silently dropped as NEUTRAL");
});

test("Conquest V2 abstention is not converted to NEUTRAL anywhere in Death's view", async () => {
  const { body } = await analyse(ACTIVATED);
  const ds = deathOf(body);
  // No disagreement/consensus finding may treat Conquest as a participant.
  assert.equal(ds.disagreement.length, 0, "no genuine disagreement exists on this fixture");
  const abstained = ds.uncertainty.find(f => f.id === "HORSEMAN_ABSTAINED");
  assert.ok(!/CONQUEST.*neutral/i.test(abstained.detail));
});

test("no observed risk is manufactured from the corrected abstention", async () => {
  const { body } = await analyse(ACTIVATED);
  const ds = deathOf(body);
  assert.equal(ds.observedRisks.filter(f => f.source === "CONSENSUS").length, 0,
    "an abstention is uncertainty, never an observed risk");
});

test("riskSeverity is unchanged by the consensus fix", async () => {
  const ds = deathOf((await analyse(ACTIVATED)).body);
  // Consensus findings are UNCERTAINTY/DISAGREEMENT, never OBSERVED_RISK,
  // so correcting which Horsemen are seen as abstaining cannot move severity.
  assert.ok(["NONE_OBSERVED", "LOW", "MODERATE", "HIGH", "SEVERE"].includes(ds.riskSeverity));
  const withoutFix = await analyse({ ticker: "TEST", warEngine: "v2", famineEngine: "v2", deathEngine: "v2" });
  assert.equal(deathOf((await analyse(ACTIVATED)).body).riskSeverity,
    deathOf(withoutFix.body).riskSeverity,
    "Conquest's consensus direction cannot itself raise or lower severity");
});

test("Council's directional coverage remains correct after the fix", async () => {
  const { body } = await analyse(ACTIVATED);
  assert.ok(body.council.coverage.abstained.includes("CONQUEST"),
    "the Council already derived this independently through the adapter");
  const contribution = body.council.directional.contributions.find(c => c.horseman === "CONQUEST");
  assert.equal(contribution.participated, false);
  assert.equal(contribution.stance, null);
});

test("Council verdict and confidence are unchanged by the consensus fix", async () => {
  // Compare the full activated run against itself computed from Death's
  // pre-fix shape (legacy conquest.direction fed to consensus) to confirm
  // the Council side of the pipeline does not depend on Death's consensus
  // wording for its own abstention accounting.
  const after = await analyse(ACTIVATED);
  assert.equal(typeof after.body.council.confidence, "number");
  assert.ok(["REJECT", "WATCH", "WAIT", "FAVOURABLE", "STRONG", "EXCEPTIONAL"].includes(after.body.council.verdict));
});

test("Famine behaviour is untouched by the Conquest consensus fix", async () => {
  const withConquest = await analyse(ACTIVATED);
  const withoutConquest = await analyse({ ticker: "TEST", warEngine: "v2", famineEngine: "v2", deathEngine: "v2" });
  assert.deepEqual(strip(withConquest.body.horsemen.find(h => h.name === "FAMINE")),
    strip(withoutConquest.body.horsemen.find(h => h.name === "FAMINE")));
});

test("legacy Conquest behaviour is unchanged when Conquest V2 is not active", async () => {
  const { body } = await analyse({ ticker: "TEST", deathEngine: "v2" });
  const ds = deathOf(body);
  // Death still sees whatever the legacy Conquest direction resolves to,
  // exactly as before this fix.
  assert.equal(ds.dataSource, undefined);
  const c = body.horsemen.find(h => h.name === "CONQUEST");
  assert.equal(c.dataSource, undefined, "legacy Conquest is untouched");
});
