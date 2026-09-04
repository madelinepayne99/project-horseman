import { test } from "node:test";
import assert from "node:assert/strict";
import { YahooNewsProvider, NewsError, NewsErrorCodes, newsFromError } from "../src/providers/YahooNewsProvider.js";
import { NewsAvailability } from "../src/schema/news.js";
import {
  classifyNewsItem, classifyCategory, classifyEvidenceType, assessDirectionalImpact,
  EventCategory, EvidenceType, Materiality, DirectionalImpact,
} from "../src/famine/eventClassification.js";
import { assessNewsEvidence, headlineSimilarity, NewsFreshness } from "../src/famine/newsEvidence.js";
import { buildFamineInput, FamineDataStatus } from "../src/famine/buildFamineInput.js";
import { famineAnalysis, FamineDirection } from "../src/famine/famineAnalysis.js";
import {
  NOW, fundamentals, earnings, unavailableFundamentals, unavailableEarnings,
  newsItem, news, quietNews, unavailableNews, ordinaryNews,
} from "./fixtures/famineFixtures.js";

/**
 * All fixtures are constructed directly. NO live provider request is made
 * anywhere in this file and no provider quota is consumed.
 */
const assess = (f, e, n, now = NOW) =>
  famineAnalysis(buildFamineInput({ ticker: "AAPL", fundamentals: f, earnings: e, news: n, now }));

/* ---------------- provider normalisation ---------------- */

function withMockFetch(factory, fn) {
  const original = global.fetch;
  global.fetch = async (...a) => factory(...a);
  return fn().finally(() => { global.fetch = original; });
}
const resp = ({ status = 200, jsonBody, textBody } = {}) => ({
  status, ok: status >= 200 && status < 300,
  text: async () => textBody !== undefined ? textBody : JSON.stringify(jsonBody),
});
const newsProvider = () => new YahooNewsProvider({ baseUrl: "https://example.invalid" });

test("Yahoo news normalises into the provider-neutral contract", async () => {
  const body = { news: [{
    uuid: "abc-123", title: "Apple announces $20bn buyback", publisher: "Reuters",
    link: "https://finance.yahoo.com/news/x", providerPublishTime: Math.floor(NOW.getTime() / 1000) - 3600,
    type: "STORY", relatedTickers: ["AAPL"],
    thumbnail: { resolutions: [{ url: "https://img", width: 400, height: 400 }] },
  }] };
  await withMockFetch(() => resp({ jsonBody: body }), async () => {
    const ev = await newsProvider().getCompanyNews("AAPL");
    assert.equal(ev.availability, NewsAvailability.PRESENT);
    const item = ev.items[0];
    assert.equal(item.id, "abc-123");
    assert.equal(item.headline, "Apple announces $20bn buyback");
    assert.equal(item.publisher, "Reuters");
    assert.ok(item.publishedAt.endsWith("Z"), "unix seconds become an ISO timestamp");
    assert.deepEqual(item.relatedTickers, ["AAPL"]);
    // Vendor field names must not survive.
    const s = JSON.stringify(ev);
    for (const v of ["uuid", "providerPublishTime", "link", "thumbnail"]) {
      assert.ok(!s.includes(v), `${v} leaked into the normalised contract`);
    }
  });
});

test("a successful search with no items is NO_RECENT_NEWS, not a failure", async () => {
  await withMockFetch(() => resp({ jsonBody: { news: [] } }), async () => {
    const ev = await newsProvider().getCompanyNews("QUIETCO");
    assert.equal(ev.availability, NewsAvailability.NO_RECENT_NEWS);
    assert.notEqual(ev.availability, NewsAvailability.PROVIDER_UNAVAILABLE);
  });
});

test("provider unavailable and malformed responses are distinguishable", async () => {
  const original = global.fetch;
  global.fetch = async () => { throw new Error("ENOTFOUND"); };
  try {
    await assert.rejects(() => newsProvider().getCompanyNews("AAPL"),
      e => e.code === NewsErrorCodes.PROVIDER_UNAVAILABLE);
  } finally { global.fetch = original; }

  await withMockFetch(() => resp({ jsonBody: { quotes: [] } }), async () => {
    await assert.rejects(() => newsProvider().getCompanyNews("AAPL"),
      e => e.code === NewsErrorCodes.MALFORMED_RESPONSE);
  });
  assert.equal(newsFromError("AAPL", new NewsError("x", NewsErrorCodes.MALFORMED_RESPONSE)).availability, NewsAvailability.MALFORMED);
});

/* ---------------- classification ---------------- */

test("classification does not determine direction", () => {
  const legal = classifyNewsItem(newsItem({ headline: "Apple files patent suit against rival" }));
  assert.equal(legal.category, EventCategory.LEGAL);
  assert.equal(legal.directionalImpact, DirectionalImpact.UNKNOWN, "LEGAL is not automatically bearish");

  const product = classifyNewsItem(newsItem({ headline: "Apple launches new iPad Air" }));
  assert.equal(product.category, EventCategory.PRODUCT);
  assert.equal(product.directionalImpact, DirectionalImpact.UNKNOWN, "PRODUCT is not automatically bullish");
});

test("generic positive or negative wording does not become a direction", () => {
  for (const h of [
    "Apple sees strong growth in services",
    "Apple shares rally on record quarter",
    "Apple hit by lawsuit and regulatory probe",
    "Apple faces weak demand and falling sales",
  ]) {
    const c = classifyNewsItem(newsItem({ headline: h }));
    assert.equal(c.directionalImpact, DirectionalImpact.UNKNOWN,
      `"${h}" must not produce a direction from wording alone`);
  }
});

test("opinion is never promoted to FACT, however reputable the publisher", () => {
  const c = classifyNewsItem(newsItem({ headline: "Why Apple is a buy at these levels", publisher: "Reuters" }));
  assert.equal(c.evidenceType, EvidenceType.OPINION);
  assert.equal(c.materiality, Materiality.LOW);
  assert.equal(c.directionalImpact, DirectionalImpact.UNKNOWN);
});

test("rumour is not treated as confirmed and carries uncertain materiality", () => {
  const c = classifyNewsItem(newsItem({ headline: "Apple reportedly in talks to acquire an AI startup" }));
  assert.equal(c.evidenceType, EvidenceType.RUMOUR);
  assert.equal(c.materiality, Materiality.UNCERTAIN, "a big rumour is not yet a material fact");
  assert.equal(c.directionalImpact, DirectionalImpact.UNKNOWN);
});

test("an unclassifiable headline keeps an explicit unknown state", () => {
  const c = classifyNewsItem(newsItem({ headline: "Apple and the city" }));
  assert.equal(c.evidenceType, EvidenceType.UNCLASSIFIED);
  assert.equal(c.category, EventCategory.OTHER);
  assert.equal(c.materiality, Materiality.UNCERTAIN, "unknown is not quietly downgraded to LOW");
});

test("forecasts are separated from reported events", () => {
  assert.equal(classifyEvidenceType("Analysts expect Apple to reach $5tn"), EvidenceType.OPINION);
  assert.equal(classifyEvidenceType("Apple forecasts stronger December quarter"), EvidenceType.FORECAST);
  assert.equal(classifyEvidenceType("Apple announces quarterly dividend"), EvidenceType.REPORTED_EVENT);
});

/* ---------------- the narrow directional rules ---------------- */

test("explicitly raised guidance produces POSITIVE impact", () => {
  const c = classifyNewsItem(newsItem({ headline: "Apple raises full-year guidance" }));
  assert.equal(c.directionalImpact, DirectionalImpact.POSITIVE);
  assert.equal(c.directionalRule, "GUIDANCE_RAISED");
  assert.equal(c.category, EventCategory.GUIDANCE);
  assert.equal(c.materiality, Materiality.HIGH);
});

test("explicitly lowered guidance produces NEGATIVE impact", () => {
  const c = classifyNewsItem(newsItem({ headline: "Apple cuts full-year outlook" }));
  assert.equal(c.directionalImpact, DirectionalImpact.NEGATIVE);
  assert.equal(c.directionalRule, "GUIDANCE_LOWERED");
});

test("earnings beat and miss are handled conservatively and only when explicit", () => {
  assert.equal(classifyNewsItem(newsItem({ headline: "Apple beats revenue estimates" })).directionalImpact, DirectionalImpact.POSITIVE);
  assert.equal(classifyNewsItem(newsItem({ headline: "Apple misses profit expectations" })).directionalImpact, DirectionalImpact.NEGATIVE);
  // "beat" without a stated benchmark is not an explicit beat.
  assert.equal(classifyNewsItem(newsItem({ headline: "Apple set to beat the market this year" })).directionalImpact, DirectionalImpact.UNKNOWN);
});

test("dividend and buyback announcements are positive; cuts are negative", () => {
  assert.equal(classifyNewsItem(newsItem({ headline: "Apple announces $20bn buyback" })).directionalImpact, DirectionalImpact.POSITIVE);
  assert.equal(classifyNewsItem(newsItem({ headline: "Apple suspends its dividend" })).directionalImpact, DirectionalImpact.NEGATIVE);
});

test("an ambiguous headline matching several rules yields UNKNOWN, not a guess", () => {
  const { impact, rule } = assessDirectionalImpact(
    "Apple beats estimates but cuts guidance", EvidenceType.REPORTED_EVENT);
  assert.equal(impact, DirectionalImpact.UNKNOWN);
  assert.equal(rule, "AMBIGUOUS_MULTIPLE_RULES");
});

/* ---------------- grouping / corroboration ---------------- */

test("duplicate reports of one event are grouped into a single catalyst", () => {
  const ev = assessNewsEvidence(news([
    newsItem({ headline: "Apple raises full-year guidance", publisher: "Reuters", hoursAgo: 3 }),
    newsItem({ headline: "Apple raises full-year guidance for 2026", publisher: "Bloomberg", hoursAgo: 2 }),
    newsItem({ headline: "Apple raises its full-year guidance", publisher: "CNBC", hoursAgo: 1 }),
  ]), NOW, { companyName: "Apple Inc." });

  assert.equal(ev.eventGroups.length, 1, "three reports of one event are one event");
  const g = ev.eventGroups[0];
  assert.equal(g.reportCount, 3);
  assert.equal(g.distinctPublishers.length, 3);
  assert.equal(g.apparentCorroboration, true);
  assert.equal(ev.materialCatalysts.length, 1);
});

test("distinct events remain distinct", () => {
  const ev = assessNewsEvidence(news([
    newsItem({ headline: "Apple raises full-year guidance", hoursAgo: 3 }),
    newsItem({ headline: "Apple appoints new chief financial officer", hoursAgo: 4 }),
  ]), NOW, { companyName: "Apple Inc." });
  assert.equal(ev.eventGroups.length, 2);
});

test("repeated publishers cannot multiply directional weight", () => {
  const one = assess(fundamentals({ revenueGrowthYoY: "0.01", earningsGrowthYoY: "0.01" }), earnings({ surprises: [0.1, 0.2] }),
    news([newsItem({ headline: "Apple cuts full-year guidance", publisher: "Reuters", hoursAgo: 2 })]));
  const many = assess(fundamentals({ revenueGrowthYoY: "0.01", earningsGrowthYoY: "0.01" }), earnings({ surprises: [0.1, 0.2] }),
    news([
      newsItem({ headline: "Apple cuts full-year guidance", publisher: "Reuters", hoursAgo: 2 }),
      newsItem({ headline: "Apple cuts full-year guidance", publisher: "CNBC", hoursAgo: 2 }),
      newsItem({ headline: "Apple cuts its full-year guidance", publisher: "Bloomberg", hoursAgo: 2 }),
    ]));
  assert.equal(one.lean, many.lean, "the same event reported three times must not treble its weight");
  assert.equal(one.direction, many.direction);
});

test("headlineSimilarity is deterministic and conservative", () => {
  assert.ok(headlineSimilarity("Apple raises full-year guidance", "Apple raises its full-year guidance") >= 0.6);
  assert.ok(headlineSimilarity("Apple raises guidance", "Apple launches new iPad") < 0.6);
});

/* ---------------- freshness ---------------- */

test("news freshness bands are distinguished", () => {
  const ev = assessNewsEvidence(news([
    newsItem({ headline: "Apple announces quarterly dividend", hoursAgo: 2 }),
  ]), NOW, { companyName: "Apple Inc." });
  assert.equal(ev.eventGroups[0].freshness, NewsFreshness.BREAKING);

  const stale = assessNewsEvidence(news([
    newsItem({ headline: "Apple announces quarterly dividend", hoursAgo: 24 * 30 }),
  ]), NOW, { companyName: "Apple Inc." });
  assert.equal(stale.eventGroups[0].freshness, NewsFreshness.STALE);
});

test("a stale material event is not a current catalyst", () => {
  const fresh = assessNewsEvidence(news([newsItem({ headline: "Apple raises full-year guidance", hoursAgo: 2 })]), NOW, { companyName: "Apple Inc." });
  const old = assessNewsEvidence(news([newsItem({ headline: "Apple raises full-year guidance", hoursAgo: 24 * 30 })]), NOW, { companyName: "Apple Inc." });
  assert.equal(fresh.materialCatalysts.length, 1);
  assert.equal(old.materialCatalysts.length, 0, "month-old news is context, not a catalyst");
  assert.equal(old.eventGroups.length, 1, "but it is still preserved as an event");
});

/* ---------------- integration with Famine ---------------- */

test("missing news reduces completeness, not direction", () => {
  const withNews = assess(fundamentals(), earnings(), ordinaryNews());
  const withoutNews = assess(fundamentals(), earnings(), unavailableNews());
  assert.equal(withNews.lean, withoutNews.lean, "an unavailable provider must not move the lean");
  assert.equal(withNews.direction, withoutNews.direction);
  assert.ok(withoutNews.completeness.score < withNews.completeness.score);
  assert.ok(withoutNews.confidence < withNews.confidence);
  assert.ok(withoutNews.completeness.unavailableCategories.some(c => c.category === "companyNews"));
});

test("a successful quiet result differs from a provider failure", () => {
  const quiet = assess(fundamentals(), earnings(), quietNews());
  const failed = assess(fundamentals(), earnings(), unavailableNews());

  assert.equal(quiet.newsAvailability, NewsAvailability.NO_RECENT_NEWS);
  assert.equal(failed.newsAvailability, NewsAvailability.PROVIDER_UNAVAILABLE);
  // "We looked and it is quiet" counts as evidence obtained.
  assert.ok(quiet.completeness.score > failed.completeness.score);
  assert.ok(quiet.completeness.present.includes("companyNews"));
  assert.ok(quiet.uncertainties.some(u => u.includes("no current catalyst")));
});

test("strong fundamentals with a negative catalyst preserves the conflict", () => {
  const r = assess(
    fundamentals({ revenueGrowthYoY: "0.20", earningsGrowthYoY: "0.24" }),
    earnings({ surprises: [8, 7, 6, 5] }),
    news([newsItem({ headline: "Apple cuts full-year guidance", hoursAgo: 2, publisher: "Reuters" })])
  );
  assert.ok(r.disagreement.some(c => c.type === "STRONG_FUNDAMENTALS_NEGATIVE_CATALYST"),
    "the conflict must be visible, not averaged away");
  assert.equal(r.materialCatalysts.length, 1);
  assert.ok(r.strongestOpposing.length >= 1, "the catalyst appears as opposing evidence");
});

test("weak fundamentals with a positive catalyst preserves the conflict", () => {
  const r = assess(
    fundamentals({ revenueGrowthYoY: "-0.15", earningsGrowthYoY: "-0.20" }),
    earnings({ surprises: [-8, -7, -6, -5] }),
    news([newsItem({ headline: "Apple announces $20bn buyback", hoursAgo: 2 })])
  );
  assert.ok(r.disagreement.some(c => c.type === "WEAK_FUNDAMENTALS_POSITIVE_CATALYST"));
  assert.equal(r.direction, FamineDirection.BEARISH, "one catalyst does not overturn the fundamentals");
});

test("ordinary coverage produces no catalyst signal at all", () => {
  const r = assess(fundamentals(), earnings(), ordinaryNews());
  assert.ok(!r.signals.some(s => s.key === "currentCatalysts"),
    "generic company coverage must not become a directional signal");
  assert.equal(r.materialCatalysts.length, 0);
});

test("events with unknown impact are surfaced rather than hidden", () => {
  const r = assess(fundamentals(), earnings(), news([
    newsItem({ headline: "Apple files patent suit against rival", hoursAgo: 3 }),
    newsItem({ headline: "Apple launches new iPad Air", hoursAgo: 6 }),
  ]));
  assert.ok(r.unknownImpactEvents.length >= 2);
  assert.ok(r.uncertainties.some(u => u.includes("could not be assigned a directional impact")));
});

test("news limitations are always declared", () => {
  const r = assess(fundamentals(), earnings(), ordinaryNews());
  assert.ok(r.limitations.some(l => /headlines and publication metadata only/i.test(l)));
  assert.ok(r.limitations.some(l => /macroeconomic/i.test(l)), "macro is still declared unchecked");
});

test("no technical or crowd fields leak in via news", () => {
  const r = assess(fundamentals(), earnings(), ordinaryNews());
  const s = JSON.stringify(r).toLowerCase();
  for (const banned of ["rsi", "ma20", "ma200", "resistance", "volatility", "crowding", "attention", "sentiment", "tone"]) {
    assert.ok(!s.includes(banned), `${banned} must not appear in a Famine assessment`);
  }
});

test("identical input produces identical output, news included", () => {
  const strip = o => JSON.stringify({ ...o, source: null });
  const a = assess(fundamentals(), earnings(), ordinaryNews());
  const b = assess(fundamentals(), earnings(), ordinaryNews());
  assert.equal(strip(a), strip(b));
});

test("news cannot rescue a total fundamentals outage from UNKNOWN", () => {
  const r = assess(unavailableFundamentals(), unavailableEarnings(),
    news([newsItem({ headline: "Apple raises full-year guidance", hoursAgo: 1 })]));
  assert.equal(r.direction, FamineDirection.UNKNOWN,
    "a single catalyst is not a substitute for knowing the company's financial direction");
  assert.equal(r.confidence, null);
});

// ---------------------------------------------------------------------
// LIVE-EVIDENCE FIX 1 — Tier 1 category recognition and Tier 2 reported-
// event breadth. Neither may create a directional reading on its own.
// ---------------------------------------------------------------------

const categoryOf = h => classifyNewsItem(newsItem({ headline: h })).category;
const typeOf = h => classifyNewsItem(newsItem({ headline: h })).evidenceType;
const impactOf = h => classifyNewsItem(newsItem({ headline: h })).directionalImpact;

test("TIER 1: legal language including class action is recognised as LEGAL", () => {
  assert.equal(categoryOf("Tesla faces class action over Autopilot claims"), EventCategory.LEGAL);
  assert.equal(categoryOf("Investors file suit against the company"), EventCategory.LEGAL);
  assert.equal(categoryOf("Company sued by former supplier"), EventCategory.LEGAL);
  assert.equal(categoryOf("Former supplier begins legal action"), EventCategory.LEGAL);
  // Precedence note: REGULATORY is checked before LEGAL, so a headline naming
  // a regulator ("Regulators drop legal action") is categorised REGULATORY.
  // That is the more accurate reading, not a misroute.
  assert.equal(categoryOf("Regulators drop legal action"), EventCategory.REGULATORY);
});

test("TIER 1: spelled-out officer titles are recognised as MANAGEMENT", () => {
  assert.equal(categoryOf("Tesla names new chief financial officer"), EventCategory.MANAGEMENT);
  assert.equal(categoryOf("Company appoints chief operating officer"), EventCategory.MANAGEMENT);
  assert.equal(categoryOf("Board promotes head of engineering to president"), EventCategory.MANAGEMENT);
  assert.equal(categoryOf("CFO steps down after four years"), EventCategory.MANAGEMENT);
});

test("TIER 1: authority approvals, clearances and bans are recognised as REGULATORY", () => {
  assert.equal(categoryOf("Tesla wins approval to expand robotaxi service in Arizona"), EventCategory.REGULATORY);
  assert.equal(categoryOf("Company receives clearance for its new therapy"), EventCategory.REGULATORY);
  assert.equal(categoryOf("Regulator bans sale of the device in Germany"), EventCategory.REGULATORY);
  assert.equal(categoryOf("Agency denied approval for the application"), EventCategory.REGULATORY);
  assert.equal(categoryOf("Company issues recall order for 12,000 units"), EventCategory.REGULATORY);
});

test("TIER 1: a shareholder vote is NOT miscategorised as a regulatory decision", () => {
  // "approved" without a granting authority nearby must not become REGULATORY.
  assert.notEqual(categoryOf("Musk pay package approved by shareholders"), EventCategory.REGULATORY);
});

test("TIER 1: volume and throughput metrics are recognised as OPERATIONAL", () => {
  assert.equal(categoryOf("Tesla deliveries rise 7% to record 497,000 vehicles"), EventCategory.OPERATIONAL);
  assert.equal(categoryOf("Tesla shipments climb in Europe"), EventCategory.OPERATIONAL);
  assert.equal(categoryOf("Quarterly output falls at the Berlin factory"), EventCategory.OPERATIONAL);
  assert.equal(categoryOf("Units delivered hit a new high"), EventCategory.OPERATIONAL);
});

test("TIER 2: factual reporting constructions are recognised as REPORTED_EVENT", () => {
  const cases = [
    "Tesla deliveries rise 7% to record levels",
    "Quarterly output falls at the Berlin factory",
    "Shares jump after the announcement",
    "Margins drop at the main division",
    "Shipments climb in Europe",
    "Energy storage deployments hit a record",
    "Tesla wins approval to expand its service",
    "Tesla faces class action over Autopilot claims",
    "Company agrees to sell its logistics arm",
    "Tesla to acquire battery materials startup",
  ];
  for (const h of cases) {
    assert.equal(typeOf(h), EvidenceType.REPORTED_EVENT, `"${h}" should read as a reported event`);
  }
});

test("TIER 2: broadened reporting language never creates a direction by itself", () => {
  for (const h of [
    "Tesla deliveries rise 7% to record levels",
    "Shares jump after the announcement",
    "Margins drop at the main division",
    "Shipments climb in Europe",
    "Tesla wins approval to expand its service",
    "Tesla faces class action over Autopilot claims",
  ]) {
    assert.equal(impactOf(h), DirectionalImpact.UNKNOWN,
      `"${h}" must be recognised without inventing an investment implication`);
  }
});

test("evidence-type precedence survives the Tier 2 broadening", () => {
  assert.equal(typeOf("Tesla reportedly in talks to acquire a rival"), EvidenceType.RUMOUR);
  assert.equal(typeOf("Why Tesla stock is a buy right now"), EvidenceType.OPINION);
  assert.equal(typeOf("Analysts expect Tesla to hit $500"), EvidenceType.OPINION);
  assert.equal(typeOf("Tesla forecasts stronger December quarter"), EvidenceType.FORECAST);
  assert.equal(typeOf("Tesla set to win approval next month"), EvidenceType.FORECAST);
});

test("PRESERVE UNKNOWN: the deliberately ambiguous event set stays directionless", () => {
  const mustStayUnknown = [
    "Tesla names new chief financial officer",          // executive change
    "CFO steps down after four years",                   // executive change
    "Tesla to acquire battery materials startup",        // M&A as acquirer
    "Company agrees to buy a rival for $2bn",            // M&A as acquirer
    "Tesla to cut 10% of workforce in restructuring",    // layoffs
    "Tesla cuts Model Y prices in China",                // price cuts
    "Tesla deliveries rise 7% to record 497,000",        // deliveries, no benchmark
    "Quarterly output falls at the Berlin factory",      // output, no benchmark
    "Tesla unveils updated Model S",                     // generic product
    "Tesla launches new energy product",                 // generic product
    "Tesla stock rises 4% in early trading",             // generic price move
    "Shares fall 3% on the session",                     // generic price move
    "Tesla recalls 12,000 Cybertrucks over software fault", // Tier 3, not yet approved
    "Regulator bans sale of the device in Germany",      // Tier 3, not yet approved
  ];
  for (const h of mustStayUnknown) {
    assert.equal(impactOf(h), DirectionalImpact.UNKNOWN,
      `"${h}" must remain UNKNOWN — recognising an event is not knowing its implication`);
  }
});

test("the approved explicit directional rules still fire after the broadening", () => {
  assert.equal(impactOf("Tesla raises full-year guidance"), DirectionalImpact.POSITIVE);
  assert.equal(impactOf("Tesla cuts full-year outlook"), DirectionalImpact.NEGATIVE);
  assert.equal(impactOf("Tesla beats revenue estimates"), DirectionalImpact.POSITIVE);
  assert.equal(impactOf("Tesla misses profit expectations"), DirectionalImpact.NEGATIVE);
  assert.equal(impactOf("Tesla announces $20bn buyback"), DirectionalImpact.POSITIVE);
  assert.equal(impactOf("Tesla suspends its dividend"), DirectionalImpact.NEGATIVE);
});

test("no technical or Conquest evidence enters Famine after these changes", () => {
  const r = assess(fundamentals(), earnings(), news([
    newsItem({ headline: "Tesla deliveries rise 7% to record levels", hoursAgo: 2 }),
    newsItem({ headline: "Tesla names new chief financial officer", hoursAgo: 5 }),
  ]));
  const s = JSON.stringify(r).toLowerCase();
  for (const banned of ["rsi", "ma20", "ma200", "resistance", "volatility", "crowding", "attention", "sentiment", "tone"]) {
    assert.ok(!s.includes(banned), `${banned} must not appear in a Famine assessment`);
  }
});

// ---------------------------------------------------------------------
// NEWS RELEVANCE — whose story is this? Regression fixtures are the six
// real headlines returned by a live Production TSLA search.
// ---------------------------------------------------------------------

import { classifyRelevance, Relevance, companyNameToken } from "../src/famine/newsEvidence.js";
import { makeNewsItem, makeNewsEvidence } from "../src/schema/news.js";

const TSLA = { ticker: "TSLA", companyName: "Tesla, Inc." };
const tslaItem = (headline, relatedTickers = ["TSLA"], hoursAgo = 1) =>
  makeNewsItem({ id: headline.slice(0, 8), headline, publisher: "Wire", url: "https://example.com/x",
    publishedAt: Math.floor(NOW.getTime() / 1000) - hoursAgo * 3600, contentType: "STORY", relatedTickers });
const relevanceOf = (headline, relatedTickers) => classifyRelevance(tslaItem(headline, relatedTickers), TSLA).relevance;

const LIVE = [
  ["What Are You Actually Buying In Aurora Innovation Stock?", ["AUR"], Relevance.IRRELEVANT],
  ["Top Midday Stories: Stocks Fall After Stronger-Than-Expected August Jobs Report; Lululemon Q2 Revenue Miss, Guidance Cut", ["LULU", "TSLA", "SPY"], Relevance.CONTEXTUAL],
  ["Lululemon Falls on China Business; Tesla Cybercab Service | Stock Movers", ["LULU", "TSLA"], Relevance.CONTEXTUAL],
  ["Stocks Fall, Rebound Bullishly; Snowflake, Dell, Tesla, Jobs Report In Focus: Weekly Review", ["SNOW", "DELL", "TSLA", "SPY"], Relevance.CONTEXTUAL],
  ["Tesla's Cybercab Just Moved From Demo to Public Rides", ["TSLA"], Relevance.COMPANY_SPECIFIC],
  ["You Can Take a Tesla Cybercab Later Today. The Stock Isn't Feeling Any Excitement.", ["TSLA"], Relevance.COMPANY_SPECIFIC],
];

test("LIVE FIXTURE: all six real TSLA headlines get the expected relevance", () => {
  for (const [headline, rt, expected] of LIVE) {
    assert.equal(relevanceOf(headline, rt), expected, `"${headline.slice(0, 60)}…"`);
  }
});

test("LIVE FIXTURE: only the two genuine Tesla stories reach company-event reasoning", () => {
  const ev = assessNewsEvidence(
    makeNewsEvidence({ ticker: "TSLA", items: LIVE.map(([h, rt]) => tslaItem(h, rt)), provider: "yahoo-news" }),
    NOW, { companyName: "Tesla, Inc." });

  assert.equal(ev.providerItemCount, 6, "the provider returned six");
  assert.equal(ev.itemCount, 2, "two are about Tesla");
  assert.equal(ev.unknownImpactEvents.length, 2, "was 5 mixed stories before relevance filtering");
  assert.equal(ev.contextualEvents.length, 3);
  assert.equal(ev.irrelevantCount, 1);
  for (const g of ev.unknownImpactEvents) assert.match(g.representative.headline, /Tesla/);
});

test("a foreign company's event classification cannot reach target-company reasoning", () => {
  const ev = assessNewsEvidence(
    makeNewsEvidence({ ticker: "TSLA", items: LIVE.map(([h, rt]) => tslaItem(h, rt)), provider: "yahoo-news" }),
    NOW, { companyName: "Tesla, Inc." });

  // The digest carries LULULEMON's guidance cut, classified GUIDANCE/HIGH.
  const companyReasoning = JSON.stringify({
    groups: ev.eventGroups, catalysts: ev.materialCatalysts, unknown: ev.unknownImpactEvents,
  });
  assert.ok(!companyReasoning.includes("GUIDANCE"), "another company's guidance cut must not appear as Tesla evidence");
  assert.ok(!companyReasoning.includes("Lululemon"));

  // And contextual evidence is retained WITHOUT a consumable classification.
  const digest = ev.contextualEvents.find(c => /Lululemon/.test(c.headline));
  assert.ok(digest, "contextual evidence is preserved for future macro work");
  for (const k of ["category", "materiality", "directionalImpact", "classification"]) {
    assert.ok(!(k in digest), `${k} must not be carried on contextual evidence`);
  }
});

test("IRRELEVANT evidence is excluded from every company-event collection", () => {
  const ev = assessNewsEvidence(
    makeNewsEvidence({ ticker: "TSLA", provider: "yahoo-news", items: [
      tslaItem("What Are You Actually Buying In Aurora Innovation Stock?", ["AUR"]),
      tslaItem("Tesla raises full-year guidance", ["TSLA"]),
    ]}), NOW, { companyName: "Tesla, Inc." });

  const all = JSON.stringify({ g: ev.eventGroups, c: ev.materialCatalysts, u: ev.unknownImpactEvents, x: ev.contextualEvents });
  assert.ok(!all.includes("Aurora"), "irrelevant search noise must not appear anywhere");
  assert.equal(ev.irrelevantCount, 1);
  assert.equal(ev.materialCatalysts.length, 1, "the genuine Tesla catalyst still counts");
});

/* ---------------- signals ---------------- */

test("an absent relatedTickers array means NO SIGNAL, not 'unrelated'", () => {
  // Ticker in the headline identifies the company with no provider help.
  assert.equal(relevanceOf("TSLA raises full-year guidance", []), Relevance.COMPANY_SPECIFIC);
  // A bare name with no corroboration is treated conservatively, not dropped.
  assert.equal(relevanceOf("Tesla raises full-year guidance", []), Relevance.CONTEXTUAL);
  // Nothing at all connects this to the company.
  assert.equal(relevanceOf("Lululemon cuts guidance", []), Relevance.IRRELEVANT);
});

test("the target appearing in relatedTickers without being named is CONTEXTUAL, not company-specific", () => {
  assert.equal(relevanceOf("Jobs report sends stocks lower", ["TSLA"]), Relevance.CONTEXTUAL);
});

test("a multi-ticker digest is CONTEXTUAL even when the company is named", () => {
  assert.equal(relevanceOf("Tesla, Ford and GM all gain | Stock Movers", ["TSLA", "F", "GM"]), Relevance.CONTEXTUAL);
  assert.equal(relevanceOf("Tesla leads gainers", ["TSLA", "F", "GM", "RIVN"]), Relevance.CONTEXTUAL,
    "a long relatedTickers list is itself a roundup signal");
});

test("company name match plus relatedTickers corroboration is COMPANY_SPECIFIC", () => {
  assert.equal(relevanceOf("Tesla names new chief financial officer", ["TSLA"]), Relevance.COMPANY_SPECIFIC);
});

test("ambiguous common-word company names are handled conservatively without a blacklist", () => {
  const apple = { ticker: "AAPL", companyName: "Apple Inc." };
  const item = (h, rt) => makeNewsItem({ headline: h, publishedAt: Math.floor(NOW.getTime() / 1000), relatedTickers: rt });

  // A bare name match, uncorroborated, is NOT treated as a company story.
  assert.equal(classifyRelevance(item("Apple pie sales rise at the county fair", []), apple).relevance,
    Relevance.CONTEXTUAL, "an uncorroborated common-word match must not become company evidence");
  // Corroborated by the provider, it is.
  assert.equal(classifyRelevance(item("Apple announces $20bn buyback", ["AAPL"]), apple).relevance,
    Relevance.COMPANY_SPECIFIC);
  // The ticker itself is always unambiguous.
  assert.equal(classifyRelevance(item("AAPL announces $20bn buyback", []), apple).relevance,
    Relevance.COMPANY_SPECIFIC);
});

test("companyNameToken strips legal suffixes and rejects unusable names", () => {
  assert.equal(companyNameToken("Tesla, Inc."), "Tesla");
  assert.equal(companyNameToken("Lululemon Athletica Inc."), "Lululemon");
  assert.equal(companyNameToken(null), null);
  assert.equal(companyNameToken("BP plc"), null, "a two-letter name is too weak to match on");
});

/* ---------------- data quality ---------------- */

test("provider success with no company-specific survivors is NO_RECENT_NEWS, not a failure", () => {
  const ev = assessNewsEvidence(
    makeNewsEvidence({ ticker: "TSLA", provider: "yahoo-news", items: [
      tslaItem("What Are You Actually Buying In Aurora Innovation Stock?", ["AUR"]),
      tslaItem("Stocks Fall; Snowflake, Dell In Focus: Weekly Review", ["SNOW", "DELL", "TSLA", "SPY"]),
    ]}), NOW, { companyName: "Tesla, Inc." });

  assert.equal(ev.availability, NewsAvailability.NO_RECENT_NEWS, "we looked and found no company news");
  assert.notEqual(ev.availability, NewsAvailability.PROVIDER_UNAVAILABLE, "the provider did not fail");
  assert.equal(ev.providerAvailability, NewsAvailability.PRESENT, "provider availability is tracked separately");
});

test("relevance filtering never reduces completeness", () => {
  const allNoise = news([
    newsItem({ headline: "What Are You Actually Buying In Aurora Innovation Stock?", tickers: ["AUR"], hoursAgo: 2 }),
  ]);
  const filtered = assess(fundamentals(), earnings(), allNoise);
  const quiet = assess(fundamentals(), earnings(), quietNews());
  const failed = assess(fundamentals(), earnings(), unavailableNews());

  assert.equal(filtered.completeness.score, quiet.completeness.score,
    "search results filtered as noise still mean we successfully looked");
  assert.ok(filtered.completeness.score > failed.completeness.score,
    "a provider failure is different and must still cost completeness");
  assert.ok(filtered.completeness.present.includes("companyNews"));
});

test("contextual and irrelevant evidence cannot influence the directional lean", () => {
  const base = assess(fundamentals(), earnings(), quietNews());
  const withNoise = assess(fundamentals(), earnings(), news([
    newsItem({ headline: "Top Midday Stories: Lululemon Q2 Revenue Miss, Guidance Cut", tickers: ["LULU", "AAPL", "SPY"], hoursAgo: 1 }),
    newsItem({ headline: "What Are You Actually Buying In Aurora Innovation Stock?", tickers: ["AUR"], hoursAgo: 2 }),
  ]));
  assert.equal(withNoise.lean, base.lean, "another company's guidance cut must not move this company's lean");
  assert.equal(withNoise.direction, base.direction);
  assert.ok(!withNoise.signals.some(s => s.key === "currentCatalysts"));
});

test("existing company-specific directional rules are unchanged by the relevance layer", () => {
  const r = assess(fundamentals(), earnings(), news([
    newsItem({ headline: "AAPL raises full-year guidance", hoursAgo: 2, tickers: ["AAPL"] }),
  ]));
  assert.equal(r.materialCatalysts.length, 1, "a genuine company catalyst still lands");
  assert.equal(r.materialCatalysts[0].classification.directionalRule, "GUIDANCE_RAISED");
});
