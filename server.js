const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ─── Your steamapis.com key — set this in Render as environment variable STEAMAPIS_KEY
// Get your free key at steamapis.com → sign in with Steam → Settings
const STEAMAPIS_KEY = process.env.STEAMAPIS_KEY || '';

const cache = new Map();
const PRICE_TTL = 5 * 60 * 1000;
const SEARCH_TTL = 30 * 1000;
const ICON_TTL = 60 * 60 * 1000;
const delay = ms => new Promise(r => setTimeout(r, ms));

const STEAM_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json',
  'Referer': 'https://steamcommunity.com/market/',
};

// ─── Single price via steamapis.com ──────────────────────────────────────────
// Returns sell_order_summary.lowest_price in USD, plus median_history
// We convert to EUR using ECB rate (or just return USD and note it)
app.get('/price', async (req, res) => {
  const name = req.query.name;
  if (!name) return res.status(400).json({ error: 'Missing name' });

  const key = 'price:' + name.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < PRICE_TTL) return res.json({ ...hit.data, cached: true });

  // Try steamapis.com first (reliable, no IP block)
  if (STEAMAPIS_KEY) {
    try {
      const url = `https://api.steamapis.com/market/item/730/${encodeURIComponent(name)}?api_key=${STEAMAPIS_KEY}`;
      const r = await fetch(url);
      if (r.ok) {
        const d = await r.json();
        // steamapis returns prices in USD — lowest_price is in cents
        const lowestUSD = d.sell_order_summary?.lowest_price / 100 || null;
        const medianUSD = d.median_history?.slice(-1)[0]?.[1] / 100 || null;
        if (lowestUSD) {
          const result = { name, lowest_price_usd: lowestUSD, median_price_usd: medianUSD, source: 'steamapis' };
          cache.set(key, { data: result, ts: Date.now() });
          return res.json(result);
        }
      }
    } catch (err) {
      console.warn('steamapis error:', err.message);
    }
  }

  // Fallback: Steam priceoverview in EUR (may 429 from Render IPs)
  try {
    const url = `https://steamcommunity.com/market/priceoverview/?appid=730&currency=3&market_hash_name=${encodeURIComponent(name)}`;
    const r = await fetch(url, { headers: STEAM_HEADERS });
    if (r.status === 429) return res.status(429).json({ error: 'Steam rate limited', tip: 'Add STEAMAPIS_KEY env var to Render' });
    const d = await r.json();
    if (!d.success) return res.status(404).json({ error: 'not_found', name });
    const parseEur = raw => raw ? parseFloat(raw.replace(/[^0-9.,]/g, '').replace(',', '.')) : null;
    const result = { name, lowest_price: parseEur(d.lowest_price), median_price: parseEur(d.median_price), raw: d.lowest_price, source: 'steam' };
    cache.set(key, { data: result, ts: Date.now() });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
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
    if (hit && Date.now() - hit.ts < PRICE_TTL) { results[name] = { ...hit.data, cached: true }; continue; }

    if (STEAMAPIS_KEY) {
      try {
        const url = `https://api.steamapis.com/market/item/730/${encodeURIComponent(name)}?api_key=${STEAMAPIS_KEY}`;
        const r = await fetch(url);
        if (r.ok) {
          const d = await r.json();
          const lowestUSD = d.sell_order_summary?.lowest_price / 100 || null;
          const medianUSD = d.median_history?.slice(-1)[0]?.[1] / 100 || null;
          if (lowestUSD) {
            const result = { name, lowest_price_usd: lowestUSD, median_price_usd: medianUSD, source: 'steamapis' };
            cache.set(key, { data: result, ts: Date.now() });
            results[name] = result;
            await delay(300); // steamapis is more lenient
            continue;
          }
        }
      } catch {}
    }

    // Steam fallback
    try {
      const url = `https://steamcommunity.com/market/priceoverview/?appid=730&currency=3&market_hash_name=${encodeURIComponent(name)}`;
      const r = await fetch(url, { headers: STEAM_HEADERS });
      if (r.status === 429) { results[name] = { error: 'rate_limited' }; break; }
      const d = await r.json();
      if (!d.success) { results[name] = { error: 'not_found' }; continue; }
      const parseEur = raw => raw ? parseFloat(raw.replace(/[^0-9.,]/g, '').replace(',', '.')) : null;
      const result = { name, lowest_price: parseEur(d.lowest_price), median_price: parseEur(d.median_price), source: 'steam' };
      cache.set(key, { data: result, ts: Date.now() });
      results[name] = result;
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
    const r = await fetch(url, { headers: STEAM_HEADERS });
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
      const r = await fetch(url, { headers: STEAM_HEADERS });
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

app.listen(PORT, () => console.log(`Proxy on :${PORT} | steamapis key: ${STEAMAPIS_KEY ? 'SET' : 'NOT SET - will use Steam fallback'}`));
