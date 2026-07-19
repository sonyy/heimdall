const { db, getFeatConfig, upsertConfig, getTfConfig, getConfig, loadPairsFor } = require('./db');
const { fetchKlinesRange, fetchCandles, VALID_TIMEFRAMES, tfToMinutes, normalizeTf } = require('./exchange');
const { ATR } = require('technicalindicators');

function calcSupertrend(candles, period, multiplier) {
  const high = candles.map(c => c.high);
  const low = candles.map(c => c.low);
  const close = candles.map(c => c.close);
  const atrValues = ATR.calculate({ high, low, close, period });
  const hl2 = high.map((h, i) => (h + low[i]) / 2);
  const atrOffset = close.length - atrValues.length;
  let finalUpperBand = 0, finalLowerBand = 0, direction = 1, prevDirection = 1;
  for (let i = atrOffset; i < close.length; i++) {
    const atr = atrValues[i - atrOffset];
    const basicUpperBand = hl2[i] + multiplier * atr;
    const basicLowerBand = hl2[i] - multiplier * atr;
    if (i === atrOffset) {
      finalUpperBand = basicUpperBand;
      finalLowerBand = basicLowerBand;
      direction = close[i] > hl2[i] ? 1 : -1;
    } else {
      prevDirection = direction;
      finalUpperBand = (basicUpperBand < finalUpperBand || close[i - 1] > finalUpperBand) ? basicUpperBand : finalUpperBand;
      finalLowerBand = (basicLowerBand > finalLowerBand || close[i - 1] < finalLowerBand) ? basicLowerBand : finalLowerBand;
      direction = direction === 1 ? (close[i] > finalLowerBand ? 1 : -1) : (close[i] < finalUpperBand ? -1 : 1);
    }
  }
  return { isBullish: direction === 1, wasBullish: prevDirection === 1, price: close[close.length - 1] };
}

function findSwingLevels(candles, lookback) {
  const highs = [];
  const lows = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i];
    let isHigh = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].high >= c.high) { isHigh = false; break; }
    }
    if (isHigh) highs.push({ index: i, price: c.high });
    let isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].low <= c.low) { isLow = false; break; }
    }
    if (isLow) lows.push({ index: i, price: c.low });
  }
  return { highs, lows };
}

function avgVolume(candles, period) {
  const slice = candles.slice(-period);
  const sum = slice.reduce((s, c) => s + c.volume, 0);
  return sum / slice.length;
}

function calcPnl(direction, entry, close, leverage, feePct) {
  const raw = direction === 'LONG' ? ((close - entry) / entry) * 100 : ((entry - close) / entry) * 100;
  return raw * (leverage || 1) - (feePct || 0.05);
}

function calcLiqPrice(direction, entry, leverage) {
  const liqGap = entry / (leverage || 1);
  return direction === 'LONG' ? entry - liqGap : entry + liqGap;
}

async function sendMenu(bot, chatId, msgId, text, opts) {
  if (msgId) {
    try {
      return await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, ...opts });
    } catch (e) {
      // edit failed — send fresh
      const fresh = await bot.sendMessage(chatId, text, opts).catch(e2 => {
        console.error('BT sendMenu edit+send err:', e.message, '/', e2.message);
        return null;
      });
      return fresh;
    }
  } else {
    try { return await bot.sendMessage(chatId, text, opts); } catch (e) {
      console.error('BT sendMenu send err:', e.message);
    }
  }
}

function formatSummaryMessage() {
  const pairs = loadPairsFor('bt_pairs');
  const pairKeys = Object.keys(pairs);
  const rows = db.prepare("SELECT ticker,timeframe,direction,total_trades,win,lose,win_rate,total_pnl,avg_pnl,max_win,max_lose FROM backtest_summary ORDER BY ticker,timeframe,direction").all();

  const sl = getFeatConfig('bt', 'slPercent', '-2');
  const tp1 = getFeatConfig('bt', 'tp1Percent', '1');
  const indicator = getFeatConfig('bt', 'indicator', 'st');
  const waitMode = getFeatConfig('bt', 'waitMode', 'trend');
  const period = Number(getConfig('supertrendPeriod', '10'));
  const multiplier = Number(getConfig('supertrendMultiplier', '3'));
  const startCapital = getFeatConfig('bt', 'startCapital', '1000');
  const usdtPerTrade = getFeatConfig('bt', 'usdtPerTrade', '100');
  const waitTxt = indicator === 'ms' ? ` | Wait: ${waitMode}` : '';

  const lines = ['<b>Backtest Supertrend</b>\n'];
  lines.push(`⚙️ SL: ${sl}% | TP: ${tp1}% | ${indicator.toUpperCase()}${waitTxt} | ST ${period}×${multiplier} | 💰 $${Number(startCapital).toLocaleString()} / 💵 $${Number(usdtPerTrade).toLocaleString()}\n`);
  if (pairKeys.length) {
    lines.push('<b>Pairs:</b>');
    for (const t of pairKeys) {
      const lev = getFeatConfig('bt', 'leverage_' + t, '1');
      lines.push(`  <i>${t}</i> (${pairs[t].join(', ')}) x${lev}`);
    }
    lines.push('');
  } else {
    lines.push('Belum ada pair. Tambah via ⚙️ Config → Manage Pair.\n');
  }

  if (!rows.length) {
    lines.push('Belum ada hasil backtest. Jalankan dengan ▶️ Run Backtest.');
    return lines.join('\n');
  }

  const groups = {};
  for (const r of rows) {
    const key = `${r.ticker}|${r.timeframe}`;
    if (!groups[key]) groups[key] = { ticker: r.ticker, timeframe: r.timeframe, directions: [] };
    groups[key].directions.push(r);
  }

  lines.push('<b>Last Results:</b>');
  for (const g of Object.values(groups)) {
    const totalTrades = g.directions.reduce((s, d) => s + d.total_trades, 0);
    const totalWin = g.directions.reduce((s, d) => s + d.win, 0);
    const totalLose = g.directions.reduce((s, d) => s + d.lose, 0);
    const totalPnl = g.directions.reduce((s, d) => s + Number(d.total_pnl), 0);
    const avgPnl = totalTrades ? totalPnl / totalTrades : 0;
    const maxWin = Math.max(...g.directions.map(d => Number(d.max_win)));
    const maxLose = Math.min(...g.directions.map(d => Number(d.max_lose)));
    const winRate = totalTrades ? ((totalWin / totalTrades) * 100).toFixed(1) : '0.0';
    const sign = totalPnl > 0 ? '+' : '';

    lines.push(`<b>${g.ticker}</b> <i>${g.timeframe}</i>`);
    lines.push(`  📊 Trades: ${totalTrades} (${totalWin}W / ${totalLose}L)`);
    lines.push(`  🎯 Win Rate: ${winRate}%`);
    lines.push(`  📈 Total PnL: ${sign}${totalPnl.toFixed(2)}%`);
    lines.push(`  📊 Avg PnL: ${avgPnl.toFixed(2)}%`);
    lines.push(`  🟢 Max Win: ${maxWin.toFixed(2)}%`);
    lines.push(`  🔴 Max Lose: ${maxLose.toFixed(2)}%`);

    if (g.directions.length > 1) {
      for (const d of g.directions) {
        const dSign = Number(d.total_pnl) > 0 ? '+' : '';
        lines.push(`  <i>  [${d.direction}]</i> ${d.total_trades}T ${d.win}W/${d.lose}L ${d.win_rate}% ${dSign}${Number(d.total_pnl).toFixed(2)}%`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

function showCalendar(bot, chatId, msgId, targetKey, conv) {
  const year = conv.calYear;
  const month = conv.calMonth;
  const monthNames = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'];
  const dayNames = ['Sn','Mn','Rn','Km','Jm','Sb','Mg'];
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const rows = [];
  rows.push([
    { text: '◀', callback_data: 'bt_cal_prev' },
    { text: `${monthNames[month]} ${year}`, callback_data: 'bt_cal_nop' },
    { text: '▶', callback_data: 'bt_cal_next' },
  ]);
  rows.push([
    { text: '⏪', callback_data: 'bt_cal_pyear' },
    { text: `${year}`, callback_data: 'bt_cal_nop' },
    { text: '⏩', callback_data: 'bt_cal_nyear' },
  ]);
  const weekRow = [];
  for (let d = 0; d < 7; d++) weekRow.push({ text: dayNames[d], callback_data: 'bt_cal_nop' });
  rows.push(weekRow);
  let week = [];
  const startOffset = (firstDay + 6) % 7;
  for (let i = 0; i < startOffset; i++) week.push({ text: ' ', callback_data: 'bt_cal_nop' });
  for (let day = 1; day <= daysInMonth; day++) {
    const ds = year + ('0' + (month + 1)).slice(-2) + ('0' + day).slice(-2);
    const isSelected = conv.calDate === ds;
    week.push({ text: (isSelected ? '[' : '') + day + (isSelected ? ']' : ''), callback_data: 'bt_cal_' + ds });
    if (week.length === 7) { rows.push(week); week = []; }
  }
  if (week.length) rows.push(week);
  const bottom = [];
  if (conv.calDate) {
    const d = conv.calDate;
    bottom.push({ text: `✅ ${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`, callback_data: 'bt_cal_ok' });
  }
  bottom.push({ text: '🗑 Hapus', callback_data: 'bt_cal_del' });
  bottom.push({ text: '❌ Batal', callback_data: 'bt_config_cancel' });
  rows.push(bottom);
  const label = targetKey === 'bt_startDate' ? 'mulai' : 'akhir';
  const text = `📅 Pilih tanggal ${label}:`;
  sendMenu(bot, chatId, conv.calMsgId, text, { reply_markup: { inline_keyboard: rows } }).then(m => {
    if (!conv.calMsgId) conv.calMsgId = m ? m.message_id : null;
  }).catch(() => {});
}

const btStop = {};
const stopMarkup = () => ({ reply_markup: { inline_keyboard: [[{ text: '🛑 Stop', callback_data: 'bt_stop' }]] } });

async function runBacktest(ticker, timeframe, bot, chatId, msgId) {
  const btSlPct = Number(getFeatConfig('bt', 'slPercent', '-2'));
  const btTp1Pct = Number(getFeatConfig('bt', 'tp1Percent', '1'));
  const btMode = getFeatConfig('bt', 'mode', 'trades');
  const btLimit = Number(getFeatConfig('bt', 'limit', '1000'));
  const btStartDate = getFeatConfig('bt', 'startDate', '2024-01-01');
  const btEndDate = getFeatConfig('bt', 'endDate', '2025-12-31');
  const btIndicator = getFeatConfig('bt', 'indicator', 'st');
  const btWaitMode = getFeatConfig('bt', 'waitMode', 'trend');
  const btSwingLookback = Number(getFeatConfig('bt', 'swingLookback', '2'));
  const btVolumeThreshold = Number(getFeatConfig('bt', 'volumeThreshold', '150'));
  const btStartCapital = Number(getFeatConfig('bt', 'startCapital', '1000'));
  const btUsdtPerTrade = Number(getFeatConfig('bt', 'usdtPerTrade', '100'));
  const globalPeriod = Number(getConfig('supertrendPeriod', '10'));
  const globalMultiplier = Number(getConfig('supertrendMultiplier', '3'));

  // MS signal constants
  const MS_SIGNAL_TIMEOUT = 200;
  const MS_COOLDOWN = 5;
  const MS_EXTEND_CANCEL_PCT = 4;

  const FEE_PCT = 0.05; // exchange fee per trade 0.05%
const insTrade = db.prepare(`INSERT INTO backtest_trades (ticker,timeframe,entry_price,close_price,pnl,liq_price,fee,sl_price,tp1_price,tp1_hit,result,direction,opened_at,closed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const upsertSummary = db.prepare(`INSERT OR REPLACE INTO backtest_summary (ticker,timeframe,direction,total_trades,win,lose,win_rate,total_pnl,avg_pnl,max_win,max_lose) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const delTrades = db.prepare(`DELETE FROM backtest_trades WHERE ticker = ? AND timeframe = ?`);
  const delSummary = db.prepare(`DELETE FROM backtest_summary WHERE ticker = ? AND timeframe = ?`);

  const pairs = ticker ? { [ticker]: timeframe ? [timeframe] : (loadPairsFor('bt_pairs')[ticker] || []) } : loadPairsFor('bt_pairs');
  const tasks = [];
  for (const [t, timeframes] of Object.entries(pairs)) {
    if (timeframes && timeframes.length) tasks.push({ ticker: t, tf: timeframes[0] });
  }
  if (!tasks.length) return 'Tidak ada pair untuk di-backtest.';

  db.transaction(() => {
    for (const { ticker: t, tf } of tasks) {
      delTrades.run(t, tf);
      delSummary.run(t, tf);
    }
  })();

  const results = [];
  const progressText = (done, total) => `⏳ Backtest Supertrend: ${done}/${total} pair selesai...`;

  let stopped = false;
  for (let i = 0; i < tasks.length; i += 5) {
    if (btStop[chatId]) { stopped = true; break; }
    const batch = tasks.slice(i, i + 5);
    const batchResults = await Promise.all(batch.map(async ({ ticker: t, tf }) => {
      try {
        if (btStop[chatId]) return '⛔ Dihentikan';
        let candleLimit, endTime, startTime;
        const hasDateRange = btStartDate && btEndDate && btStartDate !== '' && btEndDate !== '';
        const useDateRange = hasDateRange || (btMode !== 'trades' && btMode !== 'days');
        if (btMode === 'days' && !hasDateRange) {
          candleLimit = Math.min(Math.ceil(btLimit * 24 * 60 / tfToMinutes(tf)), 100000);
          endTime = null; startTime = null;
        } else if (useDateRange) {
          const startTs = new Date(btStartDate).getTime();
          const endTs = new Date(btEndDate).getTime() + 86400000;
          candleLimit = Math.min(Math.ceil((endTs - startTs) / (60000 * tfToMinutes(tf))), 200000) + 200;
          endTime = endTs; startTime = startTs;
        } else {
          candleLimit = Math.min(btLimit * 30, 100000);
          endTime = null; startTime = null;
        }

        const result = await fetchKlinesRange(t, tf, startTime, endTime, candleLimit);
        const data = result.data;
        if (!data || !data.length) return `⚠️ ${t} ${tf}: No data`;

        const leverage = Number(getFeatConfig('bt', 'leverage_' + t, '1')) || 1;
        const tfCfg = getTfConfig(tf, globalPeriod, globalMultiplier);
        const period = tfCfg.period;

        let trades = [], openTrade = null;
        let signal = null;
        let cooldown = 0;

        // === ST MODE ===
        if (btIndicator === 'st') {
          const pairTfs = loadPairsFor('bt_pairs')[t] || [];
          const GUARD_TFS = pairTfs.filter(g => g !== tf);

          const guardSt = {};
          for (const g of GUARD_TFS) {
            try {
              const gCfg = getTfConfig(g, globalPeriod, globalMultiplier);
              const gResult = await fetchKlinesRange(t, g, startTime, endTime, candleLimit);
              if (!gResult.data || !gResult.data.length) continue;
              const gList = [];
              for (let j = gCfg.period; j < gResult.data.length; j++) {
                const st = calcSupertrend(gResult.data.slice(0, j + 1), gCfg.period, gCfg.multiplier);
                gList.push({ isBullish: st?.isBullish ?? false, openTime: gResult.data[j].openTime });
              }
              guardSt[g] = gList;
            } catch (e) {
              console.error(`Guard fetch error ${t} ${g}: ${e.message}`);
            }
          }

          let gIdx = {};
          GUARD_TFS.forEach(g => { gIdx[g] = 0; });
          function isAligned(ts) {
            for (const g of GUARD_TFS) {
              if (!guardSt[g]?.length) continue;
              while (gIdx[g] + 1 < guardSt[g].length && guardSt[g][gIdx[g] + 1].openTime <= ts) {
                gIdx[g]++;
              }
              if (!guardSt[g][gIdx[g]]?.isBullish) return false;
            }
            return true;
          }

          let prevBullish = null;

          for (let idx = period; idx < data.length; idx++) {
            const slice = data.slice(0, idx + 1);
            const st = calcSupertrend(slice, period, tfCfg.multiplier);
            if (!st) continue;
            const price = data[idx].close;
            const lowPrice = data[idx].low;
            const highPrice = data[idx].high;
            const ts = data[idx].openTime || data[idx][0] || 0;

            const nowBullish = st.isBullish && isAligned(ts);

            // Long entry: ST flip bearish→bullish + guard aligned
            if (prevBullish !== null && !prevBullish && nowBullish && !openTrade) {
              const sl = price * (1 + btSlPct / 100);
              const tp1 = price * (1 + btTp1Pct / 100);
              let openTs;
              try { openTs = new Date(ts).toISOString().replace('T', ' ').slice(0, 19); } catch (e) { openTs = 'unknown'; }
              openTrade = { entry: price, sl, tp1, direction: 'LONG', openAt: openTs };
            }

            // Short entry: ST flip bullish→bearish + guard aligned
            if (prevBullish !== null && prevBullish && !st.isBullish && isAligned(ts) && !openTrade) {
              const sl = price * (1 - btSlPct / 100);
              const tp1 = price * (1 - btTp1Pct / 100);
              let openTs;
              try { openTs = new Date(ts).toISOString().replace('T', ' ').slice(0, 19); } catch (e) { openTs = 'unknown'; }
              openTrade = { entry: price, sl, tp1, direction: 'SHORT', openAt: openTs };
            }

            // Check open trade exit
            if (openTrade) {
              let closeTs;
              try { closeTs = new Date(ts).toISOString().replace('T', ' ').slice(0, 19); } catch (e) { closeTs = 'unknown'; }

              if (openTrade.direction === 'LONG') {
                if (lowPrice <= openTrade.sl) {
                  const cp = openTrade.sl;
                  const liq = calcLiqPrice('LONG', openTrade.entry, leverage);
                  const pnl = calcPnl('LONG', openTrade.entry, cp, leverage);
                  insTrade.run(t, tf, openTrade.entry, cp, pnl.toFixed(2), liq.toFixed(2), FEE_PCT, openTrade.sl, openTrade.tp1, null, 'LOSE', 'LONG', openTrade.openAt, closeTs);
                  trades.push({ pnl, result: 'LOSE', direction: 'LONG' });
                  openTrade = null;
                } else if (highPrice >= openTrade.tp1) {
                  const cp = openTrade.tp1;
                  const liq = calcLiqPrice('LONG', openTrade.entry, leverage);
                  const pnl = calcPnl('LONG', openTrade.entry, cp, leverage);
                  insTrade.run(t, tf, openTrade.entry, cp, pnl.toFixed(2), liq.toFixed(2), FEE_PCT, openTrade.sl, openTrade.tp1, openTrade.tp1, 'WIN', 'LONG', openTrade.openAt, closeTs);
                  trades.push({ pnl, result: 'WIN', direction: 'LONG' });
                  openTrade = null;
                }
              } else {
                if (highPrice >= openTrade.sl) {
                  const cp = openTrade.sl;
                  const liq = calcLiqPrice('SHORT', openTrade.entry, leverage);
                  const pnl = calcPnl('SHORT', openTrade.entry, cp, leverage);
                  insTrade.run(t, tf, openTrade.entry, cp, pnl.toFixed(2), liq.toFixed(2), FEE_PCT, openTrade.sl, openTrade.tp1, null, 'LOSE', 'SHORT', openTrade.openAt, closeTs);
                  trades.push({ pnl, result: 'LOSE', direction: 'SHORT' });
                  openTrade = null;
                } else if (lowPrice <= openTrade.tp1) {
                  const cp = openTrade.tp1;
                  const liq = calcLiqPrice('SHORT', openTrade.entry, leverage);
                  const pnl = calcPnl('SHORT', openTrade.entry, cp, leverage);
                  insTrade.run(t, tf, openTrade.entry, cp, pnl.toFixed(2), liq.toFixed(2), FEE_PCT, openTrade.sl, openTrade.tp1, openTrade.tp1, 'WIN', 'SHORT', openTrade.openAt, closeTs);
                  trades.push({ pnl, result: 'WIN', direction: 'SHORT' });
                  openTrade = null;
                }
              }
            }

            prevBullish = nowBullish;

            if (idx % 1000 === 0) await new Promise(r => setImmediate(r));
            if (btStop[chatId]) break;
            if (idx % 5000 === 0 || idx === data.length - 1) {
              const pct = ((idx - period) / (data.length - period) * 100).toFixed(0);
              if (bot && (Number(pct) % 20 === 0 || idx === data.length - 1)) {
                try {
                  sendMenu(bot, chatId, msgId, `⏳ ${t} ${tf}: ${pct}% selesai (${trades.length} trade)`, stopMarkup());
                } catch (e) {}
              }
            }
          }
        }

        // === MS MODE ===
        if (btIndicator === 'ms') {
          const MS_ANALYSIS_START = 60;

          for (let idx = MS_ANALYSIS_START; idx < data.length; idx++) {
            const windowData = data.slice(Math.max(0, idx - 120), idx + 1);
            const levels = findSwingLevels(windowData, btSwingLookback);

            const c = data[idx];
            const price = c.close;
            const lowPrice = c.low;
            const highPrice = c.high;
            const volume = c.volume;
            const ts = new Date(c.openTime || Date.now()).toISOString().replace('T', ' ').slice(0, 19);

            // Check open trade exit
            if (openTrade) {
              let closed = false;
              if (openTrade.direction === 'LONG') {
                if (lowPrice <= openTrade.sl) {
                  const cp = openTrade.sl;
                  const liq = calcLiqPrice('LONG', openTrade.entry, leverage);
                  const pnl = calcPnl('LONG', openTrade.entry, cp, leverage);
                  insTrade.run(t, tf, openTrade.entry, cp, pnl.toFixed(2), liq.toFixed(2), FEE_PCT, openTrade.sl, openTrade.tp1, null, 'LOSE', 'LONG', openTrade.openAt, ts);
                  trades.push({ pnl, result: 'LOSE', direction: 'LONG' });
                  closed = true;
                } else if (highPrice >= openTrade.tp1) {
                  const cp = openTrade.tp1;
                  const liq = calcLiqPrice('LONG', openTrade.entry, leverage);
                  const pnl = calcPnl('LONG', openTrade.entry, cp, leverage);
                  insTrade.run(t, tf, openTrade.entry, cp, pnl.toFixed(2), liq.toFixed(2), FEE_PCT, openTrade.sl, openTrade.tp1, openTrade.tp1, 'WIN', 'LONG', openTrade.openAt, ts);
                  trades.push({ pnl, result: 'WIN', direction: 'LONG' });
                  closed = true;
                }
              } else {
                if (highPrice >= openTrade.sl) {
                  const cp = openTrade.sl;
                  const liq = calcLiqPrice('SHORT', openTrade.entry, leverage);
                  const pnl = calcPnl('SHORT', openTrade.entry, cp, leverage);
                  insTrade.run(t, tf, openTrade.entry, cp, pnl.toFixed(2), liq.toFixed(2), FEE_PCT, openTrade.sl, openTrade.tp1, null, 'LOSE', 'SHORT', openTrade.openAt, ts);
                  trades.push({ pnl, result: 'LOSE', direction: 'SHORT' });
                  closed = true;
                } else if (lowPrice <= openTrade.tp1) {
                  const cp = openTrade.tp1;
                  const liq = calcLiqPrice('SHORT', openTrade.entry, leverage);
                  const pnl = calcPnl('SHORT', openTrade.entry, cp, leverage);
                  insTrade.run(t, tf, openTrade.entry, cp, pnl.toFixed(2), liq.toFixed(2), FEE_PCT, openTrade.sl, openTrade.tp1, openTrade.tp1, 'WIN', 'SHORT', openTrade.openAt, ts);
                  trades.push({ pnl, result: 'WIN', direction: 'SHORT' });
                  closed = true;
                }
              }
              if (closed) { openTrade = null; signal = null; }
              if (btStop[chatId]) break;
              if (idx % 5000 === 0) await new Promise(r => setImmediate(r));
              if (idx % 5000 === 0) await new Promise(r => setImmediate(r));
              if (idx % 5000 === 0 || idx === data.length - 1) {
                const pct = ((idx - MS_ANALYSIS_START) / (data.length - MS_ANALYSIS_START) * 100).toFixed(0);
                if (bot && (Number(pct) % 20 === 0 || idx === data.length - 1)) {
                  try { sendMenu(bot, chatId, msgId, `⏳ ${t} ${tf}: ${pct}% selesai (${trades.length} trade)`, stopMarkup()); } catch (e) {}
                }
              }
              continue;
            }

            // Signal processing (waiting for retest / volume confirmation)
            if (signal) {
              if (idx - signal.since > MS_SIGNAL_TIMEOUT) { signal = null; cooldown = idx; continue; }
              if (signal.direction === 'LONG') {
                if (price > signal.level * (1 + MS_EXTEND_CANCEL_PCT / 100)) { signal = null; cooldown = idx; continue; }
                if (price < signal.level * 0.995) { signal = null; continue; }
                if (btWaitMode === 'trend') {
                  if (!signal.retested && lowPrice <= signal.level * 1.005) signal.retested = true;
                  if (signal.retested && price > signal.level) {
                    openTrade = { entry: price, sl: price * (1 + btSlPct / 100), tp1: price * (1 + btTp1Pct / 100), direction: 'LONG', openAt: ts };
                    signal = null;
                    continue;
                  }
                }
              } else {
                if (price < signal.level * (1 - MS_EXTEND_CANCEL_PCT / 100)) { signal = null; cooldown = idx; continue; }
                if (price > signal.level * 1.005) { signal = null; continue; }
                if (btWaitMode === 'trend') {
                  if (!signal.retested && highPrice >= signal.level * 0.995) signal.retested = true;
                  if (signal.retested && price < signal.level) {
                    openTrade = { entry: price, sl: price * (1 - btSlPct / 100), tp1: price * (1 - btTp1Pct / 100), direction: 'SHORT', openAt: ts };
                    signal = null;
                    continue;
                  }
                }
              }
              continue;
            }

            if (cooldown && idx - cooldown < MS_COOLDOWN) continue;

            if (levels.highs.length < 2 || levels.lows.length < 2) continue;
            const lastHigh = levels.highs[levels.highs.length - 1].price;
            const prevHigh = levels.highs[levels.highs.length - 2].price;
            const lastLow = levels.lows[levels.lows.length - 1].price;
            const prevLow = levels.lows[levels.lows.length - 2].price;

            const higherHigh = lastHigh > prevHigh;
            const higherLow = lastLow > prevLow;
            const lowerHigh = lastHigh < prevHigh;
            const lowerLow = lastLow < prevLow;

            if (higherHigh && higherLow) {
              if (price > lastHigh) {
                if (btWaitMode === 'volume') {
                  const avgVol = avgVolume(windowData, 20);
                  if (volume >= avgVol * (btVolumeThreshold / 100)) {
                    openTrade = { entry: price, sl: price * (1 + btSlPct / 100), tp1: price * (1 + btTp1Pct / 100), direction: 'LONG', openAt: ts };
                    continue;
                  }
                }
                signal = { direction: 'LONG', level: lastHigh, since: idx, retested: false };
              }
            } else if (lowerHigh && lowerLow) {
              if (price < lastLow) {
                if (btWaitMode === 'volume') {
                  const avgVol = avgVolume(windowData, 20);
                  if (volume >= avgVol * (btVolumeThreshold / 100)) {
                    openTrade = { entry: price, sl: price * (1 - btSlPct / 100), tp1: price * (1 - btTp1Pct / 100), direction: 'SHORT', openAt: ts };
                    continue;
                  }
                }
                signal = { direction: 'SHORT', level: lastLow, since: idx, retested: false };
              }
            }

            if (idx % 5000 === 0 || idx === data.length - 1) {
              const pct = ((idx - MS_ANALYSIS_START) / (data.length - MS_ANALYSIS_START) * 100).toFixed(0);
              if (bot && (Number(pct) % 20 === 0 || idx === data.length - 1)) {
                try { sendMenu(bot, chatId, msgId, `⏳ ${t} ${tf}: ${pct}% selesai (${trades.length} trade)`); } catch (e) {}
              }
            }
          }
        }

        // Close any remaining open trade at last price
        if (openTrade) {
          const lastPrice = data[data.length - 1].close;
          const liq = calcLiqPrice(openTrade.direction, openTrade.entry, leverage);
          const pnl = calcPnl(openTrade.direction, openTrade.entry, lastPrice, leverage);
          let lastTs;
          try { lastTs = new Date(data[data.length - 1].openTime || data[data.length - 1][0]).toISOString().replace('T', ' ').slice(0, 19); } catch (e) { lastTs = 'unknown'; }
          const result = pnl > 0 ? 'WIN' : 'LOSE';
          insTrade.run(t, tf, openTrade.entry, lastPrice, pnl.toFixed(2), liq.toFixed(2), FEE_PCT, openTrade.sl, openTrade.tp1, openTrade.tp1Hit || null, result, openTrade.direction, openTrade.openAt, lastTs);
          trades.push({ pnl, result, direction: openTrade.direction });
        }

        if (btMode === 'trades' && trades.length > btLimit) {
          trades = trades.slice(trades.length - btLimit);
        }

        // Per-direction summary
        const directionGroups = {};
        for (const trade of trades) {
          const dir = trade.direction || 'LONG';
          if (!directionGroups[dir]) directionGroups[dir] = [];
          directionGroups[dir].push(trade);
        }
        for (const [dir, dirTrades] of Object.entries(directionGroups)) {
          const win = dirTrades.filter(x => x.result === 'WIN').length;
          const lose = dirTrades.filter(x => x.result === 'LOSE').length;
          const total = win + lose;
          if (!total) continue;
          const totalPnl = dirTrades.reduce((s, x) => s + x.pnl, 0);
          const avgPnl = totalPnl / total;
          const maxWin = Math.max(...dirTrades.filter(x => x.result === 'WIN').map(x => x.pnl), 0);
          const maxLose = Math.min(...dirTrades.filter(x => x.result === 'LOSE').map(x => x.pnl), 0);
          const winRate = (win / total) * 100;
          upsertSummary.run(t, tf, dir, total, win, lose, winRate.toFixed(1), totalPnl.toFixed(2), avgPnl.toFixed(2), maxWin.toFixed(2), maxLose.toFixed(2));
        }

        const totalTrades = trades.length;
        const totalWin = trades.filter(x => x.result === 'WIN').length;
        const totalLose = trades.filter(x => x.result === 'LOSE').length;
        const totalPnl = trades.reduce((s, x) => s + x.pnl, 0);

        if (totalTrades) {
          const absPnl = (totalPnl / 100) * btUsdtPerTrade;
          const endCapital = btStartCapital + absPnl;
          return `${t} ${tf}: ${totalTrades} trade (${totalWin}W/${totalLose}L) ${((totalWin / totalTrades) * 100).toFixed(0)}% WR, total ${totalPnl.toFixed(2)}% (lev x${leverage})\n  💰 $${btStartCapital.toLocaleString()} → $${endCapital.toFixed(2)} (${absPnl >= 0 ? '+' : ''}$${absPnl.toFixed(2)})`;
        }
        return `${t} ${tf}: 0 trade`;
      } catch (e) {
        console.error(`Backtest error ${t} ${tf}:`, e.stack || e.message);
        return `⚠️ ${t} ${tf}: ${e.message}`;
      }
    }));
    results.push(...batchResults.filter(Boolean));
    if (bot && chatId) {
      try {
        sendMenu(bot, chatId, msgId, progressText(Math.min(i + 5, tasks.length), tasks.length), stopMarkup());
      } catch (e) {}
    }
  }

  const summaryLines = [stopped ? '<b>⛔ Backtest Dihentikan</b>' : '<b>Backtest Supertrend Selesai</b>', ''];
  for (const r of results) summaryLines.push(r);
  return summaryLines.join('\n');
}

function showBtFeatureMenu(bot, chatId, msgId) {
  const sl = getFeatConfig('bt', 'slPercent', '-2');
  const tp1 = getFeatConfig('bt', 'tp1Percent', '1');
  const mode = getFeatConfig('bt', 'mode', 'trades');
  const limit = getFeatConfig('bt', 'limit', '1000');
  const indicator = getFeatConfig('bt', 'indicator', 'st');
  const waitMode = getFeatConfig('bt', 'waitMode', 'trend');
  const startDate = getFeatConfig('bt', 'startDate', '2024-01-01');
  const endDate = getFeatConfig('bt', 'endDate', '2025-12-31');
  const startCapital = getFeatConfig('bt', 'startCapital', '1000');
  const usdtPerTrade = getFeatConfig('bt', 'usdtPerTrade', '100');
  const period = Number(getConfig('supertrendPeriod', '10'));
  const multiplier = Number(getConfig('supertrendMultiplier', '3'));
  const pairs = loadPairsFor('bt_pairs');
  const pairKeys = Object.keys(pairs);
  const pairSummary = pairKeys.length
    ? pairKeys.map(t => `${t} (${pairs[t].join(',')})`).join(', ')
    : 'Belum ada pair';
  const waitTxt = indicator === 'ms' ? ` | Wait: ${waitMode}` : '';
  const text = `📊 <b>Backtest Supertrend</b>\n` +
    `📉 SL: ${sl}% | 📈 TP: ${tp1}%\n` +
    `📊 Indicator: ${indicator.toUpperCase()}${waitTxt} | ST: ${period}×${multiplier}\n` +
    `📋 Mode: ${mode} | 🔢 Limit: ${limit}\n` +
    `💰 Modal: $${Number(startCapital).toLocaleString()} | 💵 Per Trade: $${Number(usdtPerTrade).toLocaleString()}\n` +
    `📅 ${startDate} → ${endDate}\n` +
    `📋 Pairs: ${pairSummary}`;
  sendMenu(bot, chatId, msgId, text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '⚙️ Config', callback_data: 'bt_config' }, { text: '📊 Status', callback_data: 'bt_status' }],
        [{ text: '➕ Manage Pair', callback_data: 'bt_managepair' }],
        [{ text: '▶️ Run Backtest', callback_data: 'bt_run' }],
      ]
    }
  });
}

function showBtConfigMenu(bot, chatId, msgId) {
  const sl = getFeatConfig('bt', 'slPercent', '-2');
  const tp1 = getFeatConfig('bt', 'tp1Percent', '1');
  const mode = getFeatConfig('bt', 'mode', 'trades');
  const limit = getFeatConfig('bt', 'limit', '1000');
  const indicator = getFeatConfig('bt', 'indicator', 'st');
  const waitMode = getFeatConfig('bt', 'waitMode', 'trend');
  const startDate = getFeatConfig('bt', 'startDate', '2024-01-01');
  const endDate = getFeatConfig('bt', 'endDate', '2025-12-31');
  const startCapital = getFeatConfig('bt', 'startCapital', '1000');
  const usdtPerTrade = getFeatConfig('bt', 'usdtPerTrade', '100');
  const period = Number(getConfig('supertrendPeriod', '10'));
  const multiplier = Number(getConfig('supertrendMultiplier', '3'));
  const rows = [
    [{ text: `📊 Indicator: ${indicator.toUpperCase()}`, callback_data: 'bt_config_indicator' }],
    [{ text: `📉 SL ${sl}%`, callback_data: 'bt_config_sl' }, { text: `📈 TP ${tp1}%`, callback_data: 'bt_config_tp1' }],
    [{ text: `📋 Mode: ${mode}`, callback_data: 'bt_config_mode' }, { text: `🔢 Limit: ${limit}`, callback_data: 'bt_config_limit' }],
    [{ text: `💰 Modal: $${Number(startCapital).toLocaleString()}`, callback_data: 'bt_config_capital' },
     { text: `💵 Per Trade: $${Number(usdtPerTrade).toLocaleString()}`, callback_data: 'bt_config_usdtpertrade' }],
  ];
  if (indicator === 'ms') {
    rows.push([{ text: `⏳ Wait Mode: ${waitMode}`, callback_data: 'bt_config_waitmode' }]);
  }
  rows.push([{ text: `⚖️ Leverage Config`, callback_data: 'bt_config_leverage' }]);
  rows.push([{ text: `📅 Mulai: ${startDate}`, callback_data: 'bt_config_startdate' }, { text: `📅 Akhir: ${endDate}`, callback_data: 'bt_config_enddate' }]);
  rows.push([{ text: '🔙 Back', callback_data: 'bt_config_back' }]);
  const text = `⚙️ <b>Backtest Supertrend Config</b>\n\n📉 SL: ${sl}%\n📈 TP: ${tp1}%\n📊 Indicator: ${indicator.toUpperCase()} | ST: ${period}×${multiplier}\n📋 Mode: ${mode}\n🔢 Limit: ${limit}\n💰 Modal: $${Number(startCapital).toLocaleString()}\n📅 ${startDate} → ${endDate}`;
  sendMenu(bot, chatId, msgId, text, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: rows }
  });
}

function showBtManagePair(bot, chatId, msgId) {
  const pairs = loadPairsFor('bt_pairs');
  const keys = Object.keys(pairs);
  if (keys.length) {
    const rows = keys.map(t => [{ text: `📝 ${t} (${pairs[t].join(',')})`, callback_data: `bt_managepair_edit_${t}` }]);
    rows.push([{ text: '➕ Add New', callback_data: 'bt_addpair' }]);
    rows.push([{ text: '🔙 Back', callback_data: 'bt_config_back' }]);
    sendMenu(bot, chatId, msgId, 'Pilih pair untuk diedit:', {
      reply_markup: { inline_keyboard: rows }
    });
  } else {
    conv[chatId] = { cmd: 'bt_managepair', step: 'ticker', data: {} };
    sendMenu(bot, chatId, msgId, 'Belum ada pair. Masukkan ticker (contoh: BTCUSDT):', {
      reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'bt_config_back' }]] }
    });
  }
}

function sortTfs(tfs) {
  const order = { '1m': 1, '3m': 2, '5m': 3, '15m': 4, '30m': 5, '1h': 6, '2h': 7, '4h': 8, '6h': 9, '8h': 10, '12h': 11, '1d': 12, '3d': 13, '1w': 14, '1M': 15 };
  return [...tfs].sort((a, b) => (order[a] || 99) - (order[b] || 99));
}

function showBtPairDetail(bot, chatId, msgId, ticker) {
  const pairs = loadPairsFor('bt_pairs');
  const tfs = sortTfs(pairs[ticker] || []);
  const leverage = getFeatConfig('bt', 'leverage_' + ticker, '1');
  const lines = [
    `📝 <b>${ticker}</b>`,
    `Timeframes: ${tfs.join(', ') || '-'}`,
    `Leverage: x${leverage}`,
  ];
  const rows = [
    [{ text: `⏰ Edit Timeframes`, callback_data: `bt_edit_tf_${ticker}` }],
    [{ text: `⚖️ Leverage: x${leverage}`, callback_data: `bt_edit_leverage_${ticker}` }],
    [{ text: `🗑️ Hapus Pair`, callback_data: `bt_delete_${ticker}` }],
    [{ text: '🔙 Back', callback_data: 'bt_managepair' }],
  ];
  sendMenu(bot, chatId, msgId, lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: rows }
  });
}

function showBtTfSelector(bot, chatId, ticker, preselected, msgId) {
  const lines = [`⏰ <b>${ticker}</b> — Tap TF untuk toggle & simpan langsung`];
  const rows = [];
  const tfs = VALID_TIMEFRAMES;
  for (let i = 0; i < tfs.length; i += 4) {
    const row = tfs.slice(i, i + 4).map(tf => ({
      text: `${preselected.includes(tf) ? '✅' : '⚪'} ${tf}`,
      callback_data: `bt_tf_tgl_${ticker}_${tf}`,
    }));
    rows.push(row);
  }
  rows.push([
    { text: '🔙 Kembali ke detail', callback_data: `bt_tf_done_${ticker}` },
  ]);
  sendMenu(bot, chatId, msgId, lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: rows }
  });
}

async function handleBtRun(bot, chatId, msgId, conv) {
  const ticker = conv && conv.data && conv.data.ticker ? conv.data.ticker : null;
  const tf = conv && conv.data && conv.data.tf ? conv.data.tf : null;
  btStop[chatId] = false;
  const msg = await sendMenu(bot, chatId, null, `⏳ Running backtest ${ticker || 'semua pair'}${tf ? ' ' + tf : ''}...`, stopMarkup());
  const resultText = await runBacktest(ticker, tf, bot, chatId, msg ? msg.message_id : msgId);
  delete btStop[chatId];
  sendMenu(bot, chatId, null, resultText, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'bt_config_back' }]] }
  });
}

module.exports = {
  runBacktest,
  register(bot) {
    const conv = {};

    async function handleCallback(query) {
      const chatId = query.message.chat.id;
      const msgId = query.message.message_id;
      const data = query.data;

      try {
        if (data === 'bt_config') {
          showBtConfigMenu(bot, chatId, msgId);
          return { action: null };
        }
        if (data === 'bt_status') {
          const text = formatSummaryMessage();
          sendMenu(bot, chatId, msgId, text, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'bt_back' }]] }
          });
          return { action: null };
        }
        if (data === 'bt_managepair') {
          showBtManagePair(bot, chatId, msgId);
          return { action: null };
        }
        if (data.startsWith('bt_managepair_edit_')) {
          const ticker = data.replace('bt_managepair_edit_', '');
          showBtPairDetail(bot, chatId, msgId, ticker);
          return { action: null };
        }
        if (data.startsWith('bt_edit_tf_')) {
          const ticker = data.replace('bt_edit_tf_', '');
          const existing = loadPairsFor('bt_pairs')[ticker] || [];
          showBtTfSelector(bot, chatId, ticker, existing, msgId).then(() => {}).catch(() => {});
          return { action: null };
        }
        if (data.startsWith('bt_tf_tgl_')) {
          const rest = data.replace('bt_tf_tgl_', '');
          const underscoreIdx = rest.lastIndexOf('_');
          if (underscoreIdx < 0) return { action: null };
          const tf = rest.slice(underscoreIdx + 1);
          const ticker = rest.slice(0, underscoreIdx);
          const cur = loadPairsFor('bt_pairs')[ticker] || [];
          const has = cur.includes(tf);
          if (cur.length <= 1 && has) {
            bot.answerCallbackQuery(query.id, { text: '❌ Minimal 1 timeframe', show_alert: false }).catch(() => {});
            return { action: null };
          }
          const next = has ? cur.filter(x => x !== tf) : [...cur, tf];
          db.prepare('DELETE FROM bt_pairs WHERE ticker = ?').run(ticker);
          const ins = db.prepare('INSERT OR IGNORE INTO bt_pairs (ticker, timeframe) VALUES (?, ?)');
          for (const t of next) ins.run(ticker, t);
          showBtTfSelector(bot, chatId, ticker, next, msgId);
          return { action: null };
        }
        if (data.startsWith('bt_tf_done_')) {
          const ticker = data.replace('bt_tf_done_', '');
          showBtPairDetail(bot, chatId, msgId, ticker);
          return { action: null };
        }
        if (data.startsWith('bt_edit_leverage_')) {
          const ticker = data.replace('bt_edit_leverage_', '');
          const cur = getFeatConfig('bt', 'leverage_' + ticker, '1');
          conv[chatId] = { cmd: 'bt_edit_leverage', step: 'leverage', data: { ticker }, promptMsgId: msgId };
          sendMenu(bot, chatId, msgId, `Leverage ${ticker} saat ini: x${cur}\nMasukkan leverage baru (contoh: 3):`, {
            reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: `bt_managepair_edit_${ticker}` }]] }
          });
          return { action: null };
        }
        if (data.startsWith('bt_delete_')) {
          const ticker = data.replace('bt_delete_', '');
          try {
            db.prepare('DELETE FROM bt_pairs WHERE ticker = ?').run(ticker);
            db.prepare('DELETE FROM backtest_trades WHERE ticker = ?').run(ticker);
            db.prepare('DELETE FROM backtest_summary WHERE ticker = ?').run(ticker);
            showBtManagePair(bot, chatId, msgId);
          } catch (e) {
            sendMenu(bot, chatId, msgId, `❌ Gagal menghapus: ${e.message}`);
          }
          return { action: null };
        }
        if (data === 'bt_run') {
          await handleBtRun(bot, chatId, msgId, { data: { ticker: null, tf: null } });
          return { action: null };
        }
        if (data === 'bt_stop') {
          btStop[chatId] = true;
          try { bot.answerCallbackQuery(query.id, { text: '⛔ Menghentikan backtest...' }); } catch (e) {}
          return { action: null };
        }
        if (data === 'bt_config_sl' || data === 'bt_config_tp1') {
          const stepMap = { bt_config_sl: 'slPercent', bt_config_tp1: 'tp1Percent' };
          const labelMap = { bt_config_sl: 'SL', bt_config_tp1: 'TP' };
          const defMap = { bt_config_sl: '-2', bt_config_tp1: '1' };
          const cur = getFeatConfig('bt', stepMap[data], defMap[data]);
          conv[chatId] = { cmd: 'bt_config', step: stepMap[data], data: {}, promptMsgId: msgId };
          sendMenu(bot, chatId, msgId, `${labelMap[data]} saat ini: ${cur}%\nMasukkan nilai baru (contoh: ${data === 'bt_config_sl' ? '-5' : '3'}):`, {
            reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'bt_config_cancel' }]] }
          });
          return { action: null };
        }
        if (data === 'bt_config_indicator') {
          const cur = getFeatConfig('bt', 'indicator', 'st');
          sendMenu(bot, chatId, msgId, `Indicator saat ini: ${cur.toUpperCase()}\nPilih indicator:`, {
            reply_markup: { inline_keyboard: [
              [{ text: `${cur === 'st' ? '✅ ' : ''}Supertrend (ST)`, callback_data: 'bt_indicator_set_st' }],
              [{ text: `${cur === 'ms' ? '✅ ' : ''}Market Structure (MS)`, callback_data: 'bt_indicator_set_ms' }],
              [{ text: '❌ Batal', callback_data: 'bt_config_cancel' }],
            ] }
          });
          return { action: null };
        }
        if (data === 'bt_indicator_set_st') {
          upsertConfig('bt_indicator', 'st');
          showBtConfigMenu(bot, chatId, msgId);
          return { action: null };
        }
        if (data === 'bt_indicator_set_ms') {
          upsertConfig('bt_indicator', 'ms');
          showBtConfigMenu(bot, chatId, msgId);
          return { action: null };
        }
        if (data === 'bt_config_waitmode') {
          const cur = getFeatConfig('bt', 'waitMode', 'trend');
          sendMenu(bot, chatId, msgId, `Wait Mode saat ini: ${cur}\nPilih wait mode:`, {
            reply_markup: { inline_keyboard: [
              [{ text: `${cur === 'trend' ? '✅ ' : ''}Trend (Retest)`, callback_data: 'bt_waitmode_set_trend' }],
              [{ text: `${cur === 'volume' ? '✅ ' : ''}Volume`, callback_data: 'bt_waitmode_set_volume' }],
              [{ text: '❌ Batal', callback_data: 'bt_config_cancel' }],
            ] }
          });
          return { action: null };
        }
        if (data === 'bt_waitmode_set_trend') {
          upsertConfig('bt_waitMode', 'trend');
          showBtConfigMenu(bot, chatId, msgId);
          return { action: null };
        }
        if (data === 'bt_waitmode_set_volume') {
          upsertConfig('bt_waitMode', 'volume');
          showBtConfigMenu(bot, chatId, msgId);
          return { action: null };
        }
        if (data === 'bt_config_leverage') {
          const pairs = loadPairsFor('bt_pairs');
          const tickers = Object.keys(pairs);
          if (!tickers.length) {
            sendMenu(bot, chatId, msgId, 'Belum ada pair. Tambah pair terlebih dahulu.', {
              reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'bt_config_cancel' }]] }
            });
            return { action: null };
          }
          const rows = tickers.map(t => {
            const lev = getFeatConfig('bt', 'leverage_' + t, '1');
            return [{ text: `${t}: x${lev}`, callback_data: `bt_config_leverage_set_${t}` }];
          });
          rows.push([{ text: '🔙 Back', callback_data: 'bt_config_cancel' }]);
          sendMenu(bot, chatId, msgId, 'Pilih pair untuk atur leverage:', { reply_markup: { inline_keyboard: rows } });
          return { action: null };
        }
        if (data.startsWith('bt_config_leverage_set_')) {
          const ticker = data.replace('bt_config_leverage_set_', '');
          const cur = getFeatConfig('bt', 'leverage_' + ticker, '1');
          conv[chatId] = { cmd: 'bt_config', step: 'leverage', data: { ticker }, promptMsgId: msgId };
          sendMenu(bot, chatId, msgId, `Leverage ${ticker} saat ini: x${cur}\nMasukkan leverage baru (contoh: 3):`, {
            reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'bt_config_cancel' }]] }
          });
          return { action: null };
        }
        if (data === 'bt_config_mode') {
          const cur = getFeatConfig('bt', 'mode', 'trades');
          const next = cur === 'trades' ? 'days' : 'trades';
          upsertConfig('bt_mode', next);
          showBtConfigMenu(bot, chatId, msgId);
          return { action: null };
        }
        if (data === 'bt_config_limit') {
          const cur = getFeatConfig('bt', 'limit', '1000');
          conv[chatId] = { cmd: 'bt_config', step: 'limit', data: {}, promptMsgId: msgId };
          sendMenu(bot, chatId, msgId, `Limit saat ini: ${cur}\nMasukkan angka baru (jumlah trade/hari):`, {
            reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'bt_config_cancel' }]] }
          });
          return { action: null };
        }
        if (data === 'bt_config_capital') {
          const cur = getFeatConfig('bt', 'startCapital', '1000');
          conv[chatId] = { cmd: 'bt_config', step: 'startCapital', data: {}, promptMsgId: msgId };
          sendMenu(bot, chatId, msgId, `Modal saat ini: $${Number(cur).toLocaleString()}\nMasukkan modal awal (USDT):`, {
            reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'bt_config_cancel' }]] }
          });
          return { action: null };
        }
        if (data === 'bt_config_usdtpertrade') {
          const cur = getFeatConfig('bt', 'usdtPerTrade', '100');
          conv[chatId] = { cmd: 'bt_config', step: 'usdtPerTrade', data: {}, promptMsgId: msgId };
          sendMenu(bot, chatId, msgId, `Per Trade saat ini: $${Number(cur).toLocaleString()}\nMasukkan USDT per trade:`, {
            reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'bt_config_cancel' }]] }
          });
          return { action: null };
        }
        if (data === 'bt_config_startdate' || data === 'bt_config_enddate') {
          const targetKey = data === 'bt_config_startdate' ? 'bt_startDate' : 'bt_endDate';
          const now = new Date();
          conv[chatId] = { cmd: 'bt_config', step: 'calendar', calTarget: targetKey, calYear: now.getFullYear(), calMonth: now.getMonth(), calMsgId: null };
          showCalendar(bot, chatId, msgId, targetKey, conv[chatId]);
          return { action: null };
        }
        if (data === 'bt_config_cancel') {
          showBtConfigMenu(bot, chatId, msgId);
          return { action: null };
        }
        if (data === 'bt_config_back') {
          showBtFeatureMenu(bot, chatId, msgId);
          return { action: null };
        }

        if (data === 'bt_addpair') {
          conv[chatId] = { cmd: 'bt_managepair', step: 'ticker', data: {} };
          sendMenu(bot, chatId, msgId, 'Masukkan ticker yang ingin ditambahkan (contoh: BTCUSDT):', {
            reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'bt_managepair' }]] }
          });
          return { action: null };
        }

        if (data.startsWith('bt_cal_') && data !== 'bt_config_back' && data !== 'bt_config') {
          const s = conv[chatId];
          if (!s || s.step !== 'calendar') return { action: null };
          const calData = data.replace('bt_cal_', '');
          if (calData === 'prev') {
            s.calMonth--; if (s.calMonth < 0) { s.calMonth = 11; s.calYear--; }
            showCalendar(bot, chatId, null, s.calTarget, s);
          } else if (calData === 'next') {
            s.calMonth++; if (s.calMonth > 11) { s.calMonth = 0; s.calYear++; }
            showCalendar(bot, chatId, null, s.calTarget, s);
          } else if (calData === 'pyear') {
            s.calYear--;
            showCalendar(bot, chatId, null, s.calTarget, s);
          } else if (calData === 'nyear') {
            s.calYear++;
            showCalendar(bot, chatId, null, s.calTarget, s);
          } else if (calData === 'nop') {
          } else if (calData === 'ok') {
            if (s.calDate) {
              const d = s.calDate;
              const dateStr = d.slice(0,4) + '-' + d.slice(4,6) + '-' + d.slice(6,8);
              upsertConfig(s.calTarget, dateStr);
              delete conv[chatId];
              sendMenu(bot, chatId, null, `✅ Tanggal ${s.calTarget === 'bt_startDate' ? 'mulai' : 'akhir'} disimpan: ${dateStr}`);
            }
          } else if (calData === 'del') {
            if (s.calDate) {
              delete s.calDate;
              showCalendar(bot, chatId, null, s.calTarget, s);
            } else {
              upsertConfig(s.calTarget, '');
              delete conv[chatId];
              sendMenu(bot, chatId, null, `✅ Tanggal ${s.calTarget === 'bt_startDate' ? 'mulai' : 'akhir'} dihapus`);
            }
          } else {
            s.calDate = calData;
            showCalendar(bot, chatId, null, s.calTarget, s);
          }
          return { action: null };
        }
      } catch (e) {
        console.error('BT handleCallback error:', e.message);
      }
      return { action: null };
    }

    async function handleMessage(text, chatId) {
      if (!text || text.startsWith('/')) return false;
      const session = conv[chatId];
      if (!session) return false;

      try {
          if (session.cmd === 'bt_config') {
            if (session.step === 'slPercent' || session.step === 'tp1Percent' || session.step === 'limit' || session.step === 'startCapital' || session.step === 'usdtPerTrade') {
              const val = session.step === 'limit' || session.step === 'startCapital' || session.step === 'usdtPerTrade' ? parseInt(text, 10) : parseFloat(text);
              const positiveOnly = session.step !== 'slPercent';
              if (isNaN(val) || (positiveOnly && val <= 0)) {
                sendMenu(bot, chatId, null, '❌ Masukkan angka yang valid.');
                return true;
              }
            const key = session.step === 'limit' ? 'bt_limit' : session.step === 'startCapital' ? 'bt_startCapital' : session.step === 'usdtPerTrade' ? 'bt_usdtPerTrade' : `bt_${session.step}`;
            upsertConfig(key, val);
            const promptId = session.promptMsgId;
            delete conv[chatId];
            showBtConfigMenu(bot, chatId, promptId);
            return true;
          }
          if (session.step === 'leverage') {
            const val = parseFloat(text);
            if (isNaN(val) || val < 1) {
              sendMenu(bot, chatId, null, '❌ Masukkan angka valid (minimal 1).');
              return true;
            }
            const ticker = session.data.ticker;
            upsertConfig('bt_leverage_' + ticker, val);
            const promptId = session.promptMsgId;
            delete conv[chatId];
            showBtConfigMenu(bot, chatId, promptId);
            return true;
          }
        }

        if (session.cmd === 'bt_managepair') {
          if (session.step === 'ticker') {
            const ticker = text.toUpperCase();
            session.data = { ticker };
            session.step = 'timeframes';
            sendMenu(bot, chatId, session.promptMsgId, `Ticker: ${ticker}\nMasukkan timeframe (pisahkan koma).\nValid: <code>${VALID_TIMEFRAMES.join(', ')}</code>`, { parse_mode: 'HTML' });
            return true;
          }
          if (session.step === 'timeframes') {
            const tfs = text.split(',').map(s => normalizeTf(s.trim())).filter(Boolean);
            const invalid = text.split(',').map(s => s.trim()).filter(s => !normalizeTf(s));
            if (invalid.length) {
              sendMenu(bot, chatId, null, `❌ Timeframe tidak valid: ${invalid.join(', ')}`);
              return true;
            }
            const ticker = session.data.ticker;
            const insPair = db.prepare('INSERT OR IGNORE INTO bt_pairs (ticker, timeframe) VALUES (?, ?)');
            db.transaction(() => {
              for (const tf of tfs) insPair.run(ticker, tf);
            })();
            const promptId = session.promptMsgId;
            delete conv[chatId];
            showBtManagePair(bot, chatId, promptId);
            return true;
          }
        }

        if (session.cmd === 'bt_edit_leverage') {
          if (session.step === 'leverage') {
            const val = parseFloat(text);
            if (isNaN(val) || val < 1) {
              sendMenu(bot, chatId, null, '❌ Masukkan angka valid (minimal 1).');
              return true;
            }
            const ticker = session.data.ticker;
            upsertConfig('bt_leverage_' + ticker, val);
            const promptId = session.promptMsgId;
            delete conv[chatId];
            showBtPairDetail(bot, chatId, promptId, ticker);
            return true;
          }
        }
      } catch (e) {
        console.error('BT message handler error:', e.message);
        try { sendMenu(bot, chatId, null, `❌ Error: ${e.message}`); } catch (_) {}
      }
      return false;
    }

    return {
      prefix: 'bt_',
      handleCallback,
      handleMessage,
      runNow: null,
      showFeatureMenu: (chatId, msgId) => showBtFeatureMenu(bot, chatId, msgId),
    };
  }
};
