# Company News Dashboard (Python + Flask)

Monitor press coverage for any company via the [Webz.io News API](https://webz.io/products/news-api):
type a company name and get an editorial-style board with

- **Coverage volume** — `total_results` for the query (articles indexed in the last 30 days)
- **Sentiment split** — company-level sentiment from Webz.io's organization entities
  (`entities.organizations[].sentiment`), falling back to post-level `sentiment`
- **Top sources & countries** — aggregated from `thread.site` / `thread.country`
- **Latest articles** — title, summary, image, outlet, recency, per-article sentiment tag

## Run it

```bash
cp .env.example .env       # paste your Webz.io token into .env
pip install -r requirements.txt
python app.py
# → http://localhost:5001
```

## How it uses the API

One call per company query:

```
GET https://api.webz.io/api/news
    ?q=(thread.title:"Tesla" OR organization:"Tesla") language:english site_type:news domain_rank:<50000
    &sort=crawled&size=10&format=json
    &webz_reporter=true&includeSyndicated=false&allowNewsHistory=false
```

Design choices worth noting:

- **Relevance engineering.** A naive full-text `"Tesla"` query matches any article
  that mentions the word once — news-roundup pages and unrelated local stories.
  Instead the query requires the company in the **headline** (`thread.title:`) OR as a
  Webz.io-recognized **organization entity** (`organization:`), and caps
  `domain_rank:<50000` so results come from established outlets.

- **Token stays server-side.** The browser only ever talks to the Flask endpoint
  (`/api/company?name=…`); the Webz.io token never ships to the client.
- **Credit-aware caching.** Every Webz.io request costs credits (the response reports
  `cost` and remaining `balance`), so responses are cached in-memory for 5 minutes per
  query — re-searching the same company or refreshing the page is free.
- **Aggregation happens server-side** — the client receives a small, dashboard-ready
  payload (sentiment counts, ranked sources/countries, trimmed summaries), not raw posts.
