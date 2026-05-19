/**
 * Storage layer for LinkPark.
 * Manages Saved Songs (Stash) and Recent Searches in localStorage.
 */
import { SAVED_KEY, RECENT_KEY } from './constants.js';

const FALLBACK_ART = 'assets/no-album-art.svg';

// ─── Saved Songs (Stash) ───

export function getSaved() {
  try { return JSON.parse(localStorage.getItem(SAVED_KEY) || '[]'); }
  catch (e) { return []; }
}

export function updateSavedStorage(saved) {
  localStorage.setItem(SAVED_KEY, JSON.stringify(saved.slice(0, 50)));
}

export function savedKey(data) {
  return `${data.t || data.title || ''}|${data.a || data.artist || ''}`;
}

export function normalizeArtworkUrl(art, size = '600x600bb') {
  if (!art || art === FALLBACK_ART) return '';
  return art
    .replace('60x60bb', size)
    .replace('100x100bb', size)
    .replace('200x200bb', size)
    .replace('600x600bb', size)
    .replace('1000x1000bb', size);
}

/**
 * Merges richer data (artwork, preview, links) into an existing saved track entry.
 * @returns {boolean} True if any field was updated.
 */
export function mergeSavedTrack(target, source) {
  let changed = false;
  const art = normalizeArtworkUrl(source.art || source.thumbnailUrl || source.thumb);
  const preview = source.preview || source.previewUrl;
  const links = source.l || source.links;

  if (art && !target.art) {
    target.art = art;
    changed = true;
  }
  if (preview && !target.preview) {
    target.preview = preview;
    changed = true;
  }
  if (links && Object.keys(links).length > 0 && (!target.l || Object.keys(target.l).length === 0)) {
    target.l = links;
    changed = true;
  }
  return changed;
}

/**
 * Toggles a track in the saved stash. If the track already exists and has no new data,
 * it is removed. Otherwise, missing fields are merged from the new data.
 * @param {object} data - The track data to toggle.
 * @param {Function} onUpdate - Callback invoked after storage is updated.
 */
export function toggleSaved(data, onUpdate) {
  if (!data.t && !data.title) return;
  const saved = getSaved();
  const t = data.t || data.title;
  const a = data.a || data.artist;
  const key = `${t}|${a}`;
  
  const idx = saved.findIndex(f => savedKey(f) === key);
  
  if (idx > -1) {
    if (mergeSavedTrack(saved[idx], data)) {
      updateSavedStorage(saved);
    } else {
      saved.splice(idx, 1);
    }
  } else {
    saved.unshift({
      t, a,
      art: normalizeArtworkUrl(data.art || data.thumbnailUrl || data.thumb),
      preview: data.preview || data.previewUrl,
      l: data.l || null,
      ts: Date.now()
    });
  }
  
  updateSavedStorage(saved);
  if (onUpdate) onUpdate();
  
  // Update UI stars
  const active = getSaved().some(f => savedKey(f) === key);
  document.querySelectorAll('.save-btn').forEach(btn => {
    if (btn.dataset.key === key) btn.classList.toggle('active', active);
  });
}

/**
 * Syncs richer resolved data back into an already-saved track entry.
 * @param {object} data - The resolved track data.
 * @param {Function} onUpdate - Callback invoked if data was merged.
 */
export function syncSavedTrackData(data, onUpdate) {
  const saved = getSaved();
  const key = `${data.t}|${data.a}`;
  const idx = saved.findIndex(f => savedKey(f) === key);
  if (idx > -1 && mergeSavedTrack(saved[idx], data)) {
    updateSavedStorage(saved);
    if (onUpdate) onUpdate();
  }
}

// ─── Recent Searches ───

export function getRecent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); }
  catch (e) { return []; }
}

export function updateRecentSearch(val) {
  if (!val) return;
  let text = typeof val === 'string' ? val : `${val.t || val.title} — ${val.a || val.artist}`;
  let data = typeof val === 'object' ? val : null;

  let recent = getRecent();
  recent = recent.filter(r => r.text !== text);
  recent.unshift({ text, data });
  localStorage.setItem(RECENT_KEY, JSON.stringify(recent.slice(0, 5)));
}

export function clearRecent() {
  localStorage.removeItem(RECENT_KEY);
}
