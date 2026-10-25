const https = require('https');

// Fed "net liquidity" = Fed total assets (WALCL) - Treasury General Account (WTREGEN)
// - Overnight reverse repo (RRPONTSYD). Uses the official FRED API when the
// FRED_API_KEY environment variable is set, otherwise the public CSV link.
// Returns one point per day, all values in $ billions.
let LAST_GOOD = null;

function fetchText(url, tries = 2) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'pulse-scanner-liquidity/1.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchText(res.headers.location, tries).then(resolve, reject);
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.setTimeout(3000, () => req.destroy(new Error('timeout')));
    req.on('error', e => {
      if (tries > 1) setTimeout(() => fetchText(url, tries - 1).then(resolve, reject), 200);
      else reject(e);
    });
  });
}

async function series(id, start) {
  const key = process.env.FRED_API_KEY;
  const out = [];
  if (key) {
    const txt = await fetchText('https://api.stlouisfed.org/fred/series/observations?series_id=' + id +
      '&api_key=' + key + '&file_type=json&observation_start=' + start);
    const j = JSON.parse(txt);
    if (!j.observations) throw new Error('FRED API: ' + (j.error_message || 'bad response'));
    j.observations.forEach(o => {
      const n = parseFloat(o.value);
      if (o.date && isFinite(n)) out.push({ d: o.date, v: n });
    });
    return out;
  }
  const txt = await fetchText('https://fred.stlouisfed.org/graph/fredgraph.csv?id=' + id + '&cosd=' + start);
  txt.trim().split(/\r?\n/).slice(1).forEach(line => {
    const [d, v] = line.split(',');
    const n = parseFloat(v);
    if (d && isFinite(n)) out.push({ d, v: n });
  });
  return out;
}

// latest value on or before date d (arr sorted asc)
function asOf(arr, d) {
  let r = null;
  for (const x of arr) { if (x.d <= d) r = x.v; else break; }
  return r;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const usingKey = !!process.env.FRED_API_KEY;
  try {
    const start = new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10);
    // one at a time keeps us inside Vercel's 10s limit even with retries
    const walcl = await series('WALCL', start);
    const tga = await series('WTREGEN', start);
    const rrp = await series('RRPONTSYD', start);
    // Extra macro series (credit spread, VIX, 10Y yield, 2s10s). Only with the API key,
    // fetched in parallel, and never allowed to break the liquidity result.
    let extra = null;
    if (usingKey) {
      const grab = id => series(id, start).then(a => a.slice(-130).map(o => ({ d: o.d, v: o.v }))).catch(() => null);
      const [hy, vix, y10, curve] = await Promise.all([grab('BAMLH0A0HYM2'), grab('VIXCLS'), grab('DGS10'), grab('T10Y2Y')]);
      extra = {};
      if (hy) extra.hy = hy;
      if (vix) extra.vix = vix;
      if (y10) extra.y10 = y10;
      if (curve) extra.curve = curve;
    }
    const pts = [];
    rrp.forEach(r => {
      const w = asOf(walcl, r.d), t = asOf(tga, r.d);
      if (w == null || t == null) return;
      // WALCL/WTREGEN are in $ millions, RRPONTSYD already in $ billions
      const net = w / 1000 - t / 1000 - r.v;
      pts.push({ date: r.d, walcl: +(w / 1000).toFixed(1), tga: +(t / 1000).toFixed(1), rrp: +r.v.toFixed(1), net: +net.toFixed(1) });
    });
    if (pts.length < 75) throw new Error('Not enough FRED data');
    LAST_GOOD = { series: pts.slice(-90), extra, updated: new Date().toISOString(), source: usingKey ? 'fred-api' : 'fred-csv' };
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    res.status(200).json(LAST_GOOD);
  } catch (e) {
    if (LAST_GOOD) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json(Object.assign({ stale: true }, LAST_GOOD));
    }
    res.setHeader('Cache-Control', 'no-store');
    res.status(500).json({
      error: String(e.message || e),
      usingApiKey: usingKey,
      hint: usingKey ? 'FRED API key is set but the request failed; retry in a moment.' : 'FRED_API_KEY is NOT set in Vercel; the public FRED link is unreliable. Add the key under Settings > Environment Variables and redeploy.'
    });
  }
};
