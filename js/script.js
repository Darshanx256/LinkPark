/**
 * Core configuration and API endpoint derivations.
 * PROXY: Target URL for the Node.js proxy server to abstract API keys.
 * TFAPI: Search endpoint for Tinyfish API (either proxied or direct).
 * ODESLI_PROXY: Resolution endpoint for Odesli via local proxy.
 * COUNTRY: Derived ISO country code for region-specific music availability.
 */
const ODESLI = 'https://api.song.link/v1-alpha.1/links';
const PROXY = 'https://linkpark.onrender.com/api/search'; 
const TFKEY = window.LINKPARK_CONFIG?.TFKEY || 'YOUR_TINYFISH_API_KEY_HERE';
const PROXY_BASE = PROXY ? PROXY.replace(/\/api\/search$/, '') : '';
const TFAPI = PROXY_BASE ? PROXY_BASE + '/api/search' : 'https://api.search.tinyfish.ai';
const ODESLI_PROXY = PROXY_BASE ? PROXY_BASE + '/api/odesli' : '';
const COUNTRY = navigator.language.split('-')[1]?.toUpperCase() || 'US';

/** 
 * Unique identifier for the current resolution request.
 * Used to discard results from stale network requests when a new search begins.
 */
let lastResolveId = 0; 
let currentData = null; // Stores currently resolved track for sharing

const SMAP = { s: 'spotify', a: 'appleMusic', y: 'youtubeMusic', z: 'amazonMusic', t: 'tidal', d: 'deezer', p: 'pandora' };
const SREV = { spotify: 's', appleMusic: 'a', youtubeMusic: 'y', amazonMusic: 'z', tidal: 't', deezer: 'd', pandora: 'p' };

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
const P = [
  {
    id: 'spotify', name: 'Spotify', bg: '#1DB954', fg: '#fff',
    svg: `<path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/>`
  },
  {
    id: 'appleMusic', name: 'Apple Music', bg: '#FA243C', fg: '#fff',
    svg: `<path d="M23.994 6.124a9.23 9.23 0 00-.24-2.19c-.317-1.31-1.062-2.31-2.18-3.043a5.022 5.022 0 00-1.877-.726 10.496 10.496 0 00-1.564-.15c-.04-.003-.083-.01-.124-.013H5.986c-.152.01-.303.017-.455.026-.747.043-1.49.123-2.193.4-1.336.53-2.3 1.452-2.865 2.78-.192.448-.292.925-.363 1.408-.056.392-.088.785-.1 1.18 0 .032-.007.062-.01.093v12.223c.01.14.017.283.027.424.05.815.154 1.624.497 2.373.65 1.42 1.738 2.353 3.234 2.801.42.127.856.187 1.293.228.555.053 1.11.06 1.667.06h11.03a12.5 12.5 0 001.57-.1c.822-.106 1.596-.35 2.295-.81a5.046 5.046 0 001.88-2.207c.186-.42.293-.87.37-1.324.113-.675.138-1.358.137-2.04-.002-3.8 0-7.595-.003-11.393zm-6.423 3.99v5.712c0 .417-.058.827-.244 1.206-.29.59-.76.962-1.388 1.14-.35.1-.706.157-1.07.173-.95.045-1.773-.6-1.943-1.536a1.88 1.88 0 011.038-2.022c.323-.16.67-.25 1.018-.324.378-.082.758-.153 1.134-.24.274-.063.457-.23.51-.516a.904.904 0 00.02-.193c0-1.815 0-3.63-.002-5.443a.725.725 0 00-.026-.185c-.04-.15-.15-.243-.304-.234-.16.01-.318.035-.475.066-.76.15-1.52.303-2.28.456l-2.325.47-1.374.278c-.016.003-.032.01-.048.013-.277.077-.377.203-.39.49-.002.042 0 .086 0 .13-.002 2.602 0 5.204-.003 7.805 0 .42-.047.836-.215 1.227-.278.64-.77 1.04-1.434 1.233-.35.1-.71.16-1.075.172-.96.036-1.755-.6-1.92-1.544-.14-.812.23-1.685 1.154-2.075.357-.15.73-.232 1.108-.31.287-.06.575-.116.86-.177.383-.083.583-.323.6-.714v-.15c0-2.96 0-5.922.002-8.882 0-.123.013-.25.042-.37.07-.285.273-.448.546-.518.255-.066.515-.112.774-.165.733-.15 1.466-.296 2.2-.444l2.27-.46c.67-.134 1.34-.27 2.01-.403.22-.043.442-.088.663-.106.31-.025.523.17.554.482.008.073.012.148.012.223.002 1.91.002 3.822 0 5.732z"/>`
  },
  {
    id: 'youtubeMusic', name: 'YT Music', bg: '#FF0000', fg: '#fff',
    svg: `<path d="M12 0C5.376 0 0 5.376 0 12s5.376 12 12 12 12-5.376 12-12S18.624 0 12 0zm0 19.104c-3.924 0-7.104-3.18-7.104-7.104S8.076 4.896 12 4.896s7.104 3.18 7.104 7.104-3.18 7.104-7.104 7.104zm0-13.332c-3.432 0-6.228 2.796-6.228 6.228S8.568 18.228 12 18.228s6.228-2.796 6.228-6.228S15.432 5.772 12 5.772zM9.684 15.54V8.46L15.816 12l-6.132 3.54z"/>`
  },
  {
    id: 'amazonMusic', name: 'Amazon Music', bg: 'linear-gradient(135deg, #00A8E1, #00E1D9)', fg: '#000', viewBox: '0 0 90 90',
    svg: `<path d="M 71.266 44.277 c -7.112 5.253 -17.446 8.042 -26.331 8.042 c -12.452 0 -23.672 -4.605 -32.146 -12.258 c -0.67 -0.605 -0.065 -1.427 0.735 -0.951 c 9.166 5.318 20.473 8.539 32.168 8.539 c 7.891 0 16.56 -1.643 24.537 -5.015 C 71.417 42.093 72.433 43.412 71.266 44.277 z M 74.227 40.904 c -0.908 -1.167 -6.01 -0.562 -8.323 -0.281 c -0.692 0.086 -0.8 -0.519 -0.173 -0.973 c 4.064 -2.854 10.744 -2.032 11.523 -1.081 c 0.778 0.973 -0.216 7.653 -4.021 10.852 c -0.584 0.497 -1.146 0.238 -0.886 -0.411 C 73.211 46.871 75.135 42.05 74.227 40.904 z" transform="translate(-13.5, 3) scale(1.3)"/>`
  },
  {
    id: 'tidal', name: 'Tidal', bg: '#00FFFF', fg: '#000',
    svg: `<path d="M12.012 3.992L8.008 7.996 4.004 3.992 0 7.996 4.004 12l4.004-4.004L12.012 12l-4.004 4.004 4.004 4.004 4.004-4.004L12.012 12l4.004-4.004-4.004-4.004zM16.042 7.996l3.979-3.979L24 7.996l-3.979 3.979z"/>`
  },
  {
    id: 'deezer', name: 'Deezer', bg: '#EF5466', fg: '#fff',
    svg: `<path d="M.693 10.024c.381 0 .693-1.256.693-2.807 0-1.55-.312-2.807-.693-2.807C.312 4.41 0 5.666 0 7.217s.312 2.808.693 2.808ZM21.038 1.56c-.364 0-.684.805-.91 2.096C19.765 1.446 19.184 0 18.526 0c-.78 0-1.464 2.036-1.784 5-.312-2.158-.788-3.536-1.325-3.536-.745 0-1.386 2.704-1.62 6.472-.442-1.932-1.083-3.145-1.793-3.145s-1.35 1.213-1.793 3.145c-.242-3.76-.874-6.463-1.628-6.463-.537 0-1.013 1.378-1.325 3.535C6.938 2.036 6.262 0 5.474 0c-.658 0-1.247 1.447-1.602 3.665-.217-1.291-.546-2.105-.91-2.105-.675 0-1.221 2.807-1.221 6.272 0 3.466.546 6.273 1.221 6.273.277 0 .537-.476.736-1.273.32 2.928.996 4.938 1.776 4.938.606 0 1.143-1.204 1.507-3.11.251 3.622.875 6.195 1.602 6.195.46 0 .875-1.023 1.187-2.677C10.142 21.6 11 24 12.004 24c1.005 0 1.863-2.4 2.235-5.822.312 1.654.727 2.677 1.186 2.677.728 0 1.352-2.573 1.603-6.195.364 1.906.9 3.11 1.507 3.11.78 0 1.455-2.01 1.775-4.938.208.797.46 1.273.737 1.273.675 0 1.22-2.807 1.22-6.273-.008-3.457-.553-6.272-1.23-6.272ZM23.307 10.024c.381 0 .693-1.256.693-2.807 0-1.55-.312-2.807-.693-2.807-.381 0-.693 1.256-.693 2.807s.312 2.808.693 2.808Z"/>`
  },
  {
    id: 'pandora', name: 'Pandora', bg: '#224099', fg: '#fff',
    svg: `<path d="M2.541 0v24h4.484V16.89h4.869c5.65 0 9.565-3.325 9.565-8.527 0-5.067-3.606-8.363-8.868-8.363H2.541z"/>`
  },
];

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
  const url = new URL(window.location.href);
  const hash = await encodeShare(currentData);
  url.searchParams.set('s', hash);
  try {
    await navigator.clipboard.writeText(url.toString());
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
  
  if (v.length < 2) {
    const url = new URL(window.location.href);
    if (url.searchParams.has('s')) {
      url.searchParams.delete('s');
      window.history.replaceState({}, '', url);
    }
    return;
  }

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

    // Sync URL state without reload (safety check for race conditions)
    if (myId === lastResolveId) {
      const hash = await encodeShare(currentData);
      const url = new URL(window.location.href);
      url.searchParams.set('s', hash);
      window.history.replaceState({}, '', url);
    }

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
  document.getElementById('cartist').textContent = artist;

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
 * Automatically falls back to corsproxy.io if no server proxy is configured.
 * @param {string} url - Target streaming URL.
 */
async function fetchOdesli(url) {
  try {
    if (ODESLI_PROXY) {
      const r = await fetch(`${ODESLI_PROXY}?url=${enc(url)}&userCountry=${COUNTRY}`);
      if (r.ok) return await r.json();
      console.warn(`Odesli proxy failed (${r.status}), falling back to direct client fetch.`);
    }
  } catch (e) {
    console.warn('Odesli proxy error, falling back to direct client fetch.', e);
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
  const headers = PROXY ? {} : { 'X-API-Key': TFKEY };
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
const ph = ['Type a few lyrics…', 'Search a song…', 'Drop a link…'];
let phIdx = 1; 
setInterval(() => {
  if (document.activeElement !== qEl && qEl.value === '') {
    qEl.classList.add('ph-fade');
    setTimeout(() => {
      phIdx = (phIdx + 1) % ph.length;
      qEl.placeholder = ph[phIdx];
      qEl.classList.remove('ph-fade');
    }, 500);
  }
}, 3000);
