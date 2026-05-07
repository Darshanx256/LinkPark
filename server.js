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

/**
 * Parses up to 9 comma-separated API keys from the TFKEY environment variable.
 * Keys are selected randomly per request to distribute load evenly
 * and avoid predictable rate-limit patterns.
 */
const TFKEYS = (process.env.TFKEY || '').split(',').map(k => k.trim()).filter(Boolean);

/**
 * Parses allowed origins from the SERVICE environment variable.
 * Used for CORS configuration in both proxy and standalone modes.
 */
const ALLOWED_ORIGINS = (process.env.SERVICE || '').split(',').map(o => o.trim()).filter(Boolean);

/**
 * Proof of Work (PoW) configuration.
 * difficulty: Number of leading zeros required in the SHA-256 hash.
 * activeChallenges: Map of valid, single-use seeds pending resolution.
 */
const POW_DIFFICULTY = parsePositiveInt(process.env.POW_DIFFICULTY, 4);
const activeChallenges = new Map();

// Background cleanup for expired challenges every minute
setInterval(() => {
  const now = Date.now();
  for (const [seed, challenge] of activeChallenges.entries()) {
    if (now > challenge.expiresAt) activeChallenges.delete(seed);
  }
}, 60000);

const CACHE_TTL = 14 * 24 * 60 * 60 * 1000;
const cache = new Map();
const CACHE_LIMIT = 500;

function cacheSet(key, value) {
  if (cache.size >= CACHE_LIMIT) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
  cache.set(key, { value, expires: Date.now() + CACHE_TTL });
}

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

/** Rate Limit Stores */
const sessionLimit = new Map();
const apiLimit = new Map();

function parsePositiveInt(val, fallback) {
  const n = parseInt(val);
  return (isNaN(n) || n <= 0) ? fallback : n;
}

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
}

function consumeRateLimit(store, key, windowMs, max) {
  const now = Date.now();
  const current = store.get(key);
  if (!current || now > current.resetAt) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  current.count += 1;
  return current.count <= max;
}

/** Helper to shuffle API key selection order */
function shuffleKeys() {
  return TFKEYS.map((_, i) => i).sort(() => Math.random() - 0.5);
}

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || isAllowedOrigin(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-LP-Nonce', 'X-LP-Seed'],
  maxAge: 86400
};

app.use(cors(corsOptions));

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (ALLOWED_ORIGINS.length === 0) return true;
  return ALLOWED_ORIGINS.some(allowed => origin === allowed || origin.endsWith('.' + allowed));
}

function hasCompatibleFetchMetadata(req) {
  const site = req.get('sec-fetch-site');
  const mode = req.get('sec-fetch-mode');
  if (!site || !mode) return true;
  return ['same-origin', 'same-site', 'cross-site'].includes(site) && mode === 'cors';
}

function deny(req, res, status, code) {
  console.warn(`[deny] ${status} ${code} | IP: ${getClientIp(req)} | UA: ${req.get('user-agent')}`);
  return res.status(status).json({ error: code });
}

function requireAllowedOrigin(req, res, next) {
  if (isAllowedOrigin(req.get('origin'))) return next();
  return deny(req, res, 403, 'blocked_origin');
}

function requireApiAccess(req, res, next) {
  const origin = req.get('origin');
  if (!isAllowedOrigin(origin)) return deny(req, res, 403, 'blocked_origin');
  if (!hasCompatibleFetchMetadata(req)) return deny(req, res, 403, 'blocked_fetch_metadata');

  const seed = req.get('X-LP-Seed');
  const nonce = req.get('X-LP-Nonce');
  
  if (!seed || !nonce) return deny(req, res, 401, 'missing_pow');

  const challenge = activeChallenges.get(seed);
  if (!challenge || challenge.origin !== origin || Date.now() > challenge.expiresAt) {
    if (challenge) activeChallenges.delete(seed);
    return deny(req, res, 401, 'invalid_or_expired_pow_seed');
  }

  // Prevent replay attacks by consuming the seed instantly
  activeChallenges.delete(seed);

  const hash = crypto.createHash('sha256').update(seed + nonce).digest('hex');
  if (!hash.startsWith('0'.repeat(POW_DIFFICULTY))) {
    return deny(req, res, 401, 'invalid_pow_hash');
  }

  const tokenKey = `${origin}:${getClientIp(req)}`;
  if (!consumeRateLimit(apiLimit, tokenKey, API_RATE_LIMIT_WINDOW_MS, API_RATE_LIMIT_MAX)) {
    return deny(req, res, 429, 'rate_limited');
  }

  return next();
}

/** Internal resolution helpers */
async function resolveOdesli(url, country = 'US') {
  // Normalize YouTube Music URLs back to standard YouTube for Odesli's engine
  const targetUrl = url.replace('music.youtube.com', 'youtube.com');
  const cacheKey = `od:${targetUrl}:${country}`;
  const cached = cacheGet(cacheKey);
  if (cached) return JSON.parse(cached);

  const target = `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(targetUrl)}&userCountry=${country}`;
  
  // 'Pro-Proxy' Strategy: Race multiple providers simultaneously to ensure near-zero latency.
  const providers = [
    target,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(target)}`,
    `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(target)}`,
    `https://api.allorigins.win/get?url=${encodeURIComponent(target)}` // Special case for .contents
  ];

  const controller = new AbortController();
  const tasks = providers.map(async (u, i) => {
    try {
      const response = await fetch(u, { signal: controller.signal, timeout: 5000 });
      if (response.ok) {
        let text = await response.text();
        // Handle allorigins.win/get wrapper
        if (u.includes('allorigins.win/get')) {
          try { text = JSON.parse(text).contents; } catch (e) { throw e; }
        }
        
        const data = JSON.parse(text);
        if (data.entityUniqueId) {
          controller.abort(); // Cancel other pending requests
          return { data, text };
        }
      }
      throw new Error('fail');
    } catch (e) { throw e; }
  });

  try {
    // Return the first successful resolution
    const { data, text } = await Promise.any(tasks);
    cacheSet(cacheKey, text);
    return data;
  } catch (e) {
    return null;
  }
}

async function resolveSearch(query) {
  if (TFKEYS.length === 0) return null;
  const cacheKey = `tf:${query}`;
  const cached = cacheGet(cacheKey);
  if (cached) return JSON.parse(cached);

  const keyOrder = shuffleKeys();
  const maxAttempts = Math.min(keyOrder.length, 9);

  for (let i = 0; i < maxAttempts; i++) {
    const currentKey = TFKEYS[keyOrder[i]];
    try {
      const response = await fetch(
        `https://api.search.tinyfish.ai/?query=${encodeURIComponent(query)}`,
        { headers: { 'X-API-Key': currentKey }, timeout: 6000 }
      );
      if (response.ok) {
        const text = await response.text();
        try {
          const data = JSON.parse(text);
          cacheSet(cacheKey, text);
          return data;
        } catch (e) { continue; }
      }
    } catch (error) { continue; }
  }
  return null;
}

/** Endpoints */

async function resolveItunes(query, country = 'US') {
  const cacheKey = `it:${query}:${country}`;
  const cached = cacheGet(cacheKey);
  if (cached) return JSON.parse(cached);

  try {
    const r = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=song&limit=1&country=${country}`);
    if (r.ok) {
      const data = await r.json();
      if (data.results?.[0]) {
        cacheSet(cacheKey, JSON.stringify(data));
        return data;
      }
    }
  } catch (e) { }
  return null;
}

app.get('/api/challenge', requireAllowedOrigin, (req, res) => {
  const seed = crypto.randomBytes(16).toString('hex');
  const origin = req.get('origin');
  activeChallenges.set(seed, { origin, expiresAt: Date.now() + 2 * 60 * 1000 });
  res.json({ seed, difficulty: POW_DIFFICULTY });
});

app.get('/api/odesli', requireApiAccess, async (req, res) => {
  const { url, userCountry } = req.query;
  if (!url) return res.status(400).json({ error: 'URL is required' });
  const data = await resolveOdesli(url, userCountry);
  if (data) return res.json(data);
  res.status(502).json({ error: 'Odesli resolution failed' });
});

app.get('/api/search', requireApiAccess, async (req, res) => {
  const { query } = req.query;
  if (!query) return res.status(400).json({ error: 'Query is required' });
  const data = await resolveSearch(query);
  if (data) return res.json(data);
  res.status(502).json({ error: 'Search failed' });
});

app.get('/api/resolve', requireApiAccess, async (req, res) => {
  const { query, u, artist, album, country } = req.query;
  const isUrlDrop = u && !query;
  
  let od = null;
  let tfSp = null, tfYt = null;
  let itRes = null;
  const initialTasks = [];

  // 1. Initial Batch
  if (u) initialTasks.push(resolveOdesli(u, country).then(d => od = d));
  if (query) {
    const qBase = query + (artist ? ' ' + artist : '');
    initialTasks.push(resolveSearch(qBase + ' spotify track').then(d => tfSp = d));
    initialTasks.push(resolveSearch(qBase + (album ? ' ' + album : '') + ' youtube music topic').then(d => tfYt = d));
  }

  await Promise.allSettled(initialTasks);

  // 2. Secondary Batch (Fallback/Supplemental)
  // If metadata was found via Odesli, use it to fill gaps in Tinyfish or get iTunes data for URL drops
  let ent = od?.entitiesByUniqueId?.[od?.entityUniqueId] || {};
  // Robustness Fallback: If primary entity lookup fails, grab the first available entity in the set
  if (!ent.title && od?.entitiesByUniqueId) {
    const firstId = Object.keys(od.entitiesByUniqueId)[0];
    if (firstId) ent = od.entitiesByUniqueId[firstId];
  }
  if (ent.title) {
    const qMeta = `${ent.title} ${ent.artistName || ''}`;
    const secondaryTasks = [];
    
    // Fill Tinyfish gaps
    if (!tfSp) secondaryTasks.push(resolveSearch(qMeta + ' spotify track').then(d => tfSp = d));
    if (!tfYt) secondaryTasks.push(resolveSearch(qMeta + ' youtube music topic').then(d => tfYt = d));
    
    // Fetch iTunes data only for URL drops (client already has it for manual searches)
    if (isUrlDrop) secondaryTasks.push(resolveItunes(qMeta, country).then(d => itRes = d));

    if (secondaryTasks.length > 0) await Promise.allSettled(secondaryTasks);
  }

  const links = {};
  const platforms = ['spotify', 'youtubeMusic', 'appleMusic', 'youtube', 'amazonMusic', 'tidal', 'deezer', 'pandora'];

  // Priority 1: Odesli native links
  platforms.forEach(pid => {
    let href = od?.linksByPlatform?.[pid]?.url;
    if (!href && pid === 'youtubeMusic') {
      const yt = od?.linksByPlatform?.youtube?.url;
      if (yt && yt.includes('watch')) {
        href = yt.replace(/^(https?:\/\/)?(www\.)?youtube\.com/, '$1music.youtube.com');
      }
    }
    if (href) links[pid] = href;
  });

  // Priority 2: Tinyfish search results
  if (!links.spotify && tfSp?.results) {
    const r = tfSp.results.find(it => it.url.includes('open.spotify.com/track'));
    if (r) links.spotify = r.url;
  }
  if (!links.youtubeMusic && tfYt?.results) {
    const r = tfYt.results.find(it => it.url.includes('music.youtube.com') || it.url.includes('youtube.com/watch'));
    if (r) links.youtubeMusic = (r?.url || '').replace(/^(https?:\/\/)?(www\.)?youtube\.com/, '$1music.youtube.com');
  }

  // Priority 3: iTunes cleanup and preview (especially for URL drops)
  const itTrack = itRes?.results?.[0];
  if (itTrack) {
    if (!links.appleMusic) links.appleMusic = itTrack.trackViewUrl;
  }

  res.json({
    links,
    title: ent.title || itTrack?.trackName || null,
    artist: ent.artistName || itTrack?.artistName || null,
    art: ent.thumbnailUrl || itTrack?.artworkUrl100?.replace('100x100bb', '600x600bb') || null,
    preview: itTrack?.previewUrl || null
  });
});

app.get('/api/cache-stats', requireApiAccess, (req, res) => {
  const now = Date.now();
  let active = 0;
  for (const entry of cache.values()) if (now <= entry.expires) active++;
  res.json({ total: cache.size, active, limit: CACHE_LIMIT, ttl_hours: CACHE_TTL / 3600000 });
});

if (ALLOWED_ORIGINS.length > 0) {
  console.log(`Proxy-only mode. Whitelist: ${ALLOWED_ORIGINS.join(', ')}`);
} else {
  app.use(express.static(__dirname));
  app.get('/config.js', (req, res) => res.type('application/javascript').send('// Standalone mode'));
  app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
}

app.listen(PORT, () => {
  console.log(`LinkPark is live on port ${PORT} | Keys: ${TFKEYS.length} | Cache: ${CACHE_LIMIT}`);
});
