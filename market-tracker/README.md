# GRID/WATCH — Renewable Energy Market Tracker (Node.js)

Industry news tracker for the renewable-energy market, built on the
[Webz.io News API](https://webz.io/products/news-api). Zero npm dependencies —
built-in `http`/`https` only, so `node server.js` is the entire setup.

Segments, each mapped to its own Webz.io boolean query:

| Segment | Query |
|---|---|
| All renewables | `"renewable energy" OR "clean energy"` |
| Solar | `"solar energy" OR "solar power" OR photovoltaic` |
| Wind | `"wind energy" OR "wind power" OR "offshore wind"` |
| Storage | `"energy storage" OR "battery storage" OR "grid-scale battery"` |
| Hydrogen | `"green hydrogen" OR "hydrogen energy"` |
| Policy | `"renewable energy" AND (policy OR regulation OR subsidy OR "tax credit")` |

For each segment the dashboard shows **coverage volume** (`total_results` — articles
indexed in the last 30 days, a useful attention-signal per segment), the latest
articles with sentiment tags, and publisher geography/outlet breakdowns.

## Run it

```bash
cp .env.example .env      # paste your Webz.io token into .env
node server.js
# → http://localhost:3000
```

## Endpoints

- `GET /` — dashboard UI
- `GET /api/segments` — segment list
- `GET /api/feed?segment=solar` — aggregated feed for one segment

## Design choices

- **Token stays server-side** — the browser only calls this server's `/api/*` routes.
- **Credit-aware caching** — each Webz.io request costs credits (`cost`/`balance` in
  the response), so each segment is cached in-memory for 10 minutes. Switching back
  and forth between segments in the UI spends nothing; the status line tells you
  whether a view was a live pull or served from cache.
- **Zero dependencies** — the whole demo is `server.js` + one static HTML file.
