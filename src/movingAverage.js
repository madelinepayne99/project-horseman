/**
 * Simple moving average of the last `period` closes in `closes`.
 * closes must be ordered oldest -> newest.
 * Returns null (not a fabricated number) if there isn't enough history.
 */
export function sma(closes, period) {
  if (!Array.isArray(closes) || closes.length < period) return null;
  const window = closes.slice(closes.length - period);
  const sum = window.reduce((a, b) => a + b, 0);
  return sum / period;
}

/**
 * Percentage difference of `value` above/below `reference`.
 * Positive = value is above reference. Returns null if reference is
 * null, 0, or not finite (avoids Infinity/NaN masquerading as a result).
 */
export function percentVsReference(value, reference) {
  if (value === null || reference === null || !Number.isFinite(reference) || reference === 0) {
    return null;
  }
  return ((value - reference) / reference) * 100;
}
