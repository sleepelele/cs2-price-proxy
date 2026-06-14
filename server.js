const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const cache = new Map();
const PRICE_TTL = 5 * 60 * 1000;   // 5 min
const SEARCH_TTL = 30 * 1000;       // 30s
const ICON_TTL = 60 * 60 * 1000;   // 1hr

const delay = ms => new Promise(r => setTimeout(r, ms));

const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };

// Parse a Steam price string like "0,49€", "€0.49", "$0.49" → float
function parsePrice(raw) {
  if (!raw) return null;
  const cleaned = raw.replace(/[^0-9.,]/g, '').replace(',', '.');
  const val = parseFloat(cleaned);
  return isNaN(val) ? null : val;
}

// Fetch price + icon for one item using the search/render endpoint
// This is more reliable than priceoverview as it's the same endpoint used by autocomplete
async function fetchItemData(name) {
  const key = 'price:' + name.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < PRICE_TTL) return { ...hit.data, cached: true };

  // Use search endpoint — search for exact name, take first result
  const url = `https://steamcommunity.com/market/search/render/?appid=730&norender=1&count=1&query=${encodeURIComponent(name)}`;
  const r = await fetch(url, { headers: HEADERS });

  if (r.status === 429) throw new Error('rate_limited');
  const d = await r.json();

  if (!d.success || !d.results || d.results.length === 0) {
    return { name, error: 'not_found' };
  }

  // Find exact match (search may return similar items)
  const match = d.results.find(i => i.hash_name === name) || d.results[0];

  const icon = match.asset_description?.icon_url
    ? `https://community.akamai.steamstatic.com/economy/image/${match.asset_description.icon_url}/75fx75f`
    : null;

  // sale_price is in cents (USD), but sell_price_text has the display string
  // We want EUR — use the priceoverview for EUR conversion on exact name
  // But as fallback, sale_price / 100 gives USD
  const priceText = match.sell_price_text || match.sale_price_text || null;
  const priceUSD = match.sell_price ? match.sell_price / 100 : null;

  // Try to get EUR price via priceoverview (fast, single item)
  let eurPrice = null;
  try {
    const po = await fetch(
      `https://steamcommunity.com/market/priceoverview/?appid=730&currency=3&market_hash_name=${encodeURIComponent(match.hash_name)}`,
      { headers: HEADERS }
    );
    if (po.ok) {
      const pod = await po.json();
      if (pod.success) {
        eurPrice = parsePrice(pod.lowest_price) || parsePrice(pod.median_price);
      }
    }
  } catch {}

  const result = {
    name: match.hash_name,
    lowest_price: eurPrice,         // EUR from priceoverview
    price_usd: priceUSD,            // USD fallback from search
    price_text: priceText,          // display string
    volume: match.sell_listings,
    icon,
  };

  cache.set(key, { data: result, ts: Date.now() });
  return result;
}

// ─── Single price ─────────────────────────────────────────────────────────────
app.get('/price', async (req, res) => {
  const name = req.query.name;
  if (!name) return res.status(400).json({ error: 'Missing name' });
  try {
    const data = await fetchItemData(name);
    res.json(data);
  } catch (err) {
    const status = err.message === 'rate_limited' ? 429 : 500;
    res.status(status).json({ error: err.message });
  }
});

// ─── Batch prices ─────────────────────────────────────────────────────────────
app.post('/prices', async (req, res) => {
  const names = req.body.names;
  if (!Array.isArray(names) || !names.length) return res.status(400).json({ error: 'Need names array' });

  const results = {};
  for (const name of names) {
    try {
      results[name] = await fetchItemData(name);
    } catch (err) {
      if (err.message === 'rate_limited') { results[name] = { error: 'rate_limited' }; break; }
      results[name] = { error: err.message };
    }
    await delay(1500); // safe gap between items
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
    const r = await fetch(url, { headers: HEADERS });
    const d = await r.json();
    if (!d.success || !d.results) return res.json([]);

    const results = d.results.map(item => ({
      name: item.hash_name,
      icon: item.asset_description?.icon_url
        ? `https://community.akamai.steamstatic.com/economy/image/${item.asset_description.icon_url}/75fx75f`
        : null,
      price: item.sell_price_text || null,
    }));

    cache.set(key, { data: results, ts: Date.now() });
    res.json(results);
  } catch {
    res.json([]);
  }
});

// ─── Icons batch ──────────────────────────────────────────────────────────────
app.post('/icons', async (req, res) => {
  const names = req.body.names;
  if (!Array.isArray(names)) return res.status(400).json({ error: 'Need names array' });

  const results = {};
  for (const name of names) {
    const key = 'icon:' + name.toLowerCase();
    const hit = cache.get(key);
    if (hit && Date.now() - hit.ts < ICON_TTL) { results[name] = hit.data; continue; }
    try {
      const url = `https://steamcommunity.com/market/search/render/?appid=730&norender=1&count=1&query=${encodeURIComponent(name)}`;
      const r = await fetch(url, { headers: HEADERS });
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

app.get('/health', (req, res) => res.json({ ok: true, cached: cache.size }));

app.listen(PORT, () => console.log(`Proxy on :${PORT}`));
