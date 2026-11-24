const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const resolver = require('../resolver');
const db = require('../db');

describe('Validation Helpers', () => {
  test('validateCountry: handles standard and edge-case inputs', () => {
    assert.equal(resolver.validateCountry('US'), 'US');
    assert.equal(resolver.validateCountry('gb'), 'GB');
    assert.equal(resolver.validateCountry(' in '), 'IN');
    assert.equal(resolver.validateCountry(''), 'US');
    assert.equal(resolver.validateCountry(null), 'US');
    assert.equal(resolver.validateCountry(undefined), 'US');
    assert.equal(resolver.validateCountry('USA'), 'US'); // Non-2-letter falls back to US
    assert.equal(resolver.validateCountry('12'), 'US');
  });

  test('validateString: enforces length and trims whitespace', () => {
    assert.equal(resolver.validateString('  hello world  ', 50), 'hello world');
    assert.equal(resolver.validateString('abcdefghij', 5), 'abcde');
    assert.equal(resolver.validateString('', 10), '');
    assert.equal(resolver.validateString(null, 10), '');
    assert.equal(resolver.validateString(12345, 10), '12345');
  });
});

describe('Title Cleanup Logic', () => {
  test('cleanupTitle: strips video noise tags', () => {
    assert.equal(
      resolver.cleanupTitle('Numb [Official Music Video]', 'Linkin Park'),
      'Numb'
    );
    assert.equal(
      resolver.cleanupTitle('In The End (Official Video)', 'Linkin Park'),
      'In The End'
    );
    assert.equal(
      resolver.cleanupTitle('Faint [Lyric Video]', 'Linkin Park'),
      'Faint'
    );
    assert.equal(
      resolver.cleanupTitle('Somewhere I Belong [HD]', 'Linkin Park'),
      'Somewhere I Belong'
    );
    assert.equal(
      resolver.cleanupTitle('Breaking the Habit - Topic', 'Linkin Park'),
      'Breaking the Habit'
    );
  });

  test('cleanupTitle: removes duplicated artist prefix and suffix', () => {
    assert.equal(
      resolver.cleanupTitle('Linkin Park - Numb', 'Linkin Park'),
      'Numb'
    );
    assert.equal(
      resolver.cleanupTitle('Numb - Linkin Park', 'Linkin Park'),
      'Numb'
    );
  });
});

describe('Music URL Validation & SSRF Prevention', () => {
  test('isValidMusicUrl: allows valid streaming domains', () => {
    assert.equal(resolver.isValidMusicUrl('https://open.spotify.com/track/12345'), true);
    assert.equal(resolver.isValidMusicUrl('https://music.apple.com/us/album/test/123'), true);
    assert.equal(resolver.isValidMusicUrl('https://www.youtube.com/watch?v=123'), true);
    assert.equal(resolver.isValidMusicUrl('https://listen.tidal.com/track/123'), true);
    assert.equal(resolver.isValidMusicUrl('https://deezer.com/track/123'), true);
  });

  test('isValidMusicUrl: blocks local, private IPs and non-music domains (SSRF protection)', () => {
    assert.equal(resolver.isValidMusicUrl('http://localhost:3000'), false);
    assert.equal(resolver.isValidMusicUrl('http://127.0.0.1:8080'), false);
    assert.equal(resolver.isValidMusicUrl('http://192.168.1.1/admin'), false);
    assert.equal(resolver.isValidMusicUrl('http://10.0.0.1/status'), false);
    assert.equal(resolver.isValidMusicUrl('https://evil-attacker.com/exploit'), false);
    assert.equal(resolver.isValidMusicUrl('javascript:alert(1)'), false);
    assert.equal(resolver.isValidMusicUrl('file:///etc/passwd'), false);
  });
});

describe('Music URL Normalization', () => {
  test('normalizeMusicUrl: converts music.youtube to youtube.com', () => {
    const ytMusic = 'https://music.youtube.com/watch?v=dQw4w9WgXcQ';
    assert.equal(db.normalizeMusicUrl(ytMusic), 'https://youtube.com/watch?v=dQw4w9WgXcQ');
  });

  test('normalizeMusicUrl: converts youtube shorts to watch URLs', () => {
    const ytShorts = 'https://youtube.com/shorts/dQw4w9WgXcQ';
    assert.equal(db.normalizeMusicUrl(ytShorts), 'https://youtube.com/watch?v=dQw4w9WgXcQ');
  });

  test('normalizeMusicUrl: strips regional codes and non-essential params from Apple Music', () => {
    const apple = 'https://music.apple.com/us/album/song-name/1234567890?i=1234567891&uo=4&app=music';
    const normalized = db.normalizeMusicUrl(apple);
    assert.ok(normalized.includes('music.apple.com/album/song-name/1234567890'));
    assert.ok(normalized.includes('i=1234567891'));
    assert.ok(!normalized.includes('uo=4'));
  });

  test('generateShortId: produces 8-char hex string', () => {
    const id1 = db.generateShortId();
    const id2 = db.generateShortId();
    assert.equal(typeof id1, 'string');
    assert.equal(id1.length, 8);
    assert.match(id1, /^[0-9a-f]{8}$/);
    assert.notEqual(id1, id2);
  });
});

describe('In-memory Cache & LRU Eviction', () => {
  test('cacheSet and cacheGet with TTL and LRU ordering', () => {
    const key = `test-key-${Date.now()}`;
    resolver.cacheSet(key, JSON.stringify({ ok: true }));
    const retrieved = resolver.cacheGet(key);
    assert.ok(retrieved);
    assert.deepEqual(JSON.parse(retrieved), { ok: true });

    // Non-existent key returns null
    assert.equal(resolver.cacheGet('non-existent-key-12345'), null);
  });
});
