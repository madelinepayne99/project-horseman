import { test } from "node:test";
import assert from "node:assert/strict";
import {
  makeCrowdObservation, makeCrowdEvidence, makeUnavailableCrowdEvidence,
  hasDirectCrowdEvidence, isPresent, factValue,
  AssetType, EvidenceOrigin, CrowdAvailability, CrowdStance, FactState, MissingReason,
} from "../src/schema/crowd.js";
import {
  CrowdProvider, CrowdError, CrowdErrorCodes, crowdEvidenceFromError,
} from "../src/providers/CrowdProvider.js";

/**
 * Conquest V2 foundation. Everything here is constructed directly — there
 * is no provider implementation, no HTTP and no network of any kind.
 */

const AT = "2026-09-04T10:00:00Z";
const obs = (over = {}) => makeCrowdObservation({
  id: "p1", sourceName: "forum-a", authorId: "u1", publishedAt: AT,
  engagement: 12, stance: CrowdStance.BULLISH, stanceConfidence: 0.8,
  isDuplicate: false, isSuspectedAutomated: false, url: "https://example.com/p1",
  ...over,
});

/* ---------------- observations ---------------- */

test("a well-formed observation normalises and is frozen", () => {
  const o = obs();
  assert.equal(o.sourceName, "forum-a");
  assert.equal(o.publishedAt, "2026-09-04T10:00:00.000Z");
  assert.equal(factValue(o.engagement), 12);
  assert.equal(o.stance, CrowdStance.BULLISH);
  assert.equal(factValue(o.stanceConfidence), 0.8);
  assert.ok(Object.isFrozen(o));
  assert.throws(() => { o.stance = CrowdStance.BEARISH; }, TypeError);
});

test("an observation without a source or timestamp is unusable and returns null", () => {
  assert.equal(makeCrowdObservation({ sourceName: null, publishedAt: AT }), null);
  assert.equal(makeCrowdObservation({ sourceName: "forum-a", publishedAt: null }), null);
  assert.equal(makeCrowdObservation({ sourceName: "  ", publishedAt: AT }), null);
  assert.equal(makeCrowdObservation({}), null);
});

test("timestamps accept ISO strings, seconds and milliseconds; nonsense yields null", () => {
  assert.equal(makeCrowdObservation({ sourceName: "s", publishedAt: 1788516000 }).publishedAt,
    new Date(1788516000 * 1000).toISOString());
  assert.equal(makeCrowdObservation({ sourceName: "s", publishedAt: 1788516000000 }).publishedAt,
    new Date(1788516000000).toISOString());
  assert.equal(makeCrowdObservation({ sourceName: "s", publishedAt: "not-a-date" }), null);
});

test("an unrecognised or absent stance becomes UNCLASSIFIED, never NEUTRAL", () => {
  assert.equal(obs({ stance: null }).stance, CrowdStance.UNCLASSIFIED);
  assert.equal(obs({ stance: "MOON" }).stance, CrowdStance.UNCLASSIFIED);
  assert.equal(obs({ stance: "" }).stance, CrowdStance.UNCLASSIFIED);
  // "we could not tell" must be distinguishable from "the crowd is neutral"
  assert.notEqual(obs({ stance: null }).stance, CrowdStance.NEUTRAL);
  assert.equal(obs({ stance: "bullish" }).stance, CrowdStance.BULLISH, "case-insensitive");
});

test("missing numeric measures stay MISSING and never become 0", () => {
  const o = obs({ engagement: null, stanceConfidence: undefined });
  assert.equal(o.engagement.state, FactState.MISSING);
  assert.equal(o.engagement.value, null);
  assert.equal(isPresent(o.stanceConfidence), false);
  // A genuine zero remains a real measurement.
  assert.equal(isPresent(obs({ engagement: 0 }).engagement), true);
  assert.equal(factValue(obs({ engagement: 0 }).engagement), 0);
});

test("unknown quality flags stay null rather than defaulting to false", () => {
  const o = obs({ isDuplicate: null, isSuspectedAutomated: undefined });
  assert.equal(o.isDuplicate, null, "unknown is not the same as 'not a duplicate'");
  assert.equal(o.isSuspectedAutomated, null);
  assert.equal(obs({ isDuplicate: "yes" }).isDuplicate, null, "non-boolean is not trusted");
});

/* ---------------- aggregate evidence ---------------- */

test("crowd evidence counts stances and diversity from the observations supplied", () => {
  const ev = makeCrowdEvidence({
    assetId: "TSLA", provider: "test-crowd",
    observations: [
      obs({ id: "1", sourceName: "forum-a", authorId: "u1", stance: CrowdStance.BULLISH }),
      obs({ id: "2", sourceName: "forum-a", authorId: "u2", stance: CrowdStance.BEARISH }),
      obs({ id: "3", sourceName: "forum-b", authorId: "u3", stance: CrowdStance.NEUTRAL }),
      obs({ id: "4", sourceName: "forum-b", authorId: "u3", stance: "unknown-thing" }),
    ],
  });

  assert.equal(ev.availability, CrowdAvailability.PRESENT);
  assert.equal(ev.observationCount, 4);
  assert.deepEqual(ev.stanceCounts, { bullish: 1, bearish: 1, neutral: 1, unclassified: 1 });
  assert.equal(ev.sourceDiversity, 2);
  assert.equal(ev.distinctAuthorCount, 3);
});

test("quality indicators are counted, including how many are unknown", () => {
  const ev = makeCrowdEvidence({
    assetId: "TSLA", provider: "test-crowd",
    observations: [
      obs({ id: "1", isDuplicate: true, isSuspectedAutomated: false }),
      obs({ id: "2", isDuplicate: false, isSuspectedAutomated: true }),
      obs({ id: "3", isDuplicate: null, isSuspectedAutomated: null }),
    ],
  });
  assert.equal(ev.quality.duplicateCount, 1);
  assert.equal(ev.quality.suspectedAutomatedCount, 1);
  assert.equal(ev.quality.qualityUnknownCount, 1,
    "a feed that tells us nothing about bots must be discountable later");
});

test("provider aggregates that were not supplied remain MISSING, not zero", () => {
  const ev = makeCrowdEvidence({ assetId: "TSLA", provider: "test-crowd", observations: [obs()] });
  for (const f of [ev.volume.posts, ev.volume.comments, ev.engagementTotal, ev.uniqueAuthors, ev.classifierConfidence]) {
    assert.equal(isPresent(f), false);
    assert.equal(f.value, null);
  }
  const supplied = makeCrowdEvidence({
    assetId: "TSLA", provider: "test-crowd", observations: [obs()],
    postVolume: 140, commentVolume: 900, engagementTotal: 4200, uniqueAuthors: 88, classifierConfidence: 0.62,
  });
  assert.equal(factValue(supplied.volume.posts), 140);
  assert.equal(factValue(supplied.classifierConfidence), 0.62);
});

test("unusable observations are dropped without shifting anything else", () => {
  const ev = makeCrowdEvidence({
    assetId: "TSLA", provider: "test-crowd",
    observations: [obs({ id: "1" }), null, makeCrowdObservation({ sourceName: null, publishedAt: AT }), obs({ id: "2" })],
  });
  assert.equal(ev.observationCount, 2);
  assert.deepEqual(ev.observations.map(o => o.id), ["1", "2"]);
});

test("the whole structure is deeply immutable", () => {
  const ev = makeCrowdEvidence({ assetId: "TSLA", provider: "test-crowd", observations: [obs()] });
  assert.throws(() => { ev.assetId = "AAPL"; }, TypeError);
  assert.throws(() => { ev.stanceCounts.bullish = 99; }, TypeError);
  assert.throws(() => { ev.observations.push(obs()); }, TypeError);
  assert.throws(() => { ev.source.provider = "other"; }, TypeError);
});

/* ---------------- availability ---------------- */

test("a provider that answered with no activity is NO_RECENT_ACTIVITY, not a failure", () => {
  const ev = makeCrowdEvidence({ assetId: "TSLA", provider: "test-crowd", observations: [] });
  assert.equal(ev.availability, CrowdAvailability.NO_RECENT_ACTIVITY);
  assert.notEqual(ev.availability, CrowdAvailability.PROVIDER_UNAVAILABLE);
  assert.equal(ev.observationCount, 0);
});

test("an outage is PROVIDER_UNAVAILABLE with every measure explicitly missing", () => {
  const ev = makeUnavailableCrowdEvidence({
    assetId: "TSLA", provider: "test-crowd", errorCode: "RATE_LIMITED", message: "quota",
  });
  assert.equal(ev.availability, CrowdAvailability.PROVIDER_UNAVAILABLE);
  assert.notEqual(ev.availability, CrowdAvailability.NO_RECENT_ACTIVITY,
    "an outage must never be reportable as a quiet crowd");
  assert.equal(ev.errorCode, "RATE_LIMITED");
  assert.equal(ev.engagementTotal.reason, MissingReason.CATEGORY_UNAVAILABLE);
  assert.equal(isPresent(ev.volume.posts), false);
});

test("hasDirectCrowdEvidence() gates directional claims on genuinely observed activity", () => {
  assert.equal(hasDirectCrowdEvidence(makeCrowdEvidence({
    assetId: "TSLA", provider: "test-crowd", observations: [obs()] })), true);
  assert.equal(hasDirectCrowdEvidence(makeCrowdEvidence({
    assetId: "TSLA", provider: "test-crowd", observations: [] })), false,
    "a quiet crowd is a finding, but it is not directional evidence");
  assert.equal(hasDirectCrowdEvidence(makeUnavailableCrowdEvidence({
    assetId: "TSLA", provider: "test-crowd", errorCode: "PROVIDER_UNAVAILABLE" })), false);
  assert.equal(hasDirectCrowdEvidence(null), false);
});

/* ---------------- origin: crowd vs user claim ---------------- */

test("every crowd structure is stamped OBSERVED_CROWD and a caller cannot override it", () => {
  const o = makeCrowdObservation({
    sourceName: "forum-a", publishedAt: AT, origin: EvidenceOrigin.USER_SUPPLIED_CLAIM,
  });
  assert.equal(o.origin, EvidenceOrigin.OBSERVED_CROWD,
    "a pasted tip must never be able to enter a crowd measurement");

  const ev = makeCrowdEvidence({
    assetId: "TSLA", provider: "test-crowd", observations: [obs()],
    origin: EvidenceOrigin.USER_SUPPLIED_CLAIM,
  });
  assert.equal(ev.origin, EvidenceOrigin.OBSERVED_CROWD);
  assert.equal(makeUnavailableCrowdEvidence({
    assetId: "TSLA", provider: "p", errorCode: "X", origin: EvidenceOrigin.USER_SUPPLIED_CLAIM,
  }).origin, EvidenceOrigin.OBSERVED_CROWD);
});

test("no constructor in the crowd schema can produce USER_SUPPLIED_CLAIM evidence", () => {
  // The value exists so the distinction is expressible and testable, but
  // Tips will need their own schema when that feature arrives.
  const built = [
    makeCrowdEvidence({ assetId: "T", provider: "p", observations: [obs()] }),
    makeCrowdEvidence({ assetId: "T", provider: "p", observations: [] }),
    makeUnavailableCrowdEvidence({ assetId: "T", provider: "p", errorCode: "X" }),
  ];
  for (const b of built) assert.notEqual(b.origin, EvidenceOrigin.USER_SUPPLIED_CLAIM);
});

/* ---------------- asset type ---------------- */

test("assetType defaults to EQUITY and accepts CRYPTO without any other change", () => {
  assert.equal(makeCrowdEvidence({ assetId: "TSLA", provider: "p", observations: [] }).assetType, AssetType.EQUITY);
  const crypto = makeCrowdEvidence({ assetId: "BTC", assetType: AssetType.CRYPTO, provider: "p", observations: [obs()] });
  assert.equal(crypto.assetType, AssetType.CRYPTO);
  assert.equal(crypto.assetId, "BTC");
  assert.equal(crypto.availability, CrowdAvailability.PRESENT);
});

test("an unknown assetType is rejected loudly rather than silently defaulted", () => {
  assert.throws(() => makeCrowdEvidence({ assetId: "X", assetType: "COMMODITY", provider: "p" }),
    /unknown assetType/);
});

/* ---------------- validation ---------------- */

test("required identity fields are enforced", () => {
  assert.throws(() => makeCrowdEvidence({ provider: "p" }), /requires an assetId/);
  assert.throws(() => makeCrowdEvidence({ assetId: "  ", provider: "p" }), /requires an assetId/);
  assert.throws(() => makeCrowdEvidence({ assetId: "TSLA" }), /requires a provider identity/);
  assert.throws(() => makeUnavailableCrowdEvidence({ provider: "p", errorCode: "X" }), /requires an assetId/);
});

/* ---------------- provider contract ---------------- */

test("the abstract CrowdProvider refuses to be used directly", async () => {
  const p = new CrowdProvider();
  await assert.rejects(() => p.getCrowdEvidence("TSLA"), /must be implemented/);
});

test("providerId falls back to the class name so provenance is never blank", () => {
  class TestCrowdProvider extends CrowdProvider {}
  assert.equal(new TestCrowdProvider().providerId, "TestCrowdProvider");
});

test("a subclass satisfying the contract returns normalised evidence", async () => {
  class StubProvider extends CrowdProvider {
    get providerId() { return "stub-crowd"; }
    async getCrowdEvidence(assetId, { assetType = AssetType.EQUITY } = {}) {
      return makeCrowdEvidence({ assetId, assetType, provider: this.providerId, observations: [obs()] });
    }
  }
  const ev = await new StubProvider().getCrowdEvidence("TSLA");
  assert.equal(ev.source.provider, "stub-crowd");
  assert.equal(ev.availability, CrowdAvailability.PRESENT);
  assert.equal(ev.origin, EvidenceOrigin.OBSERVED_CROWD);
});

test("crowdEvidenceFromError maps failures without ever implying a quiet crowd", () => {
  const unavailable = crowdEvidenceFromError("TSLA",
    new CrowdError("down", CrowdErrorCodes.PROVIDER_UNAVAILABLE), { provider: "stub" });
  assert.equal(unavailable.availability, CrowdAvailability.PROVIDER_UNAVAILABLE);
  assert.equal(unavailable.errorCode, "PROVIDER_UNAVAILABLE");

  const malformed = crowdEvidenceFromError("TSLA",
    new CrowdError("bad", CrowdErrorCodes.MALFORMED_RESPONSE), { provider: "stub" });
  assert.equal(malformed.availability, CrowdAvailability.MALFORMED);

  for (const ev of [unavailable, malformed]) {
    assert.notEqual(ev.availability, CrowdAvailability.NO_RECENT_ACTIVITY);
    assert.equal(hasDirectCrowdEvidence(ev), false);
  }
});

test("the crowd error taxonomy is the project's existing one, not a third vocabulary", () => {
  for (const code of ["NOT_FOUND", "RATE_LIMITED", "PROVIDER_UNAVAILABLE", "UNAUTHORISED", "MALFORMED_RESPONSE", "SERVER_MISCONFIGURED"]) {
    assert.equal(CrowdErrorCodes[code], code);
  }
});

/* ---------------- inertness ---------------- */

test("this layer produces no direction, sentiment, confidence or score", () => {
  const ev = makeCrowdEvidence({
    assetId: "TSLA", provider: "test-crowd",
    observations: [obs({ stance: CrowdStance.BULLISH }), obs({ id: "2", stance: CrowdStance.BULLISH })],
  });
  const serialised = JSON.stringify(ev).toLowerCase();
  for (const banned of ["direction", "\"confidence\"", "sentimentscore", "verdict", "lean", "attentionlabel"]) {
    assert.ok(!serialised.includes(banned), `${banned} must not be produced by the schema layer`);
  }
  // Two bullish observations are COUNTED, never interpreted.
  assert.equal(ev.stanceCounts.bullish, 2);
});
