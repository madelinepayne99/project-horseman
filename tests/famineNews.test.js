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
  ]), NOW);

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
  ]), NOW);
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
  ]), NOW);
  assert.equal(ev.eventGroups[0].freshness, NewsFreshness.BREAKING);

  const stale = assessNewsEvidence(news([
    newsItem({ headline: "Apple announces quarterly dividend", hoursAgo: 24 * 30 }),
  ]), NOW);
  assert.equal(stale.eventGroups[0].freshness, NewsFreshness.STALE);
});

test("a stale material event is not a current catalyst", () => {
  const fresh = assessNewsEvidence(news([newsItem({ headline: "Apple raises full-year guidance", hoursAgo: 2 })]), NOW);
  const old = assessNewsEvidence(news([newsItem({ headline: "Apple raises full-year guidance", hoursAgo: 24 * 30 })]), NOW);
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
