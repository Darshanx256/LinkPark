import {
  ODESLI, PROXY_URL, TFKEY, TFAPI, ODESLI_PROXY,
  COUNTRY, SMAP, SREV, P, PLACEHOLDERS
} from './constants.js';

/** 
 * Unique identifier for the current resolution request.
 * Used to discard results from stale network requests when a new search begins.
 */
let lastResolveId = 0;
let currentData = null; // Stores currently resolved track for sharing

let currentPoWPromise = null;

async function solvePoW(seed, difficulty) {
  const target = '0'.repeat(difficulty);
  const encoder = new TextEncoder();
  let nonce = 0;
  
  while (true) {
    const data = encoder.encode(seed + nonce);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    // Convert bytes to hex string
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    
    if (hashHex.startsWith(target)) return nonce;
    
    nonce++;

    // Yield to the event loop every 2000 iterations to prevent UI freezing
    if (nonce % 2000 === 0) await new Promise(r => setTimeout(r, 0));
  }
}

function fetchAndSolveChallenge() {
  if (!PROXY_URL) return;
  
  currentPoWPromise = (async () => {
    try {
      const res = await fetch(`${PROXY_URL}/api/challenge`);
      if (!res.ok) throw new Error('Challenge fetch failed');
      const { seed, difficulty } = await res.json();
      
      const nonce = await solvePoW(seed, difficulty);
      return { seed, nonce };
    } catch (e) {
      console.error('PoW challenge failed:', e);
      await new Promise(r => setTimeout(r, 2000));
      currentPoWPromise = null;
      throw e;
    }
  })();
}

async function getPoWHeaders() {
  if (!PROXY_URL) return { 'X-API-Key': TFKEY };

  if (!currentPoWPromise) fetchAndSolveChallenge();
  
  try {
    const pow = await currentPoWPromise;
    // Pre-warm the next challenge for the next search
    fetchAndSolveChallenge();
    return {
      'X-LP-Seed': pow.seed,
      'X-LP-Nonce': pow.nonce.toString()
    };
  } catch (e) {
    // Fallback if proxy fails
    return {};
  }
}

/**
 * Advanced Compression & Encoding Engine.
 * Uses browser-native CompressionStream (Deflate) and URL-safe Base64 
 * to create the smallest possible shareable links without external libraries.
 */
async function compress(str) {
  const stream = new Blob([str]).stream().pipeThrough(new CompressionStream('deflate'));
  const buffer = await new Response(stream).arrayBuffer();
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function decompress(b64) {
  try {
    const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    return await new Response(stream).text();
  } catch (e) { return null; }
}

async function encodeShare(d) {
  const sl = [];
  // Store only "Odesli-exclusive" or "Hard to find" IDs to save space.
  // Spotify and YT Music can be re-resolved via Tinyfish for free.
  const EXCLUSIVE = ['amazonMusic', 'tidal', 'deezer', 'pandora'];

  for (const pid of EXCLUSIVE) {
    if (d.l[pid]) {
      const k = SREV[pid] || pid;
      let v = d.l[pid];
      if (pid === 'amazonMusic') v = v.match(/[?&]trackAsin=([a-zA-Z0-9]+)/)?.[1] || v;
      else if (pid === 'tidal') v = v.match(/track\/(\d+)/)?.[1] || v;
      else if (pid === 'deezer') v = v.match(/track\/(\d+)/)?.[1] || v;
      else if (pid === 'pandora') v = v.match(/TR:(\d+)/)?.[1] || v;
      sl.push(`${k}:${v}`);
    }
  }

  // Get iTunes ID from Apple link if available
  const itid = d.l.appleMusic?.match(/[?&]i=(\d+)/)?.[1] || '';

  // Format: Title|Artist|iTunesID|ExclusiveLinks
  const pipe = [d.t, d.a, itid, sl.join(',')].join('|');
  return await compress(pipe);
}

async function decodeShare(s) {
  const pipe = await decompress(s);
  if (!pipe) return null;
  try {
    const a = pipe.split('|');
    const links = {};
    const sl = (a[3] || '').split(',');
    sl.forEach(pair => {
      const [k, ...rest] = pair.split(':');
      const pid = SMAP[k] || k;
      let val = rest.join(':');
      if (val && !val.startsWith('http')) {
        if (pid === 'amazonMusic') val = `https://music.amazon.com/albums/_?trackAsin=${val}`;
        else if (pid === 'tidal') val = `https://listen.tidal.com/track/${val}`;
        else if (pid === 'deezer') val = `https://www.deezer.com/track/${val}`;
        else if (pid === 'pandora') val = `https://www.pandora.com/TR:${val}`;
      }
      if (pid && val) links[pid] = val;
    });
    return { t: a[0], a: a[1], itunesId: a[2], l: links };
  } catch (e) { return null; }
}
/** 
 * Platform definitions for UI rendering and link mapping.
 * Ordered by display priority. 
 */


const qEl = document.getElementById('q');
const ddEl = document.getElementById('dd');
const hintEl = document.getElementById('hint');
const loaderEl = document.getElementById('loader');
const errEl = document.getElementById('err');
const cardEl = document.getElementById('card');
const linksEl = document.getElementById('links');
const logoEl = document.querySelector('.logo');

/** 
 * Logo 'Home' functionality: Clears search, resets state, and cleans URL.
 */
if (logoEl) {
  logoEl.addEventListener('click', () => {
    qEl.value = '';
    closeDD();
    cardEl.style.display = 'none';
    errEl.style.display = 'none';
    currentData = null;
    const url = new URL(window.location.href);
    url.searchParams.delete('s');
    window.history.replaceState({}, '', url);
    audio.pause();
  });
}

/** 
 * UI state variables.
 * timer: Ref for search debouncing.
 * idx: Tracks keyboard navigation index in dropdown.
 * items: Local cache of current search suggestions.
 */
let timer = null, idx = -1, items = [];

const audio = new Audio();
let isPlaying = false;

/**
 * Orchestrates audio playback states and progress UI updates.
 * listenners handle the native HTML5 Audio events to sync CSS and text labels.
 */
audio.addEventListener('play', () => { isPlaying = true; updatePlayBtn(); });
audio.addEventListener('pause', () => { isPlaying = false; updatePlayBtn(); });
audio.addEventListener('ended', () => { isPlaying = false; updatePlayBtn(); });
audio.addEventListener('timeupdate', () => {
  if (!audio.duration) return;
  const p = (audio.currentTime / audio.duration) * 100;
  document.getElementById('seekFill').style.width = `${p}%`;
  document.getElementById('timeLabel').textContent = formatTime(audio.currentTime);
});

document.getElementById('playBtn').addEventListener('click', () => {
  if (isPlaying) audio.pause(); else audio.play();
});

document.getElementById('seekWrap').addEventListener('click', (e) => {
  if (!audio.duration) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const p = (e.clientX - rect.left) / rect.width;
  audio.currentTime = p * audio.duration;
});

document.getElementById('shareCardBtn')?.addEventListener('click', async (e) => {
  if (!currentData) return;
  const btn = e.currentTarget;
  const currentUrl = new URL(window.location.href);
  const hash = await encodeShare(currentData);

  // Use the Render proxy for sharing to enable dynamic OG tags (Social Previews)
  const shareUrl = PROXY_URL ? new URL(`${PROXY_URL}/share`) : currentUrl;
  shareUrl.searchParams.set('s', hash);

  try {
    await navigator.clipboard.writeText(shareUrl.toString());
    window.history.replaceState({}, '', shareUrl);

    const oldHtml = btn.innerHTML;
    btn.classList.add('copied');
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>Copied Link`;
    setTimeout(() => { btn.classList.remove('copied'); btn.innerHTML = oldHtml; }, 2000);
  } catch (err) { }
});

/**
 * Instantly renders a shared card from URL parameters.
 * Bypasses all API calls to provide immediate visual feedback to recipients.
 */
window.addEventListener('load', async () => {
  const s = new URLSearchParams(window.location.search).get('s');
  if (s) {
    const data = await decodeShare(s);
    if (data) {
      setLoad(true);

      // Background Resolution: Get high-res assets and links
      const myId = ++lastResolveId;
      try {
        let art = '', preview = '', appleUrl = '';

        // 1. Fetch iTunes info (cheap, covers art, preview, apple link, album)
        let album = '';
        if (data.itunesId) {
          const r = await fetch(`https://itunes.apple.com/lookup?id=${data.itunesId}&country=${COUNTRY}`);
          const d = await r.json();
          if (d.results?.[0]) {
            const track = d.results[0];
            art = track.artworkUrl100.replace('100x100bb', '600x600bb');
            preview = track.previewUrl;
            appleUrl = track.trackViewUrl;
            album = track.collectionName || '';
          }
        }

        // 2. Fetch Tinyfish (cheap, covers spotify, youtube)
        const tf = await fetchTinyfish(data.t, data.a, album).catch(() => ({}));

        if (myId !== lastResolveId) return;

        // 3. Merge with Odesli links from share
        const merged = { ...data.l };
        if (tf.spotify) merged.spotify = tf.spotify;
        if (tf.youtubeMusic) merged.youtubeMusic = tf.youtubeMusic;
        if (appleUrl) merged.appleMusic = appleUrl;

        // Only show everything once resolution is 100% complete
        populateUI(data.t, data.a, art, preview, merged);
        cardEl.style.display = 'block';
      } catch (e) {
        console.error('Hybrid resolve failed', e);
        // Fallback: at least show what we have if APIs fail
        populateUI(data.t, data.a, '', '', data.l);
        cardEl.style.display = 'block';
      }
      setLoad(false);
    }
  }
});

/**
 * Formats seconds into a human-readable MM:SS string.
 * @param {number} s - Time in seconds.
 * @returns {string} Formatted duration.
 */
function formatTime(s) {
  const min = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

/**
 * Toggles play/pause button visuals based on current playback state.
 */
function updatePlayBtn() {
  const btn = document.getElementById('playBtn');
  if (!btn) return;
  if (isPlaying) {
    btn.classList.add('playing');
    btn.innerHTML = `<svg viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`;
  } else {
    btn.classList.remove('playing');
    btn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>`;
  }
}

/**
 * Dispatches input to either URL resolution or search suggestion.
 * Uses a 280ms debounce to minimize API chatter and improve typing feel.
 */
qEl.addEventListener('input', () => {
  clearTimeout(timer);
  const v = qEl.value.trim();
  closeDD();
  errEl.style.display = 'none';
  cardEl.style.display = 'none'; // Instant card drop on new input
  if (v.length < 2 || v !== `${currentData?.t} — ${currentData?.a}`) {
    const url = new URL(window.location.href);
    if (url.searchParams.has('s')) {
      url.searchParams.delete('s');
      window.history.replaceState({}, '', url);
    }
  }

  if (v.length < 2) return;

  /**
   * Identifies if input is a streaming URL or Spotify URI.
   * If detected, bypasses suggestion logic and attempts direct resolution.
   */
  if (!/\s/.test(v) && /^(https?:\/\/|spotify:track:)/i.test(v)) {
    let url = v;
    if (!/^https?:\/\//i.test(url) && !url.startsWith('spotify:')) {
      url = 'https://' + url;
    }
    timer = setTimeout(() => resolve(url), 280);
    return;
  }

  timer = setTimeout(() => suggest(v), 280);
});

/**
 * Queries iTunes API for song suggestions.
 * @param {string} q - The user's search query.
 */
async function suggest(q) {
  try {
    const r = await fetch(`https://itunes.apple.com/search?term=${enc(q)}&entity=song&limit=6&country=${COUNTRY}&v=${Date.now()}`);
    const d = await r.json();
    renderDD(d.results || []);
  } catch (_) { }
}

/**
 * Builds and displays the suggestion dropdown.
 * @param {Array} tracks - Raw iTunes result array.
 */
function renderDD(tracks) {
  if (!tracks.length) { closeDD(); return; }
  items = tracks.map(t => ({
    appleUrl: t.trackViewUrl,
    title: t.trackName,
    artist: t.artistName,
    art: (t.artworkUrl100 || t.artworkUrl60).replace('100x100bb', '600x600bb'),
    thumb: t.artworkUrl60,
    previewUrl: t.previewUrl,
    album: t.collectionName || '',
  }));

  ddEl.innerHTML = items.map((it, i) => `
    <div class="dd-item" data-i="${i}">
      <img src="${it.thumb}" loading="lazy" alt="${esc(it.title)} by ${esc(it.artist)}">
      <div style="min-width:0">
        <div class="dd-title">${esc(it.title)}</div>
        <div class="dd-artist">${esc(it.artist)}</div>
      </div>
    </div>`).join('');

  ddEl.style.display = 'block';
  hintEl.classList.add('on');
  idx = -1;

  ddEl.querySelectorAll('.dd-item').forEach(el => {
    el.addEventListener('mousedown', e => e.preventDefault());
    el.addEventListener('click', () => pick(+el.dataset.i));
  });
}

/**
 * Handles keyboard accessibility for the suggestion dropdown.
 */
qEl.addEventListener('keydown', e => {
  if (ddEl.style.display !== 'block') return;
  if (e.key === 'ArrowDown') { e.preventDefault(); idx = (idx + 1) % items.length; hl(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); idx = (idx - 1 + items.length) % items.length; hl(); }
  else if (e.key === 'Enter') { e.preventDefault(); if (idx >= 0) pick(idx); }
  else if (e.key === 'Escape') { closeDD(); }
});

/** Highlights the current keyboard-focused item. */
function hl() {
  ddEl.querySelectorAll('.dd-item').forEach((el, i) => el.classList.toggle('active', i === idx));
}

/** Closes the suggestion dropdown and resets state. */
function closeDD() { ddEl.style.display = 'none'; hintEl.classList.remove('on'); idx = -1; }

/** Closes dropdown on click-outside. */
document.addEventListener('click', e => { if (!e.target.closest('.search-wrap')) closeDD(); });

/**
 * Finalizes selection from dropdown.
 * @param {number} i - Index of the selected item.
 */
function pick(i) {
  const it = items[i]; if (!it) return;
  qEl.value = `${it.title} — ${it.artist}`;
  closeDD();
  resolve(it);
}

/** Handles mobile 'Go' / 'Enter' form submission. */
document.getElementById('searchForm')?.addEventListener('submit', e => {
  e.preventDefault();
  const v = qEl.value.trim();
  if (!v) return;

  if (ddEl.style.display === 'block' && idx >= 0) {
    pick(idx);
    return;
  }

  const isUrl = /^(https?:\/\/|spotify:track:)/i.test(v) || (!/\s/.test(v) && v.includes('.'));
  if (isUrl) {
    clearTimeout(timer);
    closeDD();
    resolve(v);
  }
});

/**
 * Main orchestration for resolving song links.
 * Coordinates Odesli, Tinyfish, and iTunes to provide full platform coverage.
 * @param {string|object} data - Either a URL string or an iTunes item object.
 */
async function resolve(data) {
  const myId = ++lastResolveId;
  setLoad(true);
  linksEl.innerHTML = '';

  try {
    let od, tf = {}, item = data;

    const getItunesId = (o) => {
      const am = o?.linksByPlatform?.appleMusic;
      if (am?.entityUniqueId) {
        const ent = o.entitiesByUniqueId[am.entityUniqueId];
        if (ent?.apiProvider === 'itunes') return ent.id;
      }
      return am?.url?.match(/[?&]i=(\d+)/)?.[1];
    };

    const pullItunes = async (id) => {
      if (!id || item.previewUrl || myId !== lastResolveId) return;
      try {
        const r = await fetch(`https://itunes.apple.com/lookup?id=${id}&entity=song&country=${COUNTRY}`);
        const d = await r.json();
        if (d.results?.[0]) {
          item.previewUrl = d.results[0].previewUrl;
          item.art = (d.results[0].artworkUrl100 || item.art).replace('100x100bb', '600x600bb');
          if (!item.appleUrl) item.appleUrl = d.results[0].trackViewUrl;
        }
      } catch (e) { }
    };

    const cleanQ = (s) => s.replace(/\(.*\)|\[.*\]|- Single|- EP|Official.*|Audio/gi, '').trim();

    if (typeof data === 'string') {
      od = await fetchOdesli(data);
      if (myId !== lastResolveId) return;

      const ent = od?.entitiesByUniqueId?.[od?.entityUniqueId] || {};
      item = {
        title: ent.title || 'Unknown',
        artist: ent.artistName || 'Unknown',
        art: ent.thumbnailUrl || '',
        previewUrl: null
      };

      const tasks = [pullItunes(getItunesId(od))];
      if (ent.title) {
        tasks.push(fetchTinyfish(ent.title, ent.artistName, ent.albumName).then(res => tf = res).catch(() => { }));
      }
      await Promise.allSettled(tasks);
      if (myId !== lastResolveId) return;

      let oLinks = od?.linksByPlatform || {};
      const canon = tf.spotify;
      if (canon && canon !== data && (!oLinks.spotify || Object.keys(oLinks).length < 3)) {
        const upgrade = await fetchOdesli(canon).catch(() => null);
        if (upgrade) {
          od = upgrade;
          if (myId !== lastResolveId) return;
          await pullItunes(getItunesId(od));
        }
      }

      const m = () => {
        const e = od?.entitiesByUniqueId?.[od?.entityUniqueId] || {};
        return {
          t: (e.title && e.title !== 'Unknown') ? e.title : item.title,
          a: (e.artistName && e.artistName !== 'Unknown') ? e.artistName : item.artist
        };
      };

      if (!item.previewUrl && m().t !== 'Unknown') {
        try {
          const { t, a } = m();
          const q = cleanQ(t) + ' ' + cleanQ(a);
          const r = await fetch(`https://itunes.apple.com/search?term=${enc(q)}&entity=song&limit=1&country=${COUNTRY}`);
          const d = await r.json();
          if (d.results?.[0]) {
            item.previewUrl = d.results[0].previewUrl;
            item.art = (d.results[0].artworkUrl100 || item.art).replace('100x100bb', '600x600bb');
            if (!item.appleUrl) item.appleUrl = d.results[0].trackViewUrl;
          }
        } catch (e) { }
      }

    } else {
      const [odesliData, tfData] = await Promise.allSettled([
        fetchOdesli(item.appleUrl),
        fetchTinyfish(item.title, item.artist, item.album),
      ]);
      if (myId !== lastResolveId) return;
      od = odesliData.status === 'fulfilled' ? odesliData.value : null;
      tf = tfData.status === 'fulfilled' ? tfData.value : {};
      await pullItunes(getItunesId(od));

      if (!item.previewUrl) {
        try {
          const q = cleanQ(item.title) + ' ' + cleanQ(item.artist);
          const r = await fetch(`https://itunes.apple.com/search?term=${enc(q)}&entity=song&limit=1&country=${COUNTRY}`);
          const d = await r.json();
          if (d.results?.[0]) {
            item.previewUrl = d.results[0].previewUrl;
            item.art = (d.results[0].artworkUrl100 || item.art).replace('100x100bb', '600x600bb');
            if (!item.appleUrl) item.appleUrl = d.results[0].trackViewUrl;
          }
        } catch (e) { }
      }
    }

    const ent = od?.entitiesByUniqueId?.[od?.entityUniqueId] || {};
    const finalTitle = (ent.title && ent.title !== 'Unknown') ? ent.title : item.title;
    const finalArtist = (ent.artistName && ent.artistName !== 'Unknown') ? ent.artistName : item.artist;

    const links = {};
    P.forEach(p => {
      let href = od?.linksByPlatform?.[p.id]?.url;
      if (!href && p.id === 'youtubeMusic') {
        const yt = od?.linksByPlatform?.youtube?.url;
        if (yt && yt.includes('watch')) href = yt.replace('www.youtube.com', 'music.youtube.com').replace('youtube.com', 'music.youtube.com');
      }
      if (href) links[p.id] = href;
    });

    if (!links.spotify && tf.spotify) links.spotify = tf.spotify;

    // Always prefer Tinyfish for YouTube Music if it found a native link
    if (tf.youtubeMusic) {
      links.youtubeMusic = tf.youtubeMusic;
    }

    if (!links.appleMusic) {
      if (item.appleUrl) links.appleMusic = item.appleUrl;
      else if (typeof data === 'string' && data.includes('music.apple.com')) links.appleMusic = data;
    }

    /**
     * Final UI population and internal state update.
     * Prepares the data for universal sharing.
     */
    currentData = { t: finalTitle, a: finalArtist, v: item.art, p: item.previewUrl, l: links };
    populateUI(finalTitle, finalArtist, item.art, item.previewUrl, links);
    cardEl.style.display = 'block';



  } catch (e) {
    if (e.message === 'NoStreamingLinks') {
      showErr('No streaming links found for this track.');
    } else {
      showErr('Could not fetch links. Try again.');
    }
    console.error(e);
  } finally {
    setLoad(false);
  }
}

/**
 * Populates the card UI with provided metadata and streaming links.
 * Shared between the main resolution pipeline and the instant-load share decoder.
 */
function populateUI(title, artist, art, preview, links) {
  const artEl = document.getElementById('art');
  artEl.src = art || '';
  artEl.alt = art ? `${title} — ${artist} album artwork` : '';
  document.getElementById('ctitle').textContent = title;
  const artistEl = document.getElementById('cartist');
  artistEl.textContent = artist;
  artistEl.classList.toggle('lp-easter', artist.trim().toLowerCase().includes('linkin park'));

  const pWrap = document.getElementById('playerWrap');
  if (preview) {
    pWrap.style.display = 'flex';
    audio.src = preview;
    audio.load();
    document.getElementById('seekFill').style.width = '0%';
    document.getElementById('timeLabel').textContent = '0:00';
  } else {
    pWrap.style.display = 'none';
    audio.pause();
  }

  linksEl.innerHTML = '';
  P.forEach(p => {
    let href = links[p.id]; if (!href) return;
    try {
      const u = new URL(href);
      if (p.id === 'appleMusic') {
        if (u.hostname === 'geo.music.apple.com') u.hostname = 'music.apple.com';
        for (const k of Array.from(u.searchParams.keys())) if (k !== 'i') u.searchParams.delete(k);
      } else if (p.id === 'spotify') {
        u.searchParams.delete('si'); u.searchParams.delete('context');
      }
      href = u.toString();
    } catch (e) { }
    linksEl.appendChild(makeRow(p, href));
  });
}

/**
 * Fetches platform links via Odesli.
 * Uses the authenticated server proxy when configured.
 * @param {string} url - Target streaming URL.
 */
async function fetchOdesli(url) {
  if (ODESLI_PROXY) {
    const headers = await getPoWHeaders();
    const r = await fetch(`${ODESLI_PROXY}?url=${enc(url)}&userCountry=${COUNTRY}`, { headers });
    if (r.ok) return await r.json();
    throw new Error(`odesli proxy ${r.status}`);
  }

  /** 
   * Fallback: Queries Odesli via AllOrigins. 
   * Used as a fail-safe if the Node.js proxy IP is rate-limited or blocked by Odesli.
   */
  const target = `${ODESLI}?url=${enc(url)}&userCountry=${COUNTRY}`;
  const r = await fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(target)}`);
  if (!r.ok) throw new Error(`odesli ${r.status}`);
  return r.json();
}

/**
 * Searches for streaming links on Tinyfish.
 * Dispatches parallel requests for Spotify and YouTube Music.
 * Uses a priority loop for YouTube Music to favor native tracks over video fallback.
 * @param {string} title - Song title.
 * @param {string} artist - Artist name.
 * @param {string} album - Optional album name for better query targeting.
 */
async function fetchTinyfish(title, artist, album = '') {
  const headers = await getPoWHeaders();
  const out = {};

  const knownArtist = (artist && artist !== 'Unknown') ? artist : '';
  const qBase = title + (knownArtist ? ' ' + knownArtist : '');
  const qYt = qBase + (album ? ' ' + album : '') + ' youtube music topic';

  try {
    const [spRes, ytRes] = await Promise.allSettled([
      fetch(`${TFAPI}?query=${enc(qBase + ' spotify track')}`, { headers }).then(r => r.ok ? r.json() : null),
      fetch(`${TFAPI}?query=${enc(qYt)}`, { headers }).then(r => r.ok ? r.json() : null)
    ]);

    if (spRes.status === 'fulfilled' && spRes.value?.results) {
      for (const r of spRes.value.results) {
        if (r.url.includes('open.spotify.com/track')) {
          out.spotify = r.url; break;
        }
      }
    }

    if (ytRes.status === 'fulfilled' && ytRes.value?.results) {
      let bestUrl = null;
      let maxScore = -1;

      ytRes.value.results.forEach((r, i) => {
        // Strict domain and track filter (removes playlists and 'site embeds')
        const isYt = r.url.includes('youtube.com/watch') || r.url.includes('music.youtube.com/watch');
        if (!isYt || r.url.includes('list=')) return;

        // Base score starts with rank (higher rank = higher base)
        let score = 20 - i;

        // Massive boost for native music domain
        if (r.url.includes('music.youtube.com')) score += 30;

        // Boost for clean title matches (ignores "Official Video" fluff)
        const rTitle = r.title.toLowerCase().trim();
        const tTitle = title.toLowerCase().trim();

        if (rTitle === tTitle) score += 40;
        else if (rTitle.includes(tTitle)) score += 10;

        // Cleanliness Bonus: Topic tracks usually have shorter, cleaner titles
        const lengthDiff = Math.abs(r.title.length - title.length);
        if (lengthDiff < 5) score += 20;

        if (score > maxScore) {
          maxScore = score;
          bestUrl = r.url;
        }
      });

      if (bestUrl) {
        out.youtubeMusic = bestUrl.replace('www.youtube.com', 'music.youtube.com');
      }
    }
  } catch (e) {
    console.error('TinyFish error:', e);
  }

  return out;
}

/**
 * Creates a styled UI row for a streaming platform.
 * Includes 'Copy Link' functionality with visual feedback.
 * @param {object} p - Platform definition object.
 * @param {string} href - Target URL.
 */
function makeRow(p, href) {
  const row = document.createElement('div');
  row.className = 'prow';

  const a = document.createElement('a');
  a.className = 'plink'; a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer';

  const icon = document.createElement('div');
  icon.className = 'picon';
  icon.style.background = p.bg;
  icon.innerHTML = `<svg viewBox="${p.viewBox || '0 0 24 24'}" fill="${p.fg}" xmlns="http://www.w3.org/2000/svg">${p.svg}</svg>`;

  const name = document.createElement('span');
  name.className = 'pname'; name.textContent = p.name;

  a.append(icon, name);

  const btn = document.createElement('button');
  btn.className = 'copy-btn';
  btn.title = 'Copy link';
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>Copy`;

  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(href);
      btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>Copied`;
      btn.classList.add('copied');
      setTimeout(() => {
        btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>Copy`;
        btn.classList.remove('copied');
      }, 1800);
    } catch (_) { }
  });

  row.append(a, btn);
  return row;
}

/** Toggles loading states across UI components. */
function setLoad(on) {
  if (on && typeof audio !== 'undefined') { try { audio.pause(); } catch (e) { } }
  loaderEl.style.display = on ? 'block' : 'none';
  if (on) { cardEl.style.display = 'none'; errEl.style.display = 'none'; }
}

/** Displays error messages to the user. */
function showErr(msg) { errEl.textContent = msg; errEl.style.display = 'block'; loaderEl.style.display = 'none'; }

/** URL safe encoder. */
function enc(s) { return encodeURIComponent(s); }

/** HTML escaper to prevent XSS on user-controlled metadata. */
function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

/**
 * Rotates the search placeholder text.
 * Occurs only when the input is empty and not focused to prevent disruption.
 */
let phIdx = 1;
setInterval(() => {
  if (document.activeElement !== qEl && qEl.value === '') {
    qEl.classList.add('ph-fade');
    setTimeout(() => {
      phIdx = (phIdx + 1) % PLACEHOLDERS.length;
      qEl.placeholder = PLACEHOLDERS[phIdx];
      qEl.classList.remove('ph-fade');
    }, 500);
  }
}, 3000);

if (PROXY_URL) fetchAndSolveChallenge();
