import { test } from "node:test";
import assert from "node:assert/strict";
import {
  makeEpistemicFinding, EpistemicLayer, FindingSubject, EpistemicViolation,
  LAYER_PERMISSIONS, ORIGIN_TO_SOURCE, usesResemblanceLanguage,
} from "../src/schema/epistemics.js";
import { EvidenceOrigin } from "../src/schema/crowd.js";
import { EvidenceSource, CorrelationGroup, areCorrelated, isIndependenceEligible } from "../src/schema/provenance.js";

/** Epistemic layer schema. Pure, inert, no network. */

const marketObservation = (over = {}) => makeEpistemicFinding({
  origin: EvidenceOrigin.OBSERVED_MARKET_BEHAVIOUR,
  layer: EpistemicLayer.OBSERVATION,
  subject: FindingSubject.MARKET,
  id: "PARTICIPATION_PERCENTILE",
  statement: "Activity is at its 97th percentile for this stock over two years.",
  correlationGroup: CorrelationGroup.MARKET_PARTICIPATION,
  ...over,
});

/* ---------------- what market history MAY do ---------------- */

test("OBSERVED_MARKET_BEHAVIOUR + OBSERVATION is valid", () => {
  const f = marketObservation();
  assert.equal(f.layer, EpistemicLayer.OBSERVATION);
  assert.equal(f.origin, EvidenceOrigin.OBSERVED_MARKET_BEHAVIOUR);
  assert.equal(f.subject, FindingSubject.MARKET);
  assert.equal(f.provenance.source, EvidenceSource.MARKET_HISTORY,
    "origin maps into the locked correlation vocabulary");
  assert.equal(f.provenance.correlationGroup, CorrelationGroup.MARKET_PARTICIPATION);
});

test("OBSERVED_MARKET_BEHAVIOUR + BEHAVIOURAL_INTERPRETATION is valid when it cites its observations", () => {
  const f = makeEpistemicFinding({
    origin: EvidenceOrigin.OBSERVED_MARKET_BEHAVIOUR,
    layer: EpistemicLayer.BEHAVIOURAL_INTERPRETATION,
    subject: FindingSubject.MARKET,
    id: "RESEMBLES_CHASING",
    statement: "This pattern resembles chasing behaviour.",
    basedOn: ["PARTICIPATION_PERCENTILE", "RETURN_PERCENTILE"],
    correlationGroup: CorrelationGroup.MARKET_ACCELERATION,
  });
  assert.equal(f.layer, EpistemicLayer.BEHAVIOURAL_INTERPRETATION);
  assert.deepEqual(f.basedOn, ["PARTICIPATION_PERCENTILE", "RETURN_PERCENTILE"]);
  assert.equal(usesResemblanceLanguage(f.statement), true);
});

test("REGRESSION: OBSERVED_MARKET_BEHAVIOUR + INTENT is rejected deterministically", () => {
  assert.throws(() => makeEpistemicFinding({
    origin: EvidenceOrigin.OBSERVED_MARKET_BEHAVIOUR,
    layer: EpistemicLayer.INTENT,
    subject: FindingSubject.MARKET,
    id: "FOMO_CLAIM",
    statement: "Investors are buying because of FOMO.",
    basedOn: ["PARTICIPATION_PERCENTILE"],
  }), EpistemicViolation, "price and volume cannot establish why anyone acted");

  // And it cannot be smuggled in by relabelling the subject.
  assert.throws(() => makeEpistemicFinding({
    origin: EvidenceOrigin.OBSERVED_MARKET_BEHAVIOUR,
    layer: EpistemicLayer.INTENT, subject: FindingSubject.CROWD,
    id: "X", statement: "The crowd is euphoric.", basedOn: ["A"],
  }), EpistemicViolation);
});

test("market behaviour may not describe the crowd's state of mind at all", () => {
  assert.throws(() => makeEpistemicFinding({
    origin: EvidenceOrigin.OBSERVED_MARKET_BEHAVIOUR,
    layer: EpistemicLayer.BEHAVIOURAL_INTERPRETATION,
    subject: FindingSubject.CROWD,
    id: "X", statement: "The crowd looks fearful.", basedOn: ["RETURN_PERCENTILE"],
  }), /may only describe MARKET/);
});

/* ---------------- crowd evidence ---------------- */

test("OBSERVED_CROWD may reach every layer, including a literal intent finding", () => {
  const observation = makeEpistemicFinding({
    origin: EvidenceOrigin.OBSERVED_CROWD, layer: EpistemicLayer.OBSERVATION,
    subject: FindingSubject.CROWD, id: "FOMO_PHRASE_COUNT",
    statement: "24 of 60 sampled posts contain FOMO-style phrasing.",
    correlationGroup: CorrelationGroup.CROWD_BEHAVIOUR,
  });
  const intent = makeEpistemicFinding({
    origin: EvidenceOrigin.OBSERVED_CROWD, layer: EpistemicLayer.INTENT,
    subject: FindingSubject.CROWD, id: "EXPRESSED_FOMO",
    statement: "FOMO language is present in the sampled crowd evidence.",
    basedOn: ["FOMO_PHRASE_COUNT"], correlationGroup: CorrelationGroup.CROWD_BEHAVIOUR,
  });
  assert.equal(observation.provenance.source, EvidenceSource.CROWD_FEED);
  assert.equal(intent.layer, EpistemicLayer.INTENT);
  assert.deepEqual(intent.basedOn, ["FOMO_PHRASE_COUNT"]);
});

test("crowd evidence still may not speak for the market", () => {
  assert.throws(() => makeEpistemicFinding({
    origin: EvidenceOrigin.OBSERVED_CROWD, layer: EpistemicLayer.INTENT,
    subject: FindingSubject.MARKET, id: "X",
    statement: "The market is experiencing FOMO.", basedOn: ["FOMO_PHRASE_COUNT"],
  }), /may only describe CROWD/, "a sample is not the wider market");
});

/* ---------------- user-supplied claims ---------------- */

test("a user claim may validly describe the supplied message itself", () => {
  const f = makeEpistemicFinding({
    origin: EvidenceOrigin.USER_SUPPLIED_CLAIM, layer: EpistemicLayer.OBSERVATION,
    subject: FindingSubject.SUPPLIED_MESSAGE, id: "URGENCY_LANGUAGE",
    statement: "The message contains urgency language.",
    correlationGroup: CorrelationGroup.CLAIM_LANGUAGE,
  });
  assert.equal(f.provenance.source, EvidenceSource.USER_CLAIM);
  assert.equal(f.subject, FindingSubject.SUPPLIED_MESSAGE);
});

test("REGRESSION: a user claim cannot masquerade as crowd or market evidence", () => {
  // It cannot describe the crowd...
  assert.throws(() => makeEpistemicFinding({
    origin: EvidenceOrigin.USER_SUPPLIED_CLAIM, layer: EpistemicLayer.OBSERVATION,
    subject: FindingSubject.CROWD, id: "X", statement: "Everyone is buying.",
  }), /may only describe SUPPLIED_MESSAGE/);
  // ...nor the market...
  assert.throws(() => makeEpistemicFinding({
    origin: EvidenceOrigin.USER_SUPPLIED_CLAIM, layer: EpistemicLayer.OBSERVATION,
    subject: FindingSubject.MARKET, id: "X", statement: "The stock is about to move.",
  }), /may only describe SUPPLIED_MESSAGE/);
  // ...nor establish intent.
  assert.throws(() => makeEpistemicFinding({
    origin: EvidenceOrigin.USER_SUPPLIED_CLAIM, layer: EpistemicLayer.INTENT,
    subject: FindingSubject.SUPPLIED_MESSAGE, id: "X",
    statement: "The sender knows something.", basedOn: ["URGENCY_LANGUAGE"],
  }), /may not produce a INTENT finding/);
});

test("a user claim never gains crowd provenance, so it cannot join crowd evidence", () => {
  const claim = makeEpistemicFinding({
    origin: EvidenceOrigin.USER_SUPPLIED_CLAIM, layer: EpistemicLayer.OBSERVATION,
    subject: FindingSubject.SUPPLIED_MESSAGE, id: "URGENCY",
    statement: "The message pushes urgency.", correlationGroup: CorrelationGroup.CLAIM_LANGUAGE,
  });
  const crowd = makeEpistemicFinding({
    origin: EvidenceOrigin.OBSERVED_CROWD, layer: EpistemicLayer.OBSERVATION,
    subject: FindingSubject.CROWD, id: "POSTS",
    statement: "60 posts sampled.", correlationGroup: CorrelationGroup.CROWD_BEHAVIOUR,
  });
  assert.equal(areCorrelated(claim.provenance, crowd.provenance), false);
  assert.notEqual(claim.provenance.source, crowd.provenance.source);
});

/* ---------------- validation ---------------- */

test("a behavioural interpretation must name the observations it rests on", () => {
  assert.throws(() => makeEpistemicFinding({
    origin: EvidenceOrigin.OBSERVED_MARKET_BEHAVIOUR,
    layer: EpistemicLayer.BEHAVIOURAL_INTERPRETATION,
    subject: FindingSubject.MARKET, id: "X",
    statement: "This resembles chasing.", basedOn: [],
  }), /must name the observations it is based on/);
  // Whitespace-only entries do not count as citations.
  assert.throws(() => makeEpistemicFinding({
    origin: EvidenceOrigin.OBSERVED_MARKET_BEHAVIOUR,
    layer: EpistemicLayer.BEHAVIOURAL_INTERPRETATION,
    subject: FindingSubject.MARKET, id: "X",
    statement: "This resembles chasing.", basedOn: ["  ", ""],
  }), EpistemicViolation);
});

test("unknown layers and unknown origins fail deterministically", () => {
  assert.throws(() => makeEpistemicFinding({
    origin: EvidenceOrigin.OBSERVED_MARKET_BEHAVIOUR, layer: "VIBES",
    subject: FindingSubject.MARKET, id: "X", statement: "s",
  }), /Unknown epistemic layer "VIBES"/);
  assert.throws(() => makeEpistemicFinding({
    origin: "SOMEWHERE_ELSE", layer: EpistemicLayer.OBSERVATION,
    subject: FindingSubject.MARKET, id: "X", statement: "s",
  }), /Unknown evidence origin "SOMEWHERE_ELSE"/);
  assert.throws(() => makeEpistemicFinding({}), EpistemicViolation);
});

test("id and statement are required", () => {
  assert.throws(() => marketObservation({ id: null }), /requires a stable id/);
  assert.throws(() => marketObservation({ statement: "" }), /requires a statement/);
});

test("the permission matrix is the single source of truth and is closed", () => {
  assert.deepEqual(Object.keys(LAYER_PERMISSIONS).sort(),
    ["OBSERVED_CROWD", "OBSERVED_MARKET_BEHAVIOUR", "USER_SUPPLIED_CLAIM"]);
  assert.ok(!LAYER_PERMISSIONS[EvidenceOrigin.OBSERVED_MARKET_BEHAVIOUR].layers.includes(EpistemicLayer.INTENT));
  assert.ok(!LAYER_PERMISSIONS[EvidenceOrigin.USER_SUPPLIED_CLAIM].layers.includes(EpistemicLayer.INTENT));
  assert.ok(LAYER_PERMISSIONS[EvidenceOrigin.OBSERVED_CROWD].layers.includes(EpistemicLayer.INTENT));
});

/* ---------------- integration with the locked contract ---------------- */

test("findings feed the LOCKED correlation contract, not a competing one", () => {
  const marketAccel = makeEpistemicFinding({
    origin: EvidenceOrigin.OBSERVED_MARKET_BEHAVIOUR,
    layer: EpistemicLayer.BEHAVIOURAL_INTERPRETATION, subject: FindingSubject.MARKET,
    id: "RESEMBLES_CHASING", statement: "This resembles chasing.",
    basedOn: ["RETURN_PERCENTILE"], correlationGroup: CorrelationGroup.MARKET_ACCELERATION,
  });
  // Correlates with Death's RAPID_MOVEMENT, which declares the same phenomenon.
  const deathRapid = { source: EvidenceSource.MARKET_HISTORY,
    correlationGroup: CorrelationGroup.MARKET_ACCELERATION, declared: true, composite: false };
  assert.equal(areCorrelated(marketAccel.provenance, deathRapid), true,
    "one move seen by two Horsemen remains one phenomenon");
  assert.equal(isIndependenceEligible(marketAccel.provenance), true,
    "constructed findings always declare, so they never fall into quarantine");
});

test("a different market phenomenon stays independent", () => {
  const participation = marketObservation();
  const acceleration = { source: EvidenceSource.MARKET_HISTORY,
    correlationGroup: CorrelationGroup.MARKET_ACCELERATION, declared: true, composite: false };
  assert.equal(areCorrelated(participation.provenance, acceleration), false,
    "sharing OHLCV does not make two phenomena one");
});

test("ORIGIN_TO_SOURCE is the only mapping between the two vocabularies", () => {
  assert.deepEqual(ORIGIN_TO_SOURCE, {
    OBSERVED_MARKET_BEHAVIOUR: EvidenceSource.MARKET_HISTORY,
    OBSERVED_CROWD: EvidenceSource.CROWD_FEED,
    USER_SUPPLIED_CLAIM: EvidenceSource.USER_CLAIM,
  });
});

/* ---------------- immutability ---------------- */

test("findings are frozen, consistent with the surrounding schema style", () => {
  const f = marketObservation();
  assert.throws(() => { f.layer = EpistemicLayer.INTENT; }, TypeError);
  assert.throws(() => { f.origin = EvidenceOrigin.OBSERVED_CROWD; }, TypeError);
  assert.throws(() => { f.basedOn.push("X"); }, TypeError);
  assert.throws(() => { f.provenance.source = EvidenceSource.CROWD_FEED; }, TypeError);
});

test("resemblance language is detectable for later assertion by behavioural modules", () => {
  assert.equal(usesResemblanceLanguage("This resembles chasing behaviour."), true);
  assert.equal(usesResemblanceLanguage("This is consistent with panic-like selling."), true);
  assert.equal(usesResemblanceLanguage("Investors are panicking."), false);
});

/* ---------------- the existing crowd vocabulary is unharmed ---------------- */

test("extending EvidenceOrigin did not disturb the crowd schema's stamping", async () => {
  const { makeCrowdEvidence, makeCrowdObservation } = await import("../src/schema/crowd.js");
  const obs = makeCrowdObservation({ sourceName: "forum-a", publishedAt: "2026-09-04T10:00:00Z" });
  const ev = makeCrowdEvidence({ assetId: "TEST", provider: "p", observations: [obs],
    origin: EvidenceOrigin.OBSERVED_MARKET_BEHAVIOUR });
  assert.equal(ev.origin, EvidenceOrigin.OBSERVED_CROWD,
    "crowd constructors still hard-stamp OBSERVED_CROWD and ignore overrides");
  assert.equal(obs.origin, EvidenceOrigin.OBSERVED_CROWD);
});
