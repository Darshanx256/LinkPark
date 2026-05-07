const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const app = express();
const PORT = process.env.PORT || 3000;
const TOKEN_TTL_SECONDS = parsePositiveInt(process.env.PROXY_TOKEN_TTL_SECONDS, 300);
const SESSION_RATE_LIMIT_WINDOW_MS = parsePositiveInt(process.env.SESSION_RATE_LIMIT_WINDOW_MS, 60 * 1000);
const SESSION_RATE_LIMIT_MAX = parsePositiveInt(process.env.SESSION_RATE_LIMIT_MAX, 20);
const API_RATE_LIMIT_WINDOW_MS = parsePositiveInt(process.env.API_RATE_LIMIT_WINDOW_MS, 60 * 1000);
const API_RATE_LIMIT_MAX = parsePositiveInt(process.env.API_RATE_LIMIT_MAX, 120);
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

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

/**
 * Returns a shuffled copy of the key indices array.
 * Guarantees each key is tried exactly once per request, in a random order.
 */
function shuffleKeys() {
  return Array.from({ length: TFKEYS.length }, (_, i) => i)
    .sort(() => Math.random() - 0.5);
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
 * Periodic sweep: removes all expired entries every 6 hours.
 * Prevents stale entries from accumulating when they are never re-requested.
 */
setInterval(() => {
  const now = Date.now();
  let swept = 0;
  for (const [key, entry] of cache.entries()) {
    if (now > entry.expires) { cache.delete(key); swept++; }
  }
  if (swept) console.log(`[cache sweep] removed ${swept} expired entries, ${cache.size} remaining`);
}, 6 * 60 * 60 * 1000).unref(); // .unref() so the timer never blocks process exit

setInterval(() => {
  sweepRateLimit(sessionLimit);
  sweepRateLimit(apiLimit);
}, 10 * 60 * 1000).unref();

/**
 * Authorized origins for browser-based CORS requests.
 * Restricts access to the proxy server to specific frontend deployments.
 */
const ALLOWED_ORIGINS = (process.env.SERVICE || '')
  .split(',')
  .map(normalizeAllowedOrigin)
  .filter(Boolean);
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || '';
const PROXY_SESSION_SECRET = process.env.PROXY_SESSION_SECRET || '';
const sessionLimit = new Map();
const apiLimit = new Map();

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeAllowedOrigin(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  try {
    return new URL(trimmed).origin;
  } catch (_) {
    console.warn(`Ignoring invalid SERVICE origin: ${trimmed}`);
    return '';
  }
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function signTokenPayload(payload) {
  return crypto
    .createHmac('sha256', PROXY_SESSION_SECRET)
    .update(payload)
    .digest('base64url');
}

function createProxyToken(origin) {
  const now = Math.floor(Date.now() / 1000);
  const payload = base64url(JSON.stringify({
    origin,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
    nonce: crypto.randomBytes(16).toString('base64url')
  }));
  return `${payload}.${signTokenPayload(payload)}`;
}

function verifyProxyToken(token, origin) {
  if (!PROXY_SESSION_SECRET || !token || !token.includes('.')) return null;

  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;

  const expected = signTokenPayload(payload);
  const receivedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (receivedBuffer.length !== expectedBuffer.length) return null;
  if (!crypto.timingSafeEqual(receivedBuffer, expectedBuffer)) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (data.origin !== origin) return null;
    if (!Number.isFinite(data.exp) || data.exp <= Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch (_) {
    return null;
  }
}

function getClientIp(req) {
  let clientIp = req.ip || '';
  if (clientIp.startsWith('::ffff:')) clientIp = clientIp.replace('::ffff:', '');
  return clientIp;
}

function isAllowedOrigin(origin) {
  return Boolean(origin && ALLOWED_ORIGINS.includes(origin));
}

function deny(req, res, status, code) {
  console.warn(`[deny] ${code} ${req.method} ${req.path} - IP: ${getClientIp(req)}`);
  res.status(status).json({ error: code });
}

function consumeRateLimit(store, key, windowMs, max) {
  const now = Date.now();
  const current = store.get(key);
  if (!current || now >= current.resetAt) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  current.count += 1;
  return current.count <= max;
}

function sweepRateLimit(store) {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (now >= entry.resetAt) store.delete(key);
  }
}

function hasCompatibleFetchMetadata(req) {
  const site = req.get('sec-fetch-site');
  const mode = req.get('sec-fetch-mode');
  const dest = req.get('sec-fetch-dest');

  if (site && !['same-origin', 'same-site', 'cross-site'].includes(site)) return false;
  if (mode && !['cors', 'same-origin'].includes(mode)) return false;
  if (dest && dest !== 'empty') return false;
  return true;
}

function requireAllowedOrigin(req, res, next) {
  if (isAllowedOrigin(req.get('origin'))) return next();
  return deny(req, res, 403, 'blocked_origin');
}

function requireProxyAuth(req, res, next) {
  const origin = req.get('origin');
  if (!isAllowedOrigin(origin)) return deny(req, res, 403, 'blocked_origin');
  if (!hasCompatibleFetchMetadata(req)) return deny(req, res, 403, 'blocked_fetch_metadata');

  const auth = req.get('authorization') || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  const tokenData = match ? verifyProxyToken(match[1], origin) : null;
  if (!tokenData) return deny(req, res, 401, 'invalid_token');

  const tokenKey = `${origin}:${tokenData.nonce || match[1].slice(0, 24)}:${getClientIp(req)}`;
  if (!consumeRateLimit(apiLimit, tokenKey, API_RATE_LIMIT_WINDOW_MS, API_RATE_LIMIT_MAX)) {
    return deny(req, res, 429, 'rate_limited');
  }

  req.proxySession = tokenData;
  return next();
}

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
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} - IP: ${getClientIp(req)}`);
  next();
});

app.use(express.json({ limit: '16kb' }));

app.use(cors({
  origin: (origin, callback) => {
    if (isAllowedOrigin(origin)) {
      callback(null, true);
    } else {
      callback(null, false);
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

/** IP allowlist guard for non-browser requests. */
app.use((req, res, next) => {
  if (ALLOWED_IPS.length === 0) return next();

  const clientIp = getClientIp(req);

  if (ALLOWED_IPS.includes(clientIp) || clientIp === '127.0.0.1' || clientIp === '::1') return next();
  if (isAllowedOrigin(req.get('origin'))) return next();

  return deny(req, res, 403, 'ip_not_allowed');
});

/**
 * Dynamic Preview Wrapper for Social Sharing.
 * Decodes the 's' parameter, fetches high-res artwork, and serves OG tags.
 * Redirects the actual user to the GitHub Pages site.
 */
app.get('/share', async (req, res) => {
  const s = req.query.s;
  const baseUrl = 'https://darshanx256.github.io/LinkPark/';
  
  if (!s) return res.redirect(baseUrl);

  try {
    // 1. Decompress metadata
    const bin = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const decompressed = zlib.inflateSync(bin).toString('utf8');
    const [title, artist, itunesId] = decompressed.split('|');

    if (!title || !artist) throw new Error('Invalid payload');

    // 2. Fetch high-res artwork from iTunes (not included in 's' to save space)
    let art = `${baseUrl}assets/logo.webp`;
    if (itunesId) {
      try {
        const r = await fetch(`https://itunes.apple.com/lookup?id=${itunesId}`);
        const d = await r.json();
        if (d.results?.[0]) {
          art = d.results[0].artworkUrl100.replace('100x100bb', '600x600bb');
        }
      } catch (err) {
        console.warn(`[share] iTunes lookup failed for ${itunesId}:`, err.message);
      }
    }

    // 3. Serve page with Open Graph tags and immediate redirect
    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${title} — ${artist}</title>
  <meta property="og:title" content="${title} — ${artist}">
  <meta property="og:description" content="Listen to this track on your favorite streaming platform via LinkPark.">
  <meta property="og:image" content="${art}">
  <meta property="og:type" content="music.song">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="theme-color" content="#0a0a0f">
  <meta http-equiv="refresh" content="0;url=${baseUrl}?s=${encodeURIComponent(s)}">
</head>
<body style="background:#0a0a0f;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
  <div style="text-align:center;">
    <p>Redirecting to LinkPark...</p>
    <script>window.location.href = "${baseUrl}?s=" + encodeURIComponent("${s}");</script>
  </div>
</body>
</html>`);
  } catch (err) {
    console.error(`[share] Failed to generate preview for ${s.slice(0, 10)}...:`, err.message);
    res.redirect(`${baseUrl}?s=${encodeURIComponent(s)}`);
  }
});


app.post('/api/session', requireAllowedOrigin, async (req, res) => {
  const origin = req.get('origin');
  if (!TURNSTILE_SECRET_KEY || !PROXY_SESSION_SECRET) {
    return deny(req, res, 503, 'proxy_auth_not_configured');
  }
  if (!hasCompatibleFetchMetadata(req)) return deny(req, res, 403, 'blocked_fetch_metadata');

  const limitKey = `${origin}:${getClientIp(req)}`;
  if (!consumeRateLimit(sessionLimit, limitKey, SESSION_RATE_LIMIT_WINDOW_MS, SESSION_RATE_LIMIT_MAX)) {
    return deny(req, res, 429, 'rate_limited');
  }

  const turnstileToken = req.body && req.body.turnstileToken;
  if (!turnstileToken || typeof turnstileToken !== 'string') {
    return deny(req, res, 400, 'missing_turnstile_token');
  }

  try {
    const params = new URLSearchParams();
    params.set('secret', TURNSTILE_SECRET_KEY);
    params.set('response', turnstileToken);
    params.set('remoteip', getClientIp(req));

    const response = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      body: params
    });
    const result = await response.json();

    if (!result.success) return deny(req, res, 401, 'turnstile_failed');

    const token = createProxyToken(origin);
    res.json({ token, expiresIn: TOKEN_TTL_SECONDS });
  } catch (error) {
    console.warn('Turnstile verification error:', error.message);
    res.status(502).json({ error: 'turnstile_unavailable' });
  }
});

/**
 * Odesli proxy with 48-hour caching.
 * Cache key is the normalized URL + country pair so regional variants are cached separately.
 */
app.get('/api/odesli', requireProxyAuth, async (req, res) => {
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
app.get('/api/search', requireProxyAuth, async (req, res) => {
  const { query } = req.query;

  if (!query) return res.status(400).json({ error: 'Query is required' });
  if (TFKEYS.length === 0) return res.status(500).json({ error: 'Missing API Key' });

  const cacheKey = `tf:${query}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    console.log(`[cache hit] ${cacheKey}`);
    return res.json(cached);
  }

  // Shuffle key indices once — guaranteed unique order, no retry collisions
  const keyOrder = shuffleKeys();
  const maxAttempts = Math.min(keyOrder.length, 9);

  for (let i = 0; i < maxAttempts; i++) {
    const currentKey = TFKEYS[keyOrder[i]];
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
      console.warn(`Tinyfish attempt ${i + 1} (key #${keyOrder[i]}) failed: ${response.status}`);
    } catch (error) {
      console.warn(`Tinyfish attempt ${i + 1} (key #${keyOrder[i]}) errored:`, error.message);
    }
  }

  res.status(502).json({ error: 'Search failed after multiple API key attempts.' });
});

/** Cache stats endpoint — useful for monitoring without exposing data. */
app.get('/api/cache-stats', requireProxyAuth, (req, res) => {
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
