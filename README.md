# ޚަބަރު (Khabaru)

Thaana news aggregator. `docs/` is served by GitHub Pages; a scheduled
Action (`.github/workflows/feeds.yml`) fetches the channels' RSS feeds every
10 minutes with `scripts/fetch-feeds.mjs` (which reuses `worker.js`) and
commits `docs/feeds.json`, which the page reads.

Enable Pages once: Settings → Pages → Source "Deploy from a branch",
branch `main`, folder `/docs`.
