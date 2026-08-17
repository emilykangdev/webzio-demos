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
const SEGMENTS = {
  all:      { label: "All renewables",   q: '"renewable energy" OR "clean energy"' },
  solar:    { label: "Solar",            q: '"solar energy" OR "solar power" OR photovoltaic' },
  wind:     { label: "Wind",             q: '"wind energy" OR "wind power" OR "offshore wind"' },
  storage:  { label: "Storage",          q: '"energy storage" OR "battery storage" OR "grid-scale battery"' },
  hydrogen: { label: "Hydrogen",         q: '"green hydrogen" OR "hydrogen energy"' },
  policy:   { label: "Policy",           q: '"renewable energy" AND (policy OR regulation OR subsidy OR "tax credit")' },
};

const cache = new Map(); // segment -> { at, payload }

// --- Webz.io call ------------------------------------------------------------
function fetchWebz(query) {
  const params = new URLSearchParams({
    token: TOKEN,
    q: `(${query}) language:english site_type:news`,
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

  const articles = posts.map((post) => {
    const thread = post.thread || {};
    if (thread.country) countries[thread.country] = (countries[thread.country] || 0) + 1;
    if (thread.site) sites[thread.site] = (sites[thread.site] || 0) + 1;
    return {
      title: post.title || thread.title || "(untitled)",
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

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Renewable-energy market tracker → http://localhost:${PORT}`);
  console.log(`Segments: ${Object.keys(SEGMENTS).join(", ")} · cache TTL ${CACHE_TTL_MS / 60000} min`);
});
