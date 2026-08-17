"""Company news monitoring dashboard backed by the Webz.io News API.

The Flask server owns the Webz.io token and does all API calls server-side,
aggregates the posts into dashboard-ready metrics, and caches responses
in-memory so repeated browsing doesn't burn API credits (every Webz.io
request has a credit cost — see `cost`/`balance` in the response).
"""

import os
import time
from collections import Counter

import requests
from flask import Flask, jsonify, render_template, request

WEBZ_ENDPOINT = "https://api.webz.io/api/news"
CACHE_TTL_SECONDS = 300  # 5 min — company coverage doesn't move faster than this
POSTS_PER_QUERY = 10


def _load_dotenv(path: str = ".env") -> None:
    """Minimal .env loader (KEY=VALUE lines) so the demo has no dotenv dep."""
    if not os.path.exists(path):
        return
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip())


_load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

WEBZ_TOKEN = os.environ.get("WEBZ_TOKEN")
if not WEBZ_TOKEN:
    raise SystemExit(
        "WEBZ_TOKEN is not set. Copy .env.example to .env and paste your Webz.io token."
    )

app = Flask(__name__)

# query string -> (fetched_at_epoch, payload)
_cache: dict[str, tuple[float, dict]] = {}


def fetch_company_news(company: str) -> dict:
    """One Webz.io call for a company, reduced to what the dashboard renders."""
    # Relevance engineering (a bare full-text '"Tesla"' matches any article that
    # mentions the word once, mostly junk): require the company in the headline
    # OR as a Webz.io-recognized organization entity, and cap domain_rank to
    # keep established outlets. Quotes are stripped from input above so the
    # name can't break out of the fielded query.
    query = (
        f'(thread.title:"{company}" OR organization:"{company}") '
        f"language:english site_type:news domain_rank:<50000"
    )

    cached = _cache.get(query)
    if cached and time.time() - cached[0] < CACHE_TTL_SECONDS:
        return {**cached[1], "cached": True}

    response = requests.get(
        WEBZ_ENDPOINT,
        params={
            "token": WEBZ_TOKEN,
            "q": query,
            "sort": "crawled",
            "format": "json",
            "size": POSTS_PER_QUERY,
            "webz_reporter": "true",
            "includeSyndicated": "false",
            "allowNewsHistory": "false",
        },
        headers={"Accept": "application/json"},
        timeout=30,
    )
    response.raise_for_status()
    data = response.json()

    payload = _aggregate(company, data)
    _cache[query] = (time.time(), payload)
    return payload


def _aggregate(company: str, data: dict) -> dict:
    posts = data.get("posts") or []
    company_lower = company.lower()

    sentiments: Counter = Counter()
    sources: Counter = Counter()
    countries: Counter = Counter()
    articles = []
    seen_titles: set[str] = set()

    for post in posts:
        thread = post.get("thread") or {}

        # Cross-site syndication slips past includeSyndicated=false — drop
        # repeats of the same headline.
        title_key = (post.get("title") or thread.get("title") or "").strip().lower()
        if title_key and title_key in seen_titles:
            continue
        seen_titles.add(title_key)

        # Prefer company-level sentiment: Webz.io tags each organization entity
        # with its own sentiment. Fall back to the post-level sentiment.
        sentiment = None
        for org in (post.get("entities") or {}).get("organizations") or []:
            if company_lower in (org.get("name") or "").lower():
                if org.get("sentiment") and org["sentiment"] != "none":
                    sentiment = org["sentiment"]
                break
        if sentiment is None:
            sentiment = post.get("sentiment")
        if sentiment in ("positive", "negative", "neutral"):
            sentiments[sentiment] += 1
        else:
            sentiments["unrated"] += 1

        site = thread.get("site") or "unknown"
        sources[site] += 1
        if thread.get("country"):
            countries[thread["country"]] += 1

        text = (post.get("text") or "").strip()
        # Some sources stuff the whole article into the title field — clamp it.
        title = (post.get("title") or thread.get("title") or "(untitled)").strip()
        if len(title) > 140:
            title = title[:140].rsplit(" ", 1)[0] + "…"
        articles.append(
            {
                "title": title,
                "url": post.get("url"),
                "site": site,
                "country": thread.get("country"),
                "published": post.get("published"),
                "sentiment": sentiment if sentiment != "none" else None,
                "summary": (post.get("summary") or text[:280]).strip(),
                "image": thread.get("main_image"),
                "domain_rank": thread.get("domain_rank"),
            }
        )

    return {
        "company": company,
        "total_results": data.get("total_results", 0),
        "sentiment": dict(sentiments),
        "top_sources": sources.most_common(6),
        "countries": countries.most_common(8),
        "articles": articles,
        "api_balance": data.get("balance"),
        "cached": False,
        "fetched_at": time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime()),
    }


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/company")
def api_company():
    company = (request.args.get("name") or "").replace('"', "").strip()
    if not company or len(company) > 80:
        return jsonify({"error": "Pass a company name, e.g. /api/company?name=Tesla"}), 400
    try:
        return jsonify(fetch_company_news(company))
    except requests.HTTPError as exc:
        return jsonify({"error": f"Webz.io API error: {exc.response.status_code}"}), 502
    except requests.RequestException as exc:
        return jsonify({"error": f"Webz.io API unreachable: {exc}"}), 502


if __name__ == "__main__":
    # 5001: macOS AirPlay squats on 5000
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", 5001)), debug=False)
