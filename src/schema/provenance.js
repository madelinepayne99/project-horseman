/**
 * HORSEMAN — EVIDENCE PROVENANCE AND CORRELATION CONTRACT
 *
 * ---------------------------------------------------------------------
 * THE PROBLEM
 * ---------------------------------------------------------------------
 * Two Horsemen can describe ONE phenomenon and look like two independent
 * confirmations. War reports "price moved 25% in 20 sessions"; behavioural
 * Conquest will report "the move resembles chasing, because acceleration
 * and activity are unusually high". Both ultimately derive from the same
 * OHLCV acceleration. Counting them twice would inflate Council's
 * confidence and multiply Death's severity for a single fact.
 *
 * ---------------------------------------------------------------------
 * WHY A TAG ALONE IS NOT ENOUGH
 * ---------------------------------------------------------------------
 * A bare `correlationGroup` string would answer "are these the same
 * phenomenon?" but not "are these the same KIND of evidence?" Those are
 * different questions, and conflating them causes both failure modes:
 *
 *   - Under-correction: two market-derived findings with different group
 *     tags still both rest on one price series.
 *   - OVER-correction: War's chart structure and a genuine Reddit crowd
 *     reading are independent evidence even when they describe the same
 *     move, and suppressing one would discard real information.
 *
 * So provenance carries THREE facts, and independence is judged from all
 * three rather than from a Horseman's name:
 *
 *   origin            what KIND of source this rests on
 *   correlationGroup  which PHENOMENON it describes
 *   basedOn           which specific observations it was computed from
 *
 * Two findings are treated as the same evidence when they share an origin
 * AND a correlationGroup. Different origins are independent even on the
 * same phenomenon — which is exactly the War-chart vs real-crowd case the
 * founder asked us not to over-correct.
 */

/** What KIND of source a finding rests on. */
export const EvidenceSource = Object.freeze({
  /** Derived from the price/volume series. War, and future behavioural Conquest. */
  MARKET_HISTORY: "MARKET_HISTORY",
  /** Company fundamentals and earnings. */
  FUNDAMENTAL_FEED: "FUNDAMENTAL_FEED",
  /** Published news and event evidence. */
  NEWS_FEED: "NEWS_FEED",
  /** Genuine external crowd/social evidence from a legitimate provider. */
  CROWD_FEED: "CROWD_FEED",
  /** A tip or message the user supplied voluntarily. Never market or crowd evidence. */
  USER_CLAIM: "USER_CLAIM",
  /** Derived from comparing Horsemen, not from any single data source. */
  CROSS_HORSEMAN: "CROSS_HORSEMAN",
  /**
   * No origin was declared. Never grouped with anything, because inventing
   * correlation between undeclared evidence would suppress genuinely
   * independent findings. Production adapters must never emit this — there
   * is a test asserting exactly that.
   */
  UNDECLARED: "UNDECLARED",
});

/**
 * Which PHENOMENON a finding describes. Assigned explicitly where a finding
 * is constructed — never inferred from a Horseman's name, and never guessed
 * by matching strings in prose.
 */
export const CorrelationGroup = Object.freeze({
  /** Rapid recent price movement, and behaviour derived from that same move. */
  MARKET_ACCELERATION: "MARKET_ACCELERATION",
  /** Price extension by oscillator measures. */
  MARKET_EXTENSION: "MARKET_EXTENSION",
  /** Unusual participation/turnover relative to the asset's own history. */
  MARKET_PARTICIPATION: "MARKET_PARTICIPATION",
  /**
   * CHANGE in participation over time — a different observable from the
   * participation LEVEL above. Today's volume being high, and recent
   * volume having fallen against its own baseline, are two distinct facts
   * that can point opposite ways. Sharing MARKET_PARTICIPATION would have
   * let one silently suppress the other.
   */
  MARKET_PARTICIPATION_CHANGE: "MARKET_PARTICIPATION_CHANGE",
  /**
   * Resemblance between current behaviour and the asset's own history.
   *
   * A distinct phenomenon from the current activity level: "activity is
   * extreme" and "this resembles six earlier episodes" are different facts,
   * even though both are computed from the same session's measurements —
   * exactly as RSI extension and a 20-session move are different phenomena
   * drawn from one price series.
   */
  MARKET_HISTORICAL_ANALOGUE: "MARKET_HISTORICAL_ANALOGUE",
  /**
   * Intraday trading range relative to the asset's own history.
   *
   * Additive extension: a session's high-to-low range is a genuinely
   * different observable from close-to-close movement. A wide range that
   * closes flat is a real phenomenon that neither MARKET_ACCELERATION nor
   * MARKET_PARTICIPATION describes, so folding it into either would be
   * semantically false.
   */
  MARKET_RANGE: "MARKET_RANGE",
  /** The company's reported financial position. */
  COMPANY_FUNDAMENTALS: "COMPANY_FUNDAMENTALS",
  /** A specific company event or catalyst. */
  COMPANY_EVENT: "COMPANY_EVENT",
  /** Observed positioning or behaviour of an actual crowd. */
  CROWD_BEHAVIOUR: "CROWD_BEHAVIOUR",
  /** The wording of a user-supplied message. */
  CLAIM_LANGUAGE: "CLAIM_LANGUAGE",
  /** Availability/quality of evidence rather than the asset itself. */
  EVIDENCE_AVAILABILITY: "EVIDENCE_AVAILABILITY",
  /** Agreement or conflict between Horsemen. */
  HORSEMAN_CONSENSUS: "HORSEMAN_CONSENSUS",
});

/**
 * Builds a provenance descriptor.
 *
 * @param {string} source   an EvidenceSource member
 * @param {string} group    a CorrelationGroup member, or null when the
 *                          finding describes nothing correlatable
 * @param {string[]} basedOn identifiers of the observations it rests on
 */
export function makeProvenance(source, group = null, basedOn = [], {
  composite = false, contributingSources = null, horizon = null,
} = {}) {
  const validSource = Object.values(EvidenceSource).includes(source);
  return Object.freeze({
    source: validSource ? source : EvidenceSource.UNDECLARED,
    correlationGroup: group && Object.values(CorrelationGroup).includes(group) ? group : null,
    basedOn: Object.freeze(Array.isArray(basedOn) ? [...basedOn] : []),
    /**
     * Whether provenance was supplied at all. Undeclared evidence is
     * retained and visible but must not earn an independence benefit —
     * see isIndependenceEligible().
     */
    declared: validSource && source !== EvidenceSource.UNDECLARED,
    /**
     * A COMPOSITE conclusion draws on several observations and is therefore
     * not a single phenomenon. War's direction, for example, combines three
     * moving-average comparisons, an RSI band and a 20-session return — so
     * stamping it MARKET_ACCELERATION would be false, and would wrongly
     * suppress War whenever another Horseman reported acceleration.
     * Composites never correlate with anything.
     */
    composite: composite === true,
    contributingSources: Object.freeze(
      Array.isArray(contributingSources) ? [...contributingSources] : []),
    /**
     * The measurement window, where a phenomenon has one.
     *
     * Some phenomena are only the same phenomenon at the same horizon. A
     * one-session price move and a twenty-session cumulative move are both
     * "price movement" and both come from the same OHLCV history, but they
     * can diverge completely: a large twenty-session move alongside a quiet
     * session today, or a flat twenty sessions with an extreme session
     * today. Treating them as one phenomenon would let either suppress the
     * other, which is a different error from double-counting and just as
     * wrong.
     *
     * Shape: { unit: "SESSIONS", length: 20 } or null where horizon is not
     * a meaningful dimension (fundamentals, crowd behaviour, availability).
     *
     * A COMPARISON measurement adds `baselineLength`: a 5-session window
     * against a 20-session baseline is { unit: "SESSIONS", length: 5,
     * baselineLength: 20 }. Stamping either 5 or 20 alone would misdescribe
     * it, and two comparisons over different windows are not the same
     * measurement even though both describe participation change.
     */
    horizon: normaliseHorizon(horizon),
  });
}

function normaliseHorizon(horizon) {
  if (!horizon || typeof horizon !== "object") return null;
  const unit = typeof horizon.unit === "string" && horizon.unit.trim() ? horizon.unit.trim().toUpperCase() : null;
  const length = Number.isFinite(horizon.length) && horizon.length > 0 ? horizon.length : null;
  if (!unit || length === null) return null;
  const baselineLength = Number.isFinite(horizon.baselineLength) && horizon.baselineLength > 0
    ? horizon.baselineLength : null;
  return Object.freeze({ unit, length, baselineLength });
}

/**
 * Horizons match when both are absent (the phenomenon has no window) or
 * both describe the same window.
 *
 * A declared horizon and an absent one do NOT match: for a phenomenon that
 * has a measurement window, an undeclared window cannot be shown to be the
 * same window. Producers of horizon-bearing evidence must therefore declare
 * it — the same discipline the contract already requires for source.
 */
export function sameHorizon(a, b) {
  // `?? null` matters: a hand-built provenance object omits `horizon`
  // entirely, and undefined must behave identically to an absent horizon
  // rather than silently failing to match.
  const ha = (a ? a.horizon : null) ?? null;
  const hb = (b ? b.horizon : null) ?? null;
  if (ha === null && hb === null) return true;
  if (ha === null || hb === null) return false;
  // A comparison window must match on BOTH its windows: 5-vs-20 and
  // 10-vs-60 both describe participation change but are not the same
  // measurement. `?? null` keeps pre-existing single-window horizons
  // (which carry no baselineLength) comparing correctly.
  return ha.unit === hb.unit
    && ha.length === hb.length
    && (ha.baselineLength ?? null) === (hb.baselineLength ?? null);
}

/**
 * May this evidence be counted as an INDEPENDENT contribution?
 *
 * Undeclared provenance is not independent evidence — it is evidence of
 * unknown origin. Granting it full independent status would let a future
 * Horseman recreate double-counting simply by forgetting to declare, which
 * is exactly the failure mode this contract exists to prevent. It is not
 * penalised either: it keeps its stance and stays in the case file. It
 * simply does not earn coverage credit it cannot justify.
 */
export function isIndependenceEligible(provenance) {
  return !!provenance && provenance.declared === true;
}

/**
 * The independence rule, in one place.
 *
 * Findings are the SAME evidence only when they share both an origin and a
 * phenomenon. Undeclared origins and null groups are never correlated —
 * fail-open here is deliberate, because a false correlation silently
 * deletes real evidence, whereas a missed one is caught by the adapter
 * test that forbids UNDECLARED in production.
 */
export function areCorrelated(a, b) {
  if (!a || !b) return false;
  // Undeclared evidence is never correlated with anything: arbitrarily
  // grouping it would suppress genuinely independent findings. Its safety
  // comes from isIndependenceEligible(), not from false correlation.
  if (!a.declared || !b.declared) return false;
  // A composite conclusion is not a single phenomenon, so it cannot be the
  // same phenomenon as anything else.
  if (a.composite || b.composite) return false;
  if (!a.correlationGroup || !b.correlationGroup) return false;
  // Same source, same phenomenon AND same measurement window.
  if (!sameHorizon(a, b)) return false;
  return a.source === b.source && a.correlationGroup === b.correlationGroup;
}

/**
 * Partitions items into correlation groups. Each returned group is ONE
 * piece of evidence seen from possibly several angles: every member is
 * preserved for explanation, but consumers count the group once.
 *
 * Deterministic: groups appear in first-seen order, members in input order.
 *
 * @param {Array} items    anything carrying a `provenance` descriptor
 * @param {Function} rank  optional comparator picking the representative
 */
export function groupByCorrelation(items = [], rank = null) {
  const groups = [];
  for (const item of items) {
    const p = item && item.provenance;
    const existing = p ? groups.find(g => areCorrelated(g.provenance, p)) : null;
    if (existing) existing.members.push(item);
    else groups.push({ provenance: p || null, members: [item] });
  }
  return groups.map(g => {
    const members = g.members;
    const representative = rank ? [...members].sort(rank)[0] : members[0];
    return Object.freeze({
      source: g.provenance ? g.provenance.source : EvidenceSource.UNDECLARED,
      correlationGroup: g.provenance ? g.provenance.correlationGroup : null,
      representative,
      members: Object.freeze(members),
      // > 1 means one phenomenon was described from several angles.
      memberCount: members.length,
      correlated: members.length > 1,
    });
  });
}

/**
 * Provenance completeness across a set of items, so incompleteness is
 * explicitly inspectable rather than silently absorbed.
 */
export function assessProvenanceIntegrity(items = [], labelOf = (i, n) => `item-${n}`) {
  const undeclared = [];
  items.forEach((item, n) => {
    const p = item && item.provenance;
    if (!isIndependenceEligible(p)) undeclared.push(labelOf(item, n));
  });
  return Object.freeze({
    complete: undeclared.length === 0,
    undeclared: Object.freeze(undeclared),
    undeclaredCount: undeclared.length,
  });
}

/** Distinct origins present, for diagnostics and evidence-independence checks. */
export function distinctSources(items = []) {
  return Object.freeze([...new Set(
    items.map(i => (i && i.provenance ? i.provenance.source : EvidenceSource.UNDECLARED)))]);
}
