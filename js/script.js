import {
  ODESLI, PROXY_URL, COUNTRY, P, PLACEHOLDERS
} from './constants.js';
import {
  fetchAndSolveChallenge, getPoWHeaders, clearChallengeQueue,
  encodeShare, decodeShare
} from './api.js';
import {
  getSaved, updateSavedStorage, savedKey, normalizeArtworkUrl,
  mergeSavedTrack, toggleSaved, syncSavedTrackData,
  getRecent, updateRecentSearch, clearRecent
} from './storage.js';

/** 
 * Unique identifier for the current resolution request.
 * Used to discard results from stale network requests when a new search begins.
 */
let lastResolveId = 0;
let currentData = null; // Stores currently resolved track for sharing

let isSearching = false;
let resultIdx = -1; // Global keyboard navigation index for results grid

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
const recentSectionEl = document.getElementById('recentSection');
const recentGridEl = document.getElementById('recentGrid');
const wrapEl = document.querySelector('.wrap');
const FALLBACK_ART = 'assets/no-album-art.svg';

if (logoEl) {
  logoEl.addEventListener('click', () => {
    qEl.value = '';
    closeDD();
    cardEl.style.display = 'none';
    lastResolvedKey = null;
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

let currentPlaybackContext = [];
let modalIndex = -1;
let stashIdx = -1; // For keyboard navigation in modal

let playingKey = null;
let fadingKey = null;

audio1.addEventListener('play', () => { isPlaying = true; updatePlayersUI(); });
audio1.addEventListener('pause', () => { if (audio === audio1) isPlaying = false; updatePlayersUI(); });
audio1.addEventListener('ended', () => { if (audio === audio1) isPlaying = false; updatePlayersUI(); });

audio2.addEventListener('play', () => { isPlaying = true; updatePlayersUI(); });
audio2.addEventListener('pause', () => { if (audio === audio2) isPlaying = false; updatePlayersUI(); });
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

  document.querySelectorAll('.player-wrap').forEach(wrap => {
    const item = wrap.closest('[data-key]') || wrap.closest('.card');
    let itemKey = item?.dataset?.key;
    if (item?.id === 'card' && currentData) itemKey = savedKey(currentData);

    const isCurrent = itemKey && itemKey === playingKey;
    const isNext = itemKey && itemKey === fadingKey;

    if (isCurrent || isNext) {
      const playBtn = wrap.querySelector('.play-btn');
      const seekFill = wrap.querySelector('.seek-fill');
      const timeLabel = wrap.querySelector('.time-label');

      if (playBtn) {
        const effectivePlaying = (isCurrent && isPlaying) || (isNext && isFading && !secondaryAudio.paused);
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
  const item = wrap.closest('[data-key]') || wrap.closest('.card');
  let itemKey = item?.dataset?.key;
  if (item?.id === 'card' && currentData) itemKey = savedKey(currentData);
  const src = item?.dataset?.preview || (item?.id === 'card' ? currentData?.preview : '');

  if (!src || !itemKey) return;

  if (itemKey === playingKey) {
    if (isPlaying) audio.pause(); else audio.play();
  } else if (itemKey === fadingKey) {
    if (secondaryAudio.paused) secondaryAudio.play(); else secondaryAudio.pause();
  } else {
    if (isFading) {
       secondaryAudio.pause();
       isFading = false;
       fadingKey = null;
    }
    playingKey = itemKey;
    audio.src = src;
    audio.play();
  }
}

function handleSeekClick(e) {
  e.stopPropagation();
  if (!audio.duration || isFading) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const wrap = e.currentTarget.closest('.player-wrap');
  const item = wrap.closest('[data-key]') || wrap.closest('.card');
  let itemKey = item?.dataset?.key;
  if (item?.id === 'card' && currentData) itemKey = savedKey(currentData);

  if (itemKey !== playingKey) return;

  const p = (e.clientX - rect.left) / rect.width;
  audio.currentTime = p * audio.duration;
}

function crossfadeTo(src, nextIndex, nextKey) {
  if (isFading) return;
  isFading = true;
  fadingKey = nextKey;
  
  secondaryAudio.src = src;
  secondaryAudio.volume = 0;
  secondaryAudio.play();
  updatePlayersUI();
  
  const fadeTime = 3000;
  let startTime = null;
  
  function fader(timestamp) {
    if (!startTime) startTime = timestamp;
    const p = Math.min((timestamp - startTime) / fadeTime, 1);
    
    audio.volume = 1 - p;
    secondaryAudio.volume = p;
    
    if (p < 1 && !secondaryAudio.paused) {
      requestAnimationFrame(fader);
    } else if (secondaryAudio.paused) {
      audio.pause();
      audio.volume = 1;
      isFading = false;
      fadingKey = null;
      updatePlayersUI();
    } else {
      audio.pause();
      audio.volume = 1;
      
      const temp = audio;
      audio = secondaryAudio;
      secondaryAudio = temp;
      
      modalIndex = nextIndex;
      playingKey = fadingKey;
      isFading = false;
      fadingKey = null;
      updatePlayersUI();
    }
  }
  requestAnimationFrame(fader);
}

audio1.addEventListener('timeupdate', checkCrossfade);
audio2.addEventListener('timeupdate', checkCrossfade);

function checkCrossfade() {
  const currentAudio = this;
  if (currentAudio !== audio || isFading || modalIndex === -1 || !currentPlaybackContext.length) return;
  
  if (currentAudio.duration && currentAudio.duration - currentAudio.currentTime <= 3) {
    if (modalIndex < currentPlaybackContext.length - 1) {
      const nextIdx = modalIndex + 1;
      const nextItem = currentPlaybackContext[nextIdx];
      if (nextItem.preview || nextItem.previewUrl) {
        crossfadeTo(nextItem.preview || nextItem.previewUrl, nextIdx, savedKey(nextItem));
      }
    }
  }
}

// Event Delegation for all clicks (play, seek, grid items)
document.body.addEventListener('click', e => {
  const playBtn = e.target.closest('.play-btn');
  if (playBtn) {
    e.stopPropagation();
    const itemEl = playBtn.closest('.stash-item-item, .result-item');
    let itemKey = itemEl?.dataset?.key;
    if (itemEl && itemKey !== playingKey && itemKey !== fadingKey) {
      if (itemEl.classList.contains('stash-item-item') && window.currentStashFull) {
        currentPlaybackContext = [...window.currentStashFull];
        modalIndex = Array.from(document.getElementById('stashFullList').children).indexOf(itemEl);
      } else if (itemEl.closest('#stashGrid') && window.currentStash20) {
        currentPlaybackContext = [...window.currentStash20];
        modalIndex = Array.from(document.getElementById('stashGrid').querySelectorAll('.result-item')).indexOf(itemEl);
      } else if (itemEl.closest('#resultsGrid') && window.currentResults) {
        currentPlaybackContext = [...window.currentResults];
        modalIndex = Array.from(document.getElementById('resultsGrid').querySelectorAll('.result-item')).indexOf(itemEl);
      }
    }
    handlePlayClick({ stopPropagation: () => {}, currentTarget: playBtn });
    return;
  }

  const seekWrap = e.target.closest('.seek-wrap');
  if (seekWrap) {
    e.stopPropagation();
    handleSeekClick({
      clientX: e.clientX,
      stopPropagation: () => {},
      currentTarget: seekWrap
    });
    return;
  }

  const resultItem = e.target.closest('.result-item');
  if (resultItem && !e.target.closest('.player-wrap')) {
    const grid = resultItem.closest('#stashGrid, #resultsGrid');
    if (grid) {
      const i = Number(resultItem.dataset.i);
      if (grid.id === 'stashGrid' && window.currentStash20) {
        const it = window.currentStash20[i];
        if (it) {
          if (!it.l || Object.keys(it.l).length === 0) resolve({ title: it.t || it.title, artist: it.a || it.artist, art: it.art, previewUrl: it.preview });
          else resolve(it);
        }
      } else if (grid.id === 'resultsGrid' && window.currentResults) {
        const it = window.currentResults[i];
        if (it) pickResult(it, resultItem);
      }
    }
    return;
  }

  const stashItem = e.target.closest('.stash-item-item');
  if (stashItem && window.currentStashFull) {
    const saveBtn = e.target.closest('.rect-save-btn');
    const i = Array.from(document.getElementById('stashFullList').children).indexOf(stashItem);
    const it = window.currentStashFull[i];
    if (!it) return;

    if (saveBtn) {
      e.stopPropagation();
      toggleSaved(it, renderSaved);
      renderStash();
      return;
    }

    if (!e.target.closest('.rect-actions')) {
      closeStashModal();
      if (!it.l || Object.keys(it.l).length === 0) resolve({ title: it.t || it.title, artist: it.a || it.artist, art: normalizeArtworkUrl(it.art), previewUrl: it.preview });
      else resolve(it);
    }
  }
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
  const stashModal = document.getElementById('stashModal');
  const stashSection = document.getElementById('stashSection');
  stashSection?.querySelector('.launcher')?.addEventListener('click', openStashModal);

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
             clearChallengeQueue();
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
    renderRecent();
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
      <img src="${it.thumb}" loading="lazy" onerror="this.onerror=null;this.src='${FALLBACK_ART}';" alt="${esc(it.title)} by ${esc(it.artist)}">
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


function renderSaved() {
  const saved = getSaved();
  const isHome = resultsGridEl.style.display !== 'flex' && cardEl.style.display !== 'block';
  
  if (!saved.length || !isHome) {
    stashSectionEl.style.display = 'none';
    if (recentSectionEl) recentSectionEl.style.display = 'none';
  } else {
    stashSectionEl.style.display = 'flex';
    const top20 = saved.slice(0, 20);
    let html = top20.map((it, i) => `
      <div class="result-item" data-i="${i}" data-preview="${it.preview || ''}" data-key="${savedKey(it).replace(/"/g, '&quot;')}" tabindex="0">
        <div class="card-meta">
          <img class="card-art" src="${normalizeArtworkUrl(it.art) || FALLBACK_ART}" onerror="this.onerror=null;this.src='${FALLBACK_ART}';" loading="lazy" alt="${esc(it.t || it.title)} artwork">
          <div class="card-info">
            <div class="card-title-wrap">
              <div class="card-title">${esc(it.t || it.title)}</div>
            </div>
            <div class="card-artist">${esc(it.a || it.artist)}</div>
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
      html += `<button id="viewAllStash" class="view-all-btn">View All ${saved.length} Tracks</button>`;
    }
    stashGridEl.innerHTML = html;
    stashGridEl.classList.toggle('has-mask', saved.length > 5);

    window.currentStash20 = top20;
    document.getElementById('viewAllStash')?.addEventListener('click', openStashModal);
    stashGridEl.querySelectorAll('.card-title').forEach(setupMarquee);
  }

  renderRecent();
}

let currentSort = 'date';
const stashModal = document.getElementById('stashModal');
const stashFullList = document.getElementById('stashFullList');

function openFavsModal() {
  stashModal.style.display = 'flex';
  stashIdx = -1;
  renderStash();
}

function openStashModal() {
  openFavsModal();
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
  
  if (currentSort === 'name') saved.sort((a, b) => (a.t || a.title || '').localeCompare(b.t || b.title || ''));
  else if (currentSort === 'artist') saved.sort((a, b) => (a.a || a.artist || '').localeCompare(b.a || b.artist || ''));
  else saved.sort((a, b) => (b.ts || 0) - (a.ts || 0));

  stashFullList.innerHTML = saved.map((it, i) => `
    <div class="stash-item-item" data-preview="${it.preview || ''}" data-key="${savedKey(it).replace(/"/g, '&quot;')}">
      <img src="${normalizeArtworkUrl(it.art) || FALLBACK_ART}" onerror="this.onerror=null;this.src='${FALLBACK_ART}';" alt="${esc(it.t || it.title)} artwork">
      <div class="stash-item-info">
        <div class="stash-item-title">${esc(it.t || it.title)}</div>
        <div class="stash-item-artist">${esc(it.a || it.artist)}</div>
      </div>
      <div class="rect-actions player-wrap">
        <button class="play-btn rect-play-btn" aria-label="Play preview">
          <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
        </button>
        <button class="rect-save-btn active" data-key="${savedKey(it).replace(/"/g, '&quot;')}">
          <svg viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
        </button>
      </div>
    </div>
  `).join('');

  window.currentStashFull = saved;
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
        if (!document.body.contains(el)) return; // Prevent race conditions
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
    if (recentSectionEl) recentSectionEl.style.display = 'none';
    renderResultsGrid([], true); 
    const r = await fetch(`https://itunes.apple.com/search?term=${enc(q)}&entity=song&limit=10&country=${COUNTRY}`);
    const d = await r.json();
    if (!d.results?.length) { 
      resultsGridEl.style.display = 'none';
      showErr('No results found.'); 
      return; 
    }
    renderResultsGrid(d.results);
    _updateRecentSearch(q);
  } catch (e) {
    showErr('Failed to fetch search results.');
  } finally {
    setLoad(false);
  }
}

function renderResultsGrid(tracks, isSkeleton = false) {
  cardEl.style.display = 'none';
  lastResolvedKey = null;
  stashSectionEl.style.display = 'none';
  if (recentSectionEl) recentSectionEl.style.display = 'none';
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
    art: normalizeArtworkUrl(t.artworkUrl100 || t.artworkUrl60),
    previewUrl: t.previewUrl,
    album: t.collectionName || '',
  }));

  resultsGridEl.innerHTML = tracksItems.map((it, i) => {
    return `
    <div class="result-item" data-i="${i}" data-preview="${it.previewUrl || ''}" data-key="${savedKey(it).replace(/"/g, '&quot;')}" tabindex="0">
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

  window.currentResults = tracksItems;
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
    currentData = { t: it.title, a: it.artist, art: normalizeArtworkUrl(it.art), preview: it.previewUrl, l: {} };
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
        _updateRecentSearch(it, document.getElementById('q').value);
        resolve(it, false);
      }, 500);
    });
  }, 50);
}

function setWide(on) {
  if (on) wrapEl.classList.add('wide');
  else wrapEl.classList.remove('wide');
}

let lastResolvedKey = null;

async function resolve(data, shouldSave = true) {
  stashSectionEl.style.display = 'none';
  if (recentSectionEl) recentSectionEl.style.display = 'none';
  const t = data.t || data.title || '';
  const a = data.a || data.artist || '';
  const currentKey = typeof data === 'string' ? data.trim() : (data ? `${t}|${a}` : '');
  if (currentKey && currentKey === lastResolvedKey) return;
  lastResolvedKey = currentKey;
  
  const myId = ++lastResolveId;
  let item = typeof data === 'object' ? data : null;
  const isUrl = typeof data === 'string';

  if (item) {
    currentData = { t, a, art: normalizeArtworkUrl(item.art || item.thumb), preview: item.preview || item.previewUrl, l: item.l || {} };
    populateUI(t, a, currentData.art, currentData.preview, null);
  } else {
    populateUI('', '', '', null, null);
  }
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
        clearChallengeQueue();
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
            const finalArt = normalizeArtworkUrl(ent.thumbnailUrl || item.art);

            populateUI(finalT, finalA, finalArt, item.preview || item.previewUrl, localLinks);
            currentData = { t: finalT, a: finalA, art: finalArt, preview: item.preview || item.previewUrl, itunesId: null, l: localLinks };
            syncSavedTrackData(currentData, renderSaved);
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
      if (!item.art) item.art = normalizeArtworkUrl(r.artworkUrl100);
      if (!res.links.appleMusic) res.links.appleMusic = r.trackViewUrl;
    }

    const finalT = res.title || t;
    const finalA = res.artist || a;
    const finalArt = normalizeArtworkUrl(res.art || item.art);
    const finalPreview = res.preview || item.preview || item.previewUrl;

    const itunesId = res.links.appleMusic?.match(/[?&]i=(\d+)/)?.[1] || null;
    populateUI(finalT, finalA, finalArt, finalPreview, res.links);
    currentData = { t: finalT, a: finalA, art: finalArt, preview: finalPreview, itunesId, l: res.links };
    
    if (shouldSave) _updateRecentSearch(currentData, document.getElementById('q').value);
    syncSavedTrackData(currentData, renderSaved);

  } catch (e) {
    console.error('Resolve failed:', e);
    if (myId === lastResolveId) showErr('Network error. Check your connection.');
  } finally {
    if (myId === lastResolveId) setLoad(false);
  }
}



function populateUI(title, artist, art, preview, links) {
  modalIndex = -1;
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
    toggleSaved(data, renderSaved);
  };
  favBtn.classList.toggle('active', getSaved().some(f => savedKey(f) === key));
  favBtn.style.display = title ? 'flex' : 'none';

  if (!art && !title) { artEl.src = BLANK; artEl.classList.add('skeleton'); }
  else { 
    artEl.classList.remove('skeleton'); 
    const displayArt = normalizeArtworkUrl(art);
    artEl.src = displayArt || FALLBACK_ART;
    artEl.style.cursor = 'zoom-in';
    artEl.onclick = () => {
      const fullArt = normalizeArtworkUrl(displayArt, '1000x1000bb');
      if (fullArt) openImgModal(fullArt);
    };
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
    if (recentSectionEl) recentSectionEl.style.display = 'none';
  }
  else loaderEl.style.display = 'none';
  if (on) errEl.style.display = 'none';
}

function showErr(msg) { errEl.textContent = msg; errEl.style.display = 'block'; loaderEl.style.display = 'none'; }
function enc(s) { return encodeURIComponent(s); }
function esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

let phIdx = 1;
setInterval(() => {
  if (document.hidden) return; // Prevent CPU wakeups
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
        lastResolvedKey = null;
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

function _updateRecentSearch(val, queryToRemove = '') {
  updateRecentSearch(val, queryToRemove);
  renderRecent();
}

function _clearRecent() {
  clearRecent();
  renderRecent();
}

function renderRecent() {
  const clearBtn = document.getElementById('clearRecent');
  if (!recentSectionEl || !recentGridEl) return;

  const isHome = resultsGridEl.style.display !== 'flex' && cardEl.style.display !== 'block';
  const recent = getRecent();

  if (!recent.length || !isHome) {
    recentSectionEl.style.display = 'none';
    recentGridEl.innerHTML = '';
    return;
  }

  recentSectionEl.style.display = 'flex';
  recentGridEl.innerHTML = recent.map((it, i) => `
    <button class="recent-chip" type="button" data-i="${i}" title="${esc(it.text)}">${esc(it.text)}</button>
  `).join('');

  recentGridEl.querySelectorAll('.recent-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const it = recent[Number(btn.dataset.i)];
      if (!it) return;
      if (it.data) resolve(it.data, false);
      else {
        qEl.value = it.text;
        search(it.text);
      }
    });
  });

  if (clearBtn) clearBtn.onclick = _clearRecent;
}
