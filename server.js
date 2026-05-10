const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const multer = require('multer');
const { Shazam } = require('shazamio');

const shazam = new Shazam();
const upload = multer({ storage: multer.memoryStorage() });

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
const USE_TINYFISH_SIMULATOR = process.env.TINYFISH_SIMULATOR === '1';

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

/** In-flight request deduplication */
const pendingItunes = new Map();

/** User-Agent Pool for rotation */
const userAgents = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1'
];
const getUA = () => userAgents[Math.floor(Math.random() * userAgents.length)];

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
app.use(express.json());

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

function cleanupTitle(title, artist) {
  if (!title) return '';
  let clean = title
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/[\u200e\u200f\xa0]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Remove common noise
  const noise = [
    /\[Official Music Video\]/i, /\(Official Music Video\)/i,
    /\[Official Video\]/i, /\(Official Video\)/i,
    /\[Official Audio\]/i, /\(Official Audio\)/i,
    /\[Lyric Video\]/i, /\(Lyric Video\)/i,
    /\[HD\]/i, /\(HD\)/i, /\[4K\]/i, /\(4K\)/i,
    /\| Official Video/i, /\| Official Audio/i,
    / - Topic$/i
  ];
  noise.forEach(n => clean = clean.replace(n, ''));

  if (artist && clean.toLowerCase().startsWith(artist.toLowerCase() + ' - ')) {
    clean = clean.substring(artist.length + 3).trim();
  } else if (artist && clean.toLowerCase().endsWith(' - ' + artist.toLowerCase())) {
    clean = clean.substring(0, clean.length - (artist.length + 3)).trim();
  }

  return clean.trim();
}

async function extractMetadataFromUrl(url) {
  // Skip scraping for services known to block/fail (Spotify, Amazon)
  if (url.includes('spotify.com') || url.includes('amazon.')) return null;

  // 1. YouTube OEmbed
  if (url.includes('youtube.com') || url.includes('youtu.be')) {
    try {
      const cleanUrl = url.replace('music.youtube.com', 'www.youtube.com');
      const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(cleanUrl)}&format=json`;
      const r = await fetch(oembedUrl, { timeout: 6000 });
      if (r.ok) {
        const data = await r.json();
        let artist = (data.author_name || '').replace(/ - Topic$/i, '').trim();
        let song = data.title || '';

        if (song.includes(' - ')) {
          const parts = song.split(' - ');
          if (parts[0].trim().toLowerCase() === artist.toLowerCase()) {
            song = parts.slice(1).join(' - ').trim();
          } else {
            artist = parts[0].trim();
            song = parts.slice(1).join(' - ').trim();
          }
        }
        return { artist, title: cleanupTitle(song, artist) };
      }
    } catch (e) { console.warn(`[oembed] Failed for ${url}: ${e.message}`); }
  }

  // 2. Generic Scraper Fallback
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': getUA(), 'Accept-Language': 'en-US,en;q=0.9' },
      timeout: 7000
    });
    if (r.ok) {
      const html = await r.text();
      const titleMatch = html.match(/<title>(.*?)<\/title>/i);
      const ogTitleMatch = html.match(/<meta property="og:title" content="(.*?)"/i);

      let pageTitle = '';
      const t = (titleMatch ? titleMatch[1] : '').trim();
      const og = (ogTitleMatch ? ogTitleMatch[1] : '').trim();

      // Prioritize the one with more information (usually the <title> tag)
      if (t.includes(' - ') || t.includes(' by ') || t.includes(' • ')) pageTitle = t;
      else if (og.includes(' - ') || og.includes(' by ') || og.includes(' • ')) pageTitle = og;
      else pageTitle = t || og;

      if (!pageTitle) return null;

      // Pattern matching based on common streaming service titles
      let artist = '', song = pageTitle;
      const separators = [' • ', ' | ', ' - '];

      if (url.includes('spotify.com')) {
        const clean = pageTitle.split('|')[0].trim();
        const spSeps = [' - song and lyrics by ', ' - song by ', ' - Single by ', ' by '];
        for (const sep of spSeps) {
          if (clean.includes(sep)) {
            const parts = clean.split(sep);
            song = parts[0].trim(); artist = parts[1].trim();
            break;
          }
        }
      } else if (url.includes('music.apple.com')) {
        const clean = pageTitle.split(' - Apple')[0].split(' on Apple')[0].trim();
        if (clean.includes(' - Song by ')) {
          const parts = clean.split(' - Song by ');
          song = parts[0].trim(); artist = parts[1].trim();
        } else if (clean.includes(' by ')) {
          const parts = clean.split(' by ');
          song = parts[0].trim(); artist = parts[1].trim();
        }
      } else {
        for (const sep of separators) {
          if (pageTitle.includes(sep)) {
            const parts = pageTitle.split(sep);
            artist = parts[0].trim();
            song = parts[1].trim();
            break;
          }
        }
      }

      return { artist, title: cleanupTitle(song, artist) };
    }
  } catch (e) { console.warn(`[scraper] Failed for ${url}: ${e.message}`); }

  return null;
}

/** Internal resolution helpers */
async function resolveOdesli(url, country = 'US') {
  // Normalize YouTube Music and Shorts URLs back to standard YouTube for Odesli's engine
  let targetUrl = url.replace('music.youtube.com', 'youtube.com');
  if (targetUrl.includes('youtube.com/shorts/')) {
    targetUrl = targetUrl.replace('youtube.com/shorts/', 'youtube.com/watch?v=');
  }
  const cacheKey = `od:${targetUrl}:${country}`;
  const cached = cacheGet(cacheKey);
  if (cached) return JSON.parse(cached);

  const target = `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(targetUrl)}&userCountry=${country}`;

  const proxies = [
    { url: `https://corsproxy.io/?${encodeURIComponent(target)}`, type: 'proxy' },
    { url: `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(target)}`, type: 'proxy' },
    { url: `https://api.allorigins.win/raw?url=${encodeURIComponent(target)}`, type: 'proxy' },
    { url: `https://api.allorigins.win/get?url=${encodeURIComponent(target)}`, type: 'allorigins' }
  ];

  // 1. Shuffled Proxies (prioritizing the first two fast ones)
  const fast = proxies.slice(0, 2).sort(() => Math.random() - 0.5);
  const others = proxies.slice(2).sort(() => Math.random() - 0.5);
  const shuffled = [...fast, ...others];

  for (const provider of shuffled) {
    try {
      const response = await fetch(provider.url, { headers: { 'User-Agent': getUA() }, timeout: 4500 });
      if (!response.ok) continue;
      let text = await response.text();
      if (provider.type === 'allorigins') {
        try { text = JSON.parse(text).contents; } catch (e) { continue; }
      }
      if (!text || text.trim().startsWith('<')) continue;
      const data = JSON.parse(text);
      if (data.entityUniqueId) { cacheSet(cacheKey, text); return data; }
    } catch (e) { continue; }
  }

  // 2. Fallback: Our Proxy (Direct server-side fetch)
  try {
    const response = await fetch(target, { headers: { 'User-Agent': getUA() }, timeout: 6000 });
    if (response.ok) {
      const text = await response.text();
      if (text && !text.trim().startsWith('<')) {
        const data = JSON.parse(text);
        if (data.entityUniqueId) { cacheSet(cacheKey, text); return data; }
      }
    }
  } catch (e) { console.warn(`[odesli] Direct fallback failed for ${targetUrl}`); }

  return null;
}

async function resolveSearch(query) {
  if (USE_TINYFISH_SIMULATOR) return simulateTinyfishSearch(query);
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

async function simulateTinyfishSearch(query) {
  const cacheKey = `tf-sim:${query}`;
  const cached = cacheGet(cacheKey);
  if (cached) return JSON.parse(cached);

  const cleanQuery = query
    .replace(/\bspotify\s+track\b/ig, '')
    .replace(/\byoutube\s+music\s+topic\b/ig, '')
    .replace(/\s+/g, ' ')
    .trim();
  const itunes = await resolveItunes(cleanQuery);
  const track = itunes?.results?.[0];
  if (!track?.trackViewUrl) return { results: [] };

  const data = {
    results: [
      {
        title: track.trackName,
        url: track.trackViewUrl,
        source: 'appleMusic',
        artist: track.artistName,
        album: track.collectionName
      },
      {
        title: `${track.trackName} ${track.artistName}`,
        url: `https://music.youtube.com/search?q=${encodeURIComponent(`${track.trackName} ${track.artistName}`)}`,
        source: 'youtubeMusic'
      }
    ]
  };
  cacheSet(cacheKey, JSON.stringify(data));
  return data;
}

/** Endpoints */

async function resolveItunes(query, country = 'US') {
  const cacheKey = `it:${query}:${country}`;
  const cached = cacheGet(cacheKey);
  if (cached) return JSON.parse(cached);

  // Deduplicate in-flight requests for the same query/country
  if (pendingItunes.has(cacheKey)) return pendingItunes.get(cacheKey);

  const fetchTask = (async () => {
    try {
      const r = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=song&limit=1&country=${country}`, { timeout: 8000 });
      if (r.ok) {
        const data = await r.json();
        if (data.results?.[0]) {
          cacheSet(cacheKey, JSON.stringify(data));
          return data;
        }
      } else if (r.status === 429) {
        console.warn(`[itunes] 429 Rate Limited for query: ${query}`);
      }
    } catch (e) {
      console.error(`[itunes] Search failed for ${query}: ${e.message}`);
    } finally {
      pendingItunes.delete(cacheKey);
    }
    return null;
  })();

  pendingItunes.set(cacheKey, fetchTask);
  return fetchTask;
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

app.post('/api/recognize', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Audio file is required' });
  
  try {
    const result = await shazam.recognize(req.file.buffer);
    
    if (!result || !result.track) {
      console.warn('[shazam] No match found');
      return res.json({ status: 'error', message: 'Could not identify song.' });
    }

    const track = result.track;
    res.json({
      status: 'success',
      song: `${track.title} - ${track.subtitle}`,
      title: track.title,
      artist: track.subtitle
    });
  } catch (e) {
    console.error('[shazam] Identification failed:', e.message);
    res.status(500).json({ status: 'error', message: 'Shazam identification service error' });
  }
});

app.get('/api/resolve', requireApiAccess, async (req, res) => {
  const { query, artist, album, country } = req.query;
  let u = req.query.u;
  const isUrlDrop = u && !query;

  // Pre-normalize URL for consistent cache keys
  if (u) {
    u = u.trim().replace('music.youtube.com', 'youtube.com');
    if (u.includes('youtube.com/shorts/')) u = u.replace('youtube.com/shorts/', 'youtube.com/watch?v=');
  }

  // Top-level O(1) Cache Lookup
  const resolveCacheKey = `res:${u || ''}:${query || ''}:${artist || ''}:${country || 'US'}`;
  const cachedResolve = cacheGet(resolveCacheKey);
  if (cachedResolve) return res.json(JSON.parse(cachedResolve));

  let od = null;
  let tfSp = null, tfYt = null;
  let itRes = null;
  let scrapedMeta = null;

  // 1. Initial Batch & Normalization
  const clean = (s) => (s || '').trim();
  const qTitle = clean(query);
  const qArtist = clean(artist);
  const qBase = (qTitle.toLowerCase().includes(qArtist.toLowerCase()))
    ? qTitle
    : (qTitle + (qArtist ? ' ' + qArtist : ''));

  const initialTasks = [];
  if (isUrlDrop) {
    const isSpecial = u.includes('spotify.com') || u.includes('amazon.');

    if (isSpecial) {
      // Straight to Odesli for Spotify/Amazon
      initialTasks.push(resolveOdesli(u, country).then(d => od = d));
    } else {
      // Parallel race for others (YouTube, Apple, etc.)
      initialTasks.push(resolveOdesli(u, country).then(d => od = d));
      initialTasks.push(extractMetadataFromUrl(u).then(d => scrapedMeta = d));
    }

    await Promise.allSettled(initialTasks);
    initialTasks.length = 0;

    const bestTitle = od?.entitiesByUniqueId?.[od?.entityUniqueId]?.title || scrapedMeta?.title;
    const bestArtist = od?.entitiesByUniqueId?.[od?.entityUniqueId]?.artistName || scrapedMeta?.artist;

    if (bestTitle) {
      const qMeta = `${bestTitle} ${bestArtist || ''}`;
      initialTasks.push(resolveSearch(qMeta + ' spotify track').then(d => tfSp = d));
      initialTasks.push(resolveSearch(qMeta + ' youtube music topic').then(d => tfYt = d));
      initialTasks.push(resolveSearch(qMeta + ' youtube music track').then(d => tfYt = d)); // Extra coverage
      initialTasks.push(resolveItunes(qMeta, country).then(d => itRes = d));
    }
  } else if (qBase) {
    initialTasks.push(resolveSearch(qBase + ' spotify track').then(d => tfSp = d));
    initialTasks.push(resolveSearch(qBase + (album ? ' ' + album : '') + ' youtube music topic').then(d => tfYt = d));
    initialTasks.push(resolveItunes(qBase, country).then(d => itRes = d));
  }

  // Overlap resolution tasks
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
  const tfResults = [...(tfSp?.results || []), ...(tfYt?.results || [])];
  if (!links.spotify && tfSp?.results) {
    const r = tfSp.results.find(it => it.url.includes('open.spotify.com/track'));
    if (r) links.spotify = r.url;
  }
  if (!links.appleMusic && tfResults.length > 0) {
    const r = tfResults.find(it => it.url.includes('music.apple.com') || it.url.includes('itunes.apple.com'));
    if (r) links.appleMusic = r.url;
  }
  if (!links.youtubeMusic && tfYt?.results) {
    const r = tfYt.results.find(it => it.url.includes('music.youtube.com') || it.url.includes('youtube.com/watch'));
    if (r) links.youtubeMusic = (r?.url || '').replace(/^(https?:\/\/)?(www\.)?youtube\.com/, '$1music.youtube.com');
  }

  // Priority 3: iTunes cleanup (especially for URL drops)
  const itTrack = itRes?.results?.[0];
  if (itTrack) {
    if (!links.appleMusic) links.appleMusic = itTrack.trackViewUrl;
  }

  // 3. Double-Dip Strategy: If we found a high-quality link (Spotify/Apple) that Odesli missed,
  // re-query Odesli with that link to get all remaining platforms (Tidal, Deezer, etc.)
  const discoveredLink = links.appleMusic || links.spotify;
  const originalHadFullLinks = od?.linksByPlatform?.spotify || od?.linksByPlatform?.appleMusic;

  if (discoveredLink && !originalHadFullLinks) {
    const secondOd = await resolveOdesli(discoveredLink, country);
    if (secondOd) {
      platforms.forEach(pid => {
        const href = secondOd.linksByPlatform?.[pid]?.url;
        if (href && !links[pid]) links[pid] = href;
      });
      // Update metadata if second Odesli has better data
      const secondEnt = secondOd.entitiesByUniqueId?.[secondOd.entityUniqueId] || {};
      if (secondEnt.title && !ent.title) ent = secondEnt;
    }
  }

  const responseData = {
    links,
    title: itTrack?.trackName || ent.title || scrapedMeta?.title || null,
    artist: itTrack?.artistName || ent.artistName || scrapedMeta?.artist || null,
    album: itTrack?.collectionName || null,
    art: itTrack?.artworkUrl100?.replace('100x100bb', '600x600bb') || ent.thumbnailUrl || null,
    preview: itTrack?.previewUrl || null
  };

  const responseString = JSON.stringify(responseData);
  cacheSet(resolveCacheKey, responseString);
  
  // Cross-Platform Cache Indexing:
  // Cache the same result for every individual platform link discovered.
  // This ensures that pasting any of the results back into the app triggers an O(1) hit.
  if (responseData.links) {
    Object.values(responseData.links).forEach(link => {
      if (typeof link !== 'string') return;
      let norm = link.trim().replace('music.youtube.com', 'youtube.com');
      if (norm.includes('youtube.com/shorts/')) norm = norm.replace('youtube.com/shorts/', 'youtube.com/watch?v=');
      const linkKey = `res:${norm}:::${country || 'US'}`;
      cacheSet(linkKey, responseString);
    });
  }

  res.json(responseData);
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
