const https = require('https');

// ── Regions ───────────────────────────────────────────────────────────────
// Representative coordinates for the main growing belts. Adjust if you want
// a different reference point (e.g. a specific station) per region.
const REGIONS = [
  { id: 'civ', label: 'Ivory Coast (San Pédro / Soubré)', lat: 5.85,   lon: -6.98 },
  { id: 'gha', label: 'Ghana (Kumasi / Ashanti)',          lat: 6.70,  lon: -1.62 },
  { id: 'mg',  label: 'Minas Gerais (Sul de Minas)',       lat: -21.55, lon: -45.43 },
];

const MN = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const NORMAL_YEARS = 10; // trailing years used to compute the rainfall "normal"

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'pulse-scanner-weather/1.0' } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function fetchJSON(url) {
  return fetchText(url).then(t => {
    try { return JSON.parse(t); } catch (e) { throw new Error('Bad JSON from ' + url); }
  });
}

// ── ENSO (RONI) ───────────────────────────────────────────────────────────
// NOAA CPC replaced ONI with RONI (Relative Oceanic Niño Index) in Feb 2026.
// File format: "SEAS YR ANOM" header, then repeating triplets, whitespace-separated.
async function getEnso() {
  const text = await fetchText('https://www.cpc.ncep.noaa.gov/data/indices/RONI.ascii.txt');
  const tokens = text.trim().split(/\s+/);
  const rows = [];
  for (let i = 3; i + 2 < tokens.length + 1; i += 3) {
    if (!tokens[i]) break;
    rows.push({ seas: tokens[i], yr: tokens[i + 1], anom: parseFloat(tokens[i + 2]) });
  }
  const recent = rows.slice(-8);
  const latest = recent[recent.length - 1];
  const phase = latest.anom >= 0.5 ? 'El Niño' : latest.anom <= -0.5 ? 'La Niña' : 'Neutral';
  return {
    phase,
    value: latest.anom,
    seas: latest.seas,
    yr: latest.yr,
    trend: recent.map(r => ({ seas: r.seas, yr: r.yr, anom: r.anom })),
  };
}

// ── Rainfall (Open-Meteo ERA5 archive — free, no key, works anywhere on earth) ─
async function getRainfall(region) {
  const now = new Date();
  const end = now.toISOString().slice(0, 10);
  const startYear = now.getFullYear() - NORMAL_YEARS;
  const start = `${startYear}-01-01`;
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${region.lat}&longitude=${region.lon}` +
    `&start_date=${start}&end_date=${end}&daily=precipitation_sum&timezone=auto`;

  const d = await fetchJSON(url);
  const times = (d.daily && d.daily.time) || [];
  const precip = (d.daily && d.daily.precipitation_sum) || [];
  const map = {};
  times.forEach((t, i) => { map[t] = precip[i] || 0; });

  // Rolling last-30-days actual
  const last30Actual = times.slice(-30).reduce((s, t) => s + (map[t] || 0), 0);

  // Normal for the same trailing-30-day calendar window, averaged over NORMAL_YEARS prior years
  const endDate = new Date(end + 'T00:00:00Z');
  const yearSums = [];
  for (let y = startYear; y < endDate.getUTCFullYear(); y++) {
    let sum = 0, count = 0;
    for (let i = 0; i < 30; i++) {
      const dcur = new Date(Date.UTC(y, endDate.getUTCMonth(), endDate.getUTCDate()));
      dcur.setUTCDate(dcur.getUTCDate() - i);
      const key = dcur.toISOString().slice(0, 10);
      if (map[key] != null) { sum += map[key]; count++; }
    }
    if (count >= 25) yearSums.push(sum);
  }
  const normal = yearSums.length ? yearSums.reduce((s, v) => s + v, 0) / yearSums.length : null;
  const anomalyPct = normal ? ((last30Actual - normal) / normal * 100) : null;

  // Monthly bars for the last 6 calendar months (incl. current, partial) vs 10yr normal for that month
  const monthlySums = {};
  times.forEach((t, i) => {
    const [y, m] = t.split('-').map(Number);
    const key = y + '-' + String(m).padStart(2, '0');
    monthlySums[key] = (monthlySums[key] || 0) + (precip[i] || 0);
  });
  const monthly = [];
  for (let i = 5; i >= 0; i--) {
    const dt = new Date(Date.UTC(now.getFullYear(), now.getMonth() - i, 1));
    const y = dt.getUTCFullYear(), m = dt.getUTCMonth();
    const key = y + '-' + String(m + 1).padStart(2, '0');
    const actual = monthlySums[key] || 0;
    const vals = [];
    for (let yy = startYear; yy < now.getFullYear(); yy++) {
      const k2 = yy + '-' + String(m + 1).padStart(2, '0');
      if (monthlySums[k2] != null) vals.push(monthlySums[k2]);
    }
    const mNormal = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
    monthly.push({
      label: MN[m] + " '" + String(y).slice(2),
      actual: +actual.toFixed(1),
      normal: mNormal != null ? +mNormal.toFixed(1) : null,
      isCurrent: i === 0,
    });
  }

  return {
    id: region.id,
    label: region.label,
    lat: region.lat,
    lon: region.lon,
    last30Actual: +last30Actual.toFixed(1),
    normal: normal != null ? +normal.toFixed(1) : null,
    anomalyPct: anomalyPct != null ? +anomalyPct.toFixed(1) : null,
    monthly,
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    const [enso, rainfall] = await Promise.all([
      getEnso().catch(e => ({ error: e.message })),
      Promise.all(REGIONS.map(r => getRainfall(r).catch(e => ({ id: r.id, label: r.label, error: e.message })))),
    ]);

    res.status(200).json({
      enso,
      rainfall,
      updated: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
};
