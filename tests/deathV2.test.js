import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDeathInput, AssetType, UNKNOWN } from "../src/death/deathInput.js";
import {
  deathAnalysis, FindingCategory, Severity, RiskSeverity, EvidenceConfidence,
  PROVISIONAL_THRESHOLDS,
} from "../src/death/deathAnalysis.js";

/**
 * Death V2 foundation. Pure functions, structured facts only, no network.
 */

/** Healthy baseline: everything available, nothing alarming. */
const healthyTechnical = {
  dataStatus: "COMPLETE", rsi14: 55, percentChange20d: 4.2,
  volatilityPct: 18, freshnessStatus: "fresh", latestBarIsProvisional: false, provider: "twelvedata",
};
const healthyFundamental = {
  dataStatus: "COMPLETE", direction: "BULLISH", completenessScore: 1,
  freshnessStatus: "CURRENT", strongestOpposing: [], disagreement: [],
  materialCatalysts: [], unknownImpactEventCount: 0, missingEvidence: [],
};
const healthyCrowd = {
  attentionLevel: "MEDIUM", sentiment: "BULLISH", crowding: "LOW", polarisation: "LOW",
  evidenceKind: "DIRECT_CROWD", directEvidence: true, evidenceQualityBand: "STRONG", sentimentConfidence: 70,
};
const healthyConsensus = { directions: { WAR: "BULLISH", FAMINE: "BULLISH", CONQUEST: "BULLISH" } };

const build = (over = {}) => buildDeathInput({
  assetId: "TSLA",
  technical: healthyTechnical, fundamental: healthyFundamental,
  crowd: healthyCrowd, consensus: healthyConsensus,
  ...over,
});
const run = (over = {}) => deathAnalysis(build(over));
const ids = list => list.map(f => f.id);

/* ---------------- technical observed risk ---------------- */

test("RSI above the provisional threshold creates exactly one technical observed-risk finding", () => {
  const r = run({ technical: { ...healthyTechnical, rsi14: 82 } });
  const hits = r.observedRisks.filter(f => f.id === "TECHNICAL_EXTENSION");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].source, "WAR");
  assert.equal(hits[0].category, FindingCategory.OBSERVED_RISK);
  assert.match(hits[0].detail, /82\.0/);
  assert.equal(PROVISIONAL_THRESHOLDS.RSI_EXTENDED, 75);
  assert.equal(PROVISIONAL_THRESHOLDS.calibrated, false, "thresholds are explicitly uncalibrated");
});

test("a large 20-session move creates exactly one rapid-movement finding", () => {
  const r = run({ technical: { ...healthyTechnical, percentChange20d: -22.4 } });
  const hits = r.observedRisks.filter(f => f.id === "RAPID_MOVEMENT");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].source, "WAR");
  assert.equal(PROVISIONAL_THRESHOLDS.RAPID_MOVE_PCT, 15);
});

test("REGRESSION: technical risks are counted exactly once, never doubled via Conquest", () => {
  // Legacy Death received RSI and the 20-day return twice: directly from
  // War, and again as Conquest "crowding" built from those same statistics.
  const r = run({
    technical: { ...healthyTechnical, rsi14: 88, percentChange20d: 25 },
    // A crowd section that (wrongly) carries technical-looking fields.
    crowd: { ...healthyCrowd, crowding: "HIGH", directEvidence: false,
             rsi14: 88, percentChange20d: 25, volumeRatio: 3.1 },
  });
  assert.equal(r.observedRisks.filter(f => f.id === "TECHNICAL_EXTENSION").length, 1);
  assert.equal(r.observedRisks.filter(f => f.id === "RAPID_MOVEMENT").length, 1);
  // Without direct crowd evidence, no crowd risk may be raised at all.
  assert.equal(r.observedRisks.filter(f => f.id === "EXPRESSED_CONCENTRATION").length, 0);
  // And no technical statistic reached Death through the crowd section.
  assert.ok(!ids(r.observedRisks).some(id => /CROWD/.test(id)));
});

test("removing legacy Conquest technical crowding cannot make Death artificially safer", () => {
  // Legacy: crowding was derived from RSI/return and added +1/+2 risk.
  // Death V2: the same technical facts are consumed directly from War, so
  // an UNKNOWN crowding cannot reduce the technical risk that was found.
  const withCrowding = run({
    technical: { ...healthyTechnical, rsi14: 88, percentChange20d: 25 },
    crowd: { ...healthyCrowd, crowding: "HIGH" },
  });
  const crowdingUnknown = run({
    technical: { ...healthyTechnical, rsi14: 88, percentChange20d: 25 },
    crowd: { ...healthyCrowd, crowding: UNKNOWN, directEvidence: false },
  });

  assert.equal(withCrowding.observedRisks.filter(f => f.source === "WAR").length, 2);
  assert.equal(crowdingUnknown.observedRisks.filter(f => f.source === "WAR").length, 2,
    "the technical risks survive intact when crowding disappears");
  assert.notEqual(crowdingUnknown.riskSeverity, RiskSeverity.NONE_OBSERVED);
});

/* ---------------- missing evidence ---------------- */

test("missing War technical data is MISSING_EVIDENCE, never an observed risk", () => {
  const r = run({ technical: { dataStatus: "DATA_UNAVAILABLE" } });
  assert.ok(ids(r.missingEvidence).includes("TECHNICAL_EVIDENCE_UNAVAILABLE"));
  assert.equal(r.observedRisks.filter(f => f.source === "WAR").length, 0,
    "an unavailable provider must not fabricate danger");
});

test("missing Famine evidence is MISSING_EVIDENCE and does not create risk", () => {
  const r = run({ fundamental: { dataStatus: "EVIDENCE_UNAVAILABLE" } });
  assert.ok(ids(r.missingEvidence).includes("FUNDAMENTAL_EVIDENCE_UNAVAILABLE"));
  assert.equal(r.observedRisks.filter(f => f.source === "FAMINE").length, 0);
});

test("incomplete fundamental evidence is recorded as missing, not as danger", () => {
  const r = run({ fundamental: { ...healthyFundamental, completenessScore: 0.6, missingEvidence: [{ field: "peRatio" }] } });
  assert.ok(ids(r.missingEvidence).includes("INCOMPLETE_FUNDAMENTAL_EVIDENCE"));
  assert.equal(r.riskSeverity, RiskSeverity.NONE_OBSERVED);
});

/* ---------------- crowding UNKNOWN ---------------- */

test("crowding UNKNOWN stays UNKNOWN: not zero, not safe, not danger", () => {
  const r = run({ crowd: { ...healthyCrowd, crowding: UNKNOWN, directEvidence: false } });
  const note = r.missingEvidence.find(f => f.id === "CROWDING_UNKNOWN");
  assert.ok(note, "unknown crowding is recorded as missing evidence");
  assert.match(note.detail, /not evidence that the trade is uncrowded/);
  assert.equal(r.observedRisks.filter(f => f.id === "EXPRESSED_CONCENTRATION").length, 0,
    "and it is not fabricated into an observed danger");
});

test("no crowd source at all is missing evidence, not an absence of crowd risk", () => {
  const r = run({ crowd: null });
  assert.ok(ids(r.missingEvidence).includes("CROWD_EVIDENCE_UNAVAILABLE"));
  assert.equal(r.observedRisks.filter(f => f.source === "CONQUEST").length, 0);
});

test("crowding is only an observed risk when a direct crowd source supports it", () => {
  const noDirect = run({ crowd: { ...healthyCrowd, crowding: "HIGH", directEvidence: false } });
  assert.equal(noDirect.observedRisks.filter(f => f.id === "EXPRESSED_CONCENTRATION").length, 0);

  const direct = run({ crowd: { ...healthyCrowd, crowding: "HIGH", directEvidence: true } });
  const hit = direct.observedRisks.find(f => f.id === "EXPRESSED_CONCENTRATION");
  assert.ok(hit);
  assert.equal(hit.severity, Severity.HIGH);
  assert.equal(hit.source, "CONQUEST");
});

test("Conquest V2's realistic shape is handled without treating UNKNOWN as safe", () => {
  // Attention HIGH, everything else UNKNOWN — the expected live output.
  const r = run({ crowd: {
    attentionLevel: "HIGH", sentiment: UNKNOWN, crowding: UNKNOWN, polarisation: UNKNOWN,
    evidenceKind: "PROXY", directEvidence: false, evidenceQualityBand: "MODERATE",
  }});
  assert.ok(ids(r.missingEvidence).includes("CROWDING_UNKNOWN"));
  const sentimentNote = r.uncertainty.find(f => f.id === "CROWD_SENTIMENT_UNKNOWN");
  assert.ok(sentimentNote);
  assert.match(sentimentNote.detail, /Attention is HIGH but crowd sentiment could not be read/);
  assert.equal(r.observedRisks.filter(f => f.source === "CONQUEST").length, 0);
});

/* ---------------- disagreement and abstention ---------------- */

test("genuine Horseman disagreement is recorded in its own category", () => {
  const r = run({ consensus: { directions: { WAR: "BULLISH", FAMINE: "BEARISH", CONQUEST: "NEUTRAL" } } });
  const hit = r.disagreement.find(f => f.id === "HORSEMEN_DISAGREE");
  assert.ok(hit);
  assert.equal(hit.category, FindingCategory.DISAGREEMENT);
  assert.equal(r.observedRisks.filter(f => f.id === "HORSEMEN_DISAGREE").length, 0,
    "disagreement is not an observed risk about the asset");
});

test("an abstention is UNCERTAINTY and is never counted as agreement", () => {
  const r = run({ consensus: { directions: { WAR: "BULLISH", FAMINE: UNKNOWN, CONQUEST: UNKNOWN } } });
  const input = build({ consensus: { directions: { WAR: "BULLISH", FAMINE: UNKNOWN, CONQUEST: UNKNOWN } } });

  assert.deepEqual(input.consensus.abstained, ["FAMINE", "CONQUEST"]);
  assert.equal(input.consensus.disagree, false, "abstention is not conflict");
  assert.equal(input.consensus.participatingCount, 1);
  const hit = r.uncertainty.find(f => f.id === "HORSEMAN_ABSTAINED");
  assert.ok(hit);
  assert.match(hit.detail, /An abstention is not agreement/);
});

/* ---------------- cross-examination from Famine ---------------- */

test("strong opposing fundamental evidence becomes a Death challenge", () => {
  const r = run({ fundamental: { ...healthyFundamental, strongestOpposing: [
    { claim: "Earnings fell 12% year-on-year" }, { claim: "Margins contracted for a third quarter" }] } });
  const hit = r.observedRisks.find(f => f.id === "OPPOSING_FUNDAMENTAL_EVIDENCE");
  assert.ok(hit);
  assert.equal(hit.severity, Severity.HIGH, "two opposing items is a strong challenge");
  assert.match(hit.detail, /Earnings fell 12%/);
});

test("a negative material catalyst is observed risk; an unreadable one is uncertainty", () => {
  const negative = run({ fundamental: { ...healthyFundamental,
    materialCatalysts: [{ headline: "Company cuts full-year guidance", impact: "NEGATIVE" }] } });
  assert.ok(ids(negative.observedRisks).includes("NEGATIVE_CATALYST"));

  const unreadable = run({ fundamental: { ...healthyFundamental, unknownImpactEventCount: 3 } });
  assert.ok(ids(unreadable.uncertainty).includes("UNRESOLVED_EVENT_IMPACT"));
  assert.equal(unreadable.observedRisks.length, 0, "an unreadable event is not a danger");
});

test("stale evidence is represented explicitly as uncertainty", () => {
  const r = run({
    technical: { ...healthyTechnical, freshnessStatus: "stale" },
    fundamental: { ...healthyFundamental, freshnessStatus: "STALE" },
  });
  assert.ok(ids(r.uncertainty).includes("STALE_TECHNICAL_EVIDENCE"));
  assert.ok(ids(r.uncertainty).includes("STALE_FUNDAMENTAL_EVIDENCE"));
});

/* ---------------- severity vs evidence confidence ---------------- */

test("severity derives from observed risk only, never from missing evidence", () => {
  const nothingAvailable = run({ technical: { dataStatus: "DATA_UNAVAILABLE" },
    fundamental: { dataStatus: "EVIDENCE_UNAVAILABLE" }, crowd: null });
  assert.equal(nothingAvailable.riskSeverity, RiskSeverity.NONE_OBSERVED,
    "an absent evidence base is not a severe risk");
  assert.ok(nothingAvailable.missingEvidence.length >= 3);
});

test("a SEVERE risk can rest on WEAK evidence confidence", () => {
  const r = run({
    technical: { dataStatus: "COMPLETE", rsi14: 92, percentChange20d: 40, freshnessStatus: "stale" },
    fundamental: { dataStatus: "PARTIAL_EVIDENCE", completenessScore: 0.3,
      strongestOpposing: [{ claim: "a" }, { claim: "b" }],
      materialCatalysts: [{ headline: "guidance cut", impact: "NEGATIVE" }],
      disagreement: [], freshnessStatus: "STALE", missingEvidence: [1, 2], unknownImpactEventCount: 0 },
    crowd: null,
    consensus: { directions: { WAR: "BULLISH", FAMINE: UNKNOWN, CONQUEST: UNKNOWN } },
  });
  assert.equal(r.riskSeverity, RiskSeverity.SEVERE);
  assert.equal(r.evidenceConfidence, EvidenceConfidence.WEAK);
});

test("a MODERATE risk can rest on STRONG evidence confidence", () => {
  const r = run({ technical: { ...healthyTechnical, rsi14: 80 } });
  assert.equal(r.riskSeverity, RiskSeverity.MODERATE);
  assert.equal(r.evidenceConfidence, EvidenceConfidence.STRONG);
});

test("evidence confidence never rises with severity", () => {
  const mild = run({ technical: { ...healthyTechnical, rsi14: 80 } });
  const severe = run({ technical: { ...healthyTechnical, rsi14: 95, percentChange20d: 60 },
    fundamental: { ...healthyFundamental, strongestOpposing: [{ claim: "a" }, { claim: "b" }] } });
  assert.notEqual(severe.riskSeverity, mild.riskSeverity);
  assert.equal(severe.evidenceConfidenceScore, mild.evidenceConfidenceScore,
    "identical evidence availability must yield identical confidence, whatever the severity");
});

/* ---------------- strongest challenge ---------------- */

test("strongestChallenge selects the highest-severity observed risk deterministically", () => {
  const r = run({
    technical: { ...healthyTechnical, rsi14: 88 },
    fundamental: { ...healthyFundamental,
      materialCatalysts: [{ headline: "Company cuts full-year guidance", impact: "NEGATIVE" }] },
  });
  assert.equal(r.strongestChallenge.hasObservedChallenge, true);
  assert.equal(r.strongestChallenge.finding.id, "NEGATIVE_CATALYST", "HIGH outranks MODERATE");
  assert.deepEqual(deathAnalysis(build({
    technical: { ...healthyTechnical, rsi14: 88 },
    fundamental: { ...healthyFundamental,
      materialCatalysts: [{ headline: "Company cuts full-year guidance", impact: "NEGATIVE" }] },
  })).strongestChallenge, r.strongestChallenge, "deterministic");
});

test("Death never invents an objection, and distinguishes clean from merely unchecked", () => {
  const clean = run();
  assert.equal(clean.strongestChallenge.hasObservedChallenge, false);
  assert.match(clean.strongestChallenge.statement, /No major observed red flag/);
  assert.ok(!/incomplete/.test(clean.strongestChallenge.statement));

  const unchecked = run({ technical: { dataStatus: "DATA_UNAVAILABLE" }, crowd: null });
  assert.equal(unchecked.strongestChallenge.hasObservedChallenge, false);
  assert.match(unchecked.strongestChallenge.statement, /evidence is incomplete/);
  assert.ok(!/clean bill of health/.test(unchecked.strongestChallenge.statement.replace("not a clean bill of health", "")));
});

/* ---------------- structure, provenance, neutrality ---------------- */

test("every finding is traceable to a contributing Horseman", () => {
  const r = run({ technical: { ...healthyTechnical, rsi14: 88 },
    fundamental: { ...healthyFundamental, strongestOpposing: [{ claim: "x" }] },
    consensus: { directions: { WAR: "BULLISH", FAMINE: "BEARISH", CONQUEST: UNKNOWN } } });
  for (const f of [...r.observedRisks, ...r.missingEvidence, ...r.uncertainty, ...r.disagreement]) {
    assert.ok(["WAR", "FAMINE", "CONQUEST", "CONSENSUS"].includes(f.source), `bad source ${f.source}`);
  }
  assert.ok(r.provenance.contributingHorsemen.includes("WAR"));
  assert.equal(r.provenance.technicalProvider, "twelvedata");
});

test("Death emits no verdict, recommendation or probability", () => {
  const r = run({ technical: { ...healthyTechnical, rsi14: 88 } });
  const keys = new Set();
  (function walk(v) {
    if (v === null || typeof v !== "object") return;
    for (const [k, val] of Object.entries(v)) { keys.add(k.toLowerCase()); walk(val); }
  })(r);
  for (const banned of ["verdict", "recommendation", "probability", "councilconfidence", "risk", "score"]) {
    assert.ok(!keys.has(banned), `no Death field may be named ${banned}`);
  }
  assert.ok(r.limitations.some(l => /does not issue a verdict/.test(l)));
});

test("no single risk integer is the primary representation", () => {
  const r = run({ technical: { ...healthyTechnical, rsi14: 88 } });
  assert.equal(typeof r.riskSeverity, "string", "severity is a band, not a count");
  assert.ok(Array.isArray(r.observedRisks));
  assert.ok(Array.isArray(r.missingEvidence));
  assert.ok(Array.isArray(r.uncertainty));
  assert.ok(Array.isArray(r.disagreement));
});

test("only structured facts are consumed — prose is never scraped", () => {
  // Narrative strings supplied alongside the facts must be ignored entirely.
  const r = run({ technical: { ...healthyTechnical, rsi14: 55,
    evidence: ["RSI is very high", "Large recent price move"], summary: "disaster incoming" } });
  assert.equal(r.observedRisks.length, 0, "prose must not create findings");
});

test("the input contract validates identity and asset type", () => {
  assert.throws(() => buildDeathInput({}), /requires an assetId/);
  assert.throws(() => buildDeathInput({ assetId: "X", assetType: "COMMODITY" }), /unknown assetType/);
});

test("a crypto asset is structurally supported", () => {
  const r = deathAnalysis(buildDeathInput({
    assetId: "BTC", assetType: AssetType.CRYPTO,
    technical: { ...healthyTechnical, rsi14: 88 }, fundamental: healthyFundamental,
    crowd: healthyCrowd, consensus: healthyConsensus,
  }));
  assert.equal(r.assetType, AssetType.CRYPTO);
  assert.equal(r.assetId, "BTC");
  assert.ok(ids(r.observedRisks).includes("TECHNICAL_EXTENSION"));
});

test("results are deeply immutable and deterministic", () => {
  const a = run({ technical: { ...healthyTechnical, rsi14: 88 } });
  const b = run({ technical: { ...healthyTechnical, rsi14: 88 } });
  assert.deepEqual(a, b);
  assert.throws(() => { a.riskSeverity = RiskSeverity.NONE_OBSERVED; }, TypeError);
  assert.throws(() => { a.observedRisks.push({}); }, TypeError);
  assert.throws(() => { a.limitations.push("x"); }, TypeError);
  assert.throws(() => { a.observedRisks[0].severity = Severity.LOW; }, TypeError);
});

/* ==================================================================== */
/* EXPRESSED_CONCENTRATION — epistemic overclaim correction              */
/*                                                                       */
/* The trigger, severity and provenance boundaries are already proven by  */
/* the tests above ("crowding is only an observed risk when a direct      */
/* crowd source supports it", "no crowd source at all is missing          */
/* evidence", "crowding UNKNOWN stays UNKNOWN"). These add only what the  */
/* rename itself requires.                                               */
/* ==================================================================== */

test("the retired identifier is gone from V2 output entirely", () => {
  const direct = run({ crowd: { ...healthyCrowd, crowding: "HIGH", directEvidence: true } });
  const serialised = JSON.stringify(direct);
  assert.ok(!serialised.includes("CROWDED_POSITIONING"),
    "the identifier claimed positions the evidence cannot measure");
  assert.ok(serialised.includes("EXPRESSED_CONCENTRATION"));
});

test("the finding describes what is SAID, never what anyone holds", () => {
  const r = run({ crowd: { ...healthyCrowd, crowding: "HIGH", directEvidence: true } });
  const hit = r.observedRisks.find(f => f.id === "EXPRESSED_CONCENTRATION");
  assert.match(hit.detail, /concentration of expressed opinion/);
  assert.match(hit.detail, /not what anyone holds/);
  for (const banned of ["position", "holding", "owns", "exposure", "accumulat",
                        "distribut", "buying pressure", "selling pressure", "institution"]) {
    assert.ok(!hit.detail.toLowerCase().includes(banned),
      `${banned} would claim more than the evidence establishes`);
  }
});

test("severity behaviour is unchanged by the rename", () => {
  const high = run({ crowd: { ...healthyCrowd, crowding: "HIGH", directEvidence: true } });
  const elevated = run({ crowd: { ...healthyCrowd, crowding: "ELEVATED", directEvidence: true } });
  assert.equal(high.observedRisks.find(f => f.id === "EXPRESSED_CONCENTRATION").severity, Severity.HIGH);
  assert.equal(elevated.observedRisks.find(f => f.id === "EXPRESSED_CONCENTRATION").severity, Severity.MODERATE);
  assert.equal(high.riskSeverity, RiskSeverity.HIGH);
});

test("it keeps its place in the strongest-challenge ordering", () => {
  // A HIGH expressed-concentration finding alongside a MODERATE technical one.
  const r = run({
    technical: { ...healthyTechnical, rsi14: 88 },
    crowd: { ...healthyCrowd, crowding: "HIGH", directEvidence: true },
  });
  assert.equal(r.strongestChallenge.finding.id, "EXPRESSED_CONCENTRATION",
    "HIGH still outranks MODERATE, exactly as before");
});

test("neither market history nor a user claim can create it", () => {
  // Extreme technicals, no crowd source.
  const marketOnly = run({ technical: { ...healthyTechnical, rsi14: 95, percentChange20d: 60 }, crowd: null });
  assert.equal(marketOnly.observedRisks.filter(f => f.id === "EXPRESSED_CONCENTRATION").length, 0);

  // Crowd-shaped input without direct evidence, as a relabelled claim would be.
  const noDirect = run({ crowd: { ...healthyCrowd, crowding: "HIGH", directEvidence: false } });
  assert.equal(noDirect.observedRisks.filter(f => f.id === "EXPRESSED_CONCENTRATION").length, 0);
});

test("the rename manufactures no new independent evidence source", () => {
  const r = run({ crowd: { ...healthyCrowd, crowding: "HIGH", directEvidence: true } });
  const hit = r.observedRisks.find(f => f.id === "EXPRESSED_CONCENTRATION");
  assert.equal(hit.source, "CONQUEST");
  assert.equal(hit.provenance.source, "CROWD_FEED", "still crowd-derived, as before");
  assert.equal(hit.provenance.correlationGroup, "CROWD_BEHAVIOUR");
  assert.equal(hit.provenance.composite, false);
  // Exactly one phenomenon, not two because the label changed.
  assert.equal(r.correlationGroups.filter(g => g.correlationGroup === "CROWD_BEHAVIOUR").length, 1);
});
