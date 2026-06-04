const fetch = require('node-fetch');
const crypto = require('crypto');

// Environment variables
const TFKEYS = (process.env.TFKEY || '').split(',').map(k => k.trim()).filter(Boolean);
const USE_TINYFISH_SIMULATOR = process.env.TINYFISH_SIMULATOR === '1';
const POW_DIFFICULTY = parseInt(process.env.POW_DIFFICULTY) || 4;

const ODESLI = 'https://api.song.link/v1-alpha.1/links';

// Cache configuration
const CACHE_TTL = 14 * 24 * 60 * 60 * 1000; // 14 days
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

function getCacheStats() {
  const now = Date.now();
  let active = 0;
  for (const entry of cache.values()) if (now <= entry.expires) active++;
  return { total: cache.size, active, limit: CACHE_LIMIT, ttl_hours: CACHE_TTL / 3600000 };
}

// Key health / blacklist store
const blacklistedKeys = new Map();

// Request deduplicator
class RequestDeduplicator {
  constructor() { this.pending = new Map(); }
  async dedupe(key, fn) {
    if (this.pending.has(key)) return this.pending.get(key);
    const task = fn().finally(() => this.pending.delete(key));
    this.pending.set(key, task);
    return task;
  }
}
const dedup = new RequestDeduplicator();

// Rotating User Agents
const userAgents = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1'
];
const getUA = () => userAgents[Math.floor(Math.random() * userAgents.length)];

// Helpers
function validateCountry(c) {
  if (!c) return 'US';
  const clean = c.toUpperCase().trim();
  return /^[A-Z]{2}$/.test(clean) ? clean : 'US';
}

function validateString(s, max = 200) {
  return (s || '').toString().substring(0, max).trim();
}

function cleanupTitle(title, artist) {
  if (!title) return '';
  let clean = title
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/[\u200e\u200f\xa0]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

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

function isValidMusicUrl(url) {
  try {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol)) return false;

    const host = u.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1') return false;
    
    const privateIpRegex = /^(10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.)/;
    if (privateIpRegex.test(host)) return false;

    const allowedDomains = [
      'spotify.com', 'open.spotify.com',
      'apple.com', 'music.apple.com', 'itunes.apple.com',
      'youtube.com', 'www.youtube.com', 'music.youtube.com', 'youtu.be',
      'tidal.com', 'listen.tidal.com',
      'deezer.com', 'www.deezer.com',
      'amazon.com', 'music.amazon.com',
      'pandora.com', 'www.pandora.com',
      'soundcloud.com', 'www.soundcloud.com',
      'song.link', 'api.song.link', 'odesli.co'
    ];

    return allowedDomains.some(domain => host === domain || host.endsWith('.' + domain));
  } catch (e) {
    return false;
  }
}

// Upstream Resolvers
async function extractMetadataFromUrl(url) {
  if (!isValidMusicUrl(url)) return null;

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

      if (t.includes(' - ') || t.includes(' by ') || t.includes(' • ')) pageTitle = t;
      else if (og.includes(' - ') || og.includes(' by ') || og.includes(' • ')) pageTitle = og;
      else pageTitle = t || og;

      if (!pageTitle) return null;

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

async function resolveOdesli(url, country = 'US') {
  if (!isValidMusicUrl(url)) return null;

  let targetUrl = url.replace('music.youtube.com', 'youtube.com');
  if (targetUrl.includes('youtube.com/shorts/')) {
    targetUrl = targetUrl.replace('youtube.com/shorts/', 'youtube.com/watch?v=');
  }
  const cacheKey = `od:${targetUrl}:${country}`;
  const cached = cacheGet(cacheKey);
  if (cached) return JSON.parse(cached);

  const target = `${ODESLI}?url=${encodeURIComponent(targetUrl)}&userCountry=${country}`;

  const proxies = [
    { url: `https://corsproxy.io/?${encodeURIComponent(target)}`, type: 'proxy' },
    { url: `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(target)}`, type: 'proxy' },
    { url: `https://api.allorigins.win/raw?url=${encodeURIComponent(target)}`, type: 'proxy' },
    { url: `https://api.allorigins.win/get?url=${encodeURIComponent(target)}`, type: 'allorigins' }
  ];

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

function shuffleKeys() {
  return TFKEYS.map((_, i) => i).sort(() => Math.random() - 0.5);
}

async function resolveSearch(query) {
  if (USE_TINYFISH_SIMULATOR) return simulateTinyfishSearch(query);
  if (TFKEYS.length === 0) return null;
  const cacheKey = `tf:${query}`;
  const cached = cacheGet(cacheKey);
  if (cached) return JSON.parse(cached);

  return dedup.dedupe(cacheKey, async () => {
    const keyOrder = shuffleKeys();
    
    const activeIndices = keyOrder.filter(idx => {
      const key = TFKEYS[idx];
      const expiry = blacklistedKeys.get(key);
      if (expiry && Date.now() < expiry) {
        return false;
      }
      if (expiry) {
        blacklistedKeys.delete(key);
      }
      return true;
    });

    const finalIndices = activeIndices.length > 0 ? activeIndices : keyOrder;
    const maxAttempts = Math.min(finalIndices.length, 9);

    for (let i = 0; i < maxAttempts; i++) {
      const currentKey = TFKEYS[finalIndices[i]];
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
        } else if (response.status === 429 || response.status === 403 || response.status >= 500) {
          console.warn(`[blacklist] Key ${currentKey.substring(0, 8)}... failed with status ${response.status}. Blacklisting for 5 minutes.`);
          blacklistedKeys.set(currentKey, Date.now() + 5 * 60 * 1000);
        }
      } catch (error) { continue; }
    }
    return null;
  });
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

async function resolveItunes(query, country = 'US') {
  const cacheKey = `it:${query}:${country}`;
  const cached = cacheGet(cacheKey);
  if (cached) return JSON.parse(cached);

  return dedup.dedupe(cacheKey, async () => {
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
    }
    return null;
  });
}

// Dynamic Resolution workflow wrapper
async function resolveTrackDetails(query, artist, album, country, u, isUrlDrop) {
  let od = null;
  let tfSp = null, tfYt = null;
  let itRes = null;
  let scrapedMeta = null;

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
      initialTasks.push(resolveOdesli(u, country).then(d => od = d));
    } else {
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
      initialTasks.push(resolveSearch(qMeta + ' youtube music track').then(d => tfYt = d));
      initialTasks.push(resolveItunes(qMeta, country).then(d => itRes = d));
    }
  } else if (qBase) {
    initialTasks.push(resolveSearch(qBase + ' spotify track').then(d => tfSp = d));
    initialTasks.push(resolveSearch(qBase + (album ? ' ' + album : '') + ' youtube music topic').then(d => tfYt = d));
    initialTasks.push(resolveItunes(qBase, country).then(d => itRes = d));
  }

  await Promise.allSettled(initialTasks);

  let ent = od?.entitiesByUniqueId?.[od?.entityUniqueId] || {};
  if (!ent.title && od?.entitiesByUniqueId) {
    const firstId = Object.keys(od.entitiesByUniqueId)[0];
    if (firstId) ent = od.entitiesByUniqueId[firstId];
  }
  
  if (ent.title) {
    const qMeta = `${ent.title} ${ent.artistName || ''}`;
    const secondaryTasks = [];

    if (!tfSp) secondaryTasks.push(resolveSearch(qMeta + ' spotify track').then(d => tfSp = d));
    if (!tfYt) secondaryTasks.push(resolveSearch(qMeta + ' youtube music topic').then(d => tfYt = d));
    if (isUrlDrop) secondaryTasks.push(resolveItunes(qMeta, country).then(d => itRes = d));

    if (secondaryTasks.length > 0) await Promise.allSettled(secondaryTasks);
  }

  const links = {};
  const platforms = ['spotify', 'youtubeMusic', 'appleMusic', 'youtube', 'amazonMusic', 'tidal', 'deezer', 'pandora'];

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

  const itTrack = itRes?.results?.[0];
  if (itTrack) {
    if (!links.appleMusic) links.appleMusic = itTrack.trackViewUrl;
  }

  const discoveredLink = links.appleMusic || links.spotify;
  const originalHadFullLinks = od?.linksByPlatform?.spotify || od?.linksByPlatform?.appleMusic;

  if (discoveredLink && !originalHadFullLinks) {
    const secondOd = await resolveOdesli(discoveredLink, country);
    if (secondOd) {
      platforms.forEach(pid => {
        const href = secondOd.linksByPlatform?.[pid]?.url;
        if (href && !links[pid]) links[pid] = href;
      });
      const secondEnt = secondOd.entitiesByUniqueId?.[secondOd.entityUniqueId] || {};
      if (secondEnt.title && !ent.title) ent = secondEnt;
    }
  }

  return {
    links,
    title: itTrack?.trackName || ent.title || scrapedMeta?.title || null,
    artist: itTrack?.artistName || ent.artistName || scrapedMeta?.artist || null,
    album: itTrack?.collectionName || null,
    art: itTrack?.artworkUrl100?.replace('100x100bb', '600x600bb') || ent.thumbnailUrl || null,
    preview: itTrack?.previewUrl || null
  };
}

module.exports = {
  resolveOdesli,
  resolveSearch,
  resolveItunes,
  getCacheStats,
  validateCountry,
  validateString,
  resolveTrackDetails,
  cacheGet,
  cacheSet
};
