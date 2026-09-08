// Vercel Node.js Function — deployed automatically because this file lives
// in /api. No framework, no build step, no vercel.json needed for this
// (confirmed against Vercel's current docs: "To use Node.js, create a file
// inside your project's api directory. No additional configuration is
// needed.").
//
// This is a thin wrapper: all real logic lives in src/, shared with the
// local dev server and covered by the existing test suite. Nothing here
// is provider-specific or duplicated.

import { createMarketDataHandler } from "../src/routes/marketDataRoute.js";
import { getProvider } from "../src/getProvider.js";

const handleMarketData = createMarketDataHandler(getProvider);

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const query = Object.fromEntries(url.searchParams.entries());
  await handleMarketData(req, res, query);
}
