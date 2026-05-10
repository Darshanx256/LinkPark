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

const challengeQueue = []; // Array of { promise, ts }

async function solvePoW(seed, difficulty) {
  const target = '0'.repeat(difficulty);
  const encoder = new TextEncoder();
  let nonce = 0;
  
  while (true) {
    const data = encoder.encode(seed + nonce);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    
    if (hashHex.startsWith(target)) return nonce;
    nonce++;

    if (nonce % 500 === 0) await new Promise(r => setTimeout(r, 0));
  }
}

function fetchAndSolveChallenge() {
  if (!PROXY_URL) return;
  const ts = Date.now();
  const promise = (async () => {
    try {
      const res = await fetch(`${PROXY_URL}/api/challenge`);
      if (!res.ok) throw new Error('Challenge fetch failed');
      const { seed, difficulty } = await res.json();
      const nonce = await solvePoW(seed, difficulty);
      return { seed, nonce, ts };
    } catch (e) {
      console.error('PoW challenge failed:', e);
      const idx = challengeQueue.findIndex(item => item.promise === promise);
      if (idx > -1) challengeQueue.splice(idx, 1);
      await new Promise(r => setTimeout(r, 2000));
      throw e;
    }
  })();
  challengeQueue.push({ promise, ts });
}

async function getPoWHeaders() {
  if (!PROXY_URL) return { 'X-API-Key': TFKEY };
  const now = Date.now();
  while (challengeQueue.length > 0 && (now - challengeQueue[0].ts > 90000)) {
    challengeQueue.shift();
  }
  if (challengeQueue.length === 0) fetchAndSolveChallenge();
  try {
    const { promise } = challengeQueue.shift();
    const pow = await promise;
    if (challengeQueue.length < 2) fetchAndSolveChallenge();
    return { 'X-LP-Seed': pow.seed, 'X-LP-Nonce': pow.nonce.toString() };
  } catch (e) {
    if (challengeQueue.length > 0) return getPoWHeaders();
    return {};
  }
}

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
  const itid = d.l.appleMusic?.match(/[?&]i=(\d+)/)?.[1] || '';
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

const qEl = document.getElementById('q');
const ddEl = document.getElementById('dd');
const hintEl = document.getElementById('hint');
const loaderEl = document.getElementById('loader');
const errEl = document.getElementById('err');
const cardEl = document.getElementById('card');
const linksEl = document.getElementById('links');
const logoEl = document.querySelector('.logo');

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

let timer = null, idx = -1, items = [];
const audio = new Audio();
let isPlaying = false;

audio.addEventListener('play', () => { isPlaying = true; updatePlayBtn(); });
audio.addEventListener('pause', () => { isPlaying = false; updatePlayBtn(); });
audio.addEventListener('ended', () => { isPlaying = false; updatePlayBtn(); });
let lastTimeUpdate = 0;
audio.addEventListener('timeupdate', () => {
  const now = Date.now();
  if (now - lastTimeUpdate < 500) return;
  lastTimeUpdate = now;
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
  const hash = await encodeShare(currentData);

  // Use the frontend origin for sharing to keep the proxy endpoint private and secure.
  const shareUrl = new URL(window.location.origin);
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

window.addEventListener('load', async () => {
  const s = new URLSearchParams(window.location.search).get('s');
  if (s) {
    const data = await decodeShare(s);
    if (data) {
      setLoad(true);
      const myId = ++lastResolveId;
      try {
        const fetchResolve = async (retry = true) => {
          if (!PROXY_URL) return null;
          const h = await getPoWHeaders();
          const r = await fetch(`${PROXY_URL}/api/resolve?query=${enc(data.t + ' ' + data.a)}&artist=${enc(data.a)}&country=${COUNTRY}`, { headers: h });
          if (r.status === 401 && retry) {
             challengeQueue.length = 0;
             return fetchResolve(false);
          }
          return r.ok ? r.json() : null;
        };

        const [res, it] = await Promise.allSettled([
          fetchResolve(),
          data.itunesId ? fetch(`https://itunes.apple.com/lookup?id=${data.itunesId}&country=${COUNTRY}`).then(r => r.json()) : Promise.resolve(null)
        ]);

        if (myId !== lastResolveId) return;
        const resolved = res.status === 'fulfilled' ? res.value : null;
        const itData = it.status === 'fulfilled' ? it.value : null;

        let art = '', preview = '', merged = { ...data.l };
        if (itData?.results?.[0]) {
           const track = itData.results[0];
           art = track.artworkUrl100.replace('100x100bb', '600x600bb');
           preview = track.previewUrl;
           merged.appleMusic = track.trackViewUrl;
        }
        if (resolved) {
           Object.assign(merged, resolved.links);
           art = art || resolved.art;
        }
        populateUI(data.t, data.a, art, preview, merged);
        cardEl.style.display = 'block';
      } catch (e) {
        populateUI(data.t, data.a, '', '', data.l);
        cardEl.style.display = 'block';
      }
      setLoad(false);
    }
  }
});

function formatTime(s) {
  const min = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

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

qEl.addEventListener('input', () => {
  clearTimeout(timer);
  const v = qEl.value.trim();
  closeDD();
  errEl.style.display = 'none';
  if (v.length < 2 || v !== `${currentData?.t} — ${currentData?.a}`) {
    const url = new URL(window.location.href);
    if (url.searchParams.has('s')) {
      url.searchParams.delete('s');
      window.history.replaceState({}, '', url);
    }
  }
  if (v.length < 2) return;
  if (!/\s/.test(v) && /^(https?:\/\/|spotify:track:)/i.test(v)) {
    let url = v;
    if (!/^https?:\/\//i.test(url) && !url.startsWith('spotify:')) url = 'https://' + url;
    timer = setTimeout(() => resolve(url), 220);
    return;
  }
  timer = setTimeout(() => suggest(v), 220);
});

async function suggest(q) {
  try {
    const r = await fetch(`https://itunes.apple.com/search?term=${enc(q)}&entity=song&limit=6&country=${COUNTRY}&v=${Date.now()}`);
    const d = await r.json();
    renderDD(d.results || []);
  } catch (_) { }
}

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
    <div class="dd-item" data-i="${i}" role="option">
      <img src="${it.thumb}" loading="lazy" onerror="this.onerror=null;this.src='assets/logo.webp';" alt="${esc(it.title)} by ${esc(it.artist)}">
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

qEl.addEventListener('keydown', e => {
  if (ddEl.style.display !== 'block') return;
  if (e.key === 'ArrowDown') { e.preventDefault(); idx = (idx + 1) % items.length; hl(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); idx = (idx - 1 + items.length) % items.length; hl(); }
  else if (e.key === 'Enter') { e.preventDefault(); if (idx >= 0) pick(idx); }
  else if (e.key === 'Escape') { closeDD(); }
});

function hl() { ddEl.querySelectorAll('.dd-item').forEach((el, i) => el.classList.toggle('active', i === idx)); }
function closeDD() { ddEl.style.display = 'none'; hintEl.classList.remove('on'); idx = -1; }
document.addEventListener('click', e => { if (!e.target.closest('.search-wrap')) closeDD(); });

function pick(i) {
  const it = items[i]; if (!it) return;
  qEl.value = `${it.title} — ${it.artist}`;
  closeDD();
  resolve(it);
}

document.getElementById('searchForm')?.addEventListener('submit', e => {
  e.preventDefault();
  const v = qEl.value.trim();
  if (!v) return;
  if (ddEl.style.display === 'block' && idx >= 0) { pick(idx); return; }
  const isUrl = /^(https?:\/\/|spotify:track:)/i.test(v) || (!/\s/.test(v) && v.includes('.'));
  if (isUrl) { clearTimeout(timer); closeDD(); resolve(v); }
});

async function resolve(data) {
  const myId = ++lastResolveId;
  let item = typeof data === 'object' ? data : null;
  const isUrl = typeof data === 'string';

  if (item) populateUI(item.title, item.artist, item.art || item.thumb.replace('100x100bb', '600x600bb'), item.previewUrl, null);
  else populateUI('', '', '', null, null);
  cardEl.style.display = 'block';
  setLoad(true);

  try {
    const q = item ? `${item.title} ${item.artist}` : '';
    const u = isUrl ? data : (item?.appleUrl || '');
    
    const fetchResolve = async (retry = true) => {
      if (!PROXY_URL) return null;
      const h = await getPoWHeaders();
      const r = await fetch(`${PROXY_URL}/api/resolve?query=${enc(q)}&u=${enc(u)}&artist=${enc(item?.artist || '')}&album=${enc(item?.album || '')}&country=${COUNTRY}`, { headers: h });
      if (r.status === 401 && retry) {
        challengeQueue.length = 0;
        return fetchResolve(false);
      }
      return r.ok ? r.json() : null;
    };

    // Parallel attempt 1: Get server resolution and initial iTunes lookup
    // If it's a 'Search Pick', the client already has metadata/preview.
    // If it's a 'URL Drop', the server will handle the iTunes lookup for us.
    const [resolved, itunesData] = await Promise.allSettled([
      fetchResolve(),
      (item && !item.previewUrl) ? fetch(`https://itunes.apple.com/search?term=${enc(q)}&entity=song&limit=1&country=${COUNTRY}`).then(r => r.json()) : Promise.resolve(null)
    ]);

    if (myId !== lastResolveId) return;
    const res = (resolved.status === 'fulfilled') ? resolved.value : null;
    const it = (itunesData.status === 'fulfilled') ? itunesData.value : null;

    // 4. Final Resort: Local Fallback (Fetch at local on user's device)
    if ((!res || Object.keys(res.links || {}).length === 0) && isUrl) {
      try {
        const targetUrl = u.replace('music.youtube.com', 'youtube.com').replace('youtube.com/shorts/', 'youtube.com/watch?v=');
        const localRes = await fetch(`${ODESLI}?url=${enc(targetUrl)}&userCountry=${COUNTRY}`);
        if (localRes.ok) {
          const localData = await localRes.json();
          if (localData.linksByPlatform) {
            const localLinks = {};
            Object.keys(localData.linksByPlatform).forEach(k => localLinks[k] = localData.linksByPlatform[k].url);
            
            const ent = localData.entitiesByUniqueId?.[localData.entityUniqueId] || {};
            const finalT = ent.title || item.title;
            const finalA = ent.artistName || item.artist;
            const finalArt = ent.thumbnailUrl || item.art;

            populateUI(finalT, finalA, finalArt, item.previewUrl, localLinks);
            currentData = { t: finalT, a: finalA, itunesId: null, l: localLinks };
            return;
          }
        }
      } catch (err) { console.warn('Local fallback failed:', err); }
    }

    if (!res) { showErr('Failed to resolve song links.'); return; }
    if (!item) item = { title: '', artist: '', art: '', previewUrl: null };

    // Update item with iTunes results if available (primarily for Search Picks)
    if (it?.results?.[0]) {
      const r = it.results[0];
      if (!item.previewUrl) item.previewUrl = r.previewUrl;
      if (!item.art) item.art = r.artworkUrl100.replace('100x100bb', '600x600bb');
      if (!res.links.appleMusic) res.links.appleMusic = r.trackViewUrl;
    }

    // Merge everything (preferring server-side cooked data)
    const finalT = res.title || item.title;
    const finalA = res.artist || item.artist;
    const finalArt = res.art || item.art;
    const finalPreview = res.preview || item.previewUrl;

    const itunesId = res.links.appleMusic?.match(/[?&]i=(\d+)/)?.[1] || null;
    populateUI(finalT, finalA, finalArt, finalPreview, res.links);
    currentData = { t: finalT, a: finalA, itunesId, l: res.links };

  } catch (e) {
    console.error('Resolve failed:', e);
    if (myId === lastResolveId) showErr('Network error. Check your connection.');
  } finally {
    if (myId === lastResolveId) setLoad(false);
  }
}

function populateUI(title, artist, art, preview, links) {
  const artEl = document.getElementById('art');
  const ctitleEl = document.getElementById('ctitle');
  const cartistEl = document.getElementById('cartist');
  const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

  if (!art && !title) { artEl.src = BLANK; artEl.classList.add('skeleton'); }
  else { artEl.classList.remove('skeleton'); artEl.src = art || 'assets/logo.webp'; }
  artEl.alt = title ? `${title} — ${artist} album artwork` : '';

  if (!title) {
    ctitleEl.textContent = ''; ctitleEl.classList.add('skeleton');
    cartistEl.textContent = ''; cartistEl.classList.add('skeleton');
  } else {
    ctitleEl.classList.remove('skeleton'); ctitleEl.textContent = title;
    cartistEl.classList.remove('skeleton'); cartistEl.textContent = artist;
    cartistEl.classList.toggle('lp-easter', artist.trim().toLowerCase().includes('linkin park'));
  }

  const pWrap = document.getElementById('playerWrap');
  if (preview) {
    pWrap.style.display = 'flex';
    const currentSrc = audio.src.split('?')[0];
    const nextSrc = preview.split('?')[0];
    if (currentSrc !== nextSrc) { audio.src = preview; audio.load(); }
  } else {
    pWrap.style.display = 'none';
    audio.pause();
  }

  linksEl.innerHTML = '';
  if (!links || Object.keys(links).length === 0) {
    const shareBtn = document.getElementById('shareCardBtn');
    if (shareBtn) shareBtn.classList.add('skeleton');
    
    if (links) { // Explicitly empty links
      linksEl.innerHTML = '<div class="err-msg">No links found for this song.</div>';
      return;
    }

    for (let i = 0; i < 5; i++) {
      const row = document.createElement('div');
      row.className = 'prow skeleton';
      row.innerHTML = `
        <div class="plink">
          <div class="picon"></div>
          <span class="pname"></span>
        </div>
        <div class="copy-btn"></div>
      `;
      linksEl.append(row);
    }
    return;
  }

  const shareBtn = document.getElementById('shareCardBtn');
  if (shareBtn) shareBtn.classList.remove('skeleton');

  P.forEach(p => {
    let href = links[p.id]; if (!href) return;
    try {
      const u = new URL(href);
      if (p.id === 'appleMusic') {
        // Normalize all Apple domains to music.apple.com for consistency
        if (u.hostname.includes('apple.com')) u.hostname = 'music.apple.com';
        // Preserve only the track identifier 'i', remove tracking/affiliate params
        const trackId = u.searchParams.get('i');
        Array.from(u.searchParams.keys()).forEach(k => u.searchParams.delete(k));
        if (trackId) u.searchParams.set('i', trackId);
      } else if (p.id === 'spotify') {
        u.searchParams.delete('si'); u.searchParams.delete('context');
      }
      href = u.toString();
    } catch (e) { }
    linksEl.appendChild(makeRow(p, href));
  });
}

/**
 * Creates a styled UI row for a streaming platform.
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
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>Copy`;
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(href);
      const old = btn.innerHTML;
      btn.innerHTML = 'Copied!';
      btn.classList.add('copied');
      setTimeout(() => { btn.innerHTML = old; btn.classList.remove('copied'); }, 2000);
    } catch (e) { }
  });
  row.append(a, btn);
  return row;
}

function setLoad(on) {
  if (on && typeof audio !== 'undefined') { 
    try { 
      audio.pause(); 
      audio.currentTime = 0;
      updatePlayBtn();
    } catch (e) { } 
  }
  if (on && cardEl.style.display !== 'block') loaderEl.style.display = 'block';
  else loaderEl.style.display = 'none';
  if (on) errEl.style.display = 'none';
}

function showErr(msg) { errEl.textContent = msg; errEl.style.display = 'block'; loaderEl.style.display = 'none'; }
function enc(s) { return encodeURIComponent(s); }
function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

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

if (PROXY_URL) {
  fetchAndSolveChallenge();
  fetchAndSolveChallenge();
}
