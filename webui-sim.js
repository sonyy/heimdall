require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'indikratos.db'));
db.pragma('journal_mode = WAL');

const app = express();
const PORT = 3030;

function getData() {
  const trades = db.prepare('SELECT * FROM sim_trades ORDER BY opened_at DESC').all();
  const openTrades = trades.filter(t => !t.result);
  const closedTrades = trades.filter(t => t.result);

  const totalWin = closedTrades.filter(t => t.result === 'WIN').length;
  const totalLose = closedTrades.filter(t => t.result === 'LOSE').length;
  const totalClosed = totalWin + totalLose;
  const winRate = totalClosed > 0 ? ((totalWin / totalClosed) * 100).toFixed(1) : 0;
  const totalPnl = closedTrades.reduce((sum, t) => sum + parseFloat(t.pnl || 0), 0).toFixed(2);

  const cfg = {};
  for (const r of db.prepare('SELECT key, value FROM config WHERE key IN (\'slPercent\',\'tp1Percent\',\'tp2Percent\')').all()) {
    cfg[r.key] = r.value;
  }

  const analysis = db.prepare(`
    SELECT ticker, timeframe,
      COUNT(*) as total,
      SUM(CASE WHEN result='WIN' THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN result='LOSE' THEN 1 ELSE 0 END) as loses,
      ROUND(AVG(CASE WHEN result IS NOT NULL THEN pnl ELSE NULL END), 2) as avg_pnl,
      ROUND(MAX(CASE WHEN result='WIN' THEN pnl ELSE NULL END), 2) as max_win_pnl,
      ROUND(MIN(CASE WHEN result='LOSE' THEN pnl ELSE NULL END), 2) as max_lose_pnl,
      ROUND(SUM(CASE WHEN result='WIN' THEN 1 ELSE 0 END) * 100.0 / MAX(COUNT(*), 1), 1) as win_rate
    FROM sim_trades
    WHERE result IS NOT NULL
    GROUP BY ticker, timeframe
    ORDER BY win_rate DESC
  `).all();

  const bestTicker = db.prepare(`
    SELECT ticker, timeframe, ROUND(SUM(pnl), 2) as total_pnl, COUNT(*) as total, SUM(CASE WHEN result='WIN' THEN 1 ELSE 0 END) as wins
    FROM sim_trades WHERE result IS NOT NULL GROUP BY ticker, timeframe ORDER BY total_pnl DESC
  `).all();

  const worstLose = db.prepare(`
    SELECT ticker, timeframe, pnl, opened_at, closed_at FROM sim_trades
    WHERE result='LOSE' ORDER BY pnl ASC LIMIT 3
  `).all();

  const bestWin = db.prepare(`
    SELECT ticker, timeframe, pnl, opened_at, closed_at FROM sim_trades
    WHERE result='WIN' ORDER BY pnl DESC LIMIT 3
  `).all();

  const pollIntervalMs = (db.prepare("SELECT value FROM config WHERE key='pollIntervalMs'").get() || {}).value || 30000;

  return { trades, openTrades, closedTrades, totalWin, totalLose, totalClosed, winRate, totalPnl, cfg, analysis, bestTicker, worstLose, bestWin, pollIntervalMs: Number(pollIntervalMs) };
}

app.get('/api/data', (req, res) => res.json(getData()));

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>indikratos — sim v1.0</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Courier New', 'Consolas', 'Lucida Console', monospace; background: #000; color: #e0e0e0; padding: 12px; font-size: 14px; line-height: 1.4; }
  h1 { color: #fff; font-size: 16px; text-transform: uppercase; margin-bottom: 4px; }
  h2 { color: #888; font-size: 13px; margin: 16px 0 8px; border-bottom: 1px solid #333; padding-bottom: 4px; text-transform: uppercase; }
  .stats { display: flex; gap: 8px; flex-wrap: wrap; margin: 8px 0; }
  .stat-card { background: #0a0a0a; border: 1px solid #333; padding: 6px 12px; }
  .stat-card .label { font-size: 10px; color: #888; text-transform: uppercase; }
  .stat-card .value { font-size: 18px; font-weight: 700; margin-top: 2px; }
  .value.green { color: #0f0; } .value.red { color: #f00; } .value.blue { color: #888; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { background: #0a0a0a; color: #888; text-align: left; padding: 6px 8px; border-bottom: 1px solid #333; font-weight: 700; position: sticky; top: 0; }
  td { padding: 4px 8px; border-bottom: 1px solid #1a1a1a; }
  tr:hover td { background: #111; }
  .badge { display: inline-block; padding: 1px 6px; font-size: 10px; font-weight: 700; border: 1px solid #333; }
  .badge-open { color: #888; border-color: #555; }
  .badge-win { color: #0f0; border-color: #0f0; }
  .badge-lose { color: #f00; border-color: #f00; }
  .pct-green { color: #0f0; } .pct-red { color: #f00; }
  .section { background: #0a0a0a; border: 1px solid #333; padding: 12px; margin-bottom: 12px; }
  .summary-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px; margin: 8px 0; }
  .summary-card { background: #0a0a0a; border: 1px solid #333; padding: 8px 12px; }
  .summary-card .title { font-size: 10px; color: #888; text-transform: uppercase; }
  .summary-card .big { font-size: 16px; font-weight: 700; margin-top: 2px; }
  .scroll-wrap { overflow-x: auto; }
  .loading { text-align: center; padding: 40px; color: #888; }
</style>
</head>
<body>
<h1>indikratos — simulasi trading</h1>
<div class="stats" id="stats-bar"></div>

<h2># Ringkasan</h2>
<div class="summary-cards" id="summary-cards"></div>

<h2># Analisis Pair</h2>
<div class="section scroll-wrap"><table class="analysis"><thead><tr><th>Ticker</th><th>TF</th><th>Total</th><th>Win</th><th>Lose</th><th>Win Rate</th><th>Rata-rata PnL</th><th>Max Win</th><th>Max Lose</th></tr></thead><tbody id="analysis-body"></tbody></table></div>

<h2># Riwayat Trading</h2>
<div class="section scroll-wrap"><table><thead><tr>
  <th>#</th><th>Ticker</th><th>TF</th><th>Signal</th><th>Entry</th><th>Close</th><th>PnL</th>
  <th>Peak</th><th>Low</th><th>SL</th><th>TP1</th><th>TP2</th><th>Result</th><th>Opened</th><th>Closed</th>
</tr></thead><tbody id="trades-body"></tbody></table></div>

<p style="text-align:center;color:#555;font-size:11px;margin-top:20px;">[indikratos sim v1.0]</p>

<script>
function fmt(n) { if (n === null || n === undefined) return '-'; const v = parseFloat(n); return v < 0.01 && v > -0.01 ? v.toFixed(8) : v.toFixed(2); }
function pctCls(v) { return v >= 0 ? 'pct-green' : 'pct-red'; }
function badgeCls(r) { return !r ? 'badge-open' : r === 'WIN' ? 'badge-win' : 'badge-lose'; }

function render(d) {
  var sl = d.cfg.slPercent || '-2', tp1 = d.cfg.tp1Percent || '2', tp2 = d.cfg.tp2Percent || '4';
  document.getElementById('stats-bar').innerHTML = [
    { label: 'Open / Close', val: d.openTrades.length + ' / ' + d.totalClosed, cls: 'blue' },
    { label: 'W / L / WR', val: d.totalWin + ' / ' + d.totalLose + ' / ' + d.winRate + '%', cls: d.winRate >= 50 ? 'green' : 'red' },
    { label: 'Total PnL', val: d.totalPnl + '%', cls: d.totalPnl >= 0 ? 'green' : 'red' },
    { label: 'SL / TP1 / TP2', val: '<span class="pct-red">' + sl + '%</span> / <span class="pct-green">' + tp1 + '%</span> / <span class="pct-green">' + tp2 + '%</span>', cls: '' },
  ].map(s => '<div class="stat-card"><div class="label">' + s.label + '</div><div class="value ' + s.cls + '">' + s.val + '</div></div>').join('');

  var analysisHtml = d.analysis.map(a =>
    '<tr><td><strong>' + a.ticker + '</strong></td><td>' + a.timeframe + '</td><td>' + a.total + '</td>'
    + '<td class="pct-green">' + a.wins + '</td><td class="pct-red">' + a.loses + '</td>'
    + '<td><strong>' + a.win_rate + '%</strong></td>'
    + '<td class="' + pctCls(a.avg_pnl) + '">' + a.avg_pnl + '%</td>'
    + '<td class="pct-green">' + (a.max_win_pnl || '-') + '%</td>'
    + '<td class="pct-red">' + (a.max_lose_pnl || '-') + '%</td></tr>'
  ).join('');
  if (!d.analysis.length) analysisHtml = '<tr><td colspan="9" style="text-align:center;color:#8b949e;">Belum ada trade tertutup</td></tr>';
  document.getElementById('analysis-body').innerHTML = analysisHtml;

  function top3(list, fmt) {
    if (!list || !list.length) return '-';
    return list.slice(0, 3).map(fmt).join('<br>');
  }
  document.getElementById('summary-cards').innerHTML = [
    { title: 'Profit Paling Besar', val: top3(d.bestTicker, function(t) { return t.ticker + ' ' + t.timeframe + ' <span class=\"pct-green\">' + t.total_pnl + '%</span>'; }), cls: '#0f0' },
    { title: 'Win Rate Tertinggi', val: top3(d.analysis, function(a) { return a.ticker + ' ' + a.timeframe + ' <span class=\"pct-green\">' + a.win_rate + '%</span>'; }), cls: '#0f0' },
    { title: 'Lose Terbesar', val: top3(d.worstLose, function(l) { return l.ticker + ' ' + l.timeframe + ' <span class=\"pct-red\">' + l.pnl + '%</span>'; }), cls: '#f00' },
    { title: 'Win Terbesar', val: top3(d.bestWin, function(w) { return w.ticker + ' ' + w.timeframe + ' <span class=\"pct-green\">+' + w.pnl + '%</span>'; }), cls: '#0f0' },
  ].map(function(s) {
    return '<div class="summary-card"><div class="title">' + s.title + '</div><div style="font-size:13px;line-height:1.6;margin-top:4px;color:' + s.cls + '">' + s.val + '</div></div>';
  }).join('');

  var tradesHtml = d.trades.map(function(t) {
    return '<tr><td>' + t.id + '</td><td><strong>' + t.ticker + '</strong></td><td>' + t.timeframe + '</td>'
      + '<td style="font-size:12px;">' + t.entry_signal + '</td>'
      + '<td>$' + fmt(t.entry_price) + '</td>'
      + '<td>' + (t.close_price ? '$' + fmt(t.close_price) : '-') + '</td>'
      + '<td class="' + pctCls(t.pnl) + '">' + (t.pnl !== null ? t.pnl + '%' : '-') + '</td>'
      + '<td class="' + pctCls(t.peak_pct) + '">' + (t.peak_pct !== null ? t.peak_pct + '%' : '-') + '</td>'
      + '<td class="' + pctCls(t.low_pct) + '">' + (t.low_pct !== null ? t.low_pct + '%' : '-') + '</td>'
      + '<td class="pct-red">$' + fmt(t.sl_price) + '</td>'
      + '<td class="' + (t.tp2_hit ? 'pct-green' : '') + '">' + (t.tp2_hit ? '✅ $' + fmt(t.tp2_hit) : '❌') + '</td>'
      + '<td class="' + (t.tp4_hit ? 'pct-green' : '') + '">' + (t.tp4_hit ? '✅ $' + fmt(t.tp4_hit) : '❌') + '</td>'
      + '<td><span class="badge ' + badgeCls(t.result) + '">' + (t.result || 'OPEN') + '</span></td>'
      + '<td style="font-size:11px;color:#8b949e;">' + t.opened_at + '</td>'
      + '<td style="font-size:11px;color:#8b949e;">' + (t.closed_at || '-') + '</td></tr>';
  }).join('');
  if (!d.trades.length) tradesHtml = '<tr><td colspan="15" style="text-align:center;color:#8b949e;">Belum ada trade</td></tr>';
  document.getElementById('trades-body').innerHTML = tradesHtml;
}

var pollTimer;
function fetchData() {
  fetch('/api/data').then(function(r) { return r.json(); }).then(function(d) {
    render(d);
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(fetchData, d.pollIntervalMs || 30000);
  }).catch(function(e) { console.error(e); });
}

fetchData();
</script>
</body>
</html>`);
});

app.listen(PORT, () => console.log(`WebUI sim running on http://localhost:${PORT}`));
