/**
 * Renewable-energy market/news tracker backed by the Webz.io News API.
 *
 * Zero-dependency Node server (built-in `http` + `https` only):
 *   - serves the dashboard UI from ./public
 *   - proxies segment feeds at /api/feed?segment=<key> so the Webz.io token
 *     never reaches the browser
 *   - caches each segment in-memory for 10 minutes — Webz.io requests cost
 *     credits (`cost`/`balance` in the response), so browsing the UI is free
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// --- minimal .env loader (no dotenv dependency) -----------------------------
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

const TOKEN = process.env.WEBZ_TOKEN;
if (!TOKEN) {
  console.error("WEBZ_TOKEN is not set. Copy .env.example to .env and paste your Webz.io token.");
  process.exit(1);
}

const PORT = Number(process.env.PORT || 3000);
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min per segment
const PAGE_SIZE = 10;

// --- market segments: one Webz.io boolean query each ------------------------
// Queries are anchored to the headline (thread.title) — a bare full-text match
// returns any article that mentions the phrase once, which is mostly noise.
const SEGMENTS = {
  all:      { label: "All renewables",   q: 'thread.title:("renewable energy" OR "clean energy" OR renewables)' },
  solar:    { label: "Solar",            q: 'thread.title:("solar power" OR "solar energy" OR photovoltaic OR "solar farm")' },
  wind:     { label: "Wind",             q: 'thread.title:("wind power" OR "wind energy" OR "wind farm" OR "offshore wind")' },
  storage:  { label: "Storage",          q: 'thread.title:("energy storage" OR "battery storage" OR "grid-scale battery")' },
  hydrogen: { label: "Hydrogen",         q: 'thread.title:("green hydrogen" OR "hydrogen energy" OR "hydrogen plant")' },
  policy:   { label: "Policy",           q: 'thread.title:("energy policy" OR "energy transition" OR "climate policy")' },
};

const cache = new Map(); // segment -> { at, payload }

// --- LLM analysis (optional: /api/analyze 503s cleanly without the key) -----
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const ANALYSIS_MODEL = "xiaomi/mimo-v2.5";
const analysisCache = new Map(); // digest hash -> { at, analysis }
const ANALYSIS_TTL_MS = 15 * 60 * 1000;

const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    brief: { type: "string", description: "3-4 sentence market brief on this renewable-energy segment's news cycle" },
    signals: { type: "array", items: { type: "string" }, description: "2-4 concrete market signals visible in these articles (deals, policy moves, capacity numbers)" },
    regions_in_play: { type: "array", items: { type: "string" }, description: "1-3 geographies where the action is, with one clause of why" },
    watch_next: { type: "array", items: { type: "string" }, description: "1-3 concrete things to watch next in this segment" },
    momentum: { type: "string", enum: ["accelerating", "steady", "cooling", "mixed"], description: "Overall read of the segment's momentum from this coverage" },
  },
  required: ["brief", "signals", "regions_in_play", "watch_next", "momentum"],
  additionalProperties: false,
};

async function analyzeSegment(payload) {
  const digest = payload.articles.map((a) => ({
    title: a.title,
    source: a.site,
    country: a.country,
    published: a.published,
    summary: (a.summary || "").slice(0, 400),
  }));
  const key = crypto.createHash("sha256").update(JSON.stringify([payload.segment, digest])).digest("hex");
  const hit = analysisCache.get(key);
  if (hit && Date.now() - hit.at < ANALYSIS_TTL_MS) return { ...hit.analysis, cached: true };

  const res = await fetch(OPENROUTER_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: ANALYSIS_MODEL,
      max_tokens: 4000,
      messages: [
        {
          role: "system",
          content:
            "You are an energy-market analyst writing a terse, concrete brief for an " +
            "investor tracking the renewable-energy sector. Ground every claim in the " +
            "supplied articles — never invent deals, numbers, or outlets. If coverage " +
            "is thin or off-topic, say so plainly. Field rules: 'brief' is exactly 3-4 " +
            "plain prose sentences — no markdown, no headers, no line breaks, no lists. " +
            "Every array item is one short plain-text phrase or sentence about the " +
            "news itself — never about these instructions or your process. Never use " +
            "markdown syntax in any field.",
        },
        {
          role: "user",
          content:
            `Segment: ${payload.label} (renewable energy)\n` +
            `Articles indexed in the last 30 days: ${payload.totalResults}\n` +
            `Latest articles (deduplicated sample):\n${JSON.stringify(digest, null, 1)}`,
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "analysis", strict: true, schema: ANALYSIS_SCHEMA },
      },
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`Upstream API error: HTTP ${res.status}`);
  const data = await res.json();
  const analysis = JSON.parse(data.choices[0].message.content);
  analysis.model = data.model || ANALYSIS_MODEL;
  analysis.generatedAt = new Date().toISOString();
  analysisCache.set(key, { at: Date.now(), analysis });
  return { ...analysis, cached: false };
}

// --- Webz.io call ------------------------------------------------------------
function fetchWebz(query) {
  const params = new URLSearchParams({
    token: TOKEN,
    // domain_rank cap keeps established outlets; filters AND with the title group
    q: `${query} language:english site_type:news domain_rank:<100000`,
    sort: "crawled",
    format: "json",
    size: String(PAGE_SIZE),
    webz_reporter: "true",
    includeSyndicated: "false",
    allowNewsHistory: "false",
  });
  const url = `https://api.webz.io/api/news?${params}`;

  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { Accept: "application/json" } }, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            return reject(new Error(`Webz.io API error: HTTP ${res.statusCode}`));
          }
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(err);
          }
        });
      })
      .on("error", reject)
      .setTimeout(30000, function () { this.destroy(new Error("Webz.io API timeout")); });
  });
}

// --- reduce raw posts to a dashboard-ready payload ---------------------------
function aggregate(segmentKey, data) {
  const posts = data.posts || [];
  const countries = {};
  const sites = {};

  // Cross-site syndication slips past includeSyndicated=false — drop repeats
  // of the same headline.
  const seenTitles = new Set();
  const deduped = posts.filter((post) => {
    const key = (post.title || (post.thread || {}).title || "").trim().toLowerCase();
    if (key && seenTitles.has(key)) return false;
    seenTitles.add(key);
    return true;
  });

  const articles = deduped.map((post) => {
    const thread = post.thread || {};
    if (thread.country) countries[thread.country] = (countries[thread.country] || 0) + 1;
    if (thread.site) sites[thread.site] = (sites[thread.site] || 0) + 1;
    // Some sources stuff the whole article into the title field — clamp it.
    let title = (post.title || thread.title || "(untitled)").trim();
    if (title.length > 140) title = title.slice(0, 140).replace(/\s+\S*$/, "") + "…";
    return {
      title,
      url: post.url,
      site: thread.site || "unknown",
      country: thread.country || null,
      published: post.published,
      sentiment: post.sentiment && post.sentiment !== "none" ? post.sentiment : null,
      summary: (post.summary || (post.text || "").slice(0, 280)).trim(),
      image: thread.main_image || null,
      domainRank: thread.domain_rank || null,
    };
  });

  const rank = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]);

  return {
    segment: segmentKey,
    label: SEGMENTS[segmentKey].label,
    totalResults: data.total_results || 0, // coverage volume, last 30 days
    countries: rank(countries).slice(0, 8),
    topSites: rank(sites).slice(0, 6),
    articles,
    apiBalance: data.balance ?? null,
    cached: false,
    fetchedAt: new Date().toISOString(),
  };
}

async function getSegment(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return { ...hit.payload, cached: true };
  }
  const payload = aggregate(key, await fetchWebz(SEGMENTS[key].q));
  cache.set(key, { at: Date.now(), payload });
  return payload;
}

// --- tiny HTTP server ---------------------------------------------------------
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const json = (code, body) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  if (url.pathname === "/api/segments") {
    return json(200, Object.entries(SEGMENTS).map(([key, s]) => ({ key, label: s.label })));
  }

  if (url.pathname === "/api/analyze") {
    const key = url.searchParams.get("segment") || "all";
    if (!SEGMENTS[key]) return json(400, { error: `Unknown segment '${key}'` });
    if (!OPENROUTER_API_KEY) return json(503, { error: "OPENROUTER_API_KEY is not configured on the server." });
    try {
      const payload = await getSegment(key); // cache hit if the feed already loaded it
      if (!payload.articles.length) return json(404, { error: "No articles to analyze in this segment." });
      return json(200, await analyzeSegment(payload));
    } catch (err) {
      return json(502, { error: err.message });
    }
  }

  if (url.pathname === "/api/feed") {
    const key = url.searchParams.get("segment") || "all";
    if (!SEGMENTS[key]) return json(400, { error: `Unknown segment '${key}'` });
    try {
      return json(200, await getSegment(key));
    } catch (err) {
      return json(502, { error: err.message });
    }
  }

  // static files from ./public (default: index.html)
  const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const file = path.join(__dirname, "public", path.normalize(rel));
  if (!file.startsWith(path.join(__dirname, "public")) || !fs.existsSync(file)) {
    res.writeHead(404).end("Not found");
    return;
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

// No host binding: Vercel's Node runtime captures the server via listen()
server.listen(PORT, () => {
  console.log(`Renewable-energy market tracker → http://localhost:${PORT}`);
  console.log(`Segments: ${Object.keys(SEGMENTS).join(", ")} · cache TTL ${CACHE_TTL_MS / 60000} min`);
});
