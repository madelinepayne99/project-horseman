/**
 * Wilder's RSI over `period` (classically 14).
 * closes ordered oldest -> newest.
 *
 * Needs at least period+1 closes (to get `period` deltas) — returns null
 * rather than a fabricated number if there isn't enough history.
 *
 * Method: seed the average gain/loss with a simple average of the first
 * `period` deltas, then apply Wilder's smoothing for the remainder. This
 * is the standard textbook formulation, chosen (over a naive rolling
 * average) because it's the most common definition traders mean by
 * "RSI(14)" and keeps our numbers comparable to charting platforms.
 */
export function rsi(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length < period + 1) return null;

  const deltas = [];
  for (let i = 1; i < closes.length; i++) {
    deltas.push(closes[i] - closes[i - 1]);
  }

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    const d = deltas[i];
    if (d > 0) avgGain += d;
    else avgLoss += -d;
  }
  avgGain /= period;
  avgLoss /= period;

  for (let i = period; i < deltas.length; i++) {
    const d = deltas[i];
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0 && avgGain === 0) return 50; // flat series, no movement at all
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;

  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}
