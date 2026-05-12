import {
  ODESLI, PROXY_URL, TFKEY, TFAPI, ODESLI_PROXY,
  COUNTRY, SMAP, SREV, P, PLACEHOLDERS, SAVED_KEY
} from './constants.js';

/** 
 * Unique identifier for the current resolution request.
 * Used to discard results from stale network requests when a new search begins.
 */
let lastResolveId = 0;
let currentData = null; // Stores currently resolved track for sharing

const challengeQueue = []; // Array of { promise, ts }
let isSearching = false;
let resultIdx = -1; // Global keyboard navigation index for results grid

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
      // Quietly handle challenge failure to prevent blocking search
      const idx = challengeQueue.findIndex(item => item.promise === promise);
      if (idx > -1) challengeQueue.splice(idx, 1);
      return null; 
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
    const item = challengeQueue.shift();
    if (!item) return {};
    const pow = await item.promise;
    if (!pow) return {}; // Failed challenge
    if (challengeQueue.length < 2) fetchAndSolveChallenge();
    return { 'X-LP-Seed': pow.seed, 'X-LP-Nonce': pow.nonce.toString() };
  } catch (e) {
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

/**
 * Normalizes a URL by removing query parameters and ensuring consistent origin.
 * @param {string} u - The URL to normalize.
 * @returns {string} The normalized URL string.
 */
function normalizeUrl(u) {
  if (!u) return '';
  try {
    return new URL(u, window.location.origin).href.split('?')[0];
  } catch (e) {
    return u;
  }
}

const qEl = document.getElementById('q');
const ddEl = document.getElementById('dd');
const hintEl = document.getElementById('hint');
const loaderEl = document.getElementById('loader');
const errEl = document.getElementById('err');
const cardEl = document.getElementById('card');
const linksEl = document.getElementById('links');
const logoEl = document.querySelector('.logo');
const resultsGridEl = document.getElementById('resultsGrid');
const stashSectionEl = document.getElementById('stashSection');
const stashGridEl = document.getElementById('stashGrid');
const wrapEl = document.querySelector('.wrap');

if (logoEl) {
  logoEl.addEventListener('click', () => {
    qEl.value = '';
    closeDD();
    cardEl.style.display = 'none';
    resultsGridEl.style.display = 'none';
    setWide(false);
    errEl.style.display = 'none';
    currentData = null;
    isSearching = false;
    resultIdx = -1;
    renderSaved();
    const url = new URL(window.location.href);
    url.searchParams.delete('s');
    window.history.replaceState({}, '', url);
    audio.pause();
    audio.src = '';
    updatePlayersUI();
  });
}

let timer = null, idx = -1, items = [];
const audio1 = new Audio();
const audio2 = new Audio();
let audio = audio1; // Primary pointer
let secondaryAudio = audio2;
let isPlaying = false;
let isFading = false;

let modalPlaylist = [];
let modalIndex = -1;
let stashIdx = -1; // For keyboard navigation in modal

audio1.addEventListener('play', () => { isPlaying = true; updatePlayersUI(); });
audio1.addEventListener('pause', () => { isPlaying = false; updatePlayersUI(); });
audio1.addEventListener('ended', () => { if (audio === audio1) isPlaying = false; updatePlayersUI(); });

audio2.addEventListener('play', () => { isPlaying = true; updatePlayersUI(); });
audio2.addEventListener('pause', () => { isPlaying = false; updatePlayersUI(); });
audio2.addEventListener('ended', () => { if (audio === audio2) isPlaying = false; updatePlayersUI(); });

let lastTimeUpdate = 0;
audio1.addEventListener('timeupdate', (e) => {
  const now = Date.now();
  if (now - lastTimeUpdate < 100) return;
  lastTimeUpdate = now;
  updatePlayersUI();
  checkCrossfade.call(e.target);
});
audio2.addEventListener('timeupdate', (e) => {
  const now = Date.now();
  if (now - lastTimeUpdate < 100) return;
  lastTimeUpdate = now;
  updatePlayersUI();
  checkCrossfade.call(e.target);
});

function updatePlayersUI() {
  const p = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
  const time = formatTime(audio.currentTime);
  const currentSrc = normalizeUrl(audio.src);
  const secondarySrc = isFading ? normalizeUrl(secondaryAudio.src) : null;

  document.querySelectorAll('.player-wrap').forEach(wrap => {
    const item = wrap.closest('[data-preview]') || wrap.closest('.card');
    const itemSrc = normalizeUrl(item?.dataset?.preview || (item?.id === 'card' ? audio.src : ''));
    
    const isCurrent = itemSrc && itemSrc === currentSrc;
    const isNext = itemSrc && itemSrc === secondarySrc;

    if (isCurrent || isNext) {
      const playBtn = wrap.querySelector('.play-btn');
      const seekFill = wrap.querySelector('.seek-fill');
      const timeLabel = wrap.querySelector('.time-label');

      if (playBtn) {
        // If it's the next song fading in, it's effectively "playing"
        const effectivePlaying = isPlaying || (isNext && isFading);
        if (effectivePlaying) {
          playBtn.classList.add('playing');
          playBtn.innerHTML = `<svg viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`;
        } else {
          playBtn.classList.remove('playing');
          playBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>`;
        }
      }
      if (isCurrent) {
        if (seekFill) seekFill.style.width = `${p}%`;
        if (timeLabel) timeLabel.textContent = time;
      }
    } else {
      // Reset other players
      const playBtn = wrap.querySelector('.play-btn');
      if (playBtn) {
        playBtn.classList.remove('playing');
        playBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>`;
      }
      const seekFill = wrap.querySelector('.seek-fill');
      if (seekFill) seekFill.style.width = '0%';
      const timeLabel = wrap.querySelector('.time-label');
      if (timeLabel) timeLabel.textContent = '0:00';
    }
  });
}

function handlePlayClick(e) {
  e.stopPropagation();
  const btn = e.currentTarget;
  const wrap = btn.closest('.player-wrap');
  const item = wrap.closest('[data-preview]') || wrap.closest('.card');
  const src = item?.dataset?.preview || (item?.id === 'card' ? audio.src : '');

  if (!src) return;

  if (normalizeUrl(audio.src) === normalizeUrl(src)) {
    if (isPlaying) audio.pause(); else audio.play();
  } else {
    audio.src = src;
    audio.play();
  }
}

function handleSeekClick(e) {
  e.stopPropagation();
  if (!audio.duration || isFading) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const wrap = e.currentTarget.closest('.player-wrap');
  const item = wrap.closest('[data-preview]') || wrap.closest('.card');
  const src = item?.dataset?.preview || (item?.id === 'card' ? audio.src : '');

  if (normalizeUrl(audio.src) !== normalizeUrl(src)) return;

  const p = (e.clientX - rect.left) / rect.width;
  audio.currentTime = p * audio.duration;
}

function crossfadeTo(src, nextIndex) {
  if (isFading) return;
  isFading = true;
  
  secondaryAudio.src = src;
  secondaryAudio.volume = 0;
  secondaryAudio.play();
  updatePlayersUI(); // Trigger UI update to show next song as playing
  
  const fadeTime = 3000;
  const steps = 30;
  const interval = fadeTime / steps;
  let step = 0;
  
  const fader = setInterval(() => {
    step++;
    const p = step / steps;
    audio.volume = 1 - p;
    secondaryAudio.volume = p;
    
    if (step >= steps) {
      clearInterval(fader);
      audio.pause();
      audio.volume = 1;
      
      // Swap pointers
      const temp = audio;
      audio = secondaryAudio;
      secondaryAudio = temp;
      
      modalIndex = nextIndex;
      isFading = false;
      updatePlayersUI();
    }
  }, interval);
}

audio1.addEventListener('timeupdate', checkCrossfade);
audio2.addEventListener('timeupdate', checkCrossfade);

function checkCrossfade() {
  const currentAudio = this;
  if (currentAudio !== audio || isFading || modalIndex === -1) return;
  
  if (currentAudio.duration && currentAudio.duration - currentAudio.currentTime <= 3) {
    if (modalIndex < modalPlaylist.length - 1) {
      const nextIdx = modalIndex + 1;
      const nextItem = modalPlaylist[nextIdx];
      if (nextItem.preview) {
        crossfadeTo(nextItem.preview, nextIdx);
      }
    }
  }
}

document.querySelectorAll('.play-btn').forEach(btn => btn.addEventListener('click', handlePlayClick));
document.querySelectorAll('.seek-wrap').forEach(btn => btn.addEventListener('click', handleSeekClick));

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
  } else {
    renderSaved();
  }
});

function formatTime(s) {
  const min = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${min}:${sec.toString().padStart(2, '0')}`;
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
  if (v.length < 2) {
    resultsGridEl.style.display = 'none';
    setWide(false);
    resultIdx = -1;
    renderSaved();
    return;
  }
  if (!/\s/.test(v) && /^(https?:\/\/|spotify:track:)/i.test(v)) {
    let url = v;
    if (!/^https?:\/\//i.test(url) && !url.startsWith('spotify:')) url = 'https://' + url;
    timer = setTimeout(() => resolve(url), 220);
    return;
  }
  isSearching = false;
  timer = setTimeout(() => suggest(v), 220);
});

async function suggest(q) {
  if (isSearching) return;
  try {
    const r = await fetch(`https://itunes.apple.com/search?term=${enc(q)}&entity=song&limit=6&country=${COUNTRY}&v=${Date.now()}`);
    const d = await r.json();
    if (isSearching) return;
    renderDD(d.results || []);
  } catch (_) { }
}

function renderDD(tracks) {
  if (!tracks.length) { closeDD(); return; }
  items = tracks.map(t => ({
    appleUrl: t.trackViewUrl,
    title: t.trackName,
    artist: t.artistName,
    art: (t.artworkUrl100 || t.artworkUrl60).replace('100x100bb', '200x200bb'),
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
  if (e.key === 'Enter') {
    isSearching = true;
    clearTimeout(timer);
    closeDD();
    // Form submit handles the rest
  }
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
  isSearching = true;
  clearTimeout(timer);
  closeDD();
  const v = qEl.value.trim();
  if (!v) return;
  if (ddEl.style.display === 'block' && idx >= 0) { pick(idx); return; }
  const isUrl = /^(https?:\/\/|spotify:track:)/i.test(v) || (!/\s/.test(v) && v.includes('.'));
  if (isUrl) { resolve(v); }
  else { search(v); }
});

function getSaved() {
  try { return JSON.parse(localStorage.getItem(SAVED_KEY) || '[]'); }
  catch (e) { return []; }
}

function updateSavedStorage(saved) {
  localStorage.setItem(SAVED_KEY, JSON.stringify(saved.slice(0, 50)));
}

function toggleSaved(data) {
  if (!data.t && !data.title) return;
  const saved = getSaved();
  const t = data.t || data.title;
  const a = data.a || data.artist;
  const key = `${t}|${a}`;
  
  const idx = saved.findIndex(f => `${f.t || f.title}|${f.a || f.artist}` === key);
  
  if (idx > -1) {
    // Update links if missing but available in new data
    if (!saved[idx].l && data.l && Object.keys(data.l).length > 0) {
      saved[idx].l = data.l;
    } else {
      saved.splice(idx, 1);
    }
  } else {
    saved.unshift({
      t, a,
      art: data.art,
      preview: data.preview || data.previewUrl,
      l: data.l || null,
      ts: Date.now()
    });
  }
  
  updateSavedStorage(saved);
  renderSaved();
  
  // Update UI stars
  const active = getSaved().some(f => `${f.t || f.title}|${f.a || f.artist}` === key);
  document.querySelectorAll(`.save-btn[data-key="${key.replace(/"/g, '&quot;')}"]`)
    .forEach(btn => btn.classList.toggle('active', active));
}

function renderSaved() {
  const saved = getSaved();
  if (!saved.length || resultsGridEl.style.display === 'flex' || cardEl.style.display === 'block') {
    stashSectionEl.style.display = 'none';
    return;
  }

  stashSectionEl.style.display = 'flex';
  const top20 = saved.slice(0, 20);
  
  let html = top20.map((it, i) => `
    <div class="result-item" data-i="${i}" data-preview="${it.preview || ''}" tabindex="0">
      <div class="card-meta">
        <img class="card-art" src="${it.art || 'assets/logo.webp'}" loading="lazy" alt="${esc(it.t)} artwork">
        <div class="card-info">
          <div class="card-title-wrap">
            <div class="card-title">${esc(it.t)}</div>
          </div>
          <div class="card-artist">${esc(it.a)}</div>
          <div class="player-wrap" ${it.preview ? '' : 'style="display:none"'}>
             <button class="play-btn" aria-label="Play preview">
               <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
             </button>
             <div class="seek-wrap" role="slider">
               <div class="seek-bar"><div class="seek-fill"></div></div>
             </div>
             <div class="time-label">0:00</div>
          </div>
        </div>
      </div>
    </div>
  `).join('');

  if (saved.length > 20) {
    html += `
      <button id="viewAllStash" class="view-all-btn">
        View All ${saved.length} Tracks
      </button>
    `;
  }

  stashGridEl.innerHTML = html;

  // Mask handled by CSS for scroll indication
  stashGridEl.classList.toggle('has-mask', saved.length > 5);

  stashGridEl.querySelectorAll('.result-item').forEach((el, i) => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.player-wrap')) return;
      const it = top20[i];
      if (!it.l || Object.keys(it.l).length === 0) {
        resolve({ title: it.t, artist: it.a, art: it.art, previewUrl: it.preview });
      } else {
        resolve(it);
      }
    });
  });

  document.getElementById('viewAllStash')?.addEventListener('click', openFavsModal);

  stashGridEl.querySelectorAll('.play-btn').forEach(btn => btn.addEventListener('click', handlePlayClick));
  stashGridEl.querySelectorAll('.seek-wrap').forEach(btn => btn.addEventListener('click', handleSeekClick));
  stashGridEl.querySelectorAll('.card-title').forEach(setupMarquee);
  updatePlayersUI();
}

let currentSort = 'date';
const stashModal = document.getElementById('stashModal');
const stashFullList = document.getElementById('stashFullList');

function openFavsModal() {
  stashModal.style.display = 'flex';
  stashIdx = -1;
  renderStash();
}

function closeStashModal() {
  stashModal.style.display = 'none';
}

document.getElementById('closeStash')?.addEventListener('click', closeStashModal);
stashModal?.addEventListener('click', e => { if (e.target === stashModal) closeStashModal(); });

document.querySelectorAll('.sort-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentSort = btn.dataset.sort;
    renderStash();
  });
});

function renderStash() {
  let saved = getSaved();
  
  if (currentSort === 'name') saved.sort((a, b) => a.t.localeCompare(b.t));
  else if (currentSort === 'artist') saved.sort((a, b) => a.a.localeCompare(b.a));
  else saved.sort((a, b) => (b.ts || 0) - (a.ts || 0));

  stashFullList.innerHTML = saved.map((it, i) => `
    <div class="stash-item-item" data-preview="${it.preview || ''}">
      <img src="${it.art || 'assets/logo.webp'}" alt="">
      <div class="stash-item-info">
        <div class="stash-item-title">${esc(it.t)}</div>
        <div class="stash-item-artist">${esc(it.a)}</div>
      </div>
      <div class="rect-actions player-wrap">
        <button class="play-btn rect-play-btn" aria-label="Play preview">
          <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
        </button>
        <button class="rect-save-btn active" data-key="${(it.t + '|' + it.a).replace(/"/g, '&quot;')}">
          <svg viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
        </button>
      </div>
    </div>
  `).join('');

  stashFullList.querySelectorAll('.stash-item-item').forEach((el, i) => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.rect-actions')) return;
      closeStashModal();
      const it = saved[i];
      if (!it.l || Object.keys(it.l).length === 0) {
        resolve({ title: it.t, artist: it.a, art: it.art, previewUrl: it.preview });
      } else {
        resolve(it);
      }
    });
    el.querySelector('.rect-save-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSaved(saved[i]);
      renderStash();
    });
    el.querySelector('.rect-play-btn').addEventListener('click', (e) => {
      modalPlaylist = saved;
      modalIndex = i;
      handlePlayClick(e);
    });
  });
  updatePlayersUI();
}

// Bulletproof Marquee Detection using Visibility + Layout
const marqueeObserver = new IntersectionObserver(entries => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      const el = entry.target;
      const wrap = el.parentElement;
      if (!wrap || !wrap.classList.contains('card-title-wrap')) return;
      
      // Delay slightly to allow transition animations to finish
      setTimeout(() => {
        const visibleWidth = wrap.clientWidth;
        const totalWidth = el.scrollWidth;
        
        if (totalWidth > visibleWidth && visibleWidth > 0) {
          el.classList.add('marquee-on');
          const dist = -(totalWidth - visibleWidth + 40);
          el.style.setProperty('--dist', `${dist}px`);
        } else {
          el.classList.remove('marquee-on');
        }
      }, 300);
    }
  });
}, { threshold: 0.1 });

function setupMarquee(el) {
  if (!el) return;
  el.classList.remove('marquee-on'); // Reset
  marqueeObserver.unobserve(el);
  marqueeObserver.observe(el);
}

async function search(q) {
  try {
    stashSectionEl.style.display = 'none';
    renderResultsGrid([], true); 
    const r = await fetch(`https://itunes.apple.com/search?term=${enc(q)}&entity=song&limit=10&country=${COUNTRY}`);
    const d = await r.json();
    if (!d.results?.length) { 
      resultsGridEl.style.display = 'none';
      showErr('No results found.'); 
      return; 
    }
    renderResultsGrid(d.results);
  } catch (e) {
    showErr('Failed to fetch search results.');
  } finally {
    setLoad(false);
  }
}

function renderResultsGrid(tracks, isSkeleton = false) {
  cardEl.style.display = 'none';
  stashSectionEl.style.display = 'none';
  setWide(false);
  resultsGridEl.style.display = 'flex';
  
  if (isSkeleton) {
    resultsGridEl.innerHTML = Array(4).fill(0).map(() => `
      <div class="result-item skeleton-item">
        <div class="card-meta">
          <div class="card-art skeleton"></div>
          <div class="card-info">
            <div class="card-title skeleton" style="width: 60%"></div>
            <div class="card-artist skeleton" style="width: 40%"></div>
            <div class="player-wrap">
              <div class="play-btn skeleton" style="border-radius: 50%"></div>
              <div class="seek-wrap"><div class="seek-bar skeleton"></div></div>
            </div>
          </div>
        </div>
      </div>
    `).join('');
    return;
  }

  const tracksItems = tracks.map(t => ({
    appleUrl: t.trackViewUrl,
    title: t.trackName,
    artist: t.artistName,
    art: (t.artworkUrl100 || t.artworkUrl60).replace('100x100bb', '600x600bb'),
    previewUrl: t.previewUrl,
    album: t.collectionName || '',
  }));

  resultsGridEl.innerHTML = tracksItems.map((it, i) => {
    return `
    <div class="result-item" data-i="${i}" data-preview="${it.previewUrl || ''}" tabindex="0">
      <div class="card-meta">
        <img class="card-art" src="${it.art}" loading="lazy" alt="${esc(it.title)} album art">
        <div class="card-info">
          <div class="card-title-wrap">
            <div class="card-title">${esc(it.title)}</div>
          </div>
          <div class="card-artist">${esc(it.artist)}</div>
          <div class="player-wrap" ${it.previewUrl ? '' : 'style="display:none"'}>
             <button class="play-btn" aria-label="Play preview">
               <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
             </button>
             <div class="seek-wrap" role="slider">
               <div class="seek-bar"><div class="seek-fill"></div></div>
             </div>
             <div class="time-label">0:00</div>
          </div>
        </div>
      </div>
    </div>
  `; }).join('');

  resultsGridEl.querySelectorAll('.result-item').forEach((el, i) => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.player-wrap')) return;
      pickResult(tracksItems[i], el);
    });
  });

  resultsGridEl.querySelectorAll('.play-btn').forEach(btn => btn.addEventListener('click', handlePlayClick));
  resultsGridEl.querySelectorAll('.seek-wrap').forEach(btn => btn.addEventListener('click', handleSeekClick));
  resultsGridEl.querySelectorAll('.card-title').forEach(setupMarquee);
  updatePlayersUI();
  
  resultIdx = -1; 
}
window.addEventListener('keydown', e => {
  if (e.code === 'Space' && document.activeElement !== qEl) {
    e.preventDefault();
    if (audio.src) {
      if (isPlaying) audio.pause(); else audio.play();
    }
    return;
  }

  if (e.key === 'Escape') {
    if (ddEl.style.display === 'block') closeDD();
    else if (resultsGridEl.style.display === 'flex') {
       resultsGridEl.style.display = 'none';
       qEl.value = '';
    }
    return;
  }

  if (resultsGridEl.style.display === 'flex' && ddEl.style.display !== 'block') {
    const items = resultsGridEl.querySelectorAll('.result-item:not(.skeleton-item)');
    if (!items.length) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      resultIdx = (resultIdx + 1) % items.length;
      hlResult(items);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      resultIdx = (resultIdx - 1 + items.length) % items.length;
      hlResult(items);
    } else if (e.key === 'Enter' && resultIdx >= 0) {
      e.preventDefault();
      items[resultIdx].click();
    }
  }
});

function hlResult(items) {
  items.forEach((el, i) => {
    el.classList.toggle('active', i === resultIdx);
    if (i === resultIdx) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
}

async function pickResult(it, el) {
  const first = el.getBoundingClientRect();
  
  resultsGridEl.querySelectorAll('.result-item').forEach(item => {
    if (item !== el) item.classList.add('fade-out');
  });

  qEl.value = `${it.title} — ${it.artist}`;
  
  setTimeout(async () => {
    resultsGridEl.style.display = 'none';
    setWide(false);
    
    populateUI(it.title, it.artist, it.art, it.previewUrl, null);
    currentData = { t: it.title, a: it.artist, art: it.art, preview: it.previewUrl, l: {} };
    cardEl.style.display = 'block';
    
    const targetMeta = cardEl.querySelector('.card-meta');
    const last = targetMeta.getBoundingClientRect();
    
    linksEl.style.opacity = '0';

    const deltaY = first.top - last.top;
    const deltaX = first.left - last.left;
    const deltaW = first.width / last.width;
    const deltaH = first.height / last.height;

    targetMeta.style.transformOrigin = 'top left';
    targetMeta.style.transform = `translate(${deltaX}px, ${deltaY}px) scale(${deltaW}, ${deltaH})`;
    targetMeta.style.transition = 'none';

    requestAnimationFrame(() => {
      targetMeta.classList.add('flipping');
      targetMeta.style.transform = '';
      targetMeta.style.transition = '';
      
      setTimeout(() => {
        targetMeta.classList.remove('flipping');
        linksEl.style.transition = 'opacity 0.5s ease';
        linksEl.style.opacity = '1';
        resolve(it);
      }, 500);
    });
  }, 50);
}

function setWide(on) {
  if (on) wrapEl.classList.add('wide');
  else wrapEl.classList.remove('wide');
}

let lastResolvedKey = null;

async function resolve(data) {
  stashSectionEl.style.display = 'none';
  const t = data.t || data.title || '';
  const a = data.a || data.artist || '';
  const currentKey = typeof data === 'string' ? data.trim() : (data ? `${t}|${a}` : '');
  if (currentKey && currentKey === lastResolvedKey) return;
  lastResolvedKey = currentKey;
  
  const myId = ++lastResolveId;
  let item = typeof data === 'object' ? data : null;
  const isUrl = typeof data === 'string';

  if (item) populateUI(t, a, item.art || item.thumb?.replace('100x100bb', '600x600bb'), item.preview || item.previewUrl, null);
  else populateUI('', '', '', null, null);
  cardEl.style.display = 'block';
  setLoad(true);

  try {
    const q = item ? `${t} ${a}` : '';
    const u = isUrl ? data : (item?.appleUrl || '');
    
    const fetchResolve = async (retry = true) => {
      if (!PROXY_URL) return null;
      const h = await getPoWHeaders();
      const r = await fetch(`${PROXY_URL}/api/resolve?query=${enc(q)}&u=${enc(u)}&artist=${enc(a)}&album=${enc(item?.album || '')}&country=${COUNTRY}`, { headers: h });
      if (r.status === 401 && retry) {
        challengeQueue.length = 0;
        return fetchResolve(false);
      }
      return r.ok ? r.json() : null;
    };

    let res = (item && item.l && Object.keys(item.l).length > 0) ? { title: t, artist: a, art: item.art, preview: item.preview, links: item.l } : null;
    let it = null;

    if (!res) {
      const [resolved, itunesData] = await Promise.allSettled([
        fetchResolve(),
        (item && !(item.preview || item.previewUrl)) ? fetch(`https://itunes.apple.com/search?term=${enc(q)}&entity=song&limit=1&country=${COUNTRY}`).then(r => r.json()) : Promise.resolve(null)
      ]);

      if (myId !== lastResolveId) return;
      res = (resolved.status === 'fulfilled') ? resolved.value : null;
      it = (itunesData.status === 'fulfilled') ? itunesData.value : null;
    }

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
            const finalT = ent.title || t;
            const finalA = ent.artistName || a;
            const finalArt = ent.thumbnailUrl || item.art;

            populateUI(finalT, finalA, finalArt, item.preview || item.previewUrl, localLinks);
            currentData = { t: finalT, a: finalA, itunesId: null, l: localLinks };
            syncSavedLinks(currentData);
            return;
          }
        }
      } catch (err) { console.warn('Local fallback failed:', err); }
    }

    if (!res) { showErr('Failed to resolve song links.'); return; }
    if (!item) item = { title: '', artist: '', art: '', previewUrl: null };

    if (it?.results?.[0]) {
      const r = it.results[0];
      if (!(item.preview || item.previewUrl)) item.preview = r.previewUrl;
      if (!item.art) item.art = r.artworkUrl100.replace('100x100bb', '600x600bb');
      if (!res.links.appleMusic) res.links.appleMusic = r.trackViewUrl;
    }

    const finalT = res.title || t;
    const finalA = res.artist || a;
    const finalArt = res.art || item.art;
    const finalPreview = res.preview || item.preview || item.previewUrl;

    const itunesId = res.links.appleMusic?.match(/[?&]i=(\d+)/)?.[1] || null;
    populateUI(finalT, finalA, finalArt, finalPreview, res.links);
    currentData = { t: finalT, a: finalA, itunesId, l: res.links };
    
    syncSavedLinks(currentData);

  } catch (e) {
    console.error('Resolve failed:', e);
    if (myId === lastResolveId) showErr('Network error. Check your connection.');
  } finally {
    if (myId === lastResolveId) setLoad(false);
  }
}

function syncSavedLinks(data) {
  const saved = getSaved();
  const key = `${data.t}|${data.a}`;
  const idx = saved.findIndex(f => `${f.t || f.title}|${f.a || f.artist}` === key);
  if (idx > -1 && (!saved[idx].l || Object.keys(saved[idx].l).length === 0)) {
    saved[idx].l = data.l;
    updateSavedStorage(saved);
  }
}

function populateUI(title, artist, art, preview, links) {
  const artEl = document.getElementById('art');
  const ctitleEl = document.getElementById('ctitle');
  const cartistEl = document.getElementById('cartist');
  const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

  const favBtn = document.getElementById('saveStar');
  const key = `${title}|${artist}`;
  favBtn.setAttribute('data-key', key);
  favBtn.onclick = () => {
    // If resolution isn't done, save with what we have (title, artist, etc.)
    const data = currentData || { t: title, a: artist, art, preview, l: links || {} };
    toggleSaved(data);
  };
  favBtn.classList.toggle('active', getSaved().some(f => `${f.t}|${f.a}` === key));
  favBtn.style.display = title ? 'flex' : 'none';

  if (!art && !title) { artEl.src = BLANK; artEl.classList.add('skeleton'); }
  else { 
    artEl.classList.remove('skeleton'); 
    artEl.src = art?.replace('200x200bb', '600x600bb') || 'assets/logo.webp';
    artEl.style.cursor = 'zoom-in';
    artEl.onclick = () => openImgModal(art?.replace('200x200bb', '1000x1000bb').replace('600x600bb', '1000x1000bb'));
  }
  artEl.alt = title ? `${title} — ${artist} album artwork` : '';

  if (!title) {
    ctitleEl.textContent = ''; ctitleEl.classList.add('skeleton');
    cartistEl.textContent = ''; cartistEl.classList.add('skeleton');
    ctitleEl.classList.remove('marquee-on');
  } else {
    ctitleEl.classList.remove('skeleton'); ctitleEl.textContent = title;
    cartistEl.classList.remove('skeleton'); cartistEl.textContent = artist;
    cartistEl.classList.toggle('lp-easter', artist.trim().toLowerCase().includes('linkin park'));
    
    setupMarquee(ctitleEl);
  }

  // Visual shortcut hints
  updateShortcutHints();

  const pWrap = document.getElementById('playerWrap');
  if (preview) {
    pWrap.style.display = 'flex';
    
    const nextSrc = normalizeUrl(preview);
    const currentSrc = normalizeUrl(audio.src);

    if (currentSrc !== nextSrc) {
       const wasPlaying = isPlaying;
       audio.pause();
       audio.src = preview; 
       audio.load(); 
       if (wasPlaying) audio.play();
    } else if (isPlaying && audio.paused) {
       // Same source, user wants it playing, but it's paused for some reason.
       audio.play();
    }
    updatePlayersUI();
  } else {
    pWrap.style.display = 'none';
    // Only reset if we are explicitly clearing (not just resolving a new item)
    if (!title && !artist) {
      audio.pause();
      audio.src = '';
      updatePlayersUI();
    }
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
  if (on && cardEl.style.display !== 'block' && resultsGridEl.style.display !== 'flex') {
    loaderEl.style.display = 'block';
    stashSectionEl.style.display = 'none';
  }
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

function openImgModal(src) {
  const modal = document.getElementById('imgModal');
  const img = document.getElementById('fullArt');
  img.src = src;
  modal.style.display = 'flex';
}

document.getElementById('closeImg')?.addEventListener('click', () => {
  document.getElementById('imgModal').style.display = 'none';
});

document.addEventListener('keydown', (e) => {
  // Don't trigger shortcuts if user is typing in search
  if (e.target.tagName === 'INPUT' && e.key !== 'Escape') return;

  if (stashModal.style.display === 'flex') {
    const items = stashFullList.querySelectorAll('.stash-item-item');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      stashIdx = Math.min(stashIdx + 1, items.length - 1);
      updateStashSelection();
      return;
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      stashIdx = Math.max(stashIdx - 1, 0);
      updateStashSelection();
      return;
    } else if (e.key === 'Enter' && stashIdx !== -1) {
      e.preventDefault();
      items[stashIdx].click();
      return;
    }
  }

  switch (e.key.toLowerCase()) {
    case 's': // Star/Unstar
      e.preventDefault();
      document.getElementById('saveStar')?.click();
      break;
    case 'l': // Library/Stash
      e.preventDefault();
      if (stashModal.style.display === 'flex') closeStashModal();
      else openFavsModal();
      break;
    case ' ': // Play/Pause
      e.preventDefault();
      if (isPlaying) audio.pause(); else audio.play();
      break;
    case '/': // Focus Search
      e.preventDefault();
      document.getElementById('q').focus();
      break;
    case 'escape': // Close everything
      if (stashModal.style.display === 'flex') {
        closeStashModal();
      } else if (cardEl.style.display === 'block') {
        cardEl.style.display = 'none';
        renderSaved();
      } else if (ddEl.style.display === 'block') {
        ddEl.style.display = 'none';
      }
      break;
  }
});

function updateShortcutHints() {
  // Optional: could add visual [S] [L] hints to buttons
}

function updateStashSelection() {
  const items = stashFullList.querySelectorAll('.stash-item-item');
  items.forEach((item, i) => item.classList.toggle('active', i === stashIdx));
  if (stashIdx !== -1) items[stashIdx].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
