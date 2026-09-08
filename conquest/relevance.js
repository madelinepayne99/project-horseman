/**
 * CONQUEST V2 — RELEVANCE TIERING
 *
 * STATUS: INERT. Nothing imports this yet.
 *
 * ---------------------------------------------------------------------
 * WHY CONQUEST NEEDS ITS OWN RELEVANCE MODEL
 * ---------------------------------------------------------------------
 * Famine asks "is this a company EVENT?" and answers with a binary useful
 * for company-event reasoning. Conquest asks a different question:
 *
 *   "Is this evidence that people are paying attention to this asset, and
 *    is it specific enough to say anything about sentiment TOWARD it?"
 *
 * Those diverge. A "Magnificent Seven" article is not a Tesla event, so
 * Famine is right to exclude it — but it IS evidence that Tesla is being
 * discussed, which is precisely Conquest's territory. Reusing Famine's
 * verdict would throw away real attention evidence.
 *
 * ---------------------------------------------------------------------
 * THE FAILURE THIS EXISTS TO PREVENT
 * ---------------------------------------------------------------------
 * A live Production TSLA run produced CONQUEST: BEARISH 84. Every point of
 * that "bearish" signal came from two Lululemon headlines and a market
 * wrap containing the words "fall", "miss" and "cut". Not one point was
 * about Tesla. Meanwhile the single genuinely Tesla-negative headline
 * scored zero.
 *
 * The invariant that prevents a repeat:
 *
 *   ONLY TARGET_SPECIFIC EVIDENCE MAY EVER INFLUENCE DIRECTIONAL SENTIMENT.
 *
 * Relevance is therefore decided BEFORE any sentiment interpretation, and
 * this module deliberately emits no direction, score or confidence of any
 * kind — only a tier and the signals behind it.
 *
 * Provider-neutral and asset-type-neutral by construction: it takes an
 * assetId and free-text, so it works equally for equity news metadata,
 * forum observations, or future crypto discussion.
 */

export const ConquestRelevance = Object.freeze({
  /** Clearly about the target. May contribute to attention AND sentiment. */
  TARGET_SPECIFIC: "TARGET_SPECIFIC",
  /** Genuine market/sector/basket discussion including the target.
   *  May contribute to ATTENTION only — never directional sentiment. */
  CONTEXTUAL: "CONTEXTUAL",
  /** Provider search contamination. Contributes to nothing. */
  IRRELEVANT: "IRRELEVANT",
});

/**
 * Roundup/basket phrasing. These items cover several assets, so whatever
 * sentiment they carry usually belongs to one of the OTHERS.
 */
const DIGEST_PHRASES = /\bstock movers\b|\bweekly review\b|\btop midday stories\b|\blive coverage\b|\bin focus\b|\bmarket today\b|\bmovers\b|\broundup\b|\brecap\b|\bwhat to watch\b|\bthings to know\b|\bmagnificent seven\b|\bmag ?7\b|\bbest stocks\b|\btop stocks\b|\bstocks to\b|\bmarket wrap\b/i;
const MULTI_SUBJECT_SEPARATORS = /[;|]/;

/** A long related-asset list is itself evidence of a basket/roundup item. */
export const MANY_RELATED_ASSETS = 4;

/**
 * Name tokens shorter than this are not used for matching at all.
 * "BP", "Gap" and similar are too collision-prone in free text to carry
 * any weight; such assets must be identified by their ticker or by
 * related-asset metadata instead. Documented limitation, not an oversight.
 */
export const MIN_NAME_TOKEN_LENGTH = 4;

function escapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/**
 * The distinguishing token of a company name — "Tesla, Inc." -> "Tesla".
 * Legal suffixes never appear in headlines, so they are stripped.
 * Returns null when nothing usable remains.
 */
export function assetNameToken(companyName) {
  if (!companyName || typeof companyName !== "string") return null;
  const cleaned = companyName
    .replace(/\b(inc|corp|corporation|company|co|plc|ltd|limited|holdings|group|sa|nv|ag|ab|oyj)\b\.?/gi, "")
    .replace(/[.,]/g, " ")
    .trim();
  const first = cleaned.split(/\s+/).filter(Boolean)[0];
  if (!first) return null;
  return first.length >= MIN_NAME_TOKEN_LENGTH ? first : null;
}

/** Word-bounded, case- and punctuation-tolerant containment. */
function mentions(text, term) {
  if (!term) return false;
  // Apostrophes and possessives must not break the match: "Tesla's" counts.
  return new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(term)}([^A-Za-z0-9]|$)`, "i").test(text);
}

function textOf(item) {
  if (!item) return "";
  // Accepts either naming convention so news items and forum observations
  // can both be passed without an adapter.
  const raw = item.headline ?? item.title ?? item.text ?? "";
  return typeof raw === "string" ? raw : "";
}

function relatedAssetsOf(item) {
  const list = item && (item.relatedTickers ?? item.relatedAssets);
  return Array.isArray(list) ? list.filter(t => typeof t === "string") : null;
}

/**
 * Classifies one candidate item's relevance to the target asset.
 *
 * AMBIGUOUS NAMES — the deliberate design decision:
 * many asset names are ordinary words (Apple, Target, Block, Shell, Match,
 * Visa). Without a lexicon there is no way to distinguish "Apple" the
 * company from "apple" the fruit, and a hand-maintained list of such names
 * was ruled out. One uniform rule therefore applies to every asset:
 *
 *   a bare NAME match is never sufficient for TARGET_SPECIFIC. It must be
 *   corroborated by the ticker/assetId appearing in the text, by
 *   related-asset metadata, or by the provider declaring the target the
 *   principal subject. Uncorroborated name matches are CONTEXTUAL.
 *
 * The cost is stated plainly: when a provider supplies no related-asset
 * metadata AND the text names the asset without its ticker, a genuine
 * target story is demoted to CONTEXTUAL. That is the conservative failure —
 * it under-counts targeted evidence rather than inventing it, and under
 * the critical invariant it can only lose attention weight, never create a
 * false sentiment signal.
 *
 * @param {object} item     normalised item ({headline|title|text}, relatedTickers?, isPrincipalSubject?)
 * @param {object} target   { assetId, companyName? }
 */
export function classifyConquestRelevance(item, { assetId, companyName = null } = {}) {
  const text = textOf(item);
  const target = String(assetId || "").trim();
  const related = relatedAssetsOf(item);

  // An absent array means UNKNOWN, never "unrelated". Distinguishing the
  // two is what stops a provider that omits metadata from silently zeroing
  // out all of Conquest's evidence.
  const relatedAssetsKnown = related !== null && related.length > 0;
  const relatedMatched = relatedAssetsKnown
    && related.some(t => t.trim().toUpperCase() === target.toUpperCase());

  const tickerMatched = target ? mentions(text, target) : false;
  const nameToken = assetNameToken(companyName);
  const nameMatched = nameToken ? mentions(text, nameToken) : false;

  // A provider may state outright that the target is the item's principal
  // subject (e.g. a forum thread bound to one asset). Trusted when present.
  const principalSubject = item && item.isPrincipalSubject === true;

  const isDigest = DIGEST_PHRASES.test(text)
    || MULTI_SUBJECT_SEPARATORS.test(text)
    || (relatedAssetsKnown && related.length >= MANY_RELATED_ASSETS);

  const anyTargetSignal = tickerMatched || nameMatched || relatedMatched || principalSubject;

  const signals = Object.freeze({
    tickerMatched,
    nameMatched,
    nameTokenUsed: nameToken,
    relatedAssetsKnown,
    relatedAssetMatched: relatedMatched,
    principalSubjectDeclared: principalSubject,
    digestDetected: isDigest,
  });

  const reasons = [];
  if (tickerMatched) reasons.push("target identifier present in text");
  if (nameMatched) reasons.push("target name present in text");
  if (relatedMatched) reasons.push("target present in related-asset metadata");
  if (principalSubject) reasons.push("provider declares target the principal subject");
  if (isDigest) reasons.push("multi-asset digest/basket/market-wrap item");
  if (!relatedAssetsKnown) reasons.push("no related-asset metadata supplied (unknown, not unrelated)");
  if (nameMatched && !tickerMatched && !relatedMatched && !principalSubject) {
    reasons.push("name match uncorroborated, so treated conservatively");
  }
  if (!anyTargetSignal) reasons.push("no signal connects this item to the target");

  const result = tier => Object.freeze({ relevance: tier, signals, reasons: Object.freeze(reasons) });

  // A basket/roundup is never TARGET_SPECIFIC however clearly it names the
  // target: its sentiment belongs to the basket, not to one member of it.
  if (isDigest) return result(anyTargetSignal ? ConquestRelevance.CONTEXTUAL : ConquestRelevance.IRRELEVANT);

  // The identifier itself is unambiguous.
  if (tickerMatched) return result(ConquestRelevance.TARGET_SPECIFIC);
  if (principalSubject) return result(ConquestRelevance.TARGET_SPECIFIC);
  // A name match counts fully only when corroborated (see note above).
  if (nameMatched && relatedMatched) return result(ConquestRelevance.TARGET_SPECIFIC);
  if (nameMatched) return result(ConquestRelevance.CONTEXTUAL);
  // Named nowhere in the text, but the provider associates it with the target.
  if (relatedMatched) return result(ConquestRelevance.CONTEXTUAL);

  return result(ConquestRelevance.IRRELEVANT);
}

/**
 * Convenience partition for later stages. Returns the three tiers plus the
 * classification alongside each item, so an attention model can weight
 * TARGET_SPECIFIC and CONTEXTUAL differently while a sentiment model reads
 * TARGET_SPECIFIC only.
 *
 * Emits no weights: weighting is a Step 4 decision, not a relevance one.
 */
export function partitionByRelevance(items = [], target = {}) {
  const scored = (Array.isArray(items) ? items : [])
    .filter(Boolean)
    .map(item => Object.freeze({ item, ...classifyConquestRelevance(item, target) }));

  return Object.freeze({
    targetSpecific: Object.freeze(scored.filter(s => s.relevance === ConquestRelevance.TARGET_SPECIFIC)),
    contextual: Object.freeze(scored.filter(s => s.relevance === ConquestRelevance.CONTEXTUAL)),
    irrelevant: Object.freeze(scored.filter(s => s.relevance === ConquestRelevance.IRRELEVANT)),
    all: Object.freeze(scored),
  });
}
