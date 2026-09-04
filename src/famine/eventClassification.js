/**
 * FAMINE V2 — EVENT CLASSIFICATION
 *
 * Deterministic, explainable, and deliberately cautious. Every decision is
 * a documented pattern over a HEADLINE — the only content the provider
 * supplies. There is no article body, so anything requiring real reading
 * comprehension is answered with an explicit UNKNOWN rather than guessed.
 *
 * FOUR INDEPENDENT AXES. They are not the same question and must not be
 * collapsed:
 *
 *   category          what KIND of event this appears to be
 *   evidenceType      whether it reports something, or interprets something
 *   materiality       whether it could plausibly change the investment case
 *   directionalImpact whether the evidence explicitly implies better/worse
 *
 * Classification is NOT direction. LEGAL is not automatically bearish;
 * PRODUCT is not automatically bullish. Direction is assigned only by the
 * narrow explicit rules in DIRECTIONAL_RULES below, and is UNKNOWN
 * otherwise — which is a perfectly acceptable, and usually correct, answer.
 *
 * This deliberately replaces V1's positive/negative word counting. Words
 * like "growth", "beat", "lawsuit" or "probe" cannot by themselves move
 * Famine's direction here.
 */

export const EventCategory = Object.freeze({
  EARNINGS: "EARNINGS", GUIDANCE: "GUIDANCE", PRODUCT: "PRODUCT",
  REGULATORY: "REGULATORY", LEGAL: "LEGAL", MANAGEMENT: "MANAGEMENT",
  M_AND_A: "M_AND_A", CAPITAL_RETURN: "CAPITAL_RETURN", FINANCING: "FINANCING",
  OPERATIONAL: "OPERATIONAL", OTHER: "OTHER",
});

export const EvidenceType = Object.freeze({
  REPORTED_EVENT: "REPORTED_EVENT",
  OPINION: "OPINION",
  FORECAST: "FORECAST",
  RUMOUR: "RUMOUR",
  UNCLASSIFIED: "UNCLASSIFIED",   // cannot be established from a headline
});

export const Materiality = Object.freeze({
  HIGH: "HIGH", MEDIUM: "MEDIUM", LOW: "LOW",
  UNCERTAIN: "UNCERTAIN",         // cannot be established — not a guess of "low"
});

export const DirectionalImpact = Object.freeze({
  POSITIVE: "POSITIVE", NEGATIVE: "NEGATIVE", UNKNOWN: "UNKNOWN",
});

/* ------------------------------------------------------------------ */
/* EVIDENCE TYPE                                                       */
/* ------------------------------------------------------------------ */

// Checked in this order. Caution wins: if a headline hedges at all, it is
// not a reported event, whoever published it. Publisher reputation never
// upgrades an opinion into a fact.
const RUMOUR_PATTERNS = /\brumou?r|reportedly|speculat|unconfirmed|sources say|said to be|market chatter|is in talks|weighing a|mulls?\b|considering\b/i;
const OPINION_PATTERNS = /\bwhy\b|\bshould you\b|\bis .{0,20}\ba (buy|sell)\b|\bbest\b|\bworst\b|undervalued|overvalued|\bopinion\b|here'?s what|\bcould be\b|\bmy take\b|\bstock to (buy|watch)\b|\banalysis:|\bthink\b/i;
// An ANALYST expectation is an opinion about the company; a COMPANY
// forecast is the company's own statement. Conflating them would let
// third-party views inherit the standing of company guidance, so analyst
// attribution is checked first and typed as OPINION.
const ANALYST_OPINION_PATTERNS = /\banalysts?\b|\bbroker(age)?\b|\bprice target\b|\brating\b|\bupgrades?\b|\bdowngrades?\b|\b(bofa|morgan stanley|goldman|jefferies|wedbush|barclays)\b/i;
const FORECAST_PATTERNS = /\bforecasts?\b|\bexpects?\b|\boutlook for\b|\bproject(s|ed|ion)\b|\bwill likely\b|\bset to\b|\bpoised to\b|\bmay \b|\bmight \b|\bpredict/i;
// Concrete corporate acts, stated in the past/announcement tense.
const REPORTED_PATTERNS = /\bannounce(s|d)?\b|\breports?\b|\bposted?\b|\blaunche[sd]\b|\bunveil(s|ed)\b|\bfiles?\b|\bcompleted?\b|\bacquire[sd]\b|\bappoints?\b|\bnames?\b|\bapprove[sd]\b|\bdeclares?\b|\bissued?\b|\braises? (its )?(dividend|guidance|outlook|forecast)|\b(cuts?|lowers?|slashes|trims?) (its )?(dividend|guidance|outlook|forecast)|\bbeats?\b|\bmisses\b|\btops\b|\bresigns?\b|\bsteps down\b|\brecalls?\b|\bsuspends?\b|\bhalts?\b|\bscraps?\b|\beliminates?\b|\binitiates?\b|\bprices?\b|\bincreases?\b/i;

export function classifyEvidenceType(headline) {
  const h = String(headline || "");
  if (!h.trim()) return EvidenceType.UNCLASSIFIED;
  if (RUMOUR_PATTERNS.test(h)) return EvidenceType.RUMOUR;
  if (OPINION_PATTERNS.test(h) || ANALYST_OPINION_PATTERNS.test(h)) return EvidenceType.OPINION;
  // A guidance/dividend CHANGE is a reported corporate act even though
  // guidance itself is forward-looking, so it is checked before FORECAST.
  if (/\b(raises?|lifts?|boosts?|cuts?|lowers?|slashes|trims?)\b.{0,25}\b(guidance|outlook|forecast|dividend)\b/i.test(h)) {
    return EvidenceType.REPORTED_EVENT;
  }
  if (FORECAST_PATTERNS.test(h)) return EvidenceType.FORECAST;
  if (REPORTED_PATTERNS.test(h)) return EvidenceType.REPORTED_EVENT;
  return EvidenceType.UNCLASSIFIED;
}

/* ------------------------------------------------------------------ */
/* CATEGORY                                                            */
/* ------------------------------------------------------------------ */

// First match wins; the order encodes which reading dominates when a
// headline touches several themes (a guidance cut inside an earnings
// report is treated as guidance, which is the more decision-relevant fact).
const CATEGORY_RULES = [
  [EventCategory.GUIDANCE, /\bguidance\b|\boutlook\b|\bfull-year forecast\b|\bfy\d{2} (guidance|outlook)\b/i],
  [EventCategory.EARNINGS, /\bearnings\b|\bquarterly results\b|\bq[1-4]\b|\beps\b|\brevenue\b|\bresults\b|\bprofit (rose|fell|jumped|dropped)\b/i],
  [EventCategory.CAPITAL_RETURN, /\bdividend\b|\bbuyback\b|\brepurchase\b|\bshare return\b/i],
  [EventCategory.M_AND_A, /\bacquir|\bmerger\b|\btakeover\b|\bbuyout\b|\bto buy\b|\bstake in\b|\bdivest|\bspin-?off\b/i],
  [EventCategory.FINANCING, /\bshare (sale|offering)\b|\bequity offering\b|\bconvertible\b|\bbond sale\b|\bdebt offering\b|\bdilut|\braises \$\d/i],
  [EventCategory.REGULATORY, /\bregulat|\bantitrust\b|\bsec\b|\bftc\b|\bdoj\b|\bfda\b|\bprobe\b|\binvestigation\b|\bfine[sd]?\b|\bsanction/i],
  [EventCategory.LEGAL, /\blawsuit\b|\bsues?\b|\bcourt\b|\bjudge\b|\bsettlement\b|\blitigation\b|\bverdict\b|\bappeal\b|\bpatent (suit|dispute)\b/i],
  [EventCategory.MANAGEMENT, /\bceo\b|\bcfo\b|\bchairman\b|\bresigns?\b|\bsteps down\b|\bappoints?\b|\bsuccessor\b|\bexecutive\b/i],
  [EventCategory.OPERATIONAL, /\bproduction\b|\bsupply chain\b|\brecalls?\b|\blayoffs?\b|\bplant\b|\bfactory\b|\boutage\b|\bstrike\b|\bshortage\b/i],
  [EventCategory.PRODUCT, /\blaunche[sd]\b|\bunveil|\breleases?\b|\bintroduces?\b|\bnew (product|model|device|chip|phone|iphone)\b|\bevent\b/i],
];

export function classifyCategory(headline) {
  const h = String(headline || "");
  for (const [category, pattern] of CATEGORY_RULES) {
    if (pattern.test(h)) return category;
  }
  return EventCategory.OTHER;
}

/* ------------------------------------------------------------------ */
/* MATERIALITY                                                         */
/* ------------------------------------------------------------------ */

// Categories capable of changing an investment case when actually reported.
const HIGH_MATERIALITY_CATEGORIES = new Set([
  EventCategory.EARNINGS, EventCategory.GUIDANCE, EventCategory.M_AND_A,
  EventCategory.CAPITAL_RETURN, EventCategory.FINANCING, EventCategory.REGULATORY,
]);
const MEDIUM_MATERIALITY_CATEGORIES = new Set([
  EventCategory.LEGAL, EventCategory.MANAGEMENT, EventCategory.OPERATIONAL, EventCategory.PRODUCT,
]);

/**
 * Materiality is about consequence, not sentiment. It is NOT statistically
 * calibrated and does not claim to be — it is a conservative ordering of
 * "could this plausibly change the case?" against what a headline can show.
 */
export function assessMateriality(category, evidenceType) {
  // Commentary is commentary regardless of subject.
  if (evidenceType === EvidenceType.OPINION) return Materiality.LOW;
  // An unconfirmed report of a major event is not yet a material fact.
  if (evidenceType === EvidenceType.RUMOUR) return Materiality.UNCERTAIN;

  if (evidenceType === EvidenceType.REPORTED_EVENT) {
    if (HIGH_MATERIALITY_CATEGORIES.has(category)) return Materiality.HIGH;
    if (MEDIUM_MATERIALITY_CATEGORIES.has(category)) return Materiality.MEDIUM;
    return Materiality.LOW;
  }
  if (evidenceType === EvidenceType.FORECAST) {
    return HIGH_MATERIALITY_CATEGORIES.has(category) ? Materiality.MEDIUM : Materiality.LOW;
  }
  // Type could not be established. If the category is also unidentifiable,
  // we genuinely cannot say — say so rather than defaulting to LOW.
  return category === EventCategory.OTHER ? Materiality.UNCERTAIN : Materiality.MEDIUM;
}

/* ------------------------------------------------------------------ */
/* DIRECTIONAL IMPACT — the narrow explicit set                        */
/* ------------------------------------------------------------------ */

/**
 * Direction is assigned ONLY where a headline makes the implication
 * explicit, and only for reported events. Everything else is UNKNOWN.
 * "I cannot establish the impact from this evidence" is a valid, and
 * usually the honest, answer.
 */
export const DIRECTIONAL_RULES = Object.freeze([
  { rule: "GUIDANCE_RAISED", impact: DirectionalImpact.POSITIVE,
    pattern: /\b(raises?|lifts?|boosts?|hikes?)\b.{0,25}\b(guidance|outlook|forecast)\b/i },
  { rule: "GUIDANCE_LOWERED", impact: DirectionalImpact.NEGATIVE,
    pattern: /\b(cuts?|lowers?|slashes|trims?|reduces?)\b.{0,25}\b(guidance|outlook|forecast)\b|\bprofit warning\b|\bwarns? on (profit|revenue|sales)\b/i },
  { rule: "EARNINGS_BEAT", impact: DirectionalImpact.POSITIVE,
    pattern: /\b(beats?|tops?|exceeds?|surpasses?)\b.{0,30}\b(estimates?|expectations?|forecasts?|views?)\b/i },
  { rule: "EARNINGS_MISS", impact: DirectionalImpact.NEGATIVE,
    pattern: /\b(misses?|missed|falls? short of|comes? in below)\b.{0,30}\b(estimates?|expectations?|forecasts?|views?)\b/i },
  { rule: "CAPITAL_RETURN_ANNOUNCED", impact: DirectionalImpact.POSITIVE,
    pattern: /\b(announces?|declares?|approves?|initiates?|raises?|increases?)\b.{0,25}\b(dividend|buyback|repurchase)\b/i },
  { rule: "CAPITAL_RETURN_REDUCED", impact: DirectionalImpact.NEGATIVE,
    pattern: /\b(cuts?|suspends?|halts?|scraps?|eliminates?)\b.{0,25}\b(dividend|buyback|repurchase)\b/i },
  { rule: "DILUTIVE_FINANCING", impact: DirectionalImpact.NEGATIVE,
    pattern: /\b(announces?|prices?|launches?|completes?)\b.{0,30}\b(share (sale|offering)|equity offering|convertible (note|bond)s?)\b/i },
]);

export function assessDirectionalImpact(headline, evidenceType) {
  // Only a reported corporate act can carry explicit direction. A rumour,
  // forecast or opinion about the same subject cannot.
  if (evidenceType !== EvidenceType.REPORTED_EVENT) {
    return { impact: DirectionalImpact.UNKNOWN, rule: null };
  }
  const h = String(headline || "");
  const matches = DIRECTIONAL_RULES.filter(r => r.pattern.test(h));
  if (matches.length !== 1) {
    // Zero matches: nothing explicit. Several: contradictory or ambiguous
    // wording, so we decline rather than pick one.
    return { impact: DirectionalImpact.UNKNOWN, rule: matches.length > 1 ? "AMBIGUOUS_MULTIPLE_RULES" : null };
  }
  return { impact: matches[0].impact, rule: matches[0].rule };
}

/** Full classification of one normalised news item. */
export function classifyNewsItem(item) {
  const category = classifyCategory(item.headline);
  const evidenceType = classifyEvidenceType(item.headline);
  const materiality = assessMateriality(category, evidenceType);
  const { impact, rule } = assessDirectionalImpact(item.headline, evidenceType);
  return Object.freeze({
    category, evidenceType, materiality,
    directionalImpact: impact,
    directionalRule: rule,
  });
}
