const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const STEAMAPIS_KEY = process.env.STEAMAPIS_KEY || '';
const cache = new Map();
const PRICE_TTL = 10 * 60 * 1000;  // 10 min
const BULK_TTL  = 10 * 60 * 1000;  // 10 min for bulk fetch
const SEARCH_TTL = 30 * 1000;
const ICON_TTL  = 60 * 60 * 1000;
const delay = ms => new Promise(r => setTimeout(r, ms));

const STEAM_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json',
  'Referer': 'https://steamcommunity.com/market/',
};

function parseEur(raw) {
  if (!raw) return null;
  const v = parseFloat(raw.replace(/[^0-9.,]/g, '').replace(',', '.'));
  return isNaN(v) ? null : v;
}

// ─── Fetch ALL CS2 prices in one request (steamapis compact format) ────────────
// Much better than one-per-item — uses 1 API call instead of N
async function fetchBulkPrices() {
  const hit = cache.get('bulk');
  if (hit && Date.now() - hit.ts < BULK_TTL) return hit.data;

  if (!STEAMAPIS_KEY) return null;

  // compact format returns { "Item Name": price_in_cents, ... }
  const url = `https://api.steamapis.com/market/items/730?api_key=${STEAMAPIS_KEY}&format=compact`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) {
    console.warn('steamapis bulk failed:', r.status);
    return null;
  }
  const data = await r.json();
  // data.data is the price map
  const priceMap = data.data || data;
  cache.set('bulk', { data: priceMap, ts: Date.now() });
  return priceMap;
}

// ─── Single price ─────────────────────────────────────────────────────────────
app.get('/price', async (req, res) => {
  const name = req.query.name;
  if (!name) return res.status(400).json({ error: 'Missing name' });

  const key = 'price:' + name.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < PRICE_TTL) return res.json({ ...hit.data, cached: true });

  // Try bulk map first
  try {
    const bulk = await fetchBulkPrices();
    if (bulk) {
      const priceUSD = bulk[name];
      if (priceUSD != null) {
        const result = { name, lowest_price_usd: priceUSD / 100, source: 'steamapis_bulk' };
        cache.set(key, { data: result, ts: Date.now() });
        return res.json(result);
      }
    }
  } catch (e) { console.warn('bulk lookup error:', e.message); }

  // Fallback: Steam priceoverview EUR
  try {
    const url = `https://steamcommunity.com/market/priceoverview/?appid=730&currency=3&market_hash_name=${encodeURIComponent(name)}`;
    const r = await fetch(url, { headers: STEAM_HEADERS });
    if (r.status === 429) return res.status(429).json({ error: 'Steam rate limited' });
    const d = await r.json();
    if (!d.success) return res.status(404).json({ error: 'not_found', name });
    const result = { name, lowest_price: parseEur(d.lowest_price), median_price: parseEur(d.median_price), source: 'steam' };
    cache.set(key, { data: result, ts: Date.now() });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── Batch prices — uses ONE bulk steamapis call then maps results ─────────────
app.post('/prices', async (req, res) => {
  const names = req.body.names;
  if (!Array.isArray(names) || !names.length) return res.status(400).json({ error: 'Need names[]' });

  const results = {};

  // Try bulk first — all items in one shot
  try {
    const bulk = await fetchBulkPrices();
    if (bulk) {
      let allFound = true;
      for (const name of names) {
        const priceUSD = bulk[name];
        if (priceUSD != null) {
          results[name] = { name, lowest_price_usd: priceUSD / 100, source: 'steamapis_bulk' };
        } else {
          allFound = false;
          results[name] = { error: 'not_in_bulk' };
        }
      }
      if (allFound) return res.json(results);
    }
  } catch (e) { console.warn('bulk prices error:', e.message); }

  // Fallback: Steam per-item for any that failed
  for (const name of names) {
    if (results[name] && !results[name].error) continue; // already got it from bulk

    const key = 'price:' + name.toLowerCase();
    const hit = cache.get(key);
    if (hit && Date.now() - hit.ts < PRICE_TTL) { results[name] = { ...hit.data, cached: true }; continue; }

    try {
      const url = `https://steamcommunity.com/market/priceoverview/?appid=730&currency=3&market_hash_name=${encodeURIComponent(name)}`;
      const r = await fetch(url, { headers: STEAM_HEADERS });
      if (r.status === 429) { results[name] = { error: 'rate_limited' }; break; }
      const d = await r.json();
      if (!d.success) { results[name] = { error: 'not_found' }; continue; }
      const result = { name, lowest_price: parseEur(d.lowest_price), median_price: parseEur(d.median_price), source: 'steam' };
      cache.set(key, { data: result, ts: Date.now() });
      results[name] = result;
    } catch (err) { results[name] = { error: err.message }; }
    await delay(1500);
  }
  res.json(results);
});

// ─── Search ───────────────────────────────────────────────────────────────────
app.get('/search', async (req, res) => {
  const q = req.query.q;
  if (!q || q.length < 2) return res.json([]);
  const key = 'search:' + q.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < SEARCH_TTL) return res.json(hit.data);
  try {
    const r = await fetch(`https://steamcommunity.com/market/search/render/?appid=730&norender=1&count=10&query=${encodeURIComponent(q)}`, { headers: STEAM_HEADERS });
    const d = await r.json();
    if (!d.success || !d.results) return res.json([]);
    const results = d.results.map(i => ({
      name: i.hash_name,
      icon: i.asset_description?.icon_url ? `https://community.akamai.steamstatic.com/economy/image/${i.asset_description.icon_url}/75fx75f` : null,
      price: i.sell_price_text || null,
    }));
    cache.set(key, { data: results, ts: Date.now() });
    res.json(results);
  } catch { res.json([]); }
});

// ─── Icons ────────────────────────────────────────────────────────────────────
app.post('/icons', async (req, res) => {
  const names = req.body.names;
  if (!Array.isArray(names)) return res.status(400).json({ error: 'Need names[]' });
  const results = {};
  for (const name of names) {
    const key = 'icon:' + name.toLowerCase();
    const hit = cache.get(key);
    if (hit && Date.now() - hit.ts < ICON_TTL) { results[name] = hit.data; continue; }
    try {
      const r = await fetch(`https://steamcommunity.com/market/search/render/?appid=730&norender=1&count=1&query=${encodeURIComponent(name)}`, { headers: STEAM_HEADERS });
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

app.get('/health', (req, res) => res.json({ ok: true, cached: cache.size, has_key: !!STEAMAPIS_KEY }));
app.listen(PORT, () => console.log(`Proxy on :${PORT} | steamapis: ${STEAMAPIS_KEY ? 'SET' : 'NOT SET'}`));
