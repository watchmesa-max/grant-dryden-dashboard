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

// Supabase config
const SUPABASE_URL  = 'https://xpfwfdfivehigppdmhnx.supabase.co/rest/v1';
const SUPABASE_KEY  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhwZndmZGZpdmVoaWdwcGRtaG54Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MTA1MjQwNCwiZXhwIjoyMDk2NjI4NDA0fQ.M0rlC_N6RjISw8q5v0Ygp7q_go_Pbhyaj6tTPxzLzIk';

// Cache
let calCache       = { data: null, fetched: 0 };
let newsCache      = { data: null, fetched: 0 };
let supabaseCache  = { data: null, fetched: 0 };
let contactsCache  = { data: null, date: '' };

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

// ── Fetch Supabase stats ─────────────────────────────
function fetchSupabase(path) {
  return new Promise((resolve, reject) => {
    const fullUrl = SUPABASE_URL + path;
    const opts = {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Prefer': 'count=exact'
      }
    };
    const req = https.get(fullUrl, opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ json: JSON.parse(data), range: res.headers['content-range'] || '' });
        } catch(e) {
          resolve({ json: [], range: '' });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function parseCount(range) {
  // content-range: 0-999/1023  → 1023
  const m = range.match(/\/(\d+)$/);
  return m ? parseInt(m[1]) : 0;
}

async function fetchSupabaseStats() {
  const now = Date.now();
  if (supabaseCache.data && now - supabaseCache.fetched < 10 * 60 * 1000) return supabaseCache.data;

  try {
    const [cust, veh, svc, pros, brands] = await Promise.all([
      fetchSupabase('/customers?select=id&limit=1'),
      fetchSupabase('/vehicles?select=id&limit=1'),
      fetchSupabase('/service_events?select=id&limit=1'),
      fetchSupabase('/prospects?select=id&limit=1'),
      fetchSupabase('/brand_summary?select=brand,vehicles,customers,total_events,services,sales'),
    ]);

    const stats = {
      customers:      parseCount(cust.range),
      vehicles:       parseCount(veh.range),
      service_events: parseCount(svc.range),
      prospects:      parseCount(pros.range),
      brands:         brands.json.filter(b => b.vehicles > 0),
      fetched_at:     new Date().toISOString(),
    };

    supabaseCache = { data: stats, fetched: now };
    return stats;
  } catch(e) {
    console.log('Supabase stats error:', e.message);
    return null;
  }
}

// ── Daily Contacts Engine ────────────────────────────
function seededRandom(seed) {
  // Simple deterministic RNG (mulberry32)
  let s = seed >>> 0;
  return function() {
    s = Math.imul(s ^ (s >>> 15), s | 1);
    s ^= s + Math.imul(s ^ (s >>> 7), s | 61);
    return ((s ^ (s >>> 14)) >>> 0) / 4294967296;
  };
}

function dateToSeed(dateStr) {
  // e.g. "2026-07-02" → integer seed
  return parseInt(dateStr.replace(/-/g,''), 10);
}

async function fetchDailyContacts() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' }); // YYYY-MM-DD
  if (contactsCache.data && contactsCache.date === today) return contactsCache.data;

  try {
    // 1. Fetch birthday candidates this month + next month
    const todayDate  = new Date(today);
    const m1 = todayDate.getMonth() + 1;
    const m2 = m1 === 12 ? 1 : m1 + 1;
    const [bdayRaw, poolRaw] = await Promise.all([
      fetchSupabase(`/birthday_calendar?select=first_name,surname,email,cell,birthdate&month_num=in.(${m1},${m2})&limit=200`),
      fetchSupabase('/customer_card?select=id,first_name,surname,email,cell,pipeline_stage,last_comm_at,comms_count,notes,tags,status,birthdate&or=(email.not.is.null,cell.not.is.null)&limit=500'),
    ]);

    const bdays = Array.isArray(bdayRaw.json) ? bdayRaw.json : [];
    const pool  = Array.isArray(poolRaw.json) ? poolRaw.json : [];

    // Birthday lookup by email
    const bdayByEmail = {};
    bdays.forEach(b => {
      if (b.email) bdayByEmail[b.email.toLowerCase()] = b.birthdate;
    });

    // Score each customer
    const todayMD = today.slice(5); // MM-DD
    const scored = pool.map(c => {
      let score = 0;
      let badges = [];

      // Has both email + cell = fully contactable
      if (c.email && c.cell)      { score += 20; badges.push('✉+📱'); }
      else if (c.email)           { score += 10; }
      else if (c.cell)            { score += 10; }

      // Never been contacted
      if (!c.last_comm_at)        { score += 30; badges.push('🆕 Never contacted'); }

      // Owner / premium pipeline stage
      if (c.pipeline_stage === 'Owner') { score += 15; badges.push('🚗 Owner'); }

      // Birthday this month
      const bd = bdayByEmail[c.email ? c.email.toLowerCase() : ''] || c.birthdate;
      if (bd) {
        const bdMD = String(bd).slice(5);  // MM-DD
        const bdM  = bdMD.slice(0,2);
        if (bdMD === todayMD)              { score += 100; badges.push('🎂 Birthday TODAY'); }
        else if (bdM === todayMD.slice(0,2)) { score += 60; badges.push('🎂 Birthday this month'); }
        else if (bdM === String(m2).padStart(2,'0')) { score += 20; badges.push('🎂 Birthday next month'); }
        c._birthdate = bd;
      }

      // Stale — last contact > 60 days
      if (c.last_comm_at) {
        const daysSince = (Date.now() - new Date(c.last_comm_at)) / 86400000;
        if (daysSince > 180)       { score += 25; badges.push(`⏰ ${Math.round(daysSince)}d no contact`); }
        else if (daysSince > 60)   { score += 10; badges.push(`⏰ ${Math.round(daysSince)}d no contact`); }
      }

      return { ...c, _score: score, _badges: badges };
    });

    // Sort: score desc, then deterministic shuffle by date seed within same score bucket
    const rng = seededRandom(dateToSeed(today));
    scored.sort((a, b) => {
      if (b._score !== a._score) return b._score - a._score;
      return rng() - 0.5;
    });

    // Take top 8, ensure we have name + at least one contact
    const selected = scored
      .filter(c => (c.first_name || c.surname))
      .slice(0, 8)
      .map((c, i) => ({
        rank:          i + 1,
        id:            c.id || null,
        entity_id:     c.entity_id || null,
        name:          [c.first_name, c.surname].filter(Boolean).join(' '),
        first_name:    c.first_name || null,
        surname:       c.surname || null,
        email:         c.email || null,
        cell:          c.cell  || null,
        pipeline:      c.pipeline_stage || '—',
        badges:        c._badges,
        last_contact:  c.last_comm_at ? new Date(c.last_comm_at).toLocaleDateString('en-ZA') : null,
        birthdate:     c._birthdate || null,
        notes:         c.notes || null,
      }));

    contactsCache = { data: { date: today, contacts: selected }, date: today };
    return contactsCache.data;
  } catch(e) {
    console.log('Daily contacts error:', e.message);
    return null;
  }
}

// ── POST to Supabase ─────────────────────────────────
function postSupabase(path, body, method) {
  return new Promise((resolve, reject) => {
    const data   = JSON.stringify(body);
    const m      = (method || 'POST').toUpperCase();
    const opts   = {
      hostname: 'xpfwfdfivehigppdmhnx.supabase.co',
      path:     '/rest/v1' + path,
      method:   m,
      headers:  {
        'apikey':         SUPABASE_KEY,
        'Authorization':  'Bearer ' + SUPABASE_KEY,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(data),
        'Prefer':         'return=representation',
      },
    };
    const req = https.request(opts, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => resolve({ status: r.statusCode, body: d }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

// ── Message template generator ───────────────────────
function buildTemplate(c, vehicle) {
  const first   = c.first_name || c.name.split(' ')[0] || 'there';
  const isBday  = (c.badges || []).some(b => b.includes('Birthday'));
  const pipeline = c.pipeline || '';
  const brand    = vehicle ? vehicle.brand : null;
  const model    = vehicle ? vehicle.model : null;
  const car      = brand && model ? `${brand} ${model}` : brand || model || null;

  let opening = '';
  let body    = '';

  if (isBday) {
    opening = `Hi ${first}, wishing you a very happy birthday! 🎉`;
    body    = car
      ? `Hope you're celebrating in style — the ${car} never looked better on a birthday drive.`
      : `Hope you have a wonderful day with your loved ones.`;
  } else if (pipeline === 'Owner') {
    opening = `Hi ${first}, hope all is well with you.`;
    body    = car
      ? `Just wanted to check in and see how you're enjoying the ${car}. It would be great to catch up.`
      : `Just wanted to reconnect — it's been a while and I'd love to know what you're up to these days.`;
  } else {
    opening = `Hi ${first}, hope you're doing well!`;
    body    = `I was thinking of you recently and wanted to reach out. Always great staying in touch with the people in my network who matter.`;
  }

  const closing = `\n\nIf there's anything I can help with — whether it's a vehicle, an introduction, or just a conversation — I'm here.\n\nBest regards,\nGrant`;

  return `${opening}\n\n${body}${closing}`;
}

// ── Read body from POST request ───────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { resolve({}); } });
    req.on('error', reject);
  });
}

// ── HTTP Server ──────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

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

  // ── /message-template  (POST {contact}) ──
  if (parsed.pathname === '/message-template' && req.method === 'POST') {
    try {
      const contact = await readBody(req);
      // Optionally fetch their vehicle
      let vehicle = null;
      if (contact.id) {
        const vr = await fetchSupabase(`/vehicle_status?select=brand,model&owner_id=eq.${contact.id}&limit=1`);
        vehicle  = Array.isArray(vr.json) && vr.json.length ? vr.json[0] : null;
      }
      const template = buildTemplate(contact, vehicle);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ template, vehicle }));
    } catch(e) {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── /log-contact  (POST {customer_id, entity_id, type, direction, subject, summary, occurred_at}) ──
  if (parsed.pathname === '/log-contact' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const record = {
        customer_id:  body.customer_id,
        entity_id:    body.entity_id || '7cg',
        type:         body.type      || 'message',
        direction:    body.direction || 'outbound',
        subject:      body.subject   || 'Outreach',
        body:         body.message   || null,
        summary:      body.summary   || body.message || null,
        occurred_at:  body.occurred_at || new Date().toISOString(),
        logged_by:    'Grant',
      };
      const r = await postSupabase('/customer_comms', record);
      // Invalidate contacts cache so next load reflects the comm
      contactsCache = { data: null, date: '' };
      res.writeHead(r.status < 300 ? 200 : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: r.status < 300, status: r.status }));
    } catch(e) {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── /search-customers  (GET ?q=name) ──
  if (parsed.pathname === '/search-customers') {
    try {
      const q   = (new URLSearchParams(parsed.query || '')).get('q') || '';
      const enc = encodeURIComponent(q);
      const r   = await fetchSupabase(
        `/customer_card?select=id,first_name,surname,email,cell,pipeline_stage,notes,entity_id` +
        `&or=(first_name.ilike.*${enc}*,surname.ilike.*${enc}*,email.ilike.*${enc}*)&limit=10`
      );
      const results = (Array.isArray(r.json) ? r.json : []).map(c => ({
        id:       c.id,
        name:     [c.first_name, c.surname].filter(Boolean).join(' '),
        email:    c.email,
        cell:     c.cell,
        pipeline: c.pipeline_stage,
        entity_id: c.entity_id,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(results));
    } catch(e) {
      res.writeHead(500); res.end('[]');
    }
    return;
  }

  // ── /log-connection  (POST {from_id, to_id, from_name, to_name, reason, outcome}) ──
  if (parsed.pathname === '/log-connection' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      // Log as a note on both customers' comms
      const note = `Connected with: ${body.to_name || body.to_id}. Reason: ${body.reason || '—'}. Outcome: ${body.outcome || 'Pending'}.`;
      const note2 = `Connected with: ${body.from_name || body.from_id}. Reason: ${body.reason || '—'}. Outcome: ${body.outcome || 'Pending'}.`;
      const ts = new Date().toISOString();
      await Promise.all([
        body.from_id ? postSupabase('/customer_comms', {
          customer_id: body.from_id, entity_id: body.entity_id || '7cg',
          type: 'note', direction: 'internal', subject: 'Network connection',
          summary: note, occurred_at: ts, logged_by: 'Grant',
        }) : Promise.resolve(),
        body.to_id ? postSupabase('/customer_comms', {
          customer_id: body.to_id, entity_id: body.entity_id || '7cg',
          type: 'note', direction: 'internal', subject: 'Network connection',
          summary: note2, occurred_at: ts, logged_by: 'Grant',
        }) : Promise.resolve(),
      ]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch(e) {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── /refresh-cache — force-bust the contacts cache ──
  if (parsed.pathname === '/refresh-cache') {
    contactsCache = { data: null, date: '' };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: 'Cache cleared — next /daily-contacts will fetch fresh data.' }));
    return;
  }

  // ── /daily-contacts ──
  if (parsed.pathname === '/daily-contacts') {
    try {
      const data = await fetchDailyContacts();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data || {}));
    } catch(e) {
      res.writeHead(500); res.end('{}');
    }
    return;
  }

  // ── /supabase-stats ──
  if (parsed.pathname === '/supabase-stats') {
    try {
      const stats = await fetchSupabaseStats();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(stats || {}));
    } catch(e) {
      res.writeHead(500); res.end('{}');
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
