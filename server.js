const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// The API Key (Stored safely as an environment variable)
const TFKEY = process.env.TFKEY;
// Optional: Your static site's URL for restricted CORS
const ALLOWED_ORIGIN = process.env.SERVICE;

app.use(cors({
    origin: ALLOWED_ORIGIN || '*'
}));

// Serve the static frontend if hosting standalone
app.use(express.static(__dirname));

// Silence config.js 404 noise in standalone mode (key comes from proxy, not config)
app.get('/config.js', (req, res) => {
    res.type('application/javascript').send('// Standalone mode: key handled by proxy');
});

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

// Fallback to index.html for standalone hosting
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`LinkPark is live on port ${PORT}`);
});
