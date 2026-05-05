const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Support multiple comma-separated keys (e.g. "key1, key2") for load balancing
const TFKEYS = (process.env.TFKEY || '').split(',').map(k => k.trim()).filter(Boolean);
let keyIndex = 0;
// Support multiple comma-separated origins (e.g. "https://site1.com, https://site2.com")
const ALLOWED_ORIGINS = (process.env.SERVICE || '').split(',').map(s => s.trim()).filter(Boolean);

// Parse IP Allowlist (JSON format with prefixes)
let ALLOWED_IPS = [];
try {
    const list = JSON.parse(process.env.IP_ALLOWLIST || '{}');
    if (list.prefixes) {
        ALLOWED_IPS = list.prefixes
            .filter(p => p && p.ip_prefix)
            .map(p => p.ip_prefix.split('/')[0]);
    }
} catch (e) {
    console.error('Failed to parse IP_ALLOWLIST:', e.message);
}

app.set('trust proxy', true);

app.use(cors({
    origin: (origin, callback) => {
        // Allow if origin is in our whitelist or if it's a non-browser request (no origin)
        if (!origin || ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('CORS blocked: Origin not allowed'));
        }
    }
}));

// Global IP Access Middleware (Optional: stricter than CORS)
app.use((req, res, next) => {
    // If no allowlist is set, let everything pass (CORS still protects browsers)
    if (ALLOWED_IPS.length === 0) return next();
    
    // Normalize IP (handle IPv6 mapped IPv4 like ::ffff:1.2.3.4)
    let clientIp = req.ip || '';
    if (clientIp.startsWith('::ffff:')) clientIp = clientIp.replace('::ffff:', '');
    
    // Allow if whitelisted or if it's a local request
    if (ALLOWED_IPS.includes(clientIp) || clientIp === '127.0.0.1' || clientIp === '::1') return next();
    
    // Also allow if it's a browser request from a whitelisted origin (already passed CORS)
    if (req.headers.origin && ALLOWED_ORIGINS.includes(req.headers.origin)) return next();

    console.log(`Access denied for IP: ${clientIp}`);
    res.status(403).json({ 
        error: 'Access denied: IP not allowed',
        yourIp: clientIp 
    });
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
    if (TFKEYS.length === 0) return res.status(500).json({ error: 'Missing API Key' });

    // Round-robin key rotation
    const currentKey = TFKEYS[keyIndex % TFKEYS.length];
    keyIndex++;

    try {
        const response = await fetch(`https://api.search.tinyfish.ai/?query=${encodeURIComponent(query)}`, {
            headers: { 'X-API-Key': currentKey }
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
