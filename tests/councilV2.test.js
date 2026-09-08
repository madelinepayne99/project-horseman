import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCouncilInput, AssetType, Direction, EXPECTED_HORSEMEN } from "../src/council/councilInput.js";
import { councilAnalysis, Verdict, COUNCIL_THRESHOLDS as T } from "../src/council/councilAnalysis.js";
import { makeProvenance, EvidenceSource } from "../src/schema/provenance.js";

/**
 * COUNCIL V2 — SPECIFICATION TESTS
 *
 * These define intended behaviour. Legacy Council's current behaviour is
 * documented separately in tests/councilLegacyCharacterisation.test.js;
 * the two must not be conflated.
 *
 * Pure functions, structured facts only, no network.
 */

/**
 * Default provenance is DECLARED and COMPOSITE — the shape production
 * adapters emit for War and Famine, whose directional conclusions combine
 * several observations. Composite provenance correlates with nothing, so
 * these fixtures exercise the judgment model without correlation effects.
 * Correlation-specific behaviour is covered in provenanceCorrelation.test.js.
 */
const DECLARED_COMPOSITE = makeProvenance(
  EvidenceSource.MARKET_HISTORY, null, [], { composite: true });

const H = (direction, {
  conf = 80, comp = 1, fresh = "CURRENT", status = "COMPLETE",
  internal = [], missing = [], supporting = [], opposing = [],
  provenance = DECLARED_COMPOSITE,
} = {}) => ({
  directionalProvenance: provenance,
  direction, evidenceConfidence: conf, completeness: comp, freshnessStatus: fresh,
  dataStatus: status, internalDisagreement: internal, missingEvidence: missing,
  strongestSupporting: supporting, strongestOpposing: opposing,
});

const D = ({
  severity = "NONE_OBSERVED", confidence = "STRONG", risks = [],
  challenge = null, missing = [], uncertainty = [], disagreement = [],
} = {}) => ({
  riskSeverity: severity, evidenceConfidence: confidence, observedRisks: risks,
  missingEvidence: missing, uncertainty, disagreement,
  strongestChallenge: challenge
    ? { hasObservedChallenge: true, statement: challenge, finding: { id: "CHALLENGE", severity } }
    : { hasObservedChallenge: false, statement: "No major observed red flag was found.", finding: null },
});

const judge = (horsemen, death = D(), extra = {}) =>
  councilAnalysis(buildCouncilInput({ assetId: "TEST", horsemen, death, ...extra }));

const allBullish = (conf = 90) => ({
  WAR: H(Direction.BULLISH, { conf }), FAMINE: H(Direction.BULLISH, { conf: conf - 2 }),
  CONQUEST: H(Direction.BULLISH, { conf: conf - 4 }),
});

/* ==================================================================== */
/* UNKNOWN / ABSTENTION — the non-negotiable                            */
/* ==================================================================== */

test("UNKNOWN is not NEUTRAL: one participates and votes, the other does neither", () => {
  const neutral = judge({ WAR: H("BULLISH", { conf: 85 }), FAMINE: H("BULLISH", { conf: 80 }), CONQUEST: H("NEUTRAL", { conf: 80 }) });
  const unknown = judge({ WAR: H("BULLISH", { conf: 85 }), FAMINE: H("BULLISH", { conf: 80 }), CONQUEST: H("UNKNOWN") });

  assert.equal(neutral.coverage.participating.length, 3);
  assert.equal(unknown.coverage.participating.length, 2);
  assert.deepEqual(unknown.coverage.abstained, ["CONQUEST"]);

  // NEUTRAL is real evidence and dilutes the directional score.
  assert.ok(neutral.directional.score < 1, "a genuine neutral finding pulls the score toward balance");
  // UNKNOWN casts no vote at all, so the score reflects only those who spoke.
  assert.equal(unknown.directional.score, 1, "an abstention contributes no stance");
  assert.notDeepEqual(neutral.verdict + neutral.confidence, unknown.verdict + unknown.confidence);
});

test("an abstention casts no directional vote and is visible in the result", () => {
  const r = judge({ WAR: H("BULLISH"), FAMINE: H("BEARISH"), CONQUEST: H("UNKNOWN") });
  const conquest = r.directional.contributions.find(c => c.horseman === "CONQUEST");
  assert.equal(conquest.participated, false);
  assert.equal(conquest.stance, null);
  assert.equal(conquest.weight, 0);
  assert.equal(conquest.contribution, 0);
  assert.deepEqual(r.coverage.abstained, ["CONQUEST"]);
});

test("REGRESSION A: removing a weak Horseman through UNKNOWN can never increase confidence", () => {
  // The legacy defect: filtering a low confidence out of the mean raised
  // Council confidence by up to 8 points. Here the guarantee is structural —
  // weights divide by EXPECTED Horsemen, so silence can only subtract.
  for (const weakConf of [5, 10, 25, 40, 55, 70, 85, 95]) {
    const present = judge({ WAR: H("BULLISH", { conf: 85 }), FAMINE: H("BULLISH", { conf: 80 }), CONQUEST: H("BULLISH", { conf: weakConf }) });
    const absent = judge({ WAR: H("BULLISH", { conf: 85 }), FAMINE: H("BULLISH", { conf: 80 }), CONQUEST: H("UNKNOWN") });
    assert.ok(absent.confidence <= present.confidence,
      `abstention raised confidence from ${present.confidence} to ${absent.confidence} (weak Horseman at ${weakConf})`);
    assert.ok(absent.factors.evidenceStrength < present.factors.evidenceStrength);
  }
});

test("missing evidence can never increase confidence", () => {
  const complete = judge(allBullish());
  const withMissing = judge({
    WAR: H("BULLISH", { conf: 90, missing: [{ field: "a" }, { field: "b" }] }),
    FAMINE: H("BULLISH", { conf: 88, missing: [{ field: "c" }] }),
    CONQUEST: H("BULLISH", { conf: 86 }),
  });
  assert.ok(withMissing.confidence < complete.confidence);
  assert.equal(withMissing.factors.missingEvidenceCount, 3);
});

test("incomplete evidence lowers confidence proportionally", () => {
  const full = judge(allBullish());
  const partial = judge({
    WAR: H("BULLISH", { conf: 90, comp: 0.4 }), FAMINE: H("BULLISH", { conf: 88, comp: 0.4 }),
    CONQUEST: H("BULLISH", { conf: 86, comp: 0.4 }),
  });
  assert.ok(partial.confidence < full.confidence);
  assert.ok(partial.factors.evidenceStrength < full.factors.evidenceStrength);
});

test("stale evidence reduces evidence quality", () => {
  const fresh = judge(allBullish());
  const stale = judge({
    WAR: H("BULLISH", { conf: 90, fresh: "STALE" }), FAMINE: H("BULLISH", { conf: 88, fresh: "STALE" }),
    CONQUEST: H("BULLISH", { conf: 86, fresh: "STALE" }),
  });
  assert.ok(stale.factors.evidenceStrength < fresh.factors.evidenceStrength);
  assert.ok(stale.confidence < fresh.confidence);
});

test("a Horseman reporting no quality information is weighted low, not perfect", () => {
  const noInfo = judge({
    WAR: { direction: "BULLISH" }, FAMINE: { direction: "BULLISH" }, CONQUEST: { direction: "BULLISH" },
  });
  const weight = noInfo.directional.contributions[0].weight;
  assert.ok(weight <= T.WEIGHT_WITHOUT_QUALITY_INFO,
    "unquantified evidence must not score as though it were complete");
  assert.ok(noInfo.confidence < judge(allBullish()).confidence);
});

/* ==================================================================== */
/* JUDGMENT — not majority voting                                       */
/* ==================================================================== */

test("high-quality evidence outweighs weak evidence rather than being outvoted", () => {
  // Two weak bulls against one strong bear.
  const r = judge({
    WAR: H("BEARISH", { conf: 95, comp: 1 }),
    FAMINE: H("BULLISH", { conf: 20, comp: 0.2 }),
    CONQUEST: H("BULLISH", { conf: 20, comp: 0.2 }),
  });
  assert.ok(r.directional.score < 0,
    "a 2-1 bullish vote count must not produce a bullish score when the bear carries the evidence");
  assert.ok(r.directional.bearWeight > r.directional.bullWeight);
});

test("a NEUTRAL stance is genuine evidence and contributes to coverage", () => {
  const r = judge({ WAR: H("BULLISH", { conf: 85 }), FAMINE: H("NEUTRAL", { conf: 85 }), CONQUEST: H("NEUTRAL", { conf: 85 }) });
  assert.equal(r.coverage.participating.length, 3);
  assert.equal(r.coverage.abstained.length, 0);
  const famine = r.directional.contributions.find(c => c.horseman === "FAMINE");
  assert.equal(famine.stance, 0);
  assert.ok(famine.weight > 0, "a neutral finding still carries evidential weight");
});

test("internal disagreement inside a Horseman reduces justified confidence", () => {
  const clean = judge(allBullish());
  const conflicted = judge({
    WAR: H("BULLISH", { conf: 90 }),
    FAMINE: H("BULLISH", { conf: 88, internal: [{ type: "REVENUE_UP_EARNINGS_DOWN" }, { type: "X" }] }),
    CONQUEST: H("BULLISH", { conf: 86 }),
  });
  assert.ok(conflicted.confidence < clean.confidence);
  assert.equal(conflicted.factors.internalDisagreementCount, 2);
});

test("directional conflict between Horsemen is weighted, not a flat penalty", () => {
  const strongConflict = judge({ WAR: H("BULLISH", { conf: 90 }), FAMINE: H("BEARISH", { conf: 90 }), CONQUEST: H("UNKNOWN") });
  const weakConflict = judge({ WAR: H("BULLISH", { conf: 90 }), FAMINE: H("BEARISH", { conf: 15, comp: 0.2 }), CONQUEST: H("UNKNOWN") });
  assert.ok(strongConflict.directional.disagreementIndex > weakConflict.directional.disagreementIndex,
    "an evenly-matched conflict is more disagreement than a weak objection");
  assert.equal(strongConflict.directional.hasDirectionalConflict, true);
});

test("proxy attention cannot become directional evidence", () => {
  // Conquest V2's realistic shape: attention observed, sentiment unknown.
  const r = judge({ WAR: H("BULLISH", { conf: 85 }), FAMINE: H("BULLISH", { conf: 80 }), CONQUEST: H("UNKNOWN") });
  const conquest = r.directional.contributions.find(c => c.horseman === "CONQUEST");
  assert.equal(conquest.contribution, 0, "attention is not a stance");
  assert.ok(r.confidence < judge(allBullish()).confidence,
    "and its absence reduces evidence strength rather than being ignored");
});

/* ==================================================================== */
/* VERDICTS                                                             */
/* ==================================================================== */

test("REJECT: weighted evidence points against with enough of it to say so", () => {
  const r = judge({ WAR: H("BEARISH", { conf: 85 }), FAMINE: H("BEARISH", { conf: 80 }), CONQUEST: H("NEUTRAL", { conf: 70 }) });
  assert.equal(r.verdict, Verdict.REJECT);
  assert.ok(r.directional.score <= T.BEARISH_REJECT);
});

test("WATCH: genuinely balanced evidence with adequate coverage", () => {
  const r = judge({ WAR: H("BULLISH", { conf: 85 }), FAMINE: H("BEARISH", { conf: 85 }), CONQUEST: H("NEUTRAL", { conf: 85 }) });
  assert.equal(r.verdict, Verdict.WATCH);
  assert.ok(Math.abs(r.directional.score) < T.BALANCED_BAND);
});

test("WAIT: a promising case whose evidence is too thin to act on", () => {
  const r = judge({
    WAR: H("BULLISH", { conf: 55, comp: 0.5 }), FAMINE: H("BULLISH", { conf: 50, comp: 0.5 }), CONQUEST: H("UNKNOWN"),
  });
  assert.equal(r.verdict, Verdict.WAIT, "positive direction, insufficient evidence strength");
  assert.ok(r.directional.score > 0);
  assert.ok(r.factors.evidenceStrength < T.FAVOURABLE_EVIDENCE);
  assert.match(r.verdictReasons.join(" "), /evidence strength/i);
});

test("WAIT is a first-class outcome, distinct from WATCH", () => {
  const wait = judge({ WAR: H("BULLISH", { conf: 55, comp: 0.5 }), FAMINE: H("BULLISH", { conf: 50, comp: 0.5 }), CONQUEST: H("UNKNOWN") });
  const watch = judge({ WAR: H("BULLISH", { conf: 85 }), FAMINE: H("BEARISH", { conf: 85 }), CONQUEST: H("NEUTRAL", { conf: 85 }) });
  assert.equal(wait.verdict, Verdict.WAIT);
  assert.equal(watch.verdict, Verdict.WATCH);
  assert.notEqual(wait.verdict, watch.verdict,
    "WATCH means balanced evidence; WAIT means promising but unproven");
});

test("FAVOURABLE: evidence points for, with adequate strength", () => {
  const r = judge({ WAR: H("BULLISH", { conf: 85 }), FAMINE: H("BULLISH", { conf: 80 }), CONQUEST: H("UNKNOWN") });
  assert.equal(r.verdict, Verdict.FAVOURABLE);
  assert.ok(r.factors.evidenceStrength >= T.FAVOURABLE_EVIDENCE);
});

test("STRONG: high score and high evidence strength with no material challenge", () => {
  const r = judge(allBullish(80), D({ severity: "LOW", risks: [{ id: "minor" }] }));
  assert.equal(r.verdict, Verdict.STRONG);
  assert.ok(r.directional.score >= T.STRONG_SCORE);
  assert.ok(r.factors.evidenceStrength >= T.STRONG_EVIDENCE);
});

test("EXCEPTIONAL: unanimous, complete, current and unchallenged", () => {
  const r = judge(allBullish(94), D());
  assert.equal(r.verdict, Verdict.EXCEPTIONAL);
  assert.ok(r.factors.evidenceStrength >= T.EXCEPTIONAL_EVIDENCE);
  assert.equal(r.coverage.abstained.length, 0);
  assert.equal(r.deathChallenge.observedRiskCount, 0);
});

test("all six canonical verdicts are reachable and no others exist", () => {
  const produced = new Set([
    judge({ WAR: H("BEARISH", { conf: 85 }), FAMINE: H("BEARISH", { conf: 80 }), CONQUEST: H("NEUTRAL", { conf: 70 }) }).verdict,
    judge({ WAR: H("BULLISH", { conf: 85 }), FAMINE: H("BEARISH", { conf: 85 }), CONQUEST: H("NEUTRAL", { conf: 85 }) }).verdict,
    judge({ WAR: H("BULLISH", { conf: 55, comp: 0.5 }), FAMINE: H("BULLISH", { conf: 50, comp: 0.5 }), CONQUEST: H("UNKNOWN") }).verdict,
    judge({ WAR: H("BULLISH", { conf: 85 }), FAMINE: H("BULLISH", { conf: 80 }), CONQUEST: H("UNKNOWN") }).verdict,
    judge(allBullish(80), D({ severity: "LOW", risks: [{ id: "m" }] })).verdict,
    judge(allBullish(94)).verdict,
  ]);
  assert.deepEqual([...produced].sort(),
    ["EXCEPTIONAL", "FAVOURABLE", "REJECT", "STRONG", "WAIT", "WATCH"]);
  for (const v of produced) assert.ok(Object.values(Verdict).includes(v));
});

test("REGRESSION C: agreeing directions cannot buy a high-confidence verdict on stale, incomplete evidence", () => {
  const pristine = judge(allBullish(94));
  const degraded = judge({
    WAR: H("BULLISH", { conf: 94, comp: 0.5, fresh: "STALE" }),
    FAMINE: H("BULLISH", { conf: 92, comp: 0.6, fresh: "STALE" }),
    CONQUEST: H("BULLISH", { conf: 90, comp: 0.6 }),
  });
  assert.equal(pristine.verdict, Verdict.EXCEPTIONAL);
  assert.equal(degraded.directional.score, 1, "the directions agree just as strongly");
  assert.ok(![Verdict.STRONG, Verdict.EXCEPTIONAL].includes(degraded.verdict),
    "unanimity alone must not reach the top verdicts");
  assert.ok(degraded.confidence < pristine.confidence - 15);
});

test("REGRESSION B: the verdict derives from the same final confidence that is displayed", () => {
  // Legacy applied the conflict penalty AFTER selecting the verdict, so a
  // STRONG could be awarded on 84 and then displayed as 76.
  const r = judge({
    WAR: H("BULLISH", { conf: 90, internal: [{ x: 1 }] }),
    FAMINE: H("BULLISH", { conf: 88, missing: [{ f: 1 }, { f: 2 }] }),
    CONQUEST: H("BULLISH", { conf: 86 }),
  }, D({ severity: "MODERATE", confidence: "MODERATE", risks: [{ id: "r" }] }));

  const raw = r.factors.evidenceStrength * r.factors.agreementFactor * r.factors.deathFactor - r.factors.penalty;
  assert.equal(r.confidenceScore, Number(Math.max(0, Math.min(1, raw)).toFixed(4)),
    "the score is derived from the published factors, with nothing applied afterwards");
  assert.equal(r.confidence, Math.round(r.confidenceScore * 100),
    "the displayed confidence is exactly the value the verdict was chosen from");
});

/* ==================================================================== */
/* DEATH                                                                */
/* ==================================================================== */

test("a well-supported SEVERE Death challenge blocks STRONG and EXCEPTIONAL", () => {
  const unchallenged = judge(allBullish(94));
  const challenged = judge(allBullish(94),
    D({ severity: "SEVERE", confidence: "STRONG", risks: [{ id: "r" }], challenge: "Company cut full-year guidance" }));

  assert.equal(unchallenged.verdict, Verdict.EXCEPTIONAL);
  assert.equal(challenged.verdict, Verdict.FAVOURABLE, "Death is not a veto, but caps the verdict");
  assert.ok(![Verdict.STRONG, Verdict.EXCEPTIONAL].includes(challenged.verdict));
  assert.equal(challenged.deathChallenge.material, true);
});

test("proceeding despite a material challenge is declared with a structured, derived reason", () => {
  const r = judge(allBullish(94),
    D({ severity: "SEVERE", confidence: "STRONG", risks: [{ id: "r" }], challenge: "Company cut full-year guidance" }));
  const p = r.proceededDespiteDeathChallenge;
  assert.ok(p, "the state must be explicit, not implied");
  assert.equal(p.severity, "SEVERE");
  assert.equal(p.deathEvidenceConfidence, "STRONG");
  assert.equal(p.challenge, "Company cut full-year guidance");
  // The basis is built from the computed figures, never invented prose.
  assert.match(p.basis, /Directional evidence 1\.00 at strength 0\.9[0-9] was judged to outweigh a SEVERE challenge/);
});

test("a weakly-evidenced severity is distinguished from a well-supported one", () => {
  const wellSupported = judge(allBullish(94), D({ severity: "SEVERE", confidence: "STRONG", risks: [{ id: "r" }], challenge: "Solid challenge" }));
  const weaklySupported = judge(allBullish(94), D({ severity: "SEVERE", confidence: "WEAK", risks: [{ id: "r" }], challenge: "Thin challenge" }));

  assert.equal(wellSupported.deathChallenge.material, true);
  assert.equal(weaklySupported.deathChallenge.material, false,
    "a severe claim on thin evidence does not bind Council");
  assert.ok(weaklySupported.confidence > wellSupported.confidence,
    "but it still discounts confidence, proportionally to how well evidenced it is");
  assert.equal(weaklySupported.proceededDespiteDeathChallenge, null);
});

test("no Death challenge does not automatically mean safe", () => {
  const noChallenge = judge(allBullish(80), D({ severity: "NONE_OBSERVED", confidence: "INSUFFICIENT",
    missing: [{ id: "CROWDING_UNKNOWN" }, { id: "TECHNICAL_EVIDENCE_UNAVAILABLE" }] }));
  assert.equal(noChallenge.deathChallenge.observedRiskCount, 0);
  assert.equal(noChallenge.deathChallenge.missingEvidenceCount, 2, "Death's missing evidence stays visible");
  assert.ok(noChallenge.factors.deathFactor < 1,
    "a Death that could not check things must not read as a clean bill of health");
});

test("Death's missing evidence and uncertainty remain visible in the case file", () => {
  const r = judge(allBullish(80), D({
    missing: [{ id: "CROWDING_UNKNOWN" }],
    uncertainty: [{ id: "CROWD_SENTIMENT_UNKNOWN", detail: "Attention is HIGH but sentiment could not be read." }],
  }));
  assert.equal(r.deathChallenge.missingEvidenceCount, 1);
  assert.equal(r.deathChallenge.uncertaintyCount, 1);
  assert.ok(r.whatWouldChangeMind.some(x => /sentiment could not be read/.test(x)));
});

test("riskSeverity is consumed directly and never mapped back to a 0-4 integer", () => {
  const r = judge(allBullish(80), D({ severity: "HIGH", confidence: "STRONG", risks: [{ id: "r" }], challenge: "c" }));
  assert.equal(r.deathChallenge.riskSeverity, "HIGH");
  assert.equal(r.deathChallenge.evidenceConfidence, "STRONG");
  const keys = new Set();
  (function walk(v) { if (v && typeof v === "object") for (const [k, val] of Object.entries(v)) { keys.add(k.toLowerCase()); walk(val); } })(r);
  assert.ok(!keys.has("risk"), "no legacy risk integer may appear");
});

/* ==================================================================== */
/* CASE FILE                                                            */
/* ==================================================================== */

test("the strongest supporting and opposing cases are structured and deterministic", () => {
  const r = judge({
    WAR: H("BULLISH", { conf: 90, supporting: ["Price above all three moving averages"] }),
    FAMINE: H("BEARISH", { conf: 88, opposing: [{ claim: "Earnings fell 12% year-on-year" }] }),
    CONQUEST: H("UNKNOWN"),
  });
  assert.equal(r.strongestSupportingCase.available, true);
  assert.equal(r.strongestSupportingCase.source, "WAR");
  assert.match(r.strongestSupportingCase.statement, /moving averages/);
  assert.equal(r.strongestOpposingCase.available, true);
  assert.equal(r.strongestOpposingCase.source, "FAMINE");
  assert.match(r.strongestOpposingCase.statement, /Earnings fell 12%/);
  assert.deepEqual(judge({
    WAR: H("BULLISH", { conf: 90, supporting: ["Price above all three moving averages"] }),
    FAMINE: H("BEARISH", { conf: 88, opposing: [{ claim: "Earnings fell 12% year-on-year" }] }),
    CONQUEST: H("UNKNOWN"),
  }).strongestSupportingCase, r.strongestSupportingCase);
});

test("an absent case is reported honestly rather than fabricated", () => {
  const r = judge(allBullish());
  assert.equal(r.strongestOpposingCase.available, false);
  assert.match(r.strongestOpposingCase.statement, /No Horseman supplied structured evidence/);
  assert.deepEqual(r.strongestOpposingCase.claims, []);
});

test("whatWouldChangeMind is derived from unresolved conditions, not a universal constant", () => {
  const abstained = judge({ WAR: H("BULLISH"), FAMINE: H("BULLISH"), CONQUEST: H("UNKNOWN") });
  const stale = judge({
    WAR: H("BULLISH", { fresh: "STALE" }), FAMINE: H("BULLISH", { comp: 0.5 }), CONQUEST: H("BULLISH"),
  });
  const challenged = judge(allBullish(94),
    D({ severity: "SEVERE", confidence: "STRONG", risks: [{ id: "r" }], challenge: "Guidance cut" }));

  assert.notDeepEqual(abstained.whatWouldChangeMind, stale.whatWouldChangeMind);
  assert.notDeepEqual(stale.whatWouldChangeMind, challenged.whatWouldChangeMind);
  assert.ok(abstained.whatWouldChangeMind.some(x => /CONQUEST/.test(x)));
  assert.ok(stale.whatWouldChangeMind.some(x => /stale/i.test(x)));
  assert.ok(stale.whatWouldChangeMind.some(x => /More complete FAMINE evidence \(currently 50%\)/.test(x)));
  assert.ok(challenged.whatWouldChangeMind.some(x => /Guidance cut/.test(x)));
});

test("whatWouldChangeMind falls back honestly when nothing is unresolved", () => {
  const r = judge(allBullish(94));
  assert.equal(r.whatWouldChangeMind.length, 1);
  assert.match(r.whatWouldChangeMind[0], /New price action, company results/);
});

test("verdict reasons cite the computed figures rather than fixed templates", () => {
  const r = judge({ WAR: H("BULLISH", { conf: 85 }), FAMINE: H("BULLISH", { conf: 80 }), CONQUEST: H("UNKNOWN") });
  assert.ok(r.verdictReasons.length > 0);
  assert.match(r.verdictReasons.join(" "), /\d\.\d\d/, "reasons quote actual numbers");
});

/* ==================================================================== */
/* NEUTRALITY, STRUCTURE, DETERMINISM                                   */
/* ==================================================================== */

test("Council emits no profit probability, BUY or SELL semantics", () => {
  const r = judge(allBullish(94));
  const keys = new Set();
  (function walk(v) { if (v && typeof v === "object") for (const [k, val] of Object.entries(v)) { keys.add(k.toLowerCase()); walk(val); } })(r);
  for (const banned of ["probability", "profit", "buy", "sell", "targetprice", "expectedreturn", "risk"]) {
    assert.ok(!keys.has(banned), `no Council field may be named ${banned}`);
  }
  assert.ok(r.limitations.some(l => /not a probability that the trade will make money/.test(l)));
});

test("thresholds are exported, inspectable and explicitly uncalibrated", () => {
  assert.equal(T.calibrated, false);
  assert.equal(T.FAVOURABLE_SCORE, 0.35);
  assert.equal(T.STRONG_EVIDENCE, 0.68);
  assert.equal(T.EXCEPTIONAL_EVIDENCE, 0.85);
  assert.ok(r => true);
  assert.ok(judge(allBullish()).limitations.some(l => /provisional and have not been calibrated/.test(l)));
});

test("a crypto asset is structurally supported", () => {
  const r = judge(allBullish(90), D(), { assetType: AssetType.CRYPTO, assetId: "BTC" });
  assert.equal(r.assetType, AssetType.CRYPTO);
  assert.ok(Object.values(Verdict).includes(r.verdict));
});

test("the input contract validates identity and asset type", () => {
  assert.throws(() => buildCouncilInput({}), /requires an assetId/);
  assert.throws(() => buildCouncilInput({ assetId: "X", assetType: "COMMODITY" }), /unknown assetType/);
});

test("an unrecognised direction is treated as an abstention, not a vote", () => {
  const r = judge({ WAR: H("MOONING"), FAMINE: H("BULLISH"), CONQUEST: H("BULLISH") });
  assert.equal(r.coverage.abstained.includes("WAR"), true);
  assert.equal(r.directional.contributions.find(c => c.horseman === "WAR").stance, null);
});

test("results are deeply immutable and deterministic", () => {
  const a = judge(allBullish(85));
  const b = judge(allBullish(85));
  assert.deepEqual(a, b);
  assert.throws(() => { a.verdict = Verdict.REJECT; }, TypeError);
  assert.throws(() => { a.factors.evidenceStrength = 1; }, TypeError);
  assert.throws(() => { a.whatWouldChangeMind.push("x"); }, TypeError);
  assert.throws(() => { a.directional.contributions.push({}); }, TypeError);
});

test("every expected Horseman appears in coverage even when it never reported", () => {
  const r = judge({ WAR: H("BULLISH") });
  assert.deepEqual(r.coverage.expected, EXPECTED_HORSEMEN);
  assert.deepEqual(r.coverage.abstained, ["FAMINE", "CONQUEST"]);
  assert.equal(r.coverage.participationRatio, Number((1 / 3).toFixed(4)));
});
