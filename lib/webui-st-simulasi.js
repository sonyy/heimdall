const { db } = require('../lib/db');

module.exports = function renderStSimulasi() {
  const trades = db.prepare('SELECT * FROM sim_trades ORDER BY opened_at DESC').all();
  const openTrades = trades.filter(t => !t.result);
  const closedTrades = trades.filter(t => t.result);

  const totalWin = closedTrades.filter(t => t.result === 'WIN').length;
  const totalLose = closedTrades.filter(t => t.result === 'LOSE').length;
  const totalClosed = totalWin + totalLose;
  const closedPnlSum = closedTrades.reduce((s, t) => s + parseFloat(t.pnl || 0), 0);
  const totalPnl = closedPnlSum.toFixed(2);
  const winRate = totalClosed > 0 ? ((totalWin / totalClosed) * 100).toFixed(1) : '0.0';
  const avgPnl = totalClosed > 0 ? (closedPnlSum / totalClosed).toFixed(2) : '0.00';

  const cfg = {};
  for (const r of db.prepare("SELECT key, value FROM config WHERE key IN ('st_slPercent','st_tp1Percent','st_tp2Percent','st_running')").all()) {
    cfg[r.key] = r.value;
  }

  const analysis = db.prepare(`
    SELECT ticker,
      COUNT(*) as total,
      SUM(CASE WHEN result='WIN' THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN result='LOSE' THEN 1 ELSE 0 END) as loses,
      ROUND(AVG(CASE WHEN result IS NOT NULL THEN pnl ELSE NULL END), 2) as avg_pnl,
      ROUND(SUM(CASE WHEN result='WIN' THEN 1 ELSE 0 END) * 100.0 / MAX(COUNT(*), 1), 1) as win_rate
    FROM sim_trades
    WHERE result IS NOT NULL
    GROUP BY ticker
    ORDER BY win_rate DESC
  `).all();

  const stRunning = cfg.st_running !== '0';
  const sl = cfg.st_slPercent || '-2';
  const tp1 = cfg.st_tp1Percent || '2';
  const tp2 = cfg.st_tp2Percent || '4';

  const fmt = (n) => {
    if (n === null || n === undefined) return '-';
    return parseFloat(n).toFixed(2);
  };

  const pnlCls = (v) => {
    if (v === null || v === undefined) return '';
    return parseFloat(v) >= 0 ? 'pos' : 'neg';
  };

  const badgeCls = (r) => {
    if (!r) return 'badge-open';
    return r === 'WIN' ? 'badge-win' : 'badge-lose';
  };

  const fmtDate = (s) => s ? s.slice(0, 16).replace('T', ' ') : '-';

  return `
<style>
  .stats-bar { background: #1a1a1a; padding: 8px; margin-bottom: 8px; display: flex; gap: 8px; flex-wrap: wrap; font-family: 'Courier New', monospace; }
  .stats-bar .item { font-size: 12px; margin-right: 16px; }
  .stats-bar .label { font-size: 10px; color: #888; text-transform: uppercase; }
  .stats-bar .value { font-size: 16px; font-weight: 700; }
  .pos { color: #00ff00; }
  .neg { color: #ff4444; }
  .data-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 12px; font-family: 'Courier New', monospace; }
  .data-table th { background: #1a1a1a; color: #888; padding: 4px 8px; border: 1px solid #333; text-align: left; font-weight: 700; }
  .data-table td { padding: 4px 8px; border: 1px solid #333; }
  .data-table tr:hover td { background: #111; }
  .badge { display: inline-block; padding: 1px 6px; font-size: 10px; font-weight: 700; border: 1px solid #333; }
  .badge-open { color: #888; border-color: #555; }
  .badge-win { color: #00ff00; border-color: #00ff00; }
  .badge-lose { color: #ff4444; border-color: #ff4444; }
  h3 { color: #888; font-size: 13px; margin: 16px 0 8px; border-bottom: 1px solid #333; padding-bottom: 4px; text-transform: uppercase; font-family: 'Courier New', monospace; }
</style>

<div class="stats-bar">
  <div class="item">
    <div class="label">Status</div>
    <div class="value" style="color:${stRunning ? '#00ff00' : '#ff4444'}">${stRunning ? 'Running' : 'Stopped'}</div>
  </div>
  <div class="item">
    <div class="label">Total PnL</div>
    <div class="value ${pnlCls(totalPnl)}">${totalPnl}%</div>
  </div>
  <div class="item">
    <div class="label">Rata-rata PnL</div>
    <div class="value ${pnlCls(avgPnl)}">${avgPnl}%</div>
  </div>
  <div class="item">
    <div class="label">Open / Closed</div>
    <div class="value" style="color:#888">${openTrades.length} / ${totalClosed}</div>
  </div>
  <div class="item">
    <div class="label">W / L / WR</div>
    <div class="value"><span class="pos">${totalWin}</span> / <span class="neg">${totalLose}</span> / <span style="color:${parseFloat(winRate) >= 50 ? '#00ff00' : '#ff4444'}">${winRate}%</span></div>
  </div>
  <div class="item">
    <div class="label">SL / TP1 / TP2</div>
    <div class="value"><span class="neg">${sl}%</span> / <span class="pos">${tp1}%</span> / <span class="pos">${tp2}%</span></div>
  </div>
</div>

<div id="analysis-st">
  <h3>Analisis Per Ticker</h3>
  <table class="data-table">
    <thead>
      <tr><th>Ticker</th><th>Total</th><th>Win</th><th>Lose</th><th>Win Rate</th><th>Rata-rata PnL</th></tr>
    </thead>
    <tbody>
      ${analysis.length ? analysis.map(a => `
        <tr>
          <td><strong>${a.ticker}</strong></td>
          <td>${a.total}</td>
          <td class="pos">${a.wins}</td>
          <td class="neg">${a.loses}</td>
          <td><strong style="color:${parseFloat(a.win_rate) >= 50 ? '#00ff00' : '#ff4444'}">${a.win_rate}%</strong></td>
          <td class="${pnlCls(a.avg_pnl)}">${fmt(a.avg_pnl)}%</td>
        </tr>`).join('') : '<tr><td colspan="6" style="text-align:center;color:#888">Belum ada trade tertutup</td></tr>'}
    </tbody>
  </table>
</div>

<h3>Open Trades (ST Simulasi)</h3>
<table class="data-table">
  <thead>
    <tr><th>#</th><th>Ticker</th><th>TF</th><th>Entry</th><th>SL</th><th>TP1</th><th>TP2</th><th>Opened</th></tr>
  </thead>
  <tbody>
    ${openTrades.length ? openTrades.map(t => `
      <tr>
        <td>${t.id}</td>
        <td><strong>${t.ticker}</strong></td>
        <td style="color:#888">${t.timeframe}</td>
        <td>$${fmt(t.entry_price)}</td>
        <td class="neg">$${fmt(t.sl_price)}</td>
        <td class="pos">$${fmt(t.tp1_price)}</td>
        <td class="pos">$${fmt(t.tp2_price)}</td>
        <td style="color:#888">${fmtDate(t.opened_at)}</td>
      </tr>`).join('') : '<tr><td colspan="8" style="text-align:center;color:#888">Tidak ada open trade</td></tr>'}
  </tbody>
</table>

<h3>Trade History (ST Simulasi)</h3>
<table class="data-table">
  <thead>
    <tr><th>#</th><th>Ticker</th><th>TF</th><th>Entry</th><th>Close</th><th>PnL</th><th>Result</th><th>Opened</th><th>Closed</th></tr>
  </thead>
  <tbody>
    ${closedTrades.length ? closedTrades.map(t => `
      <tr>
        <td>${t.id}</td>
        <td><strong>${t.ticker}</strong></td>
        <td style="color:#888">${t.timeframe}</td>
        <td>$${fmt(t.entry_price)}</td>
        <td>${t.close_price != null ? '$' + fmt(t.close_price) : '-'}</td>
        <td class="${pnlCls(t.pnl)}">${t.pnl != null ? parseFloat(t.pnl).toFixed(2) + '%' : '-'}</td>
        <td><span class="badge ${badgeCls(t.result)}">${t.result || 'OPEN'}</span></td>
        <td style="color:#888">${fmtDate(t.opened_at)}</td>
        <td style="color:#888">${fmtDate(t.closed_at)}</td>
      </tr>`).join('') : '<tr><td colspan="9" style="text-align:center;color:#888">Belum ada trade history</td></tr>'}
  </tbody>
</table>`;
};
