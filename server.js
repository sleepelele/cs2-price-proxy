const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const cache = new Map();
const PRICE_TTL = 5 * 60 * 1000;
const SEARCH_TTL = 30 * 1000;
const ICON_TTL = 60 * 60 * 1000;
const delay = ms => new Promise(r => setTimeout(r, ms));

// Mimic a real browser to avoid Steam IP blocks
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer': 'https://steamcommunity.com/market/',
  'X-Requested-With': 'XMLHttpRequest',
  'Origin': 'https://steamcommunity.com',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
};

function parseEur(raw) {
  if (!raw) return null;
  const val = parseFloat(raw.replace(/[^0-9.,]/g, '').replace(',', '.'));
  return isNaN(val) ? null : val;
}

// ─── Single price ─────────────────────────────────────────────────────────────
app.get('/price', async (req, res) => {
  const name = req.query.name;
  if (!name) return res.status(400).json({ error: 'Missing name' });

  const key = 'price:' + name.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < PRICE_TTL) return res.json({ ...hit.data, cached: true });

  try {
    const url = `https://steamcommunity.com/market/priceoverview/?appid=730&currency=3&market_hash_name=${encodeURIComponent(name)}`;
    const r = await fetch(url, { headers: BROWSER_HEADERS });

    if (r.status === 429) return res.status(429).json({ error: 'Steam rate limited, wait 1 min' });
    if (!r.ok) return res.status(r.status).json({ error: `Steam returned ${r.status}` });

    const d = await r.json();
    if (!d.success) return res.status(404).json({ error: 'not_found', name });

    const result = {
      name,
      lowest_price: parseEur(d.lowest_price),
      median_price: parseEur(d.median_price),
      raw_lowest: d.lowest_price,
      volume: d.volume,
    };
    cache.set(key, { data: result, ts: Date.now() });
    res.json(result);
  } catch (err) {
    console.error('price error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Batch prices ─────────────────────────────────────────────────────────────
app.post('/prices', async (req, res) => {
  const names = req.body.names;
  if (!Array.isArray(names) || !names.length) return res.status(400).json({ error: 'Need names[]' });

  const results = {};
  for (const name of names) {
    const key = 'price:' + name.toLowerCase();
    const hit = cache.get(key);
    if (hit && Date.now() - hit.ts < PRICE_TTL) {
      results[name] = { ...hit.data, cached: true };
      continue;
    }
    try {
      const url = `https://steamcommunity.com/market/priceoverview/?appid=730&currency=3&market_hash_name=${encodeURIComponent(name)}`;
      const r = await fetch(url, { headers: BROWSER_HEADERS });
      if (r.status === 429) { results[name] = { error: 'rate_limited' }; break; }
      const d = await r.json();
      if (!d.success) {
        results[name] = { error: 'not_found' };
      } else {
        const result = { name, lowest_price: parseEur(d.lowest_price), median_price: parseEur(d.median_price), raw_lowest: d.lowest_price, volume: d.volume };
        cache.set(key, { data: result, ts: Date.now() });
        results[name] = result;
      }
    } catch (err) {
      results[name] = { error: err.message };
    }
    await delay(1500);
  }
  res.json(results);
});

// ─── Search autocomplete ──────────────────────────────────────────────────────
app.get('/search', async (req, res) => {
  const q = req.query.q;
  if (!q || q.length < 2) return res.json([]);

  const key = 'search:' + q.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < SEARCH_TTL) return res.json(hit.data);

  try {
    const url = `https://steamcommunity.com/market/search/render/?appid=730&norender=1&count=10&query=${encodeURIComponent(q)}`;
    const r = await fetch(url, { headers: BROWSER_HEADERS });
    const d = await r.json();
    if (!d.success || !d.results) return res.json([]);
    const results = d.results.map(item => ({
      name: item.hash_name,
      icon: item.asset_description?.icon_url ? `https://community.akamai.steamstatic.com/economy/image/${item.asset_description.icon_url}/75fx75f` : null,
      price: item.sell_price_text || null,
    }));
    cache.set(key, { data: results, ts: Date.now() });
    res.json(results);
  } catch { res.json([]); }
});

// ─── Icons batch ──────────────────────────────────────────────────────────────
app.post('/icons', async (req, res) => {
  const names = req.body.names;
  if (!Array.isArray(names)) return res.status(400).json({ error: 'Need names[]' });
  const results = {};
  for (const name of names) {
    const key = 'icon:' + name.toLowerCase();
    const hit = cache.get(key);
    if (hit && Date.now() - hit.ts < ICON_TTL) { results[name] = hit.data; continue; }
    try {
      const url = `https://steamcommunity.com/market/search/render/?appid=730&norender=1&count=1&query=${encodeURIComponent(name)}`;
      const r = await fetch(url, { headers: BROWSER_HEADERS });
      const d = await r.json();
      const iconHash = d?.results?.[0]?.asset_description?.icon_url;
      const icon = iconHash ? `https://community.akamai.steamstatic.com/economy/image/${iconHash}/75fx75f` : null;
      cache.set(key, { data: icon, ts: Date.now() });
      results[name] = icon;
    } catch { results[name] = null; }
    await delay(400);
  }
  res.json(results);
});

// ─── Debug endpoint — test if Steam responds ─────────────────────────────────
app.get('/debug', async (req, res) => {
  const name = req.query.name || 'Fracture Case';
  try {
    const url = `https://steamcommunity.com/market/priceoverview/?appid=730&currency=3&market_hash_name=${encodeURIComponent(name)}`;
    const r = await fetch(url, { headers: BROWSER_HEADERS });
    const text = await r.text();
    res.json({ status: r.status, headers: Object.fromEntries(r.headers), body: text.slice(0, 500) });
  } catch (err) {
    res.json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true, cached: cache.size }));

app.listen(PORT, () => console.log(`Proxy on :${PORT}`));
