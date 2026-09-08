import { sma, percentVsReference } from "./movingAverage.js";

/**
 * Compares the latest volume against the trailing `period`-day average
 * volume (excluding the latest bar from its own average, so a huge print
 * doesn't drag its own baseline up). Returns nulls rather than fabricated
 * numbers when volume data is missing or history is too short.
 */
export function volumeVsAverage(volumes, period = 20) {
  if (!Array.isArray(volumes) || volumes.length < period + 1) {
    return { latest: volumes?.length ? volumes[volumes.length - 1] : null, average: null, vsAveragePct: null };
  }
  const latest = volumes[volumes.length - 1];
  const priorWindow = volumes.slice(volumes.length - 1 - period, volumes.length - 1);
  if (priorWindow.some(v => v === null || v === undefined)) {
    return { latest, average: null, vsAveragePct: null };
  }
  const average = sma(priorWindow, period);
  return { latest, average, vsAveragePct: percentVsReference(latest, average) };
}
