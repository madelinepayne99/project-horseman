/**
 * Freshness/completeness assessment for a normalised series + the derived
 * indicator set. Every field here is directly explainable — this is the
 * "machine-readable quality metadata" the Council will eventually reason
 * over, deliberately built as inspectable facts rather than a single
 * opaque score.
 */

const FRESH_MAX_AGE_HOURS = 96; // generous enough to span a weekend/holiday for daily bars

export function assessFreshness(latestPoint) {
  if (!latestPoint || !latestPoint.timestamp) {
    return { latestDataTimestamp: null, ageHours: null, status: "unavailable" };
  }
  const ageMs = Date.now() - latestPoint.timestamp;
  const ageHours = ageMs / (1000 * 60 * 60);
  return {
    latestDataTimestamp: new Date(latestPoint.timestamp).toISOString(),
    ageHours: Math.round(ageHours * 10) / 10,
    status: ageHours <= FRESH_MAX_AGE_HOURS ? "fresh" : "stale",
  };
}

/**
 * @param {Record<string, unknown>} indicatorValues - map of indicator name -> computed value (or null)
 */
export function assessCompleteness(indicatorValues) {
  const entries = Object.entries(indicatorValues);
  const missing = entries.filter(([, v]) => v === null || v === undefined).map(([k]) => k);
  const score = entries.length ? (entries.length - missing.length) / entries.length : 0;
  return { score: Math.round(score * 100) / 100, missing };
}

export const FRESHNESS_MAX_AGE_HOURS = FRESH_MAX_AGE_HOURS;
