const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// The API Key (Stored safely as an environment variable)
const TFKEY = process.env.TFKEY;
// Support multiple comma-separated origins (e.g. "https://site1.com, https://site2.com")
const ALLOWED_ORIGINS = (process.env.SERVICE || '').split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
    origin: (origin, callback) => {
        // Allow if no origin (like UptimeRobot/Server-to-server) or if it matches our list
        if (!origin || ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('CORS blocked: Origin not allowed'));
        }
    }
}));

// Odesli Proxy Route
app.get('/api/odesli', async (req, res) => {
    const { url, userCountry } = req.query;
    if (!url) return res.status(400).json({ error: 'url is required' });
    try {
        const response = await fetch(
            `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(url)}&userCountry=${userCountry || 'US'}`
        );
        const data = await response.json();
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: 'Odesli fetch failed' });
    }
});

// Tinyfish Proxy Route
app.get('/api/search', async (req, res) => {
    const { query } = req.query;
    
    if (!query) return res.status(400).json({ error: 'Query is required' });
    if (!TFKEY) return res.status(500).json({ error: 'Missing API Key' });

    try {
        const response = await fetch(`https://api.search.tinyfish.ai/?query=${encodeURIComponent(query)}`, {
            headers: { 'X-API-Key': TFKEY }
        });
        const data = await response.json();
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: 'Search failed' });
    }
});

if (ALLOWED_ORIGINS.length > 0) {
    // Hybrid mode: SERVICE is set, so we're a proxy only
    // Don't serve any static files — the frontend lives elsewhere
    console.log(`Proxy-only mode. Whitelist: ${ALLOWED_ORIGINS.join(', ')}`);
} else {
    // Standalone mode: serve the full frontend too
    app.use(express.static(__dirname));

    // Silence config.js 404 noise (key comes from proxy, not config)
    app.get('/config.js', (req, res) => {
        res.type('application/javascript').send('// Standalone mode: key handled by proxy');
    });

    // Fallback to index.html for standalone hosting
    app.get('*', (req, res) => {
        res.sendFile(path.join(__dirname, 'index.html'));
    });
}

app.listen(PORT, () => {
    console.log(`LinkPark is live on port ${PORT}`);
});
