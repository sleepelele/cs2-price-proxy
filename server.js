const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 min for prices
const SEARCH_CACHE_TTL = 30 * 1000; // 30s for search

const STEAM_PRICE_URL = 'https://steamcommunity.com/market/priceoverview/?appid=730&currency=3&market_hash_name=';
const STEAM_SEARCH_URL = 'https://steamcommunity.com/market/search/render/?appid=730&norender=1&count=10&query=';

const delay = ms => new Promise(r => setTimeout(r, ms));

function parsePrice(raw) {
  if (!raw) return null;
  return parseFloat(raw.replace(/[^0-9.,]/g, '').replace(',', '.')) || null;
}

// ─── Single price fetch ───────────────────────────────────────────────────────
app.get('/price', async (req, res) => {
  const name = req.query.name;
  if (!name) return res.status(400).json({ error: 'Missing name' });

  const key = 'price:' + name.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return res.json({ ...hit.data, cached: true });

  try {
    const r = await fetch(STEAM_PRICE_URL + encodeURIComponent(name), {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (r.status === 429) return res.status(429).json({ error: 'Steam rate limited' });
    const d = await r.json();
    if (!d.success) return res.status(404).json({ error: 'Not found', name });

    const result = {
      name,
      lowest_price: parsePrice(d.lowest_price),
      median_price: parsePrice(d.median_price),
      volume: d.volume,
    };
    cache.set(key, { data: result, ts: Date.now() });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Batch price fetch ────────────────────────────────────────────────────────
app.post('/prices', async (req, res) => {
  const names = req.body.names;
  if (!Array.isArray(names) || !names.length) return res.status(400).json({ error: 'Need names array' });

  const results = {};
  for (const name of names) {
    const key = 'price:' + name.toLowerCase();
    const hit = cache.get(key);
    if (hit && Date.now() - hit.ts < CACHE_TTL) {
      results[name] = { ...hit.data, cached: true };
      continue;
    }
    try {
      const r = await fetch(STEAM_PRICE_URL + encodeURIComponent(name), {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      if (r.status === 429) { results[name] = { error: 'rate_limited' }; break; }
      const d = await r.json();
      if (!d.success) {
        results[name] = { error: 'not_found' };
      } else {
        const result = {
          name,
          lowest_price: parsePrice(d.lowest_price),
          median_price: parsePrice(d.median_price),
          volume: d.volume,
        };
        cache.set(key, { data: result, ts: Date.now() });
        results[name] = result;
      }
    } catch (err) {
      results[name] = { error: err.message };
    }
    await delay(1200); // respect Steam rate limit
  }
  res.json(results);
});

// ─── Search (for autocomplete) ────────────────────────────────────────────────
app.get('/search', async (req, res) => {
  const q = req.query.q;
  if (!q || q.length < 2) return res.json([]);

  const key = 'search:' + q.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < SEARCH_CACHE_TTL) return res.json(hit.data);

  try {
    const r = await fetch(STEAM_SEARCH_URL + encodeURIComponent(q), {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const d = await r.json();
    if (!d.success || !d.results) return res.json([]);

    const results = d.results.map(item => ({
      name: item.hash_name,
      icon: item.asset_description?.icon_url
        ? `https://community.akamai.steamstatic.com/economy/image/${item.asset_description.icon_url}/75fx75f`
        : null,
      price: item.sale_price_text || null,
    }));

    cache.set(key, { data: results, ts: Date.now() });
    res.json(results);
  } catch (err) {
    res.json([]);
  }
});

// ─── Icon batch fetch — get icons for a list of item names via search ─────────
app.post('/icons', async (req, res) => {
  const names = req.body.names;
  if (!Array.isArray(names)) return res.status(400).json({ error: 'Need names array' });

  const results = {};
  for (const name of names) {
    const key = 'icon:' + name.toLowerCase();
    const hit = cache.get(key);
    if (hit && Date.now() - hit.ts < 60 * 60 * 1000) { // icons cached 1hr
      results[name] = hit.data;
      continue;
    }
    try {
      const r = await fetch(STEAM_SEARCH_URL + encodeURIComponent(name) + '&count=1', {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      const d = await r.json();
      const iconHash = d?.results?.[0]?.asset_description?.icon_url;
      const icon = iconHash
        ? `https://community.akamai.steamstatic.com/economy/image/${iconHash}/75fx75f`
        : null;
      cache.set(key, { data: icon, ts: Date.now() });
      results[name] = icon;
    } catch {
      results[name] = null;
    }
    await delay(400); // search endpoint is less strict
  }
  res.json(results);
});

app.get('/health', (req, res) => res.json({ ok: true, cached: cache.size }));

app.listen(PORT, () => console.log(`Proxy running on :${PORT}`));
