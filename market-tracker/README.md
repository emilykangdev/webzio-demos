# GRID/WATCH — Renewable Energy Market Tracker (Node.js)

Industry news tracker for the renewable-energy market, built on the
[Webz.io News API](https://webz.io/products/news-api). Zero npm dependencies —
built-in `http`/`https` only, so `node server.js` is the entire setup.

Segments, each mapped to its own Webz.io boolean query:

| Segment | Query |
|---|---|
| All renewables | `thread.title:("renewable energy" OR "clean energy" OR renewables)` |
| Solar | `thread.title:("solar power" OR "solar energy" OR photovoltaic OR "solar farm")` |
| Wind | `thread.title:("wind power" OR "wind energy" OR "wind farm" OR "offshore wind")` |
| Storage | `thread.title:("energy storage" OR "battery storage" OR "grid-scale battery")` |
| Hydrogen | `thread.title:("green hydrogen" OR "hydrogen energy" OR "hydrogen plant")` |
| Policy | `thread.title:("energy policy" OR "energy transition" OR "climate policy")` |

Queries are **anchored to the headline** (`thread.title:`) rather than full text — a bare
phrase match returns any article that mentions it once, which is mostly noise — and every
query adds `language:english site_type:news domain_rank:<100000` so results come from
established English-language news outlets.

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
