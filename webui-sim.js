require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'indikratos.db'));
db.pragma('journal_mode = WAL');

const app = express();
const PORT = 3030;

app.get('/', (req, res) => {
  const trades = db.prepare('SELECT * FROM sim_trades ORDER BY opened_at DESC').all();
  const openTrades = trades.filter(t => !t.result);
  const closedTrades = trades.filter(t => t.result);

  const totalWin = closedTrades.filter(t => t.result === 'WIN').length;
  const totalLose = closedTrades.filter(t => t.result === 'LOSE').length;
  const totalClosed = totalWin + totalLose;
  const winRate = totalClosed > 0 ? ((totalWin / totalClosed) * 100).toFixed(1) : 0;

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
    SELECT ticker, ROUND(SUM(pnl), 2) as total_pnl, COUNT(*) as total, SUM(CASE WHEN result='WIN' THEN 1 ELSE 0 END) as wins
    FROM sim_trades WHERE result IS NOT NULL GROUP BY ticker ORDER BY total_pnl DESC
  `).all();

  const worstLose = db.prepare(`
    SELECT ticker, timeframe, pnl, opened_at, closed_at FROM sim_trades
    WHERE result='LOSE' ORDER BY pnl ASC LIMIT 1
  `).get();

  const bestWin = db.prepare(`
    SELECT ticker, timeframe, pnl, opened_at, closed_at FROM sim_trades
    WHERE result='WIN' ORDER BY pnl DESC LIMIT 1
  `).get();

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Indikratos - Simulasi Trading</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0d1117; color: #c9d1d9; padding: 20px; }
  h1 { color: #58a6ff; margin-bottom: 8px; }
  h2 { color: #8b949e; font-size: 16px; margin: 24px 0 12px; border-bottom: 1px solid #21262d; padding-bottom: 6px; }
  .stats { display: flex; gap: 12px; flex-wrap: wrap; margin: 16px 0; }
  .stat-card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 14px 20px; min-width: 120px; }
  .stat-card .label { font-size: 11px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.5px; }
  .stat-card .value { font-size: 22px; font-weight: 600; margin-top: 4px; }
  .value.green { color: #3fb950; }
  .value.red { color: #f85149; }
  .value.blue { color: #58a6ff; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { background: #161b22; color: #8b949e; text-align: left; padding: 10px 8px; border-bottom: 1px solid #30363d; font-weight: 500; position: sticky; top: 0; }
  td { padding: 8px; border-bottom: 1px solid #21262d; }
  tr:hover td { background: #1c2128; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; }
  .badge-open { background: #1f6feb22; color: #58a6ff; border: 1px solid #1f6feb66; }
  .badge-win { background: #3fb95022; color: #3fb950; border: 1px solid #3fb95066; }
  .badge-lose { background: #f8514922; color: #f85149; border: 1px solid #f8514966; }
  .pct-green { color: #3fb950; }
  .pct-red { color: #f85149; }
  .section { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 768px) { .grid-2 { grid-template-columns: 1fr; } }
  table.analysis th { font-size: 12px; }
  .highlight-row { background: #1f6feb11; }
  .summary-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin: 12px 0; }
  .summary-card { background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 12px; }
  .summary-card .title { font-size: 11px; color: #8b949e; }
  .summary-card .big { font-size: 18px; font-weight: 600; margin-top: 4px; }
  .scroll-wrap { overflow-x: auto; }
</style>
</head>
<body>
<h1>Indikratos — Simulasi Trading</h1>
<p style="color:#8b949e;margin-bottom:16px;">Monitoring ${openTrades.length} open trade(s) · ${totalClosed} closed (${winRate}% win rate)</p>

<div class="stats">
  <div class="stat-card"><div class="label">Open Trades</div><div class="value blue">${openTrades.length}</div></div>
  <div class="stat-card"><div class="label">Closed Trades</div><div class="value blue">${totalClosed}</div></div>
  <div class="stat-card"><div class="label">Win</div><div class="value green">${totalWin}</div></div>
  <div class="stat-card"><div class="label">Lose</div><div class="value red">${totalLose}</div></div>
  <div class="stat-card"><div class="label">Win Rate</div><div class="value ${winRate >= 50 ? 'green' : 'red'}">${winRate}%</div></div>
</div>

<h2>📊 Analisis Pair</h2>
<div class="section scroll-wrap">
<table class="analysis">
<thead><tr><th>Ticker</th><th>TF</th><th>Total</th><th>Win</th><th>Lose</th><th>Win Rate</th><th>Rata-rata PnL</th><th>Max Win</th><th>Max Lose</th></tr></thead>
<tbody>
${analysis.map(a => `
<tr>
  <td><strong>${a.ticker}</strong></td>
  <td>${a.timeframe}</td>
  <td>${a.total}</td>
  <td class="pct-green">${a.wins}</td>
  <td class="pct-red">${a.loses}</td>
  <td><strong>${a.win_rate}%</strong></td>
  <td class="${a.avg_pnl >= 0 ? 'pct-green' : 'pct-red'}">${a.avg_pnl}%</td>
  <td class="pct-green">${a.max_win_pnl || '-'}%</td>
  <td class="pct-red">${a.max_lose_pnl || '-'}%</td>
</tr>`).join('')}
${analysis.length === 0 ? '<tr><td colspan="9" style="text-align:center;color:#8b949e;">Belum ada trade tertutup</td></tr>' : ''}
</tbody>
</table>
</div>

<h2>🏆 Ringkasan</h2>
<div class="summary-cards">
  <div class="summary-card">
    <div class="title">Ticker Paling Profit (%)</div>
    <div class="big" style="color:#3fb950;">${bestTicker.length ? bestTicker[0].ticker + ' (' + bestTicker[0].total_pnl + '%)' : '-'}</div>
  </div>
  <div class="summary-card">
    <div class="title">Win Rate Tertinggi</div>
    <div class="big" style="color:#58a6ff;">${analysis.length ? analysis[0].ticker + ' ' + analysis[0].timeframe + ' (' + analysis[0].win_rate + '%)' : '-'}</div>
  </div>
  <div class="summary-card">
    <div class="title">Lose Terbesar</div>
    <div class="big" style="color:#f85149;">${worstLose ? worstLose.ticker + ' ' + worstLose.timeframe + ' (' + worstLose.pnl + '%)' : '-'}</div>
  </div>
  <div class="summary-card">
    <div class="title">Win Terbesar</div>
    <div class="big" style="color:#3fb950;">${bestWin ? bestWin.ticker + ' ' + bestWin.timeframe + ' (+' + bestWin.pnl + '%)' : '-'}</div>
  </div>
</div>

<h2>📋 Riwayat Trading</h2>
<div class="section scroll-wrap">
<table>
<thead><tr>
  <th>#</th><th>Ticker</th><th>TF</th><th>Signal</th><th>Entry</th><th>Close</th><th>PnL</th>
  <th>Peak</th><th>SL</th><th>TP 2%</th><th>TP 4%</th><th>Result</th><th>Opened</th><th>Closed</th>
</tr></thead>
<tbody>
${trades.map(t => {
  const pnlColor = t.pnl >= 0 ? 'pct-green' : 'pct-red';
  const peakPctColor = t.peak_pct >= 0 ? 'pct-green' : 'pct-red';
  const badgeClass = !t.result ? 'badge-open' : t.result === 'WIN' ? 'badge-win' : 'badge-lose';
  const badgeText = !t.result ? 'OPEN' : t.result;
  return `<tr>
    <td>${t.id}</td>
    <td><strong>${t.ticker}</strong></td>
    <td>${t.timeframe}</td>
    <td style="font-size:12px;">${t.entry_signal}</td>
    <td>$${t.entry_price.toFixed(t.entry_price < 0.01 ? 8 : 2)}</td>
    <td>${t.close_price ? '$' + t.close_price.toFixed(t.close_price < 0.01 ? 8 : 2) : '-'}</td>
    <td class="${pnlColor}">${t.pnl !== null ? t.pnl + '%' : '-'}</td>
    <td class="${peakPctColor}">${t.peak_pct !== null ? t.peak_pct + '%' : '-'}</td>
    <td>$${t.sl_price.toFixed(t.sl_price < 0.01 ? 8 : 2)}</td>
    <td>${t.tp2_hit ? '✅ $' + t.tp2_hit.toFixed(t.tp2_hit < 0.01 ? 8 : 2) : '❌'}</td>
    <td>${t.tp4_hit ? '✅ $' + t.tp4_hit.toFixed(t.tp4_hit < 0.01 ? 8 : 2) : '❌'}</td>
    <td><span class="badge ${badgeClass}">${badgeText}</span></td>
    <td style="font-size:11px;color:#8b949e;">${t.opened_at}</td>
    <td style="font-size:11px;color:#8b949e;">${t.closed_at || '-'}</td>
  </tr>`;
}).join('')}
${trades.length === 0 ? '<tr><td colspan="14" style="text-align:center;color:#8b949e;">Belum ada trade</td></tr>' : ''}
</tbody>
</table>
</div>

<p style="text-align:center;color:#8b949e;font-size:12px;margin-top:24px;">Indikratos · Simulasi Trading Bot</p>
</body>
</html>`;

  res.send(html);
});

app.listen(PORT, () => console.log(`WebUI sim running on http://localhost:${PORT}`));
