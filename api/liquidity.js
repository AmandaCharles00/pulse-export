const https = require('https');

// Fed "net liquidity" = Fed total assets (WALCL) - Treasury General Account (WTREGEN)
// - Overnight reverse repo (RRPONTSYD). Pulled from FRED's public CSV endpoint
// (no API key needed). All values returned in $ billions.
function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'pulse-scanner-liquidity/1.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchText(res.headers.location).then(resolve, reject);
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function series(id, start) {
  const txt = await fetchText('https://fred.stlouisfed.org/graph/fredgraph.csv?id=' + id + '&cosd=' + start);
  const out = [];
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
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
  try {
    const start = new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10);
    const [walcl, tga, rrp] = await Promise.all([series('WALCL', start), series('WTREGEN', start), series('RRPONTSYD', start)]);
    const pts = [];
    walcl.forEach(w => {
      const t = asOf(tga, w.d), r = asOf(rrp, w.d);
      if (t == null) return;
      // WALCL/WTREGEN are in $ millions, RRPONTSYD already in $ billions
      const net = w.v / 1000 - t / 1000 - (r || 0);
      pts.push({ date: w.d, walcl: +(w.v / 1000).toFixed(1), tga: +(t / 1000).toFixed(1), rrp: +(r || 0).toFixed(1), net: +net.toFixed(1) });
    });
    if (pts.length < 15) throw new Error('Not enough FRED data');
    res.status(200).json({ series: pts.slice(-30), updated: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};
