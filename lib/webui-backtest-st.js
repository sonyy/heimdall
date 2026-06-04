const { db } = require('../lib/db');

module.exports = function renderBacktestSt() {
  const cfg = {};
  for (const r of db.prepare("SELECT key, value FROM config WHERE key IN ('bt_slPercent','bt_tp1Percent','bt_tp2Percent','bt_mode','bt_limit','bt_startDate','bt_endDate')").all()) {
    cfg[r.key] = r.value;
  }

  const summary = db.prepare('SELECT * FROM backtest_summary ORDER BY win_rate DESC').all();
  const trades = db.prepare('SELECT * FROM backtest_trades ORDER BY opened_at DESC LIMIT 50').all();

  const allTrades = db.prepare('SELECT * FROM backtest_trades').all();
  const agg = {};
  if (allTrades.length) {
    const wins = allTrades.filter(t => t.result === 'WIN');
    const loses = allTrades.filter(t => t.result === 'LOSE');
    agg.total = allTrades.length;
    agg.win = wins.length;
    agg.lose = loses.length;
    agg.winRate = allTrades.length > 0 ? ((wins.length / allTrades.length) * 100).toFixed(1) : '0.0';
    const totalPnl = allTrades.reduce((s, t) => s + parseFloat(t.pnl || 0), 0);
    agg.totalPnl = totalPnl.toFixed(2);
    agg.avgPnl = allTrades.length > 0 ? (totalPnl / allTrades.length).toFixed(2) : '0.00';
    agg.maxWin = wins.length ? Math.max(...wins.map(t => parseFloat(t.pnl))).toFixed(2) : '-';
    agg.maxLose = loses.length ? Math.min(...loses.map(t => parseFloat(t.pnl))).toFixed(2) : '-';
  }

  const sl = cfg.bt_slPercent || '-2';
  const tp1 = cfg.bt_tp1Percent || '2';
  const tp2 = cfg.bt_tp2Percent || '4';
  const mode = cfg.bt_mode || 'trades';
  const limit = cfg.bt_limit || '100';
  const startDate = cfg.bt_startDate || '';
  const endDate = cfg.bt_endDate || '';

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
    <div class="label">Mode</div>
    <div class="value" style="color:#888">${mode}</div>
  </div>
  <div class="item">
    <div class="label">Limit</div>
    <div class="value" style="color:#888">${limit}</div>
  </div>
  <div class="item">
    <div class="label">SL / TP1 / TP2</div>
    <div class="value"><span class="neg">${sl}%</span> / <span class="pos">${tp1}%</span> / <span class="pos">${tp2}%</span></div>
  </div>
  <div class="item">
    <div class="label">Periode</div>
    <div class="value" style="color:#888">${startDate || '?'} → ${endDate || '?'}</div>
  </div>
  ${agg.total ? `
  <div class="item">
    <div class="label">Total Trades</div>
    <div class="value" style="color:#888">${agg.total}</div>
  </div>
  <div class="item">
    <div class="label">W / L / WR</div>
    <div class="value"><span class="pos">${agg.win}</span> / <span class="neg">${agg.lose}</span> / <span style="color:${parseFloat(agg.winRate) >= 50 ? '#00ff00' : '#ff4444'}">${agg.winRate}%</span></div>
  </div>
  <div class="item">
    <div class="label">Total PnL</div>
    <div class="value ${pnlCls(agg.totalPnl)}">${agg.totalPnl}%</div>
  </div>
  <div class="item">
    <div class="label">Rata-rata PnL</div>
    <div class="value ${pnlCls(agg.avgPnl)}">${agg.avgPnl}%</div>
  </div>
  <div class="item">
    <div class="label">Max Win / Max Lose</div>
    <div class="value"><span class="pos">${agg.maxWin}%</span> / <span class="neg">${agg.maxLose}%</span></div>
  </div>` : '<div class="item"><div class="label">Data</div><div class="value" style="color:#888">Belum ada backtest</div></div>'}
</div>

<div id="backtest-summary">
  <h3>Backtest Summary</h3>
  <table class="data-table">
    <thead>
      <tr><th>Ticker</th><th>TF</th><th>Total</th><th>Win</th><th>Lose</th><th>Win Rate</th><th>Total PnL</th><th>Rata-rata PnL</th><th>Max Win</th><th>Max Lose</th></tr>
    </thead>
    <tbody>
      ${summary.length ? summary.map(s => `
        <tr>
          <td><strong>${s.ticker}</strong></td>
          <td style="color:#888">${s.timeframe}</td>
          <td>${s.total_trades}</td>
          <td class="pos">${s.win}</td>
          <td class="neg">${s.lose}</td>
          <td><strong style="color:${parseFloat(s.win_rate) >= 50 ? '#00ff00' : '#ff4444'}">${s.win_rate}%</strong></td>
          <td class="${pnlCls(s.total_pnl)}">${fmt(s.total_pnl)}%</td>
          <td class="${pnlCls(s.avg_pnl)}">${fmt(s.avg_pnl)}%</td>
          <td class="pos">${s.max_win != null ? fmt(s.max_win) + '%' : '-'}</td>
          <td class="neg">${s.max_lose != null ? fmt(s.max_lose) + '%' : '-'}</td>
        </tr>`).join('') : '<tr><td colspan="10" style="text-align:center;color:#888">Belum ada backtest</td></tr>'}
    </tbody>
  </table>
</div>

<h3>Trade History (Backtest ST)</h3>
<table class="data-table">
  <thead>
    <tr><th>#</th><th>Ticker</th><th>TF</th><th>Entry</th><th>Close</th><th>PnL</th><th>Result</th><th>Opened</th><th>Closed</th></tr>
  </thead>
  <tbody>
    ${trades.length ? trades.map(t => `
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
