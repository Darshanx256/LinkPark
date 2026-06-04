const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const db = require('./db');
const resolver = require('./resolver');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

const PORT = process.env.PORT || 3000;
const SESSION_RATE_LIMIT_WINDOW_MS = parseInt(process.env.SESSION_RATE_LIMIT_WINDOW_MS) || 60 * 1000;
const SESSION_RATE_LIMIT_MAX = parseInt(process.env.SESSION_RATE_LIMIT_MAX) || 20;
const API_RATE_LIMIT_WINDOW_MS = parseInt(process.env.API_RATE_LIMIT_WINDOW_MS) || 60 * 1000;
const API_RATE_LIMIT_MAX = parseInt(process.env.API_RATE_LIMIT_MAX) || 120;

const ALLOWED_ORIGINS = (process.env.SERVICE || '').split(',').map(o => o.trim()).filter(Boolean);
const POW_DIFFICULTY = parseInt(process.env.POW_DIFFICULTY) || 4;
const activeChallenges = new Map();

// Background cleanup for expired challenges every minute
setInterval(() => {
  const now = Date.now();
  for (const [seed, challenge] of activeChallenges.entries()) {
    if (now > challenge.expiresAt) activeChallenges.delete(seed);
  }
}, 60000);

// Rate Limit Stores
const sessionLimit = new Map();
const apiLimit = new Map();

// Expired rate limit garbage collection every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, limit] of sessionLimit.entries()) {
    if (now > limit.resetAt) sessionLimit.delete(key);
  }
  for (const [key, limit] of apiLimit.entries()) {
    if (now > limit.resetAt) apiLimit.delete(key);
  }
}, 5 * 60 * 1000);

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

// Security Headers Middleware with Cryptographic Nonce Generation
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  
  // Generate cryptographically secure nonce per request
  const nonce = crypto.randomBytes(16).toString('base64');
  res.locals.nonce = nonce;

  // Content Security Policy (CSP) with nonce-based script execution
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https:",
    "connect-src 'self' https:",
    "media-src 'self' https: data: blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; ');
  res.setHeader('Content-Security-Policy', csp);
  next();
});

function isAllowedOrigin(origin) {
  if (ALLOWED_ORIGINS.length === 0) return true;
  if (!origin) return false;

  if (ALLOWED_ORIGINS.includes(origin)) return true;

  try {
    const originHost = new URL(origin).hostname.toLowerCase();
    return ALLOWED_ORIGINS.some(allowed => {
      let allowedHost = allowed.toLowerCase();
      if (allowedHost.startsWith('http')) {
        try { allowedHost = new URL(allowedHost).hostname; } catch (e) {}
      }
      return originHost === allowedHost || originHost.endsWith('.' + allowedHost);
    });
  } catch (e) {
    return ALLOWED_ORIGINS.some(allowed => origin === allowed || origin.endsWith('.' + allowed));
  }
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

// REST Endpoints
app.get('/api/challenge', requireAllowedOrigin, (req, res) => {
  const ip = getClientIp(req);
  if (!consumeRateLimit(sessionLimit, ip, SESSION_RATE_LIMIT_WINDOW_MS, SESSION_RATE_LIMIT_MAX)) {
    return deny(req, res, 429, 'too_many_challenges');
  }

  const seed = crypto.randomBytes(16).toString('hex');
  const origin = req.get('origin');
  activeChallenges.set(seed, { origin, expiresAt: Date.now() + 60 * 1000 });
  res.json({ seed, difficulty: POW_DIFFICULTY });
});

app.get('/api/odesli', requireApiAccess, async (req, res) => {
  const url = resolver.validateString(req.query.url, 500);
  const userCountry = resolver.validateCountry(req.query.userCountry);
  if (!url) return res.status(400).json({ error: 'URL is required' });
  const data = await resolver.resolveOdesli(url, userCountry);
  if (data) return res.json(data);
  res.status(502).json({ error: 'Odesli resolution failed' });
});

app.get('/api/search', requireApiAccess, async (req, res) => {
  const query = resolver.validateString(req.query.query, 300);
  if (!query) return res.status(400).json({ error: 'Query is required' });
  const data = await resolver.resolveSearch(query);
  if (data) return res.json(data);
  res.status(502).json({ error: 'Search failed' });
});

app.get('/api/resolve', requireApiAccess, async (req, res) => {
  const query = resolver.validateString(req.query.query, 300);
  const artist = resolver.validateString(req.query.artist, 200);
  const album = resolver.validateString(req.query.album, 200);
  const country = resolver.validateCountry(req.query.country);
  let u = resolver.validateString(req.query.u, 500);
  const isUrlDrop = u && !query;

  if (u) {
    u = u.trim().replace('music.youtube.com', 'youtube.com');
    if (u.includes('youtube.com/shorts/')) u = u.replace('youtube.com/shorts/', 'youtube.com/watch?v=');
  }

  const lookupKey = u || query;
  
  // 1. Check local/in-memory cache first
  const resolveCacheKey = `res:${u || ''}:${query || ''}:${artist || ''}:${country || 'US'}`;
  const cachedResolve = resolver.cacheGet(resolveCacheKey);
  if (cachedResolve) {
    return res.json(JSON.parse(cachedResolve));
  }

  // 2. Check Database cache next
  if (db.isDbActive()) {
    try {
      const cached = await db.getCachedSong(lookupKey, country);
      if (cached) {
        resolver.cacheSet(resolveCacheKey, JSON.stringify(cached));
        return res.json(cached);
      }
    } catch (e) {
      console.error('[server] Database cache lookup failed:', e.message);
    }
  }

  // 3. Perform Live Resolution
  try {
    const responseData = await resolver.resolveTrackDetails(query, artist, album, country, u, isUrlDrop);
    
    // Save to database cache in the background (which generates a shortId)
    if (db.isDbActive() && (responseData.title || responseData.artist)) {
      try {
        const shortId = await db.saveCachedSong(lookupKey, country, responseData);
        responseData.shortId = shortId;
      } catch (dbErr) {
        console.error('[server] Failed to save resolved song to database:', dbErr.message);
        responseData.shortId = null;
      }
    } else {
      responseData.shortId = null;
    }

    const responseString = JSON.stringify(responseData);
    
    resolver.cacheSet(resolveCacheKey, responseString);
    
    // Cross-Platform Cache Indexing:
    if (responseData.links) {
      Object.values(responseData.links).forEach(link => {
        if (typeof link !== 'string') return;
        let norm = link.trim().replace('music.youtube.com', 'youtube.com');
        if (norm.includes('youtube.com/shorts/')) norm = norm.replace('youtube.com/shorts/', 'youtube.com/watch?v=');
        const linkKey = `res:${norm}:::${country || 'US'}`;
        resolver.cacheSet(linkKey, responseString);
      });
    }

    res.json(responseData);
  } catch (err) {
    console.error('[server] Resolve failed:', err);
    res.status(502).json({ error: 'resolve_failed' });
  }
});

// Resolve short link by ID
app.get('/api/share', async (req, res) => {
  if (!db.isDbActive()) {
    return res.status(503).json({ error: 'database_inactive' });
  }
  const id = resolver.validateString(req.query.id, 20);
  if (!id) return res.status(400).json({ error: 'id_required' });

  try {
    const songData = await db.getSongByShortId(id);
    if (songData) return res.json(songData);
    res.status(404).json({ error: 'not_found' });
  } catch (e) {
    console.error('[server] Failed to retrieve short link:', e.message);
    res.status(500).json({ error: 'db_query_failed' });
  }
});

app.get('/api/cache-stats', requireApiAccess, (req, res) => {
  res.json(resolver.getCacheStats());
});

if (ALLOWED_ORIGINS.length > 0) {
  console.log(`Proxy-only mode. Whitelist: ${ALLOWED_ORIGINS.join(', ')}`);
} else {
  let indexHtmlTemplate = '';
  try {
    indexHtmlTemplate = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  } catch (e) {
    console.error('Failed to read index.html template:', e);
  }

  function serveIndexHtml(req, res) {
    const nonce = res.locals.nonce || crypto.randomBytes(16).toString('base64');
    const html = indexHtmlTemplate.replace(/%%NONCE%%/g, nonce);
    res.send(html);
  }

  app.get('/', serveIndexHtml);
  app.get('/index.html', serveIndexHtml);

  app.use(express.static(__dirname));
  app.get('/config.js', (req, res) => res.type('application/javascript').send('// Standalone mode'));
  
  app.get('*', (req, res) => {
    if (req.accepts('html')) {
      return serveIndexHtml(req, res);
    }
    res.status(404).end();
  });
}

app.listen(PORT, () => {
  console.log(`LinkPark is live on port ${PORT} | Cache: 500`);
});
