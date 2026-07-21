const { db } = require('../lib/db');

module.exports = function renderBacktestSt() {
  const cfg = {};
  for (const r of db.prepare("SELECT key, value FROM config WHERE key IN ('bt_slPercent','bt_tp1Percent','bt_mode','bt_limit','bt_startDate','bt_endDate','bt_indicator','bt_waitMode','bt_startCapital','bt_usdtPerTrade','bt_marginPercent','bt_marginMode','bt_msRetestZone','bt_msRrRatio') OR key LIKE 'bt_leverage_%'").all()) {
    cfg[r.key] = r.value;
  }

  const summary = db.prepare('SELECT * FROM backtest_summary ORDER BY win_rate DESC').all();
  const trades = db.prepare('SELECT * FROM backtest_trades ORDER BY opened_at DESC LIMIT 50').all();

  const allTrades = db.prepare('SELECT * FROM backtest_trades').all();
  const agg = {};
  if (allTrades.length) {
    const wins = allTrades.filter(t => t.result === 'WIN');
    const loses = allTrades.filter(t => t.result === 'LOSE' || t.result === 'LIQUIDATED');
    const longs = allTrades.filter(t => (t.direction || 'LONG') === 'LONG');
    const shorts = allTrades.filter(t => t.direction === 'SHORT');
    agg.total = allTrades.length;
    agg.win = wins.length;
    agg.lose = loses.length;
    agg.longCount = longs.length;
    agg.shortCount = shorts.length;
    agg.longWin = longs.filter(t => t.result === 'WIN').length;
    agg.shortWin = shorts.filter(t => t.result === 'WIN').length;
    agg.winRate = allTrades.length > 0 ? ((wins.length / allTrades.length) * 100).toFixed(1) : '0.0';
    const totalPnl = allTrades.reduce((s, t) => s + parseFloat(t.pnl || 0), 0);
    agg.totalPnl = totalPnl.toFixed(2);
    agg.avgPnl = allTrades.length > 0 ? (totalPnl / allTrades.length).toFixed(2) : '0.00';
    agg.maxWin = wins.length ? Math.max(...wins.map(t => parseFloat(t.pnl))).toFixed(2) : '-';
    agg.maxLose = loses.length ? Math.min(...loses.map(t => parseFloat(t.pnl))).toFixed(2) : '-';
    agg.totalUsdt = allTrades.reduce((s, t) => s + (parseFloat(t.pnl || 0) / 100 * (t.margin_size || Number(usdtPerTrade))), 0).toFixed(2);
    agg.avgUsdt = allTrades.length > 0 ? (allTrades.reduce((s, t) => s + (parseFloat(t.pnl || 0) / 100 * (t.margin_size || Number(usdtPerTrade))), 0) / allTrades.length).toFixed(2) : '0.00';
  }

  const sl = cfg.bt_slPercent || '-2';
  const tp = cfg.bt_tp1Percent || '2';
  const mode = cfg.bt_mode || 'trades';
  const limit = cfg.bt_limit || '100';
  const indicator = (cfg.bt_indicator || 'st').toUpperCase();
  const waitMode = cfg.bt_waitMode || 'trend';
  const startDate = cfg.bt_startDate || '';
  const endDate = cfg.bt_endDate || '';
  const startCapital = cfg.bt_startCapital || '1000';
  const usdtPerTrade = cfg.bt_usdtPerTrade || '100';
  const marginMode = cfg.bt_marginMode || 'fixed';
  const marginPct = cfg.bt_marginPercent || '10';
  const msRetestZone = cfg.bt_msRetestZone || '1.5';
  const msRrRatio = cfg.bt_msRrRatio || '2.0';

  const startCap = Number(startCapital);
  const isCompoundMode = marginMode === 'percent';
  const chronoTrades = [...allTrades].sort((a, b) => (a.id || 0) - (b.id || 0));
  const capMap = {};
  let runCap = startCap;
  for (const t of chronoTrades) {
    const m = t.margin_size || Number(usdtPerTrade);
    runCap += (parseFloat(t.pnl || 0) / 100) * m;
    capMap[t.id] = runCap;
  }
  agg.endCapital = runCap.toFixed(2);

  const fmt = (n) => {
    if (n === null || n === undefined) return '-';
    return parseFloat(n).toFixed(2);
  };

  const usd = (pct) => (parseFloat(pct) / 100 * Number(usdtPerTrade)).toFixed(2);

  const pnlCls = (v) => {
    if (v === null || v === undefined) return '';
    return parseFloat(v) >= 0 ? 'pos' : 'neg';
  };

  const badgeCls = (r) => {
    if (!r) return 'badge-open';
    return r === 'WIN' ? 'badge-win' : 'badge-lose';
  };

  const fmtDate = (s) => s ? s.slice(0, 16).replace('T', ' ') : '-';

  const pairs = db.prepare('SELECT DISTINCT ticker FROM bt_pairs ORDER BY ticker').all();
  const pairInfo = pairs.map(p => {
    const tfs = db.prepare('SELECT timeframe FROM bt_pairs WHERE ticker = ? ORDER BY timeframe').all(p.ticker).map(r => r.timeframe);
    const lev = cfg['bt_leverage_' + p.ticker] || '1';
    return { ticker: p.ticker, tfs, leverage: lev };
  });

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
  .data-table td.empty { text-align: center; color: #888; padding: 12px; font-style: italic; }
  .badge { display: inline-block; padding: 1px 6px; font-size: 10px; font-weight: 700; border: 1px solid #333; }
  .badge-open { color: #888; border-color: #555; }
  .badge-win { color: #00ff00; border-color: #00ff00; }
  .badge-lose { color: #ff4444; border-color: #ff4444; }
  h3 { color: #888; font-size: 13px; margin: 16px 0 8px; border-bottom: 1px solid #333; padding-bottom: 4px; text-transform: uppercase; font-family: 'Courier New', monospace; }
  .stats-section { border-left: 2px solid #333; padding-left: 12px; margin-right: 14px; }
  .stats-section:first-child { border-left: none; padding-left: 0; margin-left: 0; }
  .section-title { font-size: 10px; color: #00ff00; text-transform: uppercase; font-weight: 700; margin-bottom: 6px; letter-spacing: 0.5px; }
  .section-items { display: flex; gap: 8px; flex-wrap: wrap; }
  .stats-section.hasil { border-left: none; padding-left: 0; }
  .stats-section.hasil .section-title { color: #4488ff; }
  .table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; margin-bottom: 12px; }
  @media (max-width: 640px) {
    .data-table { font-size: 11px; min-width: 900px; }
    .data-table th, .data-table td { padding: 3px 4px; white-space: nowrap; }
  }
</style>

<div class="stats-bar">
  <div class="stats-section">
    <div class="section-title">⚙️ Config</div>
    <div class="section-items">
      <div class="item">
        <div class="label">Indicator</div>
        <div class="value" style="color:#888">${indicator}</div>
      </div>
      ${indicator === 'MS' ? `<div class="item">
        <div class="label">Wait Mode</div>
        <div class="value" style="color:#888">${waitMode}</div>
      </div>
      <div class="item">
        <div class="label">Retest Zone</div>
        <div class="value" style="color:#888">${msRetestZone}%</div>
      </div>
      <div class="item">
        <div class="label">RR Ratio</div>
        <div class="value" style="color:#888">${msRrRatio}x</div>
      </div>` : ''}
      <div class="item">
        <div class="label">Mode</div>
        <div class="value" style="color:#888">${mode}</div>
      </div>
      <div class="item">
        <div class="label">Limit</div>
        <div class="value" style="color:#888">${limit}</div>
      </div>
      <div class="item">
        <div class="label">SL / TP</div>
        <div class="value"><span class="neg">${sl}%</span> / <span class="pos">${tp}%</span></div>
      </div>
      <div class="item">
        <div class="label">Modal</div>
        <div class="value" style="color:#888">$${Number(startCapital).toLocaleString()}</div>
      </div>
      <div class="item">
        <div class="label">Margin Mode</div>
        <div class="value" style="color:${isCompoundMode ? '#4488ff' : '#888'}">${isCompoundMode ? 'Percent' : 'Fixed'}</div>
      </div>
      <div class="item">
        <div class="label">${isCompoundMode ? 'Margin %' : 'Per Trade'}</div>
        <div class="value" style="color:#888">${isCompoundMode ? marginPct + '%' : '$' + Number(usdtPerTrade).toLocaleString()}</div>
      </div>
      ${agg.endCapital ? `<div class="item">
        <div class="label">Modal Akhir</div>
        <div class="value" style="color:${parseFloat(agg.endCapital) >= startCap ? '#00ff00' : '#ff4444'}">$${Number(agg.endCapital).toLocaleString()}</div>
      </div>` : ''}
      <div class="item">
        <div class="label">Periode</div>
        <div class="value" style="color:#888">${startDate || '?'} → ${endDate || '?'}</div>
      </div>
    </div>
  </div>
  ${agg.total ? `
  <div class="stats-section hasil">
    <div class="section-title">📊 Hasil</div>
    <div class="section-items">
      <div class="item">
        <div class="label">Total Trades</div>
        <div class="value" style="color:#888">${agg.total}</div>
      </div>
      <div class="item">
        <div class="label">Long / Short</div>
        <div class="value"><span class="pos">${agg.longCount}L</span> / <span class="neg">${agg.shortCount}S</span></div>
      </div>
      <div class="item">
        <div class="label">W / L / WR</div>
        <div class="value"><span class="pos">${agg.win}</span> / <span class="neg">${agg.lose}</span> / <span style="color:${parseFloat(agg.winRate) >= 50 ? '#00ff00' : '#ff4444'}">${agg.winRate}%</span></div>
      </div>
      <div class="item">
        <div class="label">Total PnL</div>
        <div class="value ${pnlCls(agg.totalPnl)}">${agg.totalPnl}% <span style="font-size:12px">($${agg.totalUsdt})</span></div>
      </div>
      <div class="item">
        <div class="label">Rata-rata PnL</div>
        <div class="value ${pnlCls(agg.avgPnl)}">${agg.avgPnl}% <span style="font-size:12px">($${agg.avgUsdt})</span></div>
      </div>
      <div class="item">
        <div class="label">Max Win / Max Lose</div>
        <div class="value"><span class="pos">${agg.maxWin}%</span> / <span class="neg">${agg.maxLose}%</span></div>
      </div>
    </div>
  </div>` : `
  <div class="stats-section hasil">
    <div class="section-title">📊 Hasil</div>
    <div class="section-items"><div class="item"><div class="value" style="color:#888">Belum ada backtest</div></div></div>
  </div>`}
</div>

<h3>Pairs (${pairInfo.length})</h3>
<table class="data-table">
  <thead>
    <tr><th>Ticker</th><th>Timeframes</th><th>Leverage</th></tr>
  </thead>
  <tbody>
    ${pairInfo.length ? pairInfo.map(p => `
      <tr>
        <td><strong>${p.ticker}</strong></td>
        <td style="color:#888">${p.tfs.join(', ')}</td>
        <td class="pos">x${p.leverage}</td>
      </tr>`).join('') : '<tr><td colspan="3" class="empty">Belum ada pair. Tambah via ⚙️ Config → Manage Pair.</td></tr>'}
  </tbody>
</table>

<h3>Trade History</h3>
<div class="table-wrap">
<table class="data-table">
  <thead>
    <tr><th>#</th><th>Ticker</th><th>TF</th><th>Dir</th><th>Entry</th><th>Close</th><th>SL</th><th>TP</th><th>Liq</th><th>Fee</th><th>PnL</th><th>Margin</th><th>Modal</th><th>Exit</th><th>Opened</th><th>Closed</th></tr>
  </thead>
  <tbody>
    ${trades.length ? trades.map(t => `
      <tr>
        <td>${t.id}</td>
        <td><strong>${t.ticker}</strong></td>
        <td style="color:#888">${t.timeframe}</td>
        <td>${t.direction || 'LONG'}</td>
        <td>$${fmt(t.entry_price)}</td>
        <td>${t.close_price != null ? '$' + fmt(t.close_price) : '-'}</td>
        <td class="neg">${t.sl_price != null && t.entry_price != null ? ((t.sl_price - t.entry_price) / t.entry_price * 100 * (t.direction === 'SHORT' ? -1 : 1)).toFixed(1) + '% ($' + fmt(t.sl_price) + ')' : '-'}</td>
        <td class="pos">${t.tp1_price != null && t.entry_price != null ? ((t.tp1_price - t.entry_price) / t.entry_price * 100 * (t.direction === 'SHORT' ? -1 : 1)).toFixed(1) + '% ($' + fmt(t.tp1_price) + ')' : '-'}</td>
        <td class="neg">${t.liq_price != null ? '$' + fmt(t.liq_price) : '-'}</td>
        <td style="color:#888">${t.fee != null ? t.fee + '%' : '-'}</td>
        <td class="${pnlCls(t.pnl)}">${t.pnl != null ? parseFloat(t.pnl).toFixed(2) + '% ($' + (parseFloat(t.pnl) / 100 * (t.margin_size || Number(usdtPerTrade))).toFixed(2) + ')' : '-'}</td>
        <td style="color:#888">${t.margin_size != null ? '$' + fmt(t.margin_size) : '$' + usdtPerTrade}</td>
        <td style="font-size:11px;white-space:nowrap">${t.capital_entry != null ? '<span style="color:#888">$' + fmt(t.capital_entry) + '</span> → ' : ''}${capMap[t.id] != null ? '<span style="color:' + (capMap[t.id] >= startCap ? '#00ff00' : '#ff4444') + '">$' + fmt(capMap[t.id]) + '</span>' : '-'}</td>
        <td><span class="badge ${badgeCls(t.result)}">${
          t.result === 'LIQUIDATED' ? 'LIQ' :
          t.result === 'WIN' ? 'TP' :
          t.result === 'LOSE' ? 'SL' : '-'
        }</span></td>
        <td style="color:#888">${fmtDate(t.opened_at)}</td>
        <td style="color:#888">${fmtDate(t.closed_at)}</td>
      </tr>`).join('')               : '<tr><td colspan="16" class="empty">Belum ada trade history — jalankan ▶️ Run Backtest</td></tr>'}
  </tbody>
</table>
</div>`;
};
