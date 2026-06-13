 const https = require('https');

const SUPA_URL = 'bmeqpzytgedymtkwtnis.supabase.co';
const SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJtZXFwenl0Z2VkeW10a3d0bmlzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc2MTI4OTAsImV4cCI6MjA5MzE4ODg5MH0.z0zXbMZd1zTXQuKYV2-yRhAzFmoqPhGp8r025KCdC5M';

function supaGet(path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: SUPA_URL, path, method: 'GET',
      headers: {'apikey': SUPA_KEY, 'Authorization': `Bearer ${SUPA_KEY}`, 'Range': '0-4999', 'Range-Unit': 'items'}
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve([]); } });
    });
    req.on('error', reject);
    req.end();
  });
}

function computeTrend(atrs) {
  const n = atrs.length;
  if (n < 3) return '→ Stable';
  const xs = Array.from({length: n}, (_, i) => i);
  const mx = xs.reduce((s,x) => s+x, 0) / n;
  const my = atrs.reduce((s,y) => s+y, 0) / n;
  const num = xs.reduce((s,x,i) => s + (x-mx)*(atrs[i]-my), 0);
  const den = xs.reduce((s,x) => s + (x-mx)**2, 0);
  const slope = den > 0 ? num/den : 0;
  const meanAbs = atrs.reduce((s,a) => s+Math.abs(a), 0) / n;
  const norm = meanAbs > 0 ? slope/meanAbs : 0;
  if (norm > 0.08) return '↑ Escalating';
  if (norm < -0.08) return '↓ Fading';
  return '→ Stable';
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    const ExcelJS = require('exceljs');
    const MN = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const now = new Date();
    const y = now.getFullYear(), m = now.getMonth();

    const buckets = [{from: new Date(y,m,1).toISOString(), to: now.toISOString()}];
    for (let i = 1; i <= 12; i++)
      buckets.push({from: new Date(y,m-i,1).toISOString(), to: new Date(y,m-i+1,1).toISOString()});

    const allRecords = (await Promise.all(buckets.map(bk =>
      supaGet(`/rest/v1/extension_history?select=ticker,theme,atr_ma,captured_at&captured_at=gte.${encodeURIComponent(bk.from)}&captured_at=lt.${encodeURIComponent(bk.to)}&order=captured_at.desc`)
        .catch(() => [])
    ))).flat();

    const tickerMap = {};
    allRecords.forEach(r => {
      const d = new Date(r.captured_at);
      const mk = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      const ls = `${d.getMonth()+1}/${d.getDate()}/${String(d.getFullYear()).slice(2)}`;
      const atr = parseFloat(r.atr_ma);
      if (!tickerMap[r.ticker]) tickerMap[r.ticker] = {theme: r.theme, months: {}};
      const ex = tickerMap[r.ticker].months[mk];
      if (!ex || Math.abs(atr) > Math.abs(ex.atr)) tickerMap[r.ticker].months[mk] = {ls, atr};
    });

    const monthKeys = [...new Set(allRecords.map(r => {
      const d = new Date(r.captured_at);
      return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    }))].sort();
    const monthLabel = mk => { const [yr,mo] = mk.split('-'); return `${MN[parseInt(mo)-1]} ${yr}`; };

    const qualified = Object.entries(tickerMap)
      .filter(([,v]) => Object.keys(v.months).length >= 3)
      .map(([ticker, v]) => {
        const entries = Object.entries(v.months).sort((a,b) => a[0].localeCompare(b[0]));
        const atrs = entries.map(([,m]) => m.atr);
        const above = atrs.filter(a => a > 0).length;
        const total = atrs.length;
        const direction = above >= total-above ? 'Above MA' : 'Below MA';
        const consistency = Math.round((above >= total-above ? above : total-above) / total * 100);
        return {ticker, theme: v.theme, appearances: total, direction, consistency, trend: computeTrend(atrs), months: v.months};
      })
      .sort((a,b) => b.appearances - a.appearances);

    const escalating = qualified.filter(t => t.trend.includes('Escalating')).length;
    const fading = qualified.filter(t => t.trend.includes('Fading')).length;
    const aboveCt = qualified.filter(t => t.direction === 'Above MA').length;
    const belowCt = qualified.filter(t => t.direction === 'Below MA').length;

    const wb = new ExcelJS.Workbook();

    // Colors
    const BG='0D0F14', BG2='12151C', BG3='181C26', HEADER_BG='1E2330';
    const TEXT='CDD6E8', TEXT2='6B7A90';
    const GREEN='00C97A', GREEN_DIM='003D25';
    const RED='FF3D55', RED_DIM='4D0010';
    const BLUE='2D8CFF', BLUE_DIM='0A2A4D';
    const AMBER='F5A623', WHITE='FFFFFF';

    function bg(hex) { return {type:'pattern', pattern:'solid', fgColor:{argb:'FF'+hex}}; }
    function atrFill(val) {
      if (val == null) return bg(BG3);
      if (val >= 6)  return bg('003D25');
      if (val >= 3)  return bg('003D25');
      if (val <= -6) return bg('4D0010');
      if (val <= -3) return bg('4D0010');
      return bg(BG3);
    }
    function atrColor(val) {
      if (val == null) return TEXT2;
      if (val >= 6)  return '00FF9D';
      if (val >= 3)  return GREEN;
      if (val <= -6) return 'FF6B7A';
      if (val <= -3) return RED;
      return TEXT2;
    }

    // ── ABOUT SHEET ──────────────────────────────────────────────────────────
    const ws1 = wb.addWorksheet('About This Report');
    ws1.views = [{showGridLines: false}];
    ws1.getColumn('A').width = 3;
    ws1.getColumn('B').width = 58;
    for (let i = 3; i <= 10; i++) ws1.getColumn(i).width = 14;

    const setBg = (row) => {
      for (let c = 1; c <= 10; c++)
        ws1.getCell(row, c).fill = bg(BG);
    };
    for (let r = 1; r <= 65; r++) setBg(r);

    // Title
    ws1.getRow(2).height = 40;
    ws1.mergeCells('B2:J2');
    const t = ws1.getCell('B2');
    t.value = 'PULSE SCANNER — Extension Recurrence Report';
    t.font = {name:'Arial', size:18, bold:true, color:{argb:'FF'+WHITE}};
    t.fill = bg(BG); t.alignment = {vertical:'middle'};

    ws1.mergeCells('B3:J3');
    const s = ws1.getCell('B3');
    s.value = 'Tickers appearing 3+ times on the ATR/50MA Extension Scanner';
    s.font = {name:'Arial', size:11, color:{argb:'FF'+TEXT2}};
    s.fill = bg(BG); s.alignment = {vertical:'middle'};

    ws1.getRow(4).height = 5;
    for (let c = 2; c <= 10; c++) { ws1.getCell(4,c).fill = bg(BLUE); }

    ws1.getRow(5).height = 8;

    // Stats
    ws1.getRow(6).height = 28;
    ws1.getRow(7).height = 18;
    const stats = [
      [`${qualified.length} Tickers`, 'Appearing 3+ months'],
      [`${monthLabel(monthKeys[0])} — ${monthLabel(monthKeys[monthKeys.length-1])}`, 'Date Range'],
      [`${aboveCt} Above / ${belowCt} Below`, 'Direction Split'],
      [`${escalating} Escalating / ${fading} Fading`, 'Trend Split'],
    ];
    stats.forEach(([val, lbl], i) => {
      const col = 2 + i*2;
      ws1.mergeCells(6, col, 6, col+1);
      ws1.mergeCells(7, col, 7, col+1);
      const vc = ws1.getCell(6, col);
      vc.value = val; vc.font = {name:'Arial', size:12, bold:true, color:{argb:'FF'+BLUE}};
      vc.fill = bg(BG2); vc.alignment = {horizontal:'center', vertical:'middle'};
      const lc = ws1.getCell(7, col);
      lc.value = lbl; lc.font = {name:'Arial', size:9, color:{argb:'FF'+TEXT2}};
      lc.fill = bg(BG2); lc.alignment = {horizontal:'center', vertical:'middle'};
    });

    let r1 = 9;
    function secHeader(text) {
      ws1.getRow(r1).height = 10; r1++;
      ws1.getRow(r1).height = 22;
      ws1.mergeCells(r1, 2, r1, 10);
      const c = ws1.getCell(r1, 2);
      c.value = text; c.font = {name:'Arial', size:10, bold:true, color:{argb:'FF'+AMBER}};
      c.fill = bg(BG); c.alignment = {vertical:'middle'}; r1++;
    }
    function bullet(text, sub=false) {
      ws1.getRow(r1).height = 20;
      ws1.mergeCells(r1, 2, r1, 10);
      const c = ws1.getCell(r1, 2);
      c.value = (sub ? '       ' : '▸  ') + text;
      c.font = {name:'Arial', size:10, color:{argb:'FF'+(sub?TEXT2:TEXT)}};
      c.fill = bg(BG); c.alignment = {vertical:'middle', wrapText:true}; r1++;
    }
    function useRow(num, title, desc) {
      ws1.getRow(r1).height = 18;
      ws1.mergeCells(r1, 2, r1, 10);
      const tc = ws1.getCell(r1, 2);
      tc.value = `  ${num}.  ${title}`; tc.font = {name:'Arial', size:10, bold:true, color:{argb:'FF'+GREEN}};
      tc.fill = bg(BG2); tc.alignment = {vertical:'middle'}; r1++;
      ws1.getRow(r1).height = 26;
      ws1.mergeCells(r1, 2, r1, 10);
      const dc = ws1.getCell(r1, 2);
      dc.value = '       ' + desc; dc.font = {name:'Arial', size:10, color:{argb:'FF'+TEXT}};
      dc.fill = bg(BG2); dc.alignment = {vertical:'middle', wrapText:true}; r1++;
    }

    secHeader('COLUMNS EXPLAINED');
    bullet('Appearances — Number of distinct months the ticker was 3x+ ATR from its 50MA.');
    bullet('Direction — Dominant direction: Above MA (bullish extension) or Below MA (bearish/oversold).');
    bullet('Consistency % — What % of appearances were in the dominant direction. 100% = always same way.');
    bullet('Trend — Is the extension magnitude growing or shrinking over time?');
    bullet('↑ Escalating = recent months show stronger extensions than earlier months.', true);
    bullet('↓ Fading = extensions getting smaller — possible trend exhaustion or mean reversion.', true);
    bullet('→ Stable = consistent magnitude with no clear directional change.', true);
    bullet('Peak ATR/50MA — Most extreme reading that month. Positive = above 50MA. Negative = below.');

    secHeader('PRACTICAL TRADING USES');
    const uses = [
      ['Mean Reversion Setups', 'If a ticker has gone -5x below its 50MA 8 of 13 months and just hit -4x again, you have historical precedent it recovers. Pattern-match against its own behavior, not intuition.'],
      ['Avoid Fighting the Trend', 'A name extending above its 50MA 11 months in a row is not a short. Knowing its history prevents you from fading a freight train.'],
      ['Sector Rotation Timing', 'When Gold names cluster in the same months, that confirms a macro move. If they cluster again, you have a roadmap for what follows.'],
      ['Position Sizing', 'Names hitting 6-8x ATR extensions regularly have a wider normal range. Size them smaller to keep risk consistent.'],
      ['Watchlist Prioritization', 'You already know which names are historically active — no need to scan 600+ tickers cold every session.'],
      ['Re-Entry Candidates', 'Names that appeared, disappeared 2-3 months, then reappeared are often the best setups — reset near MA then re-extended.'],
      ['Escalating Names to Watch', 'Tickers marked Escalating are extending further over time — momentum is building. High-conviction trend candidates.'],
      ['Fading Names for Exits', 'Tickers marked Fading show weaker extensions recently. If holding based on extension, this signals the move may be exhausting.'],
    ];
    uses.forEach(([title, desc], i) => useRow(i+1, title, desc));

    secHeader('HOW TO READ THE DATA TAB');
    bullet('Sort by Appearances (desc) to find the most chronically active tickers.');
    bullet('Sort by Consistency % to separate pure directional names from oscillators.');
    bullet('Sort by Trend to find Escalating names building momentum right now.');
    bullet('Empty ATR cells = ticker was within 3x ATR of 50MA that month (not extended).');
    bullet('A gap between two populated months = potential re-entry setup after a reset.');
    bullet('Negative ATR values = below 50MA. Positive = above. Bold = 5x+ extension.');

    // ── DATA SHEET ────────────────────────────────────────────────────────────
    const ws2 = wb.addWorksheet('Extension Recurrence');
    ws2.views = [{showGridLines: false, state:'frozen', xSplit:6, ySplit:2}];
    ws2.autoFilter = {
      from: {row: 2, column: 1},
      to: {row: 2, column: 6 + monthKeys.length*2}
    };

    const FIXED = 6;
    ws2.getColumn(1).width = 9;
    ws2.getColumn(2).width = 26;
    ws2.getColumn(3).width = 13;
    ws2.getColumn(4).width = 12;
    ws2.getColumn(5).width = 14;
    ws2.getColumn(6).width = 14;
    monthKeys.forEach((mk, i) => {
      ws2.getColumn(FIXED+1+i*2).width = 11;
      ws2.getColumn(FIXED+2+i*2).width = 12;
    });

    // Row 1: fixed headers (merged 1-2) + month headers
    ws2.getRow(1).height = 22;
    ws2.getRow(2).height = 18;

    ['TICKER','THEME','APPEARANCES','DIRECTION','CONSISTENCY %','TREND'].forEach((lbl, i) => {
      ws2.mergeCells(1, i+1, 2, i+1);
      const c = ws2.getCell(1, i+1);
      c.value = lbl; c.font = {name:'Arial', size:8, bold:true, color:{argb:'FF'+TEXT2}};
      c.fill = bg(HEADER_BG); c.alignment = {horizontal:'center', vertical:'middle', wrapText:true};
    });

    monthKeys.forEach((mk, i) => {
      const col = FIXED+1+i*2;
      ws2.mergeCells(1, col, 1, col+1);
      const hc = ws2.getCell(1, col);
      hc.value = monthLabel(mk);
      hc.font = {name:'Arial', size:9, bold:true, color:{argb:'FF'+WHITE}};
      hc.fill = bg(BLUE_DIM); hc.alignment = {horizontal:'center', vertical:'middle'};
      ['Last Seen','Peak ATR/50MA'].forEach((lbl, j) => {
        const sc = ws2.getCell(2, col+j);
        sc.value = lbl; sc.font = {name:'Arial', size:8, color:{argb:'FF'+TEXT2}};
        sc.fill = bg(HEADER_BG); sc.alignment = {horizontal:'center', vertical:'middle'};
      });
    });

    qualified.forEach((t, ri) => {
      const row = ri + 3;
      ws2.getRow(row).height = 17;
      const even = ri % 2 === 0;
      const rowBg = even ? BG : BG2;

      const setCell = (col, val, opts={}) => {
        const c = ws2.getCell(row, col);
        c.value = val;
        c.font = {name:'Arial', size: opts.size||10, bold: opts.bold||false, color:{argb:'FF'+(opts.color||TEXT)}};
        c.fill = bg(opts.bg||rowBg);
        c.alignment = {horizontal: opts.align||'left', vertical:'middle'};
        if (opts.numFmt) c.numFmt = opts.numFmt;
      };

      setCell(1, t.ticker, {color:BLUE, bold:true});
      setCell(2, t.theme, {size:9});
      setCell(3, t.appearances, {color:AMBER, bold:true, align:'center'});
      setCell(4, t.direction, {color: t.direction==='Above MA'?GREEN:RED, bold:true, align:'center', size:9});
      setCell(5, t.consistency, {
        color: t.consistency>=80?GREEN:t.consistency>=60?AMBER:TEXT2, bold:true, align:'center',
        numFmt: '0"%"'
      });
      const trendColor = t.trend.includes('Escalating')?GREEN:t.trend.includes('Fading')?RED:AMBER;
      setCell(6, t.trend, {color:trendColor, bold:true, align:'center', size:9});

      monthKeys.forEach((mk, i) => {
        const col = FIXED+1+i*2;
        const mo = t.months[mk];
        const lsCell = ws2.getCell(row, col);
        lsCell.fill = bg(rowBg);
        if (mo) {
          lsCell.value = mo.ls;
          lsCell.font = {name:'Arial', size:9, color:{argb:'FF'+TEXT2}};
          lsCell.alignment = {horizontal:'center', vertical:'middle'};
        }
        const atrCell = ws2.getCell(row, col+1);
        if (mo) {
          atrCell.value = Math.round(mo.atr * 100) / 100;
          const ac = atrColor(mo.atr);
          atrCell.font = {name:'Arial', size:10, bold:Math.abs(mo.atr)>=5, color:{argb:'FF'+ac}};
          atrCell.fill = atrFill(mo.atr);
          atrCell.alignment = {horizontal:'center', vertical:'middle'};
          atrCell.numFmt = '+0.00;-0.00;0.00';
        } else {
          atrCell.fill = bg(rowBg);
        }
      });
    });

    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="extension_recurrence.xlsx"');
    res.status(200).send(Buffer.from(buf));

  } catch(err) {
    res.status(500).json({error: err.message, stack: err.stack});
  }
};
