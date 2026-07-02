const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;

const ICS_URL = 'https://p154-caldav.icloud.com/published/2/MTAyNzgxMzE5NjEwMjc4MeQpRiWg8s91ZttUzCscn0LVukQGO_XhrS79WurbTSRN';

// News RSS feeds - confirmed working, 6 categories
const NEWS_FEEDS = [
  { url: 'https://www.autocar.co.uk/rss',            label: 'Auto',      color: '#0071e3' },
  { url: 'https://www.motor1.com/rss/news/all/',      label: 'Auto',      color: '#0071e3' },
  { url: 'https://www.electrive.com/feed/',           label: 'EV',        color: '#34c759' },
  { url: 'https://www.moneyweb.co.za/feed/',          label: 'SA Biz',    color: '#ff9f0a' },
  { url: 'https://www.crash.net/rss/f1',              label: 'F1',        color: '#ff3b30' },
  { url: 'https://robbreport.com/feed/',              label: 'Luxury',    color: '#af52de' },
];

// Cache
let calCache  = { data: null, fetched: 0 };
let newsCache = { data: null, fetched: 0 };

// ── Fetch a URL ──────────────────────────────────────
function fetchURL(targetUrl) {
  return new Promise((resolve, reject) => {
    const mod = targetUrl.startsWith('https') ? https : http;
    const req = mod.get(targetUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DashboardBot/1.0)' }
    }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchURL(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── Parse RSS feed ───────────────────────────────────
function parseRSS(xml, label, color) {
  const items = [];
  const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null && items.length < 4) {
    const block = match[1];
    const getTag = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([^<]*)<\\/${tag}>`, 'i'));
      return m ? (m[1] || m[2] || '').trim() : '';
    };
    const title = getTag('title').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#039;/g,"'").replace(/&quot;/g,'"');
    const link  = getTag('link') || (block.match(/<link>([^<]+)<\/link>/) || [])[1] || '';
    const desc  = getTag('description').replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&#039;/g,"'").substring(0,120);
    const pub   = getTag('pubDate');
    if (title && link && title.length > 5) {
      items.push({ title, link: link.trim(), desc, pub, label, color });
    }
  }
  return items;
}

// ── Fetch all news feeds ─────────────────────────────
async function fetchNews() {
  const now = Date.now();
  if (newsCache.data && now - newsCache.fetched < 30 * 60 * 1000) return newsCache.data;

  const allItems = [];
  for (const feed of NEWS_FEEDS) {
    try {
      const xml   = await fetchURL(feed.url);
      const items = parseRSS(xml, feed.label, feed.color);
      allItems.push(...items);
    } catch(e) {
      console.log('Feed error:', feed.url, e.message);
    }
  }

  // Shuffle so it's not always same source first, cap at 12
  const shuffled = allItems.sort(() => Math.random() - 0.5).slice(0, 12);
  newsCache = { data: shuffled, fetched: now };
  return shuffled;
}

// ── HTTP Server ──────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  // ── /calendar ──
  if (parsed.pathname === '/calendar') {
    try {
      const now = Date.now();
      if (!calCache.data || now - calCache.fetched > 15 * 60 * 1000) {
        calCache.data = await fetchURL(ICS_URL);
        calCache.fetched = now;
      }
      res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8' });
      res.end(calCache.data);
    } catch(e) {
      res.writeHead(500); res.end('Calendar fetch failed');
    }
    return;
  }

  // ── /news ──
  if (parsed.pathname === '/news') {
    try {
      const items = await fetchNews();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(items));
    } catch(e) {
      res.writeHead(500); res.end('[]');
    }
    return;
  }

  // ── /health ──
  if (parsed.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
    return;
  }

  // ── Static files from public/ ──
  let filePath = path.join(__dirname, 'public',
    parsed.pathname === '/' ? 'index.html' : parsed.pathname);

  const ext = path.extname(filePath);
  const mimeTypes = {
    '.html': 'text/html', '.css': 'text/css',
    '.js': 'application/javascript', '.json': 'application/json',
    '.png': 'image/png', '.ico': 'image/x-icon',
  };

  fs.readFile(filePath, (err, data) => {
    if (err) {
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

server.listen(PORT, () => console.log(`Dashboard server running on port ${PORT}`));
