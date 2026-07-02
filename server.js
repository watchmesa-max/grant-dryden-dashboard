const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const ICS_URL = 'https://p154-caldav.icloud.com/published/2/MTAyNzgxMzE5NjEwMjc4MeQpRiWg8s91ZttUzCscn0LVukQGO_XhrS79WurbTSRN';

// Cache calendar data to avoid hammering iCloud
let calCache = { data: null, fetched: 0 };

function fetchICS() {
  return new Promise((resolve, reject) => {
    https.get(ICS_URL, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url);

  // CORS headers for all responses
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  // Calendar proxy endpoint
  if (parsed.pathname === '/calendar') {
    try {
      const now = Date.now();
      // Cache for 15 minutes
      if (!calCache.data || now - calCache.fetched > 15 * 60 * 1000) {
        calCache.data = await fetchICS();
        calCache.fetched = now;
      }
      res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8' });
      res.end(calCache.data);
    } catch (e) {
      res.writeHead(500);
      res.end('Calendar fetch failed');
    }
    return;
  }

  // Health check
  if (parsed.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
    return;
  }

  // Serve static files from public/
  let filePath = path.join(__dirname, 'public',
    parsed.pathname === '/' ? 'index.html' : parsed.pathname);

  const ext = path.extname(filePath);
  const mimeTypes = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
  };

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // Fallback to index.html
      fs.readFile(path.join(__dirname, 'public', 'index.html'), (err2, data2) => {
        if (err2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data2);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Dashboard server running on port ${PORT}`);
});
