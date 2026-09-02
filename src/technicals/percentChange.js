/**
 * Percentage change from `periods` bars ago to the latest close.
 * closes ordered oldest -> newest. Returns null if there isn't enough
 * history rather than guessing.
 */
export function percentChangeOverPeriods(closes, periods) {
  if (!Array.isArray(closes) || closes.length < periods + 1) return null;
  const latest = closes[closes.length - 1];
  const past = closes[closes.length - 1 - periods];
  if (!Number.isFinite(past) || past === 0) return null;
  return ((latest - past) / past) * 100;
}
