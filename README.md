# Project Horseman — Current Prototype

This ZIP contains the current Project Horseman web prototype source code.

## Files
- `index.html` — the user interface and Council/Horsemen result presentation.
- `api/analyse.js` — the server-side analysis endpoint.

## Run/deploy notes
The backend expects an environment variable named:

`ALPHA_VANTAGE_API_KEY`

The actual API key is intentionally **not included** in this ZIP. Configure it as a secret/environment variable in the hosting platform.

## Product direction
Horseman is a trading decision-support framework built around four specialist perspectives:
- War — technical/market analysis
- Famine — fundamental/macro evidence
- Conquest — sentiment/behaviour evidence
- Death — mandatory risk cross-examination

The Council combines the evidence into an explainable verdict. The user makes the final decision.

Core principle: **Rank the evidence, not the website.**

This is a prototype/research tool, not a guarantee of returns or financial advice.


## Conquest multi-signal layer
Conquest no longer depends on a social network to function. The current build measures crowd attention using recent news intensity, headline disagreement, unusual trading volume, recent volatility, large short-term moves, and crowding indicators. Trading/news activity is treated as an attention proxy, not proof of what investors believe. Death receives elevated/high crowding risk as a cross-examination input.

## Deployment

This repository is ready for Vercel Git deployment. Keep `ALPHA_VANTAGE_API_KEY` in Vercel Environment Variables; do not commit the real key to GitHub. The `/api/analyse.js` file is the live analysis endpoint and `index.html` is the full Horseman interface.

