import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyConquestRelevance, partitionByRelevance, assetNameToken,
  ConquestRelevance, MIN_NAME_TOKEN_LENGTH, MANY_RELATED_ASSETS,
} from "../src/conquest/relevance.js";

/**
 * Conquest relevance. Pure functions, no network, no provider.
 * The central regression is the live Production failure: a Lululemon
 * guidance-cut headline returned by a TSLA search made Conquest BEARISH.
 */

const TSLA = { assetId: "TSLA", companyName: "Tesla, Inc." };
const tierOf = (headline, relatedTickers, target = TSLA, extra = {}) =>
  classifyConquestRelevance({ headline, relatedTickers, ...extra }, target).relevance;

/* ---------------- TARGET_SPECIFIC ---------------- */

test("a Tesla-specific headline with corroborating metadata is TARGET_SPECIFIC", () => {
  assert.equal(tierOf("Tesla's Cybercab Just Moved From Demo to Public Rides", ["TSLA"]),
    ConquestRelevance.TARGET_SPECIFIC);
});

test("the target identifier in the text alone is TARGET_SPECIFIC", () => {
  assert.equal(tierOf("TSLA Stock Slides 6% After Cybercab Launch", []),
    ConquestRelevance.TARGET_SPECIFIC, "the ticker is unambiguous identification");
  assert.equal(tierOf("TSLA Stock Slides 6% After Cybercab Launch", null),
    ConquestRelevance.TARGET_SPECIFIC, "and works with no metadata at all");
});

test("a provider declaring the target the principal subject is TARGET_SPECIFIC", () => {
  // e.g. a forum thread bound to one asset, where the title need not name it.
  assert.equal(tierOf("Anyone else holding through earnings?", null, TSLA, { isPrincipalSubject: true }),
    ConquestRelevance.TARGET_SPECIFIC);
});

test("possessives, case and punctuation do not break target matching", () => {
  for (const h of ["Tesla's robotaxi expands", "TESLA expands robotaxi", "tesla expands robotaxi",
                   "(Tesla) expands robotaxi", "Tesla — robotaxi expands"]) {
    assert.equal(tierOf(h, ["TSLA"]), ConquestRelevance.TARGET_SPECIFIC, h);
  }
  assert.equal(tierOf("tsla slides 6%", []), ConquestRelevance.TARGET_SPECIFIC, "lower-case ticker");
});

/* ---------------- IRRELEVANT: the contamination ---------------- */

test("REGRESSION: a Lululemon guidance-cut headline from a TSLA search can never be TARGET_SPECIFIC", () => {
  // This exact item drove the live Production CONQUEST: BEARISH 84.
  const headline = "Top Midday Stories: Stocks Fall After Stronger-Than-Expected August Jobs Report; Lululemon Q2 Revenue Miss, Guidance Cut";

  // No Tesla connection at all -> contributes nothing.
  assert.equal(tierOf(headline, ["LULU"]), ConquestRelevance.IRRELEVANT);
  // Even when the provider associates it with TSLA, it is a digest and so
  // can only ever be CONTEXTUAL — attention, never sentiment.
  assert.equal(tierOf(headline, ["LULU", "TSLA", "SPY"]), ConquestRelevance.CONTEXTUAL);
  // And under no metadata combination does it become TARGET_SPECIFIC.
  for (const rt of [null, [], ["TSLA"], ["LULU"], ["LULU", "TSLA"]]) {
    assert.notEqual(tierOf(headline, rt), ConquestRelevance.TARGET_SPECIFIC,
      `strongly negative wording must not buy target-specific status (relatedTickers=${JSON.stringify(rt)})`);
  }
});

test("a Lululemon-only result from a TSLA search is IRRELEVANT", () => {
  assert.equal(tierOf("Lululemon Falls on China Business", ["LULU"]), ConquestRelevance.IRRELEVANT);
});

test("a Volkswagen-only story from a TSLA search is IRRELEVANT", () => {
  assert.equal(tierOf("Volkswagen cuts EV production targets for 2027", ["VOW3.DE"]),
    ConquestRelevance.IRRELEVANT);
  assert.equal(tierOf("Volkswagen cuts EV production targets for 2027", null),
    ConquestRelevance.IRRELEVANT, "still irrelevant with no metadata");
});

test("a digest in which the target does not appear is IRRELEVANT", () => {
  assert.equal(tierOf("Stocks Fall; Snowflake, Dell, Lululemon In Focus: Weekly Review", ["SNOW", "DELL", "LULU"]),
    ConquestRelevance.IRRELEVANT);
});

/* ---------------- CONTEXTUAL ---------------- */

test("a Magnificent Seven article including the target is CONTEXTUAL, not target-specific", () => {
  assert.equal(tierOf("Magnificent Seven stocks lead the rally", ["AAPL", "MSFT", "TSLA", "NVDA", "META"]),
    ConquestRelevance.CONTEXTUAL, "evidence of attention, but its sentiment belongs to the basket");
});

test("a market wrap genuinely naming the target is CONTEXTUAL", () => {
  assert.equal(tierOf("Stocks Fall, Rebound Bullishly; Snowflake, Dell, Tesla, Jobs Report In Focus: Weekly Review",
    ["SNOW", "DELL", "TSLA", "SPY"]), ConquestRelevance.CONTEXTUAL);
  assert.equal(tierOf("Lululemon Falls on China Business; Tesla Cybercab Service | Stock Movers", ["LULU", "TSLA"]),
    ConquestRelevance.CONTEXTUAL);
});

test("a long related-asset list is itself a basket signal", () => {
  const many = ["AAPL", "MSFT", "TSLA", "NVDA"];
  assert.equal(many.length >= MANY_RELATED_ASSETS, true);
  assert.equal(tierOf("Tesla leads the group higher", many), ConquestRelevance.CONTEXTUAL,
    "named clearly, but the item covers a basket");
});

test("target present only in metadata, unnamed in the text, is CONTEXTUAL", () => {
  assert.equal(tierOf("Jobs report sends indexes lower", ["TSLA"]), ConquestRelevance.CONTEXTUAL);
});

/* ---------------- missing metadata ---------------- */

test("missing related-asset metadata means UNKNOWN, never automatic exclusion", () => {
  const r = classifyConquestRelevance({ headline: "Tesla raises production target", relatedTickers: null }, TSLA);
  assert.equal(r.signals.relatedAssetsKnown, false);
  assert.equal(r.relevance, ConquestRelevance.CONTEXTUAL,
    "an uncorroborated name match is demoted, not discarded");
  assert.ok(r.reasons.some(x => /unknown, not unrelated/.test(x)));

  // An empty array is equally "unknown".
  assert.equal(classifyConquestRelevance({ headline: "Tesla raises production target", relatedTickers: [] }, TSLA)
    .signals.relatedAssetsKnown, false);
});

test("missing metadata still cannot promote an unrelated item", () => {
  assert.equal(tierOf("Lululemon cuts guidance", null), ConquestRelevance.IRRELEVANT);
});

/* ---------------- ambiguous / short names ---------------- */

test("short name tokens are not used for matching at all", () => {
  assert.equal(assetNameToken("BP plc"), null);
  assert.equal(assetNameToken("Gap Inc."), null);
  assert.equal("Gap".length < MIN_NAME_TOKEN_LENGTH, true);
  // A company identified only by a short name must rely on its ticker.
  const bp = { assetId: "BP", companyName: "BP plc" };
  assert.equal(classifyConquestRelevance({ headline: "Mind the gap in the market", relatedTickers: null }, bp).relevance,
    ConquestRelevance.IRRELEVANT, "a short token must not create a false match");
});

test("ordinary-word company names cannot reach TARGET_SPECIFIC uncorroborated", () => {
  const apple = { assetId: "AAPL", companyName: "Apple Inc." };
  assert.equal(classifyConquestRelevance({ headline: "Apple pie sales rise at the county fair", relatedTickers: null }, apple).relevance,
    ConquestRelevance.CONTEXTUAL, "no lexicon exists, so an uncorroborated common word is demoted");
  // Corroborated, it is target-specific.
  assert.equal(classifyConquestRelevance({ headline: "Apple unveils new chip", relatedTickers: ["AAPL"] }, apple).relevance,
    ConquestRelevance.TARGET_SPECIFIC);
  // The ticker is always unambiguous.
  assert.equal(classifyConquestRelevance({ headline: "AAPL unveils new chip", relatedTickers: null }, apple).relevance,
    ConquestRelevance.TARGET_SPECIFIC);
});

test("assetNameToken strips legal suffixes", () => {
  assert.equal(assetNameToken("Tesla, Inc."), "Tesla");
  assert.equal(assetNameToken("Lululemon Athletica Inc."), "Lululemon");
  assert.equal(assetNameToken(null), null);
  assert.equal(assetNameToken(""), null);
});

test("a substring of a longer word is not a match", () => {
  assert.equal(tierOf("Teslaphile forums are busy today", null), ConquestRelevance.IRRELEVANT,
    "word-bounded matching only");
});

/* ---------------- asset/provider neutrality ---------------- */

test("the module is asset-type neutral and works for a crypto asset", () => {
  const btc = { assetId: "BTC", companyName: "Bitcoin" };
  assert.equal(classifyConquestRelevance({ headline: "BTC breaks above resistance", relatedTickers: null }, btc).relevance,
    ConquestRelevance.TARGET_SPECIFIC);
  assert.equal(classifyConquestRelevance({ headline: "Crypto majors rally; BTC, ETH, SOL lead", relatedAssets: ["BTC", "ETH", "SOL"] }, btc).relevance,
    ConquestRelevance.CONTEXTUAL);
});

test("the module is provider-neutral about field naming", () => {
  // News items use `headline`; forum observations may use `title` or `text`.
  for (const key of ["headline", "title", "text"]) {
    assert.equal(classifyConquestRelevance({ [key]: "TSLA slides 6%" }, TSLA).relevance,
      ConquestRelevance.TARGET_SPECIFIC, `should read ${key}`);
  }
  assert.equal(classifyConquestRelevance({ headline: "Tesla news", relatedAssets: ["TSLA"] }, TSLA).relevance,
    ConquestRelevance.TARGET_SPECIFIC, "relatedAssets is accepted alongside relatedTickers");
});

/* ---------------- output discipline ---------------- */

test("no directional, sentiment or confidence field is emitted", () => {
  const r = classifyConquestRelevance({ headline: "Tesla crashes 20% on disastrous results", relatedTickers: ["TSLA"] }, TSLA);
  const serialised = JSON.stringify(r).toLowerCase();
  for (const banned of ["bullish", "bearish", "direction", "sentiment", "confidence", "score", "verdict", "weight"]) {
    assert.ok(!serialised.includes(banned), `${banned} must not be emitted by the relevance layer`);
  }
  assert.deepEqual(Object.keys(r).sort(), ["reasons", "relevance", "signals"]);
});

test("the structured signals explain the decision", () => {
  const r = classifyConquestRelevance(
    { headline: "Stocks Fall; Snowflake, Dell, Tesla In Focus", relatedTickers: ["SNOW", "DELL", "TSLA"] }, TSLA);
  assert.equal(r.signals.nameMatched, true);
  assert.equal(r.signals.relatedAssetMatched, true);
  assert.equal(r.signals.digestDetected, true);
  assert.equal(r.signals.tickerMatched, false);
  assert.equal(r.signals.nameTokenUsed, "Tesla");
  assert.ok(r.reasons.length > 0);
});

test("results are deeply immutable", () => {
  const r = classifyConquestRelevance({ headline: "Tesla news", relatedTickers: ["TSLA"] }, TSLA);
  assert.throws(() => { r.relevance = ConquestRelevance.IRRELEVANT; }, TypeError);
  assert.throws(() => { r.signals.tickerMatched = true; }, TypeError);
  assert.throws(() => { r.reasons.push("x"); }, TypeError);
});

test("classification is deterministic", () => {
  const item = { headline: "Tesla's Cybercab Just Moved From Demo to Public Rides", relatedTickers: ["TSLA"] };
  assert.deepEqual(classifyConquestRelevance(item, TSLA), classifyConquestRelevance(item, TSLA));
});

/* ---------------- partitioning ---------------- */

test("partitionByRelevance separates the live TSLA result set correctly", () => {
  const LIVE = [
    { headline: "What Are You Actually Buying In Aurora Innovation Stock?", relatedTickers: ["AUR"] },
    { headline: "Top Midday Stories: Stocks Fall After Stronger-Than-Expected August Jobs Report; Lululemon Q2 Revenue Miss, Guidance Cut", relatedTickers: ["LULU", "TSLA", "SPY"] },
    { headline: "Lululemon Falls on China Business; Tesla Cybercab Service | Stock Movers", relatedTickers: ["LULU", "TSLA"] },
    { headline: "Stocks Fall, Rebound Bullishly; Snowflake, Dell, Tesla, Jobs Report In Focus: Weekly Review", relatedTickers: ["SNOW", "DELL", "TSLA", "SPY"] },
    { headline: "Tesla's Cybercab Just Moved From Demo to Public Rides", relatedTickers: ["TSLA"] },
    { headline: "You Can Take a Tesla Cybercab Later Today. The Stock Isn't Feeling Any Excitement.", relatedTickers: ["TSLA"] },
  ];
  const p = partitionByRelevance(LIVE, TSLA);

  assert.equal(p.targetSpecific.length, 2, "only the two genuine Tesla stories");
  assert.equal(p.contextual.length, 3);
  assert.equal(p.irrelevant.length, 1);
  for (const s of p.targetSpecific) assert.match(s.item.headline, /Tesla/);
  // The contaminating Lululemon items are nowhere near sentiment-eligible.
  const sentimentEligible = JSON.stringify(p.targetSpecific);
  assert.ok(!sentimentEligible.includes("Lululemon"));
  assert.ok(!sentimentEligible.includes("Aurora"));
});

test("partitionByRelevance tolerates empty and malformed input", () => {
  assert.equal(partitionByRelevance([], TSLA).all.length, 0);
  assert.equal(partitionByRelevance(null, TSLA).all.length, 0);
  assert.equal(partitionByRelevance([null, undefined], TSLA).all.length, 0);
  assert.equal(partitionByRelevance([{}], TSLA).irrelevant.length, 1, "an item with no text is irrelevant, not a crash");
});

test("partition results carry no weighting — that is a later decision", () => {
  const p = partitionByRelevance([{ headline: "Tesla news", relatedTickers: ["TSLA"] }], TSLA);
  assert.ok(!("weight" in p.targetSpecific[0]));
  assert.deepEqual(Object.keys(p.targetSpecific[0]).sort(), ["item", "reasons", "relevance", "signals"]);
});
