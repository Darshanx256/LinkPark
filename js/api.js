/**
 * API communication layer for LinkPark.
 * Handles Proof-of-Work challenge/response, proxy communication,
 * and share link encoding/decoding.
 */
import { PROXY_URL, TFKEY, SMAP, SREV } from './constants.js';

// ─── Proof-of-Work Engine ───

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

export function fetchAndSolveChallenge() {
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

export async function getPoWHeaders() {
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

export function clearChallengeQueue() {
  challengeQueue.length = 0;
}

// ─── Share Link Encoding/Decoding ───

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

export async function encodeShare(d) {
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

export async function decodeShare(s) {
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
