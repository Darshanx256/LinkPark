const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

/**
 * Parses up to 9 comma-separated API keys from the TFKEY environment variable.
 * Keys are selected randomly per request to distribute load evenly
 * and avoid predictable rate-limit patterns.
 */
const TFKEYS = (process.env.TFKEY || '')
  .split(',')
  .map(k => k.trim())
  .filter(Boolean)
  .slice(0, 9);

/** Returns a cryptographically-random key index each call. */
function pickKey() {
  return Math.floor(Math.random() * TFKEYS.length);
}

/**
 * In-memory LRU-style cache with a hard cap on entry count.
 * Prevents unbounded memory growth on busy deployments.
 * Each entry stores the parsed JSON payload and an expiry timestamp.
 */
const CACHE_TTL   = 48 * 60 * 60 * 1000; // 48 hours in ms
const CACHE_LIMIT = 500;                  // max entries before eviction

const cache = new Map();

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) { cache.delete(key); return null; }
  return entry.data;
}

function cacheSet(key, data) {
  // Evict the oldest entry if we've hit the limit
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  cache.set(key, { data, expires: Date.now() + CACHE_TTL });
}

/**
 * Authorized origins for browser-based CORS requests.
 * Restricts access to the proxy server to specific frontend deployments.
 */
const ALLOWED_ORIGINS = (process.env.SERVICE || '').split(',').map(s => s.trim()).filter(Boolean);

/**
 * Parses the IP_ALLOWLIST environment variable into a lookup array.
 * Required for non-browser monitoring services like UptimeRobot.
 */
let ALLOWED_IPS = [];
try {
  const list = JSON.parse(process.env.IP_ALLOWLIST || '{}');
  if (list.prefixes) {
    ALLOWED_IPS = list.prefixes
      .filter(p => p && p.ip_prefix)
      .map(p => p.ip_prefix.split('/')[0]);
  }
} catch (e) {
  console.error('Failed to parse IP_ALLOWLIST:', e.message);
}

/** Configures the application to trust the reverse proxy (Render). */
app.set('trust proxy', true);

/** Public health check — bypasses all auth middleware. */
app.get('/health', (req, res) => res.status(200).send('OK'));

/** Global request logger. */
app.use((req, res, next) => {
  let clientIp = req.ip || '';
  if (clientIp.startsWith('::ffff:')) clientIp = clientIp.replace('::ffff:', '');
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} - IP: ${clientIp}`);
  next();
});

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('CORS blocked: Origin not allowed'));
    }
  }
}));

/** IP allowlist guard for non-browser requests. */
app.use((req, res, next) => {
  if (ALLOWED_IPS.length === 0) return next();

  let clientIp = req.ip || '';
  if (clientIp.startsWith('::ffff:')) clientIp = clientIp.replace('::ffff:', '');

  if (ALLOWED_IPS.includes(clientIp) || clientIp === '127.0.0.1' || clientIp === '::1') return next();
  if (req.headers.origin && ALLOWED_ORIGINS.includes(req.headers.origin)) return next();

  console.log(`Access denied for IP: ${clientIp}`);
  res.status(403).json({ error: 'Access denied: IP not allowed', yourIp: clientIp });
});

/**
 * Odesli proxy with 48-hour caching.
 * Cache key is the normalized URL + country pair so regional variants are cached separately.
 */
app.get('/api/odesli', async (req, res) => {
  const { url, userCountry } = req.query;
  if (!url) return res.status(400).json({ error: 'url is required' });

  const cacheKey = `odesli:${url}:${userCountry || 'US'}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    console.log(`[cache hit] ${cacheKey}`);
    return res.json(cached);
  }

  const target = `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(url)}&userCountry=${userCountry || 'US'}`;

  /**
   * Randomized fetch strategies to bypass potential Odesli IP blocks.
   * Shuffled each request to distribute load across fallback proxies.
   */
  const strategies = [
    async () => await fetch(target),
    async () => await fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(target)}`),
    async () => {
      const r = await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(target)}`);
      if (!r.ok) return r;
      const j = await r.json();
      return { ok: true, json: () => JSON.parse(j.contents) };
    },
    async () => await fetch(`https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(target)}`)
  ].sort(() => Math.random() - 0.5);

  for (let i = 0; i < strategies.length; i++) {
    try {
      const response = await strategies[i]();
      if (response.ok) {
        const data = await response.json();
        cacheSet(cacheKey, data);
        return res.json(data);
      }
      console.warn(`Odesli strategy attempt ${i + 1} failed: ${response.status}`);
    } catch (error) {
      console.warn(`Odesli strategy attempt ${i + 1} error:`, error.message);
    }
  }

  res.status(502).json({ error: 'Odesli resolution failed across all available proxy strategies.' });
});

/**
 * Tinyfish search proxy with 48-hour caching and random key selection.
 * Each query is cached by its exact text so identical searches never
 * hit the Tinyfish API twice within the TTL window.
 * On a rate-limit (429) or server error, retries with a different random key.
 */
app.get('/api/search', async (req, res) => {
  const { query } = req.query;

  if (!query) return res.status(400).json({ error: 'Query is required' });
  if (TFKEYS.length === 0) return res.status(500).json({ error: 'Missing API Key' });

  const cacheKey = `tf:${query}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    console.log(`[cache hit] ${cacheKey}`);
    return res.json(cached);
  }

  // Attempt with up to min(keyCount, 9) unique random keys before giving up
  const tried = new Set();
  const maxAttempts = Math.min(TFKEYS.length, 9);

  for (let i = 0; i < maxAttempts; i++) {
    // Pick a random key we haven't tried yet this request
    let keyIdx = pickKey();
    let safety = 0;
    while (tried.has(keyIdx) && safety++ < 20) keyIdx = pickKey();
    tried.add(keyIdx);

    const currentKey = TFKEYS[keyIdx];
    try {
      const response = await fetch(
        `https://api.search.tinyfish.ai/?query=${encodeURIComponent(query)}`,
        { headers: { 'X-API-Key': currentKey } }
      );
      if (response.ok) {
        const data = await response.json();
        cacheSet(cacheKey, data);
        return res.json(data);
      }
      console.warn(`Tinyfish attempt ${i + 1} (key #${keyIdx}) failed: ${response.status}`);
    } catch (error) {
      console.warn(`Tinyfish attempt ${i + 1} (key #${keyIdx}) errored:`, error.message);
    }
  }

  res.status(502).json({ error: 'Search failed after multiple API key attempts.' });
});

/** Cache stats endpoint — useful for monitoring without exposing data. */
app.get('/api/cache-stats', (req, res) => {
  const now = Date.now();
  let active = 0;
  for (const entry of cache.values()) {
    if (now <= entry.expires) active++;
  }
  res.json({ total: cache.size, active, limit: CACHE_LIMIT, ttl_hours: CACHE_TTL / 3600000 });
});

/**
 * Deployment Mode Configuration.
 * Proxy-only mode: when SERVICE env var is set, acts as API proxy for external frontends.
 * Standalone mode: serves both the API and the static LinkPark frontend.
 */
if (ALLOWED_ORIGINS.length > 0) {
  console.log(`Proxy-only mode. Whitelist: ${ALLOWED_ORIGINS.join(', ')}`);
} else {
  app.use(express.static(__dirname));

  app.get('/config.js', (req, res) => {
    res.type('application/javascript').send('// Standalone mode: key handled by proxy');
  });

  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`LinkPark is live on port ${PORT} | Keys loaded: ${TFKEYS.length} | Cache limit: ${CACHE_LIMIT} entries`);
});
