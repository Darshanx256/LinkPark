const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

/**
 * Load balances requests across multiple API keys if provided.
 * Enables higher rate limits and redundancy by rotating keys in a round-robin fashion.
 */
const TFKEYS = (process.env.TFKEY || '').split(',').map(k => k.trim()).filter(Boolean);
let keyIndex = 0;

/**
 * Authorized origins for browser-based CORS requests.
 * Restricts access to the proxy server to specific frontend deployments (e.g., GitHub Pages).
 */
const ALLOWED_ORIGINS = (process.env.SERVICE || '').split(',').map(s => s.trim()).filter(Boolean);

/**
 * Parses the IP_ALLOWLIST environment variable into a lookup array.
 * Required for non-browser monitoring services like UptimeRobot which do not send Origin headers.
 */
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

/** 
 * Configures the application to trust the reverse proxy (Render).
 * Necessary for accurate client IP identification via req.ip. 
 */
app.set('trust proxy', true);

/** 
 * Public health check endpoint.
 * Bypasses IP and CORS middleware to ensure monitoring services can verify server uptime.
 */
app.get('/health', (req, res) => res.status(200).send('OK'));

/**
 * Global request logger for production debugging.
 * Normalizes IPv6-mapped IPv4 addresses to simplify log analysis and IP matching.
 */
app.use((req, res, next) => {
    let clientIp = req.ip || '';
    if (clientIp.startsWith('::ffff:')) clientIp = clientIp.replace('::ffff:', '');
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} - IP: ${clientIp}`);
    next();
});

app.use(cors({
    origin: (origin, callback) => {
        /**
         * Permissive origin logic:
         * 1. Allow non-browser requests (no origin).
         * 2. Allow if SERVICE is unset (standalone dev mode).
         * 3. Allow if origin matches the whitelist.
         */
        if (!origin || ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('CORS blocked: Origin not allowed'));
        }
    }
}));

/**
 * Secondary security layer for non-browser requests.
 * Validates the client IP against the ALLOWED_IPS whitelist if configured.
 */
app.use((req, res, next) => {
    if (ALLOWED_IPS.length === 0) return next();
    
    let clientIp = req.ip || '';
    if (clientIp.startsWith('::ffff:')) clientIp = clientIp.replace('::ffff:', '');
    
    /** 
     * Grant access if the IP is whitelisted, local, or if the request already 
     * satisfied browser-based CORS requirements via an authorized origin.
     */
    if (ALLOWED_IPS.includes(clientIp) || clientIp === '127.0.0.1' || clientIp === '::1') return next();
    if (req.headers.origin && ALLOWED_ORIGINS.includes(req.headers.origin)) return next();

    console.log(`Access denied for IP: ${clientIp}`);
    res.status(403).json({ 
        error: 'Access denied: IP not allowed',
        yourIp: clientIp 
    });
});

/**
 * Proxies requests to Odesli (Songlink).
 * Abstracts regional availability parameters and prevents client-side CORS issues.
 */
app.get('/api/odesli', async (req, res) => {
    const { url, userCountry } = req.query;
    if (!url) return res.status(400).json({ error: 'url is required' });

    const target = `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(url)}&userCountry=${userCountry || 'US'}`;
    
    /**
     * Array of fetch strategies to bypass potential Odesli IP blocks.
     * Strategies include direct fetch and multiple public CORS wrappers.
     */
    const strategies = [
        async () => await fetch(target),
        async () => await fetch(`https://corsproxy.io/?${encodeURIComponent(target)}`),
        async () => {
            const r = await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(target)}`);
            if (!r.ok) return r;
            const j = await r.json();
            return { ok: true, json: () => JSON.parse(j.contents) };
        },
        async () => await fetch(`https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(target)}`)
    ];

    for (let i = 0; i < strategies.length; i++) {
        try {
            const response = await strategies[i]();
            if (response.ok) {
                const data = await response.json();
                return res.json(data);
            }
            console.warn(`Odesli strategy ${i} (Attempt ${i + 1}/${strategies.length}) failed: ${response.status}`);
        } catch (error) {
            console.warn(`Odesli strategy ${i} error:`, error.message);
        }
    }

    res.status(502).json({ error: 'Odesli resolution failed across all available proxy strategies.' });
});

/**
 * Proxies requests to the Tinyfish search API.
 * Injects secret API keys server-side to prevent exposure in the browser.
 * Utilizes round-robin key rotation for load management.
 */
app.get('/api/search', async (req, res) => {
    const { query } = req.query;
    
    if (!query) return res.status(400).json({ error: 'Query is required' });
    if (TFKEYS.length === 0) return res.status(500).json({ error: 'Missing API Key' });

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

/**
 * Deployment Mode Configuration.
 * Hybrid Mode: Acts as a proxy only, serving API responses to external frontends.
 * Standalone Mode: Serves both the API and the static LinkPark frontend.
 */
if (ALLOWED_ORIGINS.length > 0) {
    console.log(`Proxy-only mode. Whitelist: ${ALLOWED_ORIGINS.join(', ')}`);
} else {
    app.use(express.static(__dirname));

    /** 
     * Provides a dummy config.js to suppress browser 404 errors in standalone mode,
     * as keys are managed by the proxy server environment.
     */
    app.get('/config.js', (req, res) => {
        res.type('application/javascript').send('// Standalone mode: key handled by proxy');
    });

    /** Catch-all handler for Single Page Application routing. */
    app.get('*', (req, res) => {
        res.sendFile(path.join(__dirname, 'index.html'));
    });
}

app.listen(PORT, () => {
    console.log(`LinkPark is live on port ${PORT}`);
});
