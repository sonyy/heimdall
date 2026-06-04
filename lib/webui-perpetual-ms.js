const { db } = require('../lib/db');

module.exports = function renderPerpetualMs() {
  const cfg = {};
  for (const r of db.prepare("SELECT key, value FROM config WHERE key IN ('perp_slPercent','perp_tp1Percent','perp_tp2Percent','perp_running','perp_waitMode','perp_swingLookback','perp_volumeThreshold')").all()) {
    cfg[r.key] = r.value;
  }

  const openPositions = db.prepare("SELECT * FROM perp_trades WHERE result IS NULL ORDER BY opened_at DESC").all();
  const closedTrades = db.prepare("SELECT * FROM perp_trades WHERE result IS NOT NULL ORDER BY opened_at DESC LIMIT 100").all();

  const sourceGroups = {};
  for (const t of closedTrades) {
    const src = t.source || 'live';
    if (!sourceGroups[src]) sourceGroups[src] = [];
    sourceGroups[src].push(t);
  }

  function calcStats(arr) {
    const wins = arr.filter(t => t.result === 'WIN');
    const loses = arr.filter(t => t.result === 'LOSE');
    const total = wins.length + loses.length;
    const pnlSum = arr.reduce((s, t) => s + parseFloat(t.pnl || 0), 0);
    return {
      total,
      win: wins.length,
      lose: loses.length,
      winRate: total > 0 ? ((wins.length / total) * 100).toFixed(1) : '0.0',
      totalPnl: pnlSum.toFixed(2),
      avgPnl: total > 0 ? (pnlSum / total).toFixed(2) : '0.00',
    };
  }

  const liveStats = calcStats(sourceGroups['live'] || []);
  const btStats = calcStats(sourceGroups['backtest'] || []);
  const allClosed = closedTrades.length;
  const allWin = closedTrades.filter(t => t.result === 'WIN').length;
  const allLose = closedTrades.filter(t => t.result === 'LOSE').length;
  const allWR = allClosed > 0 ? ((allWin / allClosed) * 100).toFixed(1) : '0.0';

  const perpRunning = cfg.perp_running === '1';
  const sl = cfg.perp_slPercent || '-0.1';
  const tp1 = cfg.perp_tp1Percent || '1';
  const tp2 = cfg.perp_tp2Percent || '200';
  const waitMode = cfg.perp_waitMode || 'trend';
  const swingLookback = cfg.perp_swingLookback || '5';
  const volumeThreshold = cfg.perp_volumeThreshold || '150';

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
  .source-tag { font-size: 10px; padding: 1px 5px; border: 1px solid #555; color: #aaa; margin-left: 4px; }
  .section-card { background: #0a0a0a; border: 1px solid #333; padding: 8px; margin-bottom: 8px; }
  .summary-grid { display: flex; gap: 16px; flex-wrap: wrap; }
  .summary-col { min-width: 200px; }
  .summary-col h4 { color: #aaa; font-size: 11px; text-transform: uppercase; border-bottom: 1px solid #333; padding-bottom: 4px; margin-bottom: 4px; }
  .summary-row { display: flex; justify-content: space-between; padding: 2px 0; font-size: 12px; }
  .summary-row .lbl { color: #888; }
</style>

<div class="stats-bar">
  <div class="item">
    <div class="label">Status</div>
    <div class="value" style="color:${perpRunning ? '#00ff00' : '#ff4444'}">${perpRunning ? 'Running' : 'Idle'}</div>
  </div>
  <div class="item">
    <div class="label">Open Positions</div>
    <div class="value" style="color:#f0c040">${openPositions.length}</div>
  </div>
  <div class="item">
    <div class="label">Closed Trades</div>
    <div class="value" style="color:#888">${allClosed}</div>
  </div>
  <div class="item">
    <div class="label">W / L / WR</div>
    <div class="value"><span class="pos">${allWin}</span> / <span class="neg">${allLose}</span> / <span style="color:${parseFloat(allWR) >= 50 ? '#00ff00' : '#ff4444'}">${allWR}%</span></div>
  </div>
  <div class="item">
    <div class="label">Wait / Swing / Vol</div>
    <div class="value" style="color:#888">${waitMode} / ${swingLookback} / ${volumeThreshold}</div>
  </div>
  <div class="item">
    <div class="label">SL / TP1 / TP2</div>
    <div class="value"><span class="neg">${sl}%</span> / <span class="pos">${tp1}%</span> / <span class="pos">${tp2}%</span></div>
  </div>
</div>

<div class="section-card">
  <h3>Summary Per Source</h3>
  <div class="summary-grid">
    <div class="summary-col">
      <h4>Live</h4>
      <div class="summary-row"><span class="lbl">Trades</span><span>${liveStats.total}</span></div>
      <div class="summary-row"><span class="lbl">Win / Lose</span><span><span class="pos">${liveStats.win}</span> / <span class="neg">${liveStats.lose}</span></span></div>
      <div class="summary-row"><span class="lbl">Win Rate</span><span style="color:${parseFloat(liveStats.winRate) >= 50 ? '#00ff00' : '#ff4444'}">${liveStats.winRate}%</span></div>
      <div class="summary-row"><span class="lbl">Total PnL</span><span class="${pnlCls(liveStats.totalPnl)}">${liveStats.totalPnl}%</span></div>
      <div class="summary-row"><span class="lbl">Rata-rata PnL</span><span class="${pnlCls(liveStats.avgPnl)}">${liveStats.avgPnl}%</span></div>
    </div>
    <div class="summary-col">
      <h4>Backtest</h4>
      <div class="summary-row"><span class="lbl">Trades</span><span>${btStats.total}</span></div>
      <div class="summary-row"><span class="lbl">Win / Lose</span><span><span class="pos">${btStats.win}</span> / <span class="neg">${btStats.lose}</span></span></div>
      <div class="summary-row"><span class="lbl">Win Rate</span><span style="color:${parseFloat(btStats.winRate) >= 50 ? '#00ff00' : '#ff4444'}">${btStats.winRate}%</span></div>
      <div class="summary-row"><span class="lbl">Total PnL</span><span class="${pnlCls(btStats.totalPnl)}">${btStats.totalPnl}%</span></div>
      <div class="summary-row"><span class="lbl">Rata-rata PnL</span><span class="${pnlCls(btStats.avgPnl)}">${btStats.avgPnl}%</span></div>
    </div>
  </div>
</div>

<h3>Open Positions (Perpetual MS)</h3>
<table class="data-table">
  <thead>
    <tr><th>#</th><th>Ticker</th><th>Dir</th><th>Entry</th><th>SL</th><th>TP</th><th>Signal</th><th>Source</th><th>Opened</th></tr>
  </thead>
  <tbody>
    ${openPositions.length ? openPositions.map(t => `
      <tr>
        <td>${t.id}</td>
        <td><strong>${t.ticker}</strong></td>
        <td class="${t.direction === 'LONG' ? 'pos' : 'neg'}">${t.direction}</td>
        <td>$${fmt(t.entry_price)}</td>
        <td class="neg">$${fmt(t.sl_price)}</td>
        <td class="pos">$${fmt(t.tp_price)}</td>
        <td style="color:#888">${t.entry_signal || '-'}</td>
        <td><span class="source-tag">${t.source || 'live'}</span></td>
        <td style="color:#888">${fmtDate(t.opened_at)}</td>
      </tr>`).join('') : '<tr><td colspan="9" style="text-align:center;color:#888">Tidak ada open position</td></tr>'}
  </tbody>
</table>

<h3>Trade History (Perpetual MS)</h3>
<table class="data-table">
  <thead>
    <tr><th>#</th><th>Ticker</th><th>Dir</th><th>Entry</th><th>Close</th><th>PnL</th><th>Result</th><th>Signal</th><th>Source</th><th>Opened</th><th>Closed</th></tr>
  </thead>
  <tbody>
    ${closedTrades.length ? closedTrades.map(t => `
      <tr>
        <td>${t.id}</td>
        <td><strong>${t.ticker}</strong></td>
        <td class="${t.direction === 'LONG' ? 'pos' : 'neg'}">${t.direction}</td>
        <td>$${fmt(t.entry_price)}</td>
        <td>${t.close_price != null ? '$' + fmt(t.close_price) : '-'}</td>
        <td class="${pnlCls(t.pnl)}">${t.pnl != null ? parseFloat(t.pnl).toFixed(2) + '%' : '-'}</td>
        <td><span class="badge ${badgeCls(t.result)}">${t.result}</span></td>
        <td style="color:#888">${t.entry_signal || '-'}</td>
        <td><span class="source-tag">${t.source || 'live'}</span></td>
        <td style="color:#888">${fmtDate(t.opened_at)}</td>
        <td style="color:#888">${fmtDate(t.closed_at)}</td>
      </tr>`).join('') : '<tr><td colspan="11" style="text-align:center;color:#888">Belum ada trade history</td></tr>'}
  </tbody>
</table>`;
};
