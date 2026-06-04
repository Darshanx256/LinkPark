const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const PROVIDER = (process.env.DB_PROVIDER || '').toUpperCase();

// Initialize the active database provider
let dbAdapter = null;

class MemoryAdapter {
  constructor() {
    this.cache = new Map();
  }
  async get(key) {
    return this.cache.get(key) || null;
  }
  async set(key, value) {
    this.cache.set(key, value);
  }
  async getByShortId(id) {
    for (const row of this.cache.values()) {
      if (row && row.id === id) return row;
    }
    return null;
  }
}

class JsonFileAdapter {
  constructor(filePath) {
    this.filePath = filePath || path.join(__dirname, 'db.json');
    this.data = {};
    this.load();
  }
  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        this.data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      }
    } catch (e) {
      console.error('[db] Failed to load JSON database:', e.message);
    }
  }
  save() {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (e) {
      console.error('[db] Failed to save JSON database:', e.message);
    }
  }
  async get(key) {
    return this.data[key] || null;
  }
  async set(key, value) {
    this.data[key] = value;
    this.save();
  }
  async getByShortId(id) {
    return Object.values(this.data).find(row => row && row.id === id) || null;
  }
}

class SqliteAdapter {
  constructor(filePath) {
    let DatabaseSync;
    try {
      const sqliteModule = require('node:sqlite');
      DatabaseSync = sqliteModule.DatabaseSync;
    } catch (e) {
      throw new Error('SQLite database provider requires Node.js v22.5.0+ (built-in node:sqlite module missing).');
    }
    this.db = new DatabaseSync(filePath || path.join(__dirname, 'db.sqlite'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS songs (
        query_hash TEXT PRIMARY KEY,
        id TEXT UNIQUE NOT NULL,
        query TEXT NOT NULL,
        title TEXT,
        artist TEXT,
        album TEXT,
        art_url TEXT,
        preview_url TEXT,
        links TEXT NOT NULL,
        country TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_songs_id ON songs(id)
    `);
  }
  async get(key) {
    try {
      const stmt = this.db.prepare('SELECT * FROM songs WHERE query_hash = ?');
      const row = stmt.get(key);
      if (!row) return null;
      return { ...row, links: JSON.parse(row.links) };
    } catch (e) {
      console.error('[db] SQLite read failed:', e.message);
      return null;
    }
  }
  async getByShortId(id) {
    try {
      const stmt = this.db.prepare('SELECT * FROM songs WHERE id = ?');
      const row = stmt.get(id);
      if (!row) return null;
      return { ...row, links: JSON.parse(row.links) };
    } catch (e) {
      console.error('[db] SQLite query by short ID failed:', e.message);
      return null;
    }
  }
  async set(key, value) {
    try {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO songs (query_hash, id, query, title, artist, album, art_url, preview_url, links, country)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        key,
        value.id,
        value.query,
        value.title,
        value.artist,
        value.album,
        value.art_url,
        value.preview_url,
        JSON.stringify(value.links),
        value.country
      );
      return true;
    } catch (e) {
      console.error('[db] SQLite write failed:', e.message);
      return false;
    }
  }
}

class SupabaseAdapter {
  constructor(url, key) {
    this.url = url.replace(/\/$/, '');
    this.key = key;
  }
  async get(key) {
    try {
      const response = await fetch(`${this.url}/rest/v1/songs?query_hash=eq.${encodeURIComponent(key)}`, {
        headers: {
          'apikey': this.key,
          'Authorization': `Bearer ${this.key}`
        }
      });
      if (response.ok) {
        const rows = await response.json();
        return rows[0] || null;
      }
    } catch (e) {
      console.error('[db] Supabase read failed:', e.message);
    }
    return null;
  }
  async getByShortId(id) {
    try {
      const response = await fetch(`${this.url}/rest/v1/songs?id=eq.${encodeURIComponent(id)}`, {
        headers: {
          'apikey': this.key,
          'Authorization': `Bearer ${this.key}`
        }
      });
      if (response.ok) {
        const rows = await response.json();
        return rows[0] || null;
      }
    } catch (e) {
      console.error('[db] Supabase query by short ID failed:', e.message);
    }
    return null;
  }
  async set(key, value) {
    try {
      const response = await fetch(`${this.url}/rest/v1/songs`, {
        method: 'POST',
        headers: {
          'apikey': this.key,
          'Authorization': `Bearer ${this.key}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates'
        },
        body: JSON.stringify({
          query_hash: key,
          id: value.id,
          query: value.query,
          title: value.title,
          artist: value.artist,
          album: value.album,
          art_url: value.art_url,
          preview_url: value.preview_url,
          links: value.links,
          country: value.country
        })
      });
      return response.ok;
    } catch (e) {
      console.error('[db] Supabase write failed:', e.message);
    }
    return false;
  }
}

// Instantiate DB Adapter based on configuration
if (PROVIDER === 'SUPABASE' && process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
  dbAdapter = new SupabaseAdapter(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  console.log('Database Provider: SUPABASE (REST API)');
} else if (PROVIDER === 'SQLITE') {
  const filePath = process.env.DB_FILE_PATH || path.join(__dirname, 'db.sqlite');
  dbAdapter = new SqliteAdapter(filePath);
  console.log(`Database Provider: SQLITE (${filePath})`);
} else if (PROVIDER === 'JSON') {
  const filePath = process.env.DB_FILE_PATH || path.join(__dirname, 'db.json');
  dbAdapter = new JsonFileAdapter(filePath);
  console.log(`Database Provider: LOCAL JSON (${filePath})`);
} else {
  dbAdapter = new MemoryAdapter();
  console.log('Database Provider: MEMORY (Transient Cache)');
}

function generateShortId() {
  return crypto.randomBytes(4).toString('hex'); // 8 character alphanumeric string
}

function getQueryHash(query) {
  const norm = (query || '').trim().toLowerCase();
  return crypto.createHash('sha256').update(norm).digest('hex');
}

module.exports = {
  isDbActive: () => PROVIDER === 'SUPABASE' || PROVIDER === 'SQLITE' || PROVIDER === 'JSON',
  
  getCachedSong: async (query) => {
    const hash = getQueryHash(query);
    const row = await dbAdapter.get(hash);
    if (!row) return null;
    return {
      links: row.links,
      title: row.title,
      artist: row.artist,
      album: row.album,
      art: row.art_url,
      preview: row.preview_url,
      shortId: row.id
    };
  },

  saveCachedSong: async (query, country, songData) => {
    const hash = getQueryHash(query);
    const shortId = songData.shortId || generateShortId();
    const dbRow = {
      id: shortId,
      query: query,
      title: songData.title || songData.t || null,
      artist: songData.artist || songData.a || null,
      album: songData.album || null,
      art_url: songData.art || null,
      preview_url: songData.preview || null,
      links: songData.links || songData.l || {},
      country: country || 'US'
    };
    await dbAdapter.set(hash, dbRow);
    return shortId;
  },

  getSongByShortId: async (id) => {
    const row = await dbAdapter.getByShortId(id);
    if (!row) return null;
    return {
      t: row.title,
      a: row.artist,
      art: row.art_url,
      preview: row.preview_url,
      l: row.links
    };
  }
};
