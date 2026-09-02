// Simple, hand-verifiable fixtures. These are deliberately NOT realistic
// price data — they're chosen so expected values can be worked out with
// basic arithmetic, independent of the implementation under test.

// 1..30 ascending: SMA/percent-change are trivial to hand-check,
// RSI should be exactly 100 (every step is a gain, never a loss).
export const ASCENDING_30 = Array.from({ length: 30 }, (_, i) => i + 1);

// 30..1 descending: RSI should be exactly 0 (every step is a loss).
export const DESCENDING_30 = Array.from({ length: 30 }, (_, i) => 30 - i);

// Alternating +1/-1 of equal size and count -> average gain == average
// loss -> RS = 1 -> RSI should be exactly 50.
export const ALTERNATING_15 = (() => {
  const arr = [100];
  for (let i = 0; i < 20; i++) {
    arr.push(arr[arr.length - 1] + (i % 2 === 0 ? 1 : -1));
  }
  return arr;
})();

// Points are anchored to "now" (not a fixed calendar date) so freshness
// checks in tests reflect what the fixture actually claims: the LAST point
// is always "today" unless a test deliberately backdates it to test
// staleness. Fixed-past dates would silently make every fixture look
// stale once enough real time has passed since this file was written.
export function makePoints(closes, { withVolume = false } = {}) {
  const now = Date.now();
  const dayMs = 86400000;
  const start = now - (closes.length - 1) * dayMs;
  return closes.map((close, i) => {
    const ts = start + i * dayMs;
    return {
      date: new Date(ts).toISOString().slice(0, 10),
      timestamp: ts,
      open: close,
      high: close + 0.5,
      low: close - 0.5,
      close,
      volume: withVolume ? 1000 + i * 10 : null,
    };
  });
}
