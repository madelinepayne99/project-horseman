import { MarketDataProvider } from "./MarketDataProvider.js";
import { makeOhlcvPoint, makeNormalisedSeries } from "../schema/ohlcv.js";

/**
 * SimulatedProvider — an explicitly-labelled development/demo data source.
 *
 * This must NEVER be reached automatically when a real provider fails.
 * It is only wired in when HORSEMAN_MODE=demo is set deliberately (see
 * config.js), and every series it returns is tagged source.simulated=true
 * so nothing downstream can present it as a real analysis.
 */
export class SimulatedProvider extends MarketDataProvider {
  async getDailySeries(ticker) {
    const rng = seededRng(ticker + "::ohlcv-demo");
    const days = 260;
    const points = [];
    let price = 40 + rng() * 260; // arbitrary but stable starting price

    const today = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - i);
      // skip weekends to loosely resemble a trading calendar
      if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;

      const drift = (rng() - 0.48) * 0.02; // slight upward bias, still noisy
      price = Math.max(1, price * (1 + drift));
      const open = price * (1 + (rng() - 0.5) * 0.01);
      const close = price;
      const high = Math.max(open, close) * (1 + rng() * 0.008);
      const low = Math.min(open, close) * (1 - rng() * 0.008);
      const volume = Math.round(500000 + rng() * 4000000);

      points.push(
        makeOhlcvPoint({
          date: d.toISOString().slice(0, 10),
          open,
          high,
          low,
          close,
          volume,
        })
      );
    }

    return makeNormalisedSeries({
      ticker,
      companyName: null,
      currency: "USD",
      points,
      provider: "simulated-demo",
      simulated: true,
      requestedTicker: ticker,
      // Deliberately NOT a real exchange value — this keeps simulated
      // series from ever accidentally passing the US-equity scope check
      // in utils/supportedScope.js, which only applies to real data.
      providerMeta: { exchange: "SIMULATED", country: "N/A", note: "Fabricated demo data, not a real security." },
    });
  }
}

function seededRng(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}
