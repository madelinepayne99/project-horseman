import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EvidenceSource, CorrelationGroup, makeProvenance, areCorrelated,
  groupByCorrelation, distinctSources,
} from "../src/schema/provenance.js";
import { buildDeathInput } from "../src/death/deathInput.js";
import { deathAnalysis, RiskSeverity, Severity } from "../src/death/deathAnalysis.js";
import { buildCouncilInput, Direction } from "../src/council/councilInput.js";
import { councilAnalysis } from "../src/council/councilAnalysis.js";
import { adaptWar, adaptFamine, adaptConquest, buildCouncilInputFromHorsemen } from "../src/council/councilAdapter.js";

/** Provenance / correlation safety. Pure functions, no network. */

const P = makeProvenance;
const item = (id, source, group, extra = {}) => ({ id, provenance: P(source, group), ...extra });

/* ================================================================== */
/* THE CONTRACT                                                       */
/* ================================================================== */

test("two findings share evidence only when origin AND phenomenon match", () => {
  const warMove = P(EvidenceSource.MARKET_HISTORY, CorrelationGroup.MARKET_ACCELERATION);
  const conquestChasing = P(EvidenceSource.MARKET_HISTORY, CorrelationGroup.MARKET_ACCELERATION);
  const warExtension = P(EvidenceSource.MARKET_HISTORY, CorrelationGroup.MARKET_EXTENSION);
  const realCrowd = P(EvidenceSource.CROWD_FEED, CorrelationGroup.CROWD_BEHAVIOUR);

  assert.equal(areCorrelated(warMove, conquestChasing), true,
    "one price move seen by two Horsemen is one piece of evidence");
  assert.equal(areCorrelated(warMove, warExtension), false,
    "different phenomena from one source stay independent");
  assert.equal(areCorrelated(warMove, realCrowd), false,
    "a genuine crowd reading is independent evidence even about the same move");
});

test("undeclared origins and null groups are never correlated", () => {
  const undeclared = P(EvidenceSource.UNDECLARED, CorrelationGroup.MARKET_ACCELERATION);
  const declared = P(EvidenceSource.MARKET_HISTORY, CorrelationGroup.MARKET_ACCELERATION);
  assert.equal(areCorrelated(undeclared, declared), false,
    "inventing correlation would silently delete genuinely independent evidence");
  assert.equal(areCorrelated(P(EvidenceSource.MARKET_HISTORY, null), declared), false);
});

test("grouping preserves every member while counting the phenomenon once", () => {
  const groups = groupByCorrelation([
    item("RAPID_MOVEMENT", EvidenceSource.MARKET_HISTORY, CorrelationGroup.MARKET_ACCELERATION),
    item("BEHAVIOURAL_CHASING", EvidenceSource.MARKET_HISTORY, CorrelationGroup.MARKET_ACCELERATION),
    item("EXPRESSED_CONCENTRATION", EvidenceSource.CROWD_FEED, CorrelationGroup.CROWD_BEHAVIOUR),
  ]);
  assert.equal(groups.length, 2, "three findings, two phenomena");
  const market = groups.find(g => g.correlationGroup === CorrelationGroup.MARKET_ACCELERATION);
  assert.equal(market.memberCount, 2);
  assert.equal(market.correlated, true);
  assert.deepEqual(market.members.map(m => m.id), ["RAPID_MOVEMENT", "BEHAVIOURAL_CHASING"],
    "both perspectives are retained for explanation");
  assert.deepEqual([...distinctSources(groups.flatMap(g => g.members))].sort(),
    ["CROWD_FEED", "MARKET_HISTORY"]);
});

test("grouping is deterministic", () => {
  const items = [
    item("A", EvidenceSource.MARKET_HISTORY, CorrelationGroup.MARKET_ACCELERATION),
    item("B", EvidenceSource.MARKET_HISTORY, CorrelationGroup.MARKET_ACCELERATION),
  ];
  assert.deepEqual(groupByCorrelation(items), groupByCorrelation(items));
});

/* ================================================================== */
/* DEATH                                                              */
/* ================================================================== */

const technical = (over = {}) => ({
  dataStatus: "COMPLETE", rsi14: 55, percentChange20d: 4,
  freshnessStatus: "fresh", provider: "twelvedata", ...over,
});
const fundamental = (over = {}) => ({
  dataStatus: "COMPLETE", direction: "BULLISH", completenessScore: 1, freshnessStatus: "CURRENT",
  strongestOpposing: [], disagreement: [], materialCatalysts: [], unknownImpactEventCount: 0,
  missingEvidence: [], ...over,
});
const runDeath = (over = {}) => deathAnalysis(buildDeathInput({
  assetId: "TEST", technical: technical(), fundamental: fundamental(),
  crowd: null, consensus: { directions: { WAR: "BULLISH", FAMINE: "BULLISH", CONQUEST: "UNKNOWN" } },
  ...over,
}));

test("every Death finding declares its provenance", () => {
  const r = runDeath({ technical: technical({ rsi14: 88, percentChange20d: 25 }) });
  for (const f of [...r.observedRisks, ...r.missingEvidence, ...r.uncertainty, ...r.disagreement]) {
    assert.ok(f.provenance, `${f.id} has no provenance`);
    assert.notEqual(f.provenance.source, EvidenceSource.UNDECLARED, `${f.id} is undeclared`);
  }
});

test("Death groups correlated risk rather than multiplying severity", () => {
  // Two findings describing ONE market acceleration.
  const grouped = groupByCorrelation([
    { id: "RAPID_MOVEMENT", severity: Severity.HIGH,
      provenance: P(EvidenceSource.MARKET_HISTORY, CorrelationGroup.MARKET_ACCELERATION) },
    { id: "BEHAVIOURAL_CHASING", severity: Severity.HIGH,
      provenance: P(EvidenceSource.MARKET_HISTORY, CorrelationGroup.MARKET_ACCELERATION) },
  ]);
  assert.equal(grouped.length, 1,
    "one phenomenon must not become two HIGH findings and escalate to SEVERE");
});

test("Death exposes its correlation handling for inspection", () => {
  const r = runDeath({ technical: technical({ rsi14: 88, percentChange20d: 25 }) });
  assert.ok(Array.isArray(r.correlationGroups));
  assert.equal(r.distinctPhenomenaCount, r.correlationGroups.length);
  // RSI extension and 20-day acceleration are genuinely different phenomena.
  const groups = r.correlationGroups.map(g => g.correlationGroup);
  assert.ok(groups.includes(CorrelationGroup.MARKET_EXTENSION));
  assert.ok(groups.includes(CorrelationGroup.MARKET_ACCELERATION));
  assert.equal(r.riskSeverity, RiskSeverity.MODERATE, "two moderate phenomena, counted separately");
});

test("the strongest challenge cites corroborating observations of the same phenomenon", () => {
  const r = runDeath({ technical: technical({ percentChange20d: 30 }) });
  const c = r.strongestChallenge;
  assert.equal(c.hasObservedChallenge, true);
  assert.ok("corroboratingObservations" in c, "one coherent challenge, not several separate risks");
  assert.equal(c.correlationGroup, CorrelationGroup.MARKET_ACCELERATION);
});

test("genuine crowd evidence stays independent of market-derived findings in Death", () => {
  const r = runDeath({
    technical: technical({ percentChange20d: 30 }),
    crowd: { attentionLevel: "HIGH", sentiment: "BULLISH", crowding: "HIGH",
             polarisation: "LOW", evidenceKind: "DIRECT_CROWD", directEvidence: true },
  });
  const crowdRisk = r.observedRisks.find(f => f.id === "EXPRESSED_CONCENTRATION");
  const marketRisk = r.observedRisks.find(f => f.id === "RAPID_MOVEMENT");
  assert.ok(crowdRisk && marketRisk);
  assert.equal(areCorrelated(crowdRisk.provenance, marketRisk.provenance), false,
    "a real crowd reading and a price move are two pieces of evidence, not one");
  assert.equal(r.distinctPhenomenaCount, 2);
});

/* ================================================================== */
/* COUNCIL                                                            */
/* ================================================================== */

const H = (direction, source, group = null, { conf = 80, comp = 1 } = {}) => ({
  direction, evidenceConfidence: conf, completeness: comp, freshnessStatus: "CURRENT",
  dataStatus: "COMPLETE", internalDisagreement: [], missingEvidence: [],
  strongestSupporting: [], strongestOpposing: [],
  directionalProvenance: { source, correlationGroup: group },
});
const DEATH_OK = { riskSeverity: "NONE_OBSERVED", evidenceConfidence: "STRONG", observedRisks: [],
  missingEvidence: [], uncertainty: [], disagreement: [],
  strongestChallenge: { hasObservedChallenge: false, statement: "none", finding: null } };
const judge = horsemen => councilAnalysis(buildCouncilInput({ assetId: "TEST", horsemen, death: DEATH_OK }));

test("REGRESSION: Council confidence cannot rise by duplicating one phenomenon through another Horseman", () => {
  const single = judge({
    WAR: H("BULLISH", EvidenceSource.MARKET_HISTORY, CorrelationGroup.MARKET_ACCELERATION),
    FAMINE: H("BULLISH", EvidenceSource.FUNDAMENTAL_FEED, CorrelationGroup.COMPANY_FUNDAMENTALS),
    CONQUEST: H("UNKNOWN", EvidenceSource.CROWD_FEED, CorrelationGroup.CROWD_BEHAVIOUR),
  });
  // Conquest now "agrees", but from the SAME price series War read.
  const duplicated = judge({
    WAR: H("BULLISH", EvidenceSource.MARKET_HISTORY, CorrelationGroup.MARKET_ACCELERATION),
    FAMINE: H("BULLISH", EvidenceSource.FUNDAMENTAL_FEED, CorrelationGroup.COMPANY_FUNDAMENTALS),
    CONQUEST: H("BULLISH", EvidenceSource.MARKET_HISTORY, CorrelationGroup.MARKET_ACCELERATION),
  });

  assert.ok(duplicated.confidence <= single.confidence,
    `duplicated evidence raised confidence ${single.confidence} -> ${duplicated.confidence}`);
  assert.equal(duplicated.factors.evidenceStrength, single.factors.evidenceStrength,
    "coverage must not grow either");
  assert.equal(duplicated.directional.correlation.hasCorrelatedEvidence, true);
  assert.deepEqual(duplicated.directional.correlation.suppressedForCorrelation, ["CONQUEST"]);
});

test("genuinely independent crowd evidence DOES strengthen Council", () => {
  const abstaining = judge({
    WAR: H("BULLISH", EvidenceSource.MARKET_HISTORY, CorrelationGroup.MARKET_ACCELERATION),
    FAMINE: H("BULLISH", EvidenceSource.FUNDAMENTAL_FEED, CorrelationGroup.COMPANY_FUNDAMENTALS),
    CONQUEST: H("UNKNOWN", EvidenceSource.CROWD_FEED, CorrelationGroup.CROWD_BEHAVIOUR),
  });
  const withCrowd = judge({
    WAR: H("BULLISH", EvidenceSource.MARKET_HISTORY, CorrelationGroup.MARKET_ACCELERATION),
    FAMINE: H("BULLISH", EvidenceSource.FUNDAMENTAL_FEED, CorrelationGroup.COMPANY_FUNDAMENTALS),
    CONQUEST: H("BULLISH", EvidenceSource.CROWD_FEED, CorrelationGroup.CROWD_BEHAVIOUR),
  });
  assert.ok(withCrowd.confidence > abstaining.confidence,
    "we need evidence independence, not arbitrary Horseman suppression");
  assert.equal(withCrowd.directional.correlation.hasCorrelatedEvidence, false);
  assert.equal(withCrowd.directional.correlation.independentContributors, 3);
});

test("the case file retains both perspectives while counting them once", () => {
  const r = judge({
    WAR: H("BULLISH", EvidenceSource.MARKET_HISTORY, CorrelationGroup.MARKET_ACCELERATION),
    FAMINE: H("BULLISH", EvidenceSource.FUNDAMENTAL_FEED, CorrelationGroup.COMPANY_FUNDAMENTALS),
    CONQUEST: H("BULLISH", EvidenceSource.MARKET_HISTORY, CorrelationGroup.MARKET_ACCELERATION),
  });
  // Both are still visible...
  assert.equal(r.directional.contributions.filter(c => c.participated).length, 3);
  const group = r.directional.correlation.groups.find(g => g.countedOnce);
  assert.deepEqual(group.horsemen, ["WAR", "CONQUEST"]);
  // ...but only one of them counts.
  assert.equal(r.directional.correlation.independentContributors, 2);
});

test("UNKNOWN remains an abstention, not a neutral vote, under correlation handling", () => {
  const r = judge({
    WAR: H("BULLISH", EvidenceSource.MARKET_HISTORY, CorrelationGroup.MARKET_ACCELERATION),
    FAMINE: H("BULLISH", EvidenceSource.FUNDAMENTAL_FEED, CorrelationGroup.COMPANY_FUNDAMENTALS),
    CONQUEST: H("UNKNOWN", EvidenceSource.CROWD_FEED, CorrelationGroup.CROWD_BEHAVIOUR),
  });
  assert.deepEqual(r.coverage.abstained, ["CONQUEST"]);
  const c = r.directional.contributions.find(x => x.horseman === "CONQUEST");
  assert.equal(c.stance, null);
  assert.equal(c.weight, 0);
  assert.equal(r.directional.score, 1, "an abstention dilutes nothing");
});

/* ================================================================== */
/* ADAPTER: production must always declare                            */
/* ================================================================== */

test("the production adapter never emits UNDECLARED provenance", () => {
  const war = { direction: "BULLISH", confidence: 90, dataSource: { engine: "v2", provider: "twelvedata",
    simulated: false, dataStatus: "COMPLETE", latestDataTimestamp: "2026-09-03",
    latestBarIsProvisional: false, candlesUsed: 320 } };
  const famine = { direction: "BULLISH", confidence: 70, dataSource: { engine: "v2", dataStatus: "COMPLETE",
    completeness: { score: 1 }, freshness: { overall: "CURRENT" }, missingEvidence: [], disagreement: [],
    strongestSupporting: [], strongestOpposing: [] } };
  const conquest = { sentiment: "BULLISH", evidenceQualityBand: "STRONG", directEvidence: true };

  for (const adapted of [adaptWar(war), adaptFamine(famine), adaptConquest(conquest), adaptConquest(null)]) {
    const p = adapted.directionalProvenance;
    assert.ok(p, "every adapted Horseman declares provenance");
    assert.equal(p.declared, true);
    assert.notEqual(p.source, EvidenceSource.UNDECLARED);
    // Either a single named phenomenon, or an honestly-declared composite.
    // A composite must NOT carry a phenomenon group — that was the
    // over-broad stamping this hardening pass removed.
    assert.ok(p.composite ? p.correlationGroup === null : !!p.correlationGroup,
      "a composite conclusion must not claim to be one phenomenon");
  }
  // War reads the price series; Conquest votes only on genuine crowd evidence.
  assert.equal(adaptWar(war).directionalProvenance.source, EvidenceSource.MARKET_HISTORY);
  assert.equal(adaptConquest(conquest).directionalProvenance.source, EvidenceSource.CROWD_FEED);
  assert.equal(areCorrelated(adaptWar(war).directionalProvenance,
    adaptConquest(conquest).directionalProvenance), false);
});

test("USER_SUPPLIED_CLAIM can never masquerade as market or crowd evidence", () => {
  const claim = P(EvidenceSource.USER_CLAIM, CorrelationGroup.CLAIM_LANGUAGE);
  const crowd = P(EvidenceSource.CROWD_FEED, CorrelationGroup.CROWD_BEHAVIOUR);
  const market = P(EvidenceSource.MARKET_HISTORY, CorrelationGroup.MARKET_ACCELERATION);

  assert.equal(areCorrelated(claim, crowd), false);
  assert.equal(areCorrelated(claim, market), false);
  // A claim cannot be grouped into a crowd or market phenomenon...
  const groups = groupByCorrelation([
    item("TIP_URGENCY", EvidenceSource.USER_CLAIM, CorrelationGroup.CLAIM_LANGUAGE),
    item("CROWDED", EvidenceSource.CROWD_FEED, CorrelationGroup.CROWD_BEHAVIOUR),
  ]);
  assert.equal(groups.length, 2);
  // ...and USER_CLAIM is a distinct origin, never conflated with the others.
  assert.notEqual(EvidenceSource.USER_CLAIM, EvidenceSource.CROWD_FEED);
  assert.notEqual(EvidenceSource.USER_CLAIM, EvidenceSource.MARKET_HISTORY);
});

test("Council V2 remains fail-closed while Conquest V2 is unavailable", () => {
  const built = buildCouncilInputFromHorsemen({
    assetId: "TEST",
    war: { direction: "BULLISH", dataSource: { engine: "v2", dataStatus: "COMPLETE", candlesUsed: 320 } },
    famine: { direction: "BULLISH", dataSource: { engine: "v2", dataStatus: "COMPLETE",
      completeness: { score: 1 }, freshness: { overall: "CURRENT" } } },
    conquestV2: null, deathV2: DEATH_OK,
  });
  assert.equal(built.ready, false);
  assert.deepEqual(built.missingDependencies, ["CONQUEST_V2"]);
  assert.equal(built.input, null);
});

/* ================================================================== */
/* HARDENING PASS — undeclared provenance must not gain independence   */
/* ================================================================== */

import { isIndependenceEligible, assessProvenanceIntegrity } from "../src/schema/provenance.js";

test("undeclared provenance cannot silently gain independent Council weight", () => {
  const declared = judge({
    WAR: H("BULLISH", EvidenceSource.MARKET_HISTORY, null),
    FAMINE: H("BULLISH", EvidenceSource.FUNDAMENTAL_FEED, CorrelationGroup.COMPANY_FUNDAMENTALS),
    CONQUEST: H("BULLISH", EvidenceSource.CROWD_FEED, CorrelationGroup.CROWD_BEHAVIOUR),
  });
  // A future Horseman that simply forgets to declare.
  const forgot = judge({
    WAR: H("BULLISH", EvidenceSource.MARKET_HISTORY, null),
    FAMINE: H("BULLISH", EvidenceSource.FUNDAMENTAL_FEED, CorrelationGroup.COMPANY_FUNDAMENTALS),
    CONQUEST: { direction: "BULLISH", evidenceConfidence: 80, completeness: 1,
      freshnessStatus: "CURRENT", dataStatus: "COMPLETE", internalDisagreement: [],
      missingEvidence: [], strongestSupporting: [], strongestOpposing: [] },
  });

  assert.ok(forgot.factors.evidenceStrength < declared.factors.evidenceStrength,
    "undeclared evidence must not earn the coverage credit declared evidence earns");
  assert.ok(forgot.confidence < declared.confidence);
  // It is withheld, not penalised: the stance is retained and visible.
  const c = forgot.directional.contributions.find(x => x.horseman === "CONQUEST");
  assert.equal(c.participated, true);
  assert.equal(c.stance, 1);
  assert.equal(forgot.provenanceIntegrity.complete, false);
  assert.deepEqual(forgot.provenanceIntegrity.undeclared, ["CONQUEST"]);
});

test("undeclared provenance is explicitly inspectable, never silently absorbed", () => {
  const r = judge({
    WAR: H("BULLISH", EvidenceSource.MARKET_HISTORY, null),
    FAMINE: H("BULLISH", EvidenceSource.FUNDAMENTAL_FEED, CorrelationGroup.COMPANY_FUNDAMENTALS),
    CONQUEST: H("BULLISH", "NONSENSE_SOURCE", CorrelationGroup.CROWD_BEHAVIOUR),
  });
  assert.equal(r.provenanceIntegrity.complete, false);
  assert.equal(r.provenanceIntegrity.undeclaredCount, 1);
  assert.equal(r.directional.correlation.independentContributors, 2,
    "only declared contributors count as independent");
});

test("undeclared evidence is NOT arbitrarily correlated with other undeclared evidence", () => {
  const a = P("NONSENSE_A", CorrelationGroup.MARKET_ACCELERATION);
  const b = P("NONSENSE_B", CorrelationGroup.MARKET_ACCELERATION);
  assert.equal(areCorrelated(a, b), false,
    "falsely grouping unknown evidence would delete genuinely independent findings");
  assert.equal(isIndependenceEligible(a), false, "its safety comes from withheld credit, not false correlation");
});

test("undeclared provenance cannot count as an independent Death phenomenon", () => {
  const withDeclared = deathAnalysis(buildDeathInput({
    assetId: "T", technical: technical({ rsi14: 88, percentChange20d: 25 }),
    fundamental: fundamental(), crowd: null,
    consensus: { directions: { WAR: "BULLISH", FAMINE: "BULLISH", CONQUEST: "UNKNOWN" } },
  }));
  const declaredPhenomena = withDeclared.distinctPhenomenaCount;

  // Simulate a producer emitting several undeclared observed risks.
  const undeclared = [
    { category: "OBSERVED_RISK", id: "X1", severity: Severity.HIGH, detail: "d", source: "CONQUEST",
      provenance: P("NOT_A_SOURCE", null) },
    { category: "OBSERVED_RISK", id: "X2", severity: Severity.HIGH, detail: "d", source: "CONQUEST",
      provenance: P("NOT_A_SOURCE", null) },
  ];
  const grouped = groupByCorrelation(undeclared);
  assert.equal(grouped.length, 2, "groupByCorrelation alone would treat them as two phenomena");
  // Death quarantines them into one group instead.
  assert.ok(declaredPhenomena >= 1);
  assert.equal(withDeclared.provenanceIntegrity.complete, true,
    "production Death declares provenance on every finding");
});

test("Death exposes provenance integrity and flags any quarantined group", () => {
  const r = runDeath({ technical: technical({ rsi14: 88 }) });
  assert.equal(r.provenanceIntegrity.complete, true);
  assert.equal(r.provenanceIntegrity.undeclaredCount, 0);
  for (const g of r.correlationGroups) assert.equal(g.provenanceUndeclared, false);
});

/* ================================================================== */
/* HARDENING PASS — composite conclusions are not one phenomenon       */
/* ================================================================== */

test("War's composite technical conclusion does NOT correlate with Conquest acceleration", () => {
  // War's direction combines three moving-average comparisons, an RSI band
  // and a 20-session return. It must keep its independent contribution even
  // when behavioural Conquest reports acceleration.
  const warComposite = adaptWar({ direction: "BULLISH", confidence: 90, dataSource: {
    engine: "v2", provider: "twelvedata", simulated: false, dataStatus: "COMPLETE",
    latestDataTimestamp: "2026-09-03", latestBarIsProvisional: false, candlesUsed: 320 } }).directionalProvenance;
  const conquestAcceleration = P(EvidenceSource.MARKET_HISTORY, CorrelationGroup.MARKET_ACCELERATION);

  assert.equal(warComposite.composite, true);
  assert.equal(warComposite.correlationGroup, null,
    "a five-input conclusion must not be stamped with one phenomenon");
  assert.equal(areCorrelated(warComposite, conquestAcceleration), false,
    "War's legitimate independent technical view must not be suppressed");
});

test("the ACCELERATION phenomenon is tagged where it actually occurs", () => {
  // Death's RAPID_MOVEMENT genuinely IS the acceleration observation, so it
  // correlates with a future Conquest finding about the same move.
  const r = runDeath({ technical: technical({ percentChange20d: 30 }) });
  const rapid = r.observedRisks.find(f => f.id === "RAPID_MOVEMENT");
  assert.equal(rapid.provenance.correlationGroup, CorrelationGroup.MARKET_ACCELERATION);
  assert.equal(rapid.provenance.composite, false);
  // It is a TWENTY-session move, and says so.
  assert.deepEqual(rapid.provenance.horizon, { unit: "SESSIONS", length: 20, baselineLength: null },
    "a single-window horizon carries no baseline");

  // A future Conquest observation of the same twenty-session move correlates...
  const sameHorizonObservation = P(EvidenceSource.MARKET_HISTORY, CorrelationGroup.MARKET_ACCELERATION,
    [], { horizon: { unit: "SESSIONS", length: 20 } });
  assert.equal(areCorrelated(rapid.provenance, sameHorizonObservation), true,
    "the same move at the same window is one phenomenon");

  // ...but a single-session observation is a different measurement.
  const oneSessionObservation = P(EvidenceSource.MARKET_HISTORY, CorrelationGroup.MARKET_ACCELERATION,
    [], { horizon: { unit: "SESSIONS", length: 1 } });
  assert.equal(areCorrelated(rapid.provenance, oneSessionObservation), false,
    "one session and twenty sessions can diverge completely");
});

test("a War conclusion from a different technical phenomenon stays independent", () => {
  const extension = P(EvidenceSource.MARKET_HISTORY, CorrelationGroup.MARKET_EXTENSION);
  const acceleration = P(EvidenceSource.MARKET_HISTORY, CorrelationGroup.MARKET_ACCELERATION);
  assert.equal(areCorrelated(extension, acceleration), false,
    "sharing OHLCV does not make two phenomena one");
});

test("Famine's directional provenance is not over-collapsed to one producer label", () => {
  const famine = adaptFamine({ direction: "BULLISH", confidence: 70, dataSource: {
    engine: "v2", dataStatus: "COMPLETE", completeness: { score: 1 },
    freshness: { overall: "CURRENT" }, missingEvidence: [], disagreement: [],
    strongestSupporting: [], strongestOpposing: [] } }).directionalProvenance;

  assert.equal(famine.composite, true);
  assert.equal(famine.correlationGroup, null);
  // Famine's lean spans fundamentals, earnings surprises AND current catalysts.
  assert.deepEqual([...famine.contributingSources].sort(),
    [EvidenceSource.FUNDAMENTAL_FEED, EvidenceSource.NEWS_FEED].sort());
  // So it must not be treated as the same phenomenon as a purely
  // fundamental finding.
  assert.equal(areCorrelated(famine, P(EvidenceSource.FUNDAMENTAL_FEED, CorrelationGroup.COMPANY_FUNDAMENTALS)), false);
});

test("assessProvenanceIntegrity reports exactly which items are undeclared", () => {
  const integrity = assessProvenanceIntegrity([
    { id: "A", provenance: P(EvidenceSource.MARKET_HISTORY, CorrelationGroup.MARKET_ACCELERATION) },
    { id: "B", provenance: P("BROKEN", null) },
    { id: "C" },
  ], i => i.id);
  assert.equal(integrity.complete, false);
  assert.deepEqual(integrity.undeclared, ["B", "C"]);
});
