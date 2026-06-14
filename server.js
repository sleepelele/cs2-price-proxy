const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Cache prices for 5 minutes to avoid Steam rate limits
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

// Steam market priceoverview endpoint
// currency=3 = EUR
const STEAM_URL = 'https://steamcommunity.com/market/priceoverview/?appid=730&currency=3&market_hash_name=';

app.get('/price', async (req, res) => {
  const name = req.query.name;
  if (!name) return res.status(400).json({ error: 'Missing name param' });

  const cacheKey = name.toLowerCase();
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return res.json({ ...cached.data, cached: true });
  }

  try {
    const url = STEAM_URL + encodeURIComponent(name);
    const response = await fetch(url);

    if (response.status === 429) {
      return res.status(429).json({ error: 'Steam rate limited, try again in a minute' });
    }

    const data = await response.json();

    if (!data.success) {
      return res.status(404).json({ error: 'Item not found on Steam market', name });
    }

    // Parse EUR price string like "0,49€" or "€0.49"
    const rawLowest = data.lowest_price || data.median_price || '0';
    const price = parseFloat(rawLowest.replace(/[^0-9.,]/g, '').replace(',', '.'));

    const result = {
      name,
      lowest_price: price,
      raw_lowest: data.lowest_price,
      median_price: data.median_price,
      volume: data.volume,
    };

    cache.set(cacheKey, { data: result, ts: Date.now() });
    res.json(result);

  } catch (err) {
    console.error('Steam fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch from Steam', detail: err.message });
  }
});

// Batch endpoint — fetches multiple items with 1.2s delay between calls
app.post('/prices', async (req, res) => {
  const names = req.body.names;
  if (!Array.isArray(names) || names.length === 0) {
    return res.status(400).json({ error: 'Body must be { names: [...] }' });
  }

  const results = {};
  const delay = ms => new Promise(r => setTimeout(r, ms));

  for (const name of names) {
    const cacheKey = name.toLowerCase();
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      results[name] = { ...cached.data, cached: true };
      continue;
    }

    try {
      const url = STEAM_URL + encodeURIComponent(name);
      const response = await fetch(url);

      if (response.status === 429) {
        results[name] = { error: 'rate_limited' };
        break;
      }

      const data = await response.json();
      if (!data.success) {
        results[name] = { error: 'not_found' };
      } else {
        const rawLowest = data.lowest_price || data.median_price || '0';
        const price = parseFloat(rawLowest.replace(/[^0-9.,]/g, '').replace(',', '.'));
        const result = {
          name,
          lowest_price: price,
          raw_lowest: data.lowest_price,
          median_price: data.median_price,
          volume: data.volume,
        };
        cache.set(cacheKey, { data: result, ts: Date.now() });
        results[name] = result;
      }
    } catch (err) {
      results[name] = { error: err.message };
    }

    // Respect Steam rate limit: 1 req/sec
    await delay(1200);
  }

  res.json(results);
});


// Search endpoint — proxies Steam market search for autocomplete
// Returns item names + icons for CS2 (appid 730)
app.get('/search', async (req, res) => {
  const q = req.query.q;
  if (!q || q.length < 2) return res.json([]);

  const cacheKey = 'search:' + q.toLowerCase();
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 30000) { // 30s cache for search
    return res.json(cached.data);
  }

  try {
    const url = `https://steamcommunity.com/market/search/render/?appid=730&norender=1&count=10&query=${encodeURIComponent(q)}`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const data = await response.json();

    if (!data.success || !data.results) return res.json([]);

    const results = data.results.map(item => ({
      name: item.hash_name,
      icon: item.asset_description?.icon_url
        ? `https://community.akamai.steamstatic.com/economy/image/${item.asset_description.icon_url}/75fx75f`
        : null,
      lowest_price: item.sale_price_text || null,
    }));

    cache.set(cacheKey, { data: results, ts: Date.now() });
    res.json(results);
  } catch (err) {
    console.error('Search error:', err.message);
    res.json([]);
  }
});

app.get('/health', (req, res) => res.json({ ok: true, cached: cache.size }));

app.listen(PORT, () => console.log(`CS2 price proxy running on :${PORT}`));
