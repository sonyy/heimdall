const { db, getFeatConfig, upsertConfig, getTfConfig, getConfig, loadPairsFor } = require('./db');
const { fetchKlinesRange, fetchCandles, VALID_TIMEFRAMES, tfToMinutes } = require('./exchange');
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

async function sendMenu(bot, chatId, msgId, text, opts) {
  if (msgId) {
    try { return await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, ...opts }); } catch (e) {}
  } else {
    try { return await bot.sendMessage(chatId, text, opts); } catch (e) {}
  }
}

function formatSummaryMessage() {
  const rows = db.prepare("SELECT ticker,timeframe,total_trades,win,lose,win_rate,total_pnl,avg_pnl,max_win,max_lose FROM backtest_summary ORDER BY ticker,timeframe").all();
  if (!rows.length) {
    return '<b>Backtest ST</b>\n\nBelum ada hasil backtest. Jalankan dengan \u25b6\ufe0f Run Backtest.';
  }
  const lines = ['<b>Backtest ST - Last Results</b>\n'];
  for (const r of rows) {
    const sign = r.total_pnl > 0 ? '+' : '';
    lines.push(`<b>${r.ticker} (${r.timeframe})</b>`);
    lines.push(`  \ud83d\udcca Trades: ${r.total_trades} (${r.win}W / ${r.lose}L)`);
    lines.push(`  \ud83c\udfaf Win Rate: ${r.win_rate}%`);
    lines.push(`  \ud83d\udcc8 Total PnL: ${sign}${Number(r.total_pnl).toFixed(2)}%`);
    lines.push(`  \ud83d\udcca Avg PnL: ${Number(r.avg_pnl).toFixed(2)}%`);
    lines.push(`  \ud83d\udfe2 Max Win: ${Number(r.max_win).toFixed(2)}%`);
    lines.push(`  \ud83d\udd34 Max Lose: ${Number(r.max_lose).toFixed(2)}%\n`);
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
    { text: '\u25c0', callback_data: 'bt_cal_prev' },
    { text: `${monthNames[month]} ${year}`, callback_data: 'bt_cal_nop' },
    { text: '\u25b6', callback_data: 'bt_cal_next' },
  ]);
  rows.push([
    { text: '\u23ee\ufe0f', callback_data: 'bt_cal_pyear' },
    { text: `${year}`, callback_data: 'bt_cal_nop' },
    { text: '\u23ed\ufe0f', callback_data: 'bt_cal_nyear' },
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
    bottom.push({ text: `\u2705 ${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`, callback_data: 'bt_cal_ok' });
  }
  bottom.push({ text: '\ud83d\uddd1 Hapus', callback_data: 'bt_cal_del' });
  bottom.push({ text: '\u274c Batal', callback_data: 'bt_config_back' });
  rows.push(bottom);
  const label = targetKey === 'bt_startDate' ? 'mulai' : 'akhir';
  const text = `\ud83d\udcc5 Pilih tanggal ${label}:`;
  sendMenu(bot, chatId, conv.calMsgId, text, { reply_markup: { inline_keyboard: rows } }).then(m => {
    if (!conv.calMsgId) conv.calMsgId = m ? m.message_id : null;
  }).catch(() => {});
}

async function runBacktest(ticker, timeframe, bot, chatId, msgId) {
  const btSlPct = Number(getFeatConfig('bt', 'slPercent', '-2'));
  const btTp1Pct = Number(getFeatConfig('bt', 'tp1Percent', '1'));
  const btTp2Pct = Number(getFeatConfig('bt', 'tp2Percent', '200'));
  const btMode = getFeatConfig('bt', 'mode', 'trades');
  const btLimit = Number(getFeatConfig('bt', 'limit', '1000'));
  const btStartDate = getFeatConfig('bt', 'startDate', '2024-01-01');
  const btEndDate = getFeatConfig('bt', 'endDate', '2025-12-31');
  const globalPeriod = Number(getConfig('supertrendPeriod', '10'));
  const globalMultiplier = Number(getConfig('supertrendMultiplier', '3'));

  const insTrade = db.prepare(`INSERT INTO backtest_trades (ticker,timeframe,entry_price,close_price,pnl,sl_price,tp1_price,tp2_price,tp1_hit,tp2_hit,result,opened_at,closed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const upsertSummary = db.prepare(`INSERT OR REPLACE INTO backtest_summary (ticker,timeframe,total_trades,win,lose,win_rate,total_pnl,avg_pnl,max_win,max_lose) VALUES (?,?,?,?,?,?,?,?,?,?)`);

  const pairs = ticker ? { [ticker]: timeframe ? [timeframe] : (loadPairsFor('bt_pairs')[ticker] || []) } : loadPairsFor('bt_pairs');
  const tasks = [];
  for (const [t, timeframes] of Object.entries(pairs)) {
    if (timeframes && timeframes.length) tasks.push({ ticker: t, tf: timeframes[0] });
  }
  if (!tasks.length) return 'Tidak ada pair untuk di-backtest.';

  const results = [];
  const progressText = (done, total) => `\u23f3 Backtest ST: ${done}/${total} pair selesai...`;

  for (let i = 0; i < tasks.length; i += 5) {
    const batch = tasks.slice(i, i + 5);
    const batchResults = await Promise.all(batch.map(async ({ ticker: t, tf }) => {
      try {
        let candleLimit, endTime, startTime;
        const useDateRange = btMode !== 'trades' && btMode !== 'days';
        if (btMode === 'days') {
          candleLimit = Math.min(Math.ceil(btLimit * 24 * 60 / tfToMinutes(tf)), 100000);
          endTime = null; startTime = null;
        } else if (useDateRange) {
          const startTs = new Date(btStartDate).getTime();
          const endTs = new Date(btEndDate).getTime() + 86400000;
          candleLimit = Math.min(Math.ceil((endTs - startTs) / (60000 * tfToMinutes(tf))), 100000) + 200;
          endTime = endTs; startTime = startTs;
        } else {
          candleLimit = Math.min(btLimit * 30, 100000);
          endTime = null; startTime = null;
        }

        const result = await fetchKlinesRange(t, tf, candleLimit, endTime, startTime);
        const data = result.data;
        if (!data || !data.length) return `\u26a0\ufe0f ${t} ${tf}: No data`;

        const pairTfs = loadPairsFor('bt_pairs')[t] || [];
        const GUARD_TFS = pairTfs.filter(g => g !== tf);
        const tfCfg = getTfConfig(tf, globalPeriod, globalMultiplier);
        const period = tfCfg.period;

        const guardSt = {};
        for (const g of GUARD_TFS) {
          try {
            const gCfg = getTfConfig(g, globalPeriod, globalMultiplier);
            const gResult = await fetchKlinesRange(t, g, candleLimit, endTime, startTime);
            if (!gResult.data || !gResult.data.length) continue;
            const gList = [];
            for (let j = gCfg.period; j < gResult.data.length; j++) {
              const st = calcSupertrend(gResult.data.slice(0, j + 1), gCfg.period, gCfg.multiplier);
              gList.push({ isBullish: st?.isBullish ?? false, openTime: gResult.data[j][0] });
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

        const closes = data.map(c => c.close);
        let trades = [], openTrade = null;
        let prevAligned = null;

        for (let i = period; i < closes.length; i++) {
          const slice = data.slice(0, i + 1);
          const st = calcSupertrend(slice, period, tfCfg.multiplier);
          if (!st) continue;
          const price = closes[i];
          const lowPrice = data[i].low;
          const highPrice = data[i].high;
          const ts = data[i].openTime || data[i][0] || 0;

          const nowAligned = st.isBullish && isAligned(ts);

          if (prevAligned !== null && !prevAligned && nowAligned && !openTrade) {
            const sl = price * (1 + btSlPct / 100);
            const tp1 = price * (1 + btTp1Pct / 100);
            const tp2 = price * (1 + btTp2Pct / 100);
            let openTs;
            try { openTs = new Date(ts).toISOString().replace('T', ' ').slice(0, 19); } catch (e) { openTs = 'unknown'; }
            openTrade = { entry: price, sl, tp1, tp2, tp1Hit: false, tp2Hit: false, openAt: openTs };
          }

          if (openTrade) {
            let closeTs;
            try { closeTs = new Date(ts).toISOString().replace('T', ' ').slice(0, 19); } catch (e) { closeTs = 'unknown'; }

            if (lowPrice <= openTrade.sl) {
              const cp = openTrade.sl;
              const pnl = ((cp - openTrade.entry) / openTrade.entry) * 100;
              insTrade.run(t, tf, openTrade.entry, cp, pnl.toFixed(2), openTrade.sl, openTrade.tp1, openTrade.tp2, null, null, 'LOSE', openTrade.openAt, closeTs);
              trades.push({ pnl, result: 'LOSE' });
              openTrade = null;
            } else if (highPrice >= openTrade.tp2) {
              const cp = openTrade.tp2;
              const pnl = ((cp - openTrade.entry) / openTrade.entry) * 100;
              if (!openTrade.tp1Hit && highPrice >= openTrade.tp1) openTrade.tp1Hit = openTrade.tp1;
              insTrade.run(t, tf, openTrade.entry, cp, pnl.toFixed(2), openTrade.sl, openTrade.tp1, openTrade.tp2, openTrade.tp1Hit || null, openTrade.tp2, 'WIN', openTrade.openAt, closeTs);
              trades.push({ pnl, result: 'WIN' });
              openTrade = null;
            } else if (highPrice >= openTrade.tp1 && !openTrade.tp1Hit) {
              openTrade.tp1Hit = openTrade.tp1;
              insTrade.run(t, tf, openTrade.entry, openTrade.tp1, ((openTrade.tp1 - openTrade.entry) / openTrade.entry * 100).toFixed(2), openTrade.sl, openTrade.tp1, openTrade.tp2, openTrade.tp1, null, 'PARTIAL', openTrade.openAt, closeTs);
            }
          }
          prevAligned = nowAligned;

          if (i % 5000 === 0 || i === closes.length - 1) {
            const pct = ((i - period) / (closes.length - period) * 100).toFixed(0);
            if (bot && (Number(pct) % 20 === 0 || i === closes.length - 1)) {
              try {
                sendMenu(bot, chatId, msgId, `\u23f3 ${t} ${tf}: ${pct}% selesai (${trades.length} trade)`);
              } catch (e) {}
            }
          }
        }

        if (openTrade) {
          const lastPrice = closes[closes.length - 1];
          const pnl = ((lastPrice - openTrade.entry) / openTrade.entry) * 100;
          let lastTs;
          try { lastTs = new Date(data[data.length - 1].openTime || data[data.length - 1][0]).toISOString().replace('T', ' ').slice(0, 19); } catch (e) { lastTs = 'unknown'; }
          const result = pnl > 0 ? 'WIN' : 'LOSE';
          insTrade.run(t, tf, openTrade.entry, lastPrice, pnl.toFixed(2), openTrade.sl, openTrade.tp1, openTrade.tp2, openTrade.tp1Hit || null, openTrade.tp2Hit || null, result, openTrade.openAt, lastTs);
          trades.push({ pnl, result });
        }

        if (btMode === 'trades' && trades.length > btLimit) {
          trades = trades.slice(trades.length - btLimit);
        }

        if (trades.length) {
          const win = trades.filter(x => x.result === 'WIN').length;
          const lose = trades.filter(x => x.result === 'LOSE').length;
          const total = win + lose;
          const totalPnl = trades.reduce((s, x) => s + x.pnl, 0);
          const avgPnl = totalPnl / total;
          const maxWin = Math.max(...trades.filter(x => x.result === 'WIN').map(x => x.pnl), 0);
          const maxLose = Math.min(...trades.filter(x => x.result === 'LOSE').map(x => x.pnl), 0);
          const winRate = (win / total) * 100;
          upsertSummary.run(t, tf, total, win, lose, winRate.toFixed(1), totalPnl.toFixed(2), avgPnl.toFixed(2), maxWin.toFixed(2), maxLose.toFixed(2));
          return `${t} ${tf}: ${total} trade (${win}W/${lose}L) ${winRate.toFixed(0)}% WR, total ${totalPnl.toFixed(2)}%`;
        }
        return `${t} ${tf}: 0 trade`;
      } catch (e) {
        console.error(`Backtest error ${t} ${tf}:`, e.stack || e.message);
        return `\u26a0\ufe0f ${t} ${tf}: ${e.message}`;
      }
    }));
    results.push(...batchResults.filter(Boolean));
    if (bot && chatId) {
      try {
        sendMenu(bot, chatId, msgId, progressText(Math.min(i + 5, tasks.length), tasks.length));
      } catch (e) {}
    }
  }

  const summaryLines = ['<b>Backtest ST Selesai</b>', ''];
  for (const r of results) summaryLines.push(r);
  return summaryLines.join('\n');
}

function showBtFeatureMenu(bot, chatId, msgId) {
  const sl = getFeatConfig('bt', 'slPercent', '-2');
  const tp1 = getFeatConfig('bt', 'tp1Percent', '1');
  const tp2 = getFeatConfig('bt', 'tp2Percent', '200');
  const mode = getFeatConfig('bt', 'mode', 'trades');
  const limit = getFeatConfig('bt', 'limit', '1000');
  const startDate = getFeatConfig('bt', 'startDate', '2024-01-01');
  const endDate = getFeatConfig('bt', 'endDate', '2025-12-31');
  const text = `\ud83d\udcca <b>Backtest ST</b>\nSL: ${sl}% | TP1: ${tp1}% | TP2: ${tp2}%\nMode: ${mode} | Limit: ${limit}\n\ud83d\udcc5 ${startDate} \u2192 ${endDate}`;
  sendMenu(bot, chatId, msgId, text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '\ud83d\udcca Status', callback_data: 'bt_status' }],
        [{ text: '\u2699\ufe0f Config', callback_data: 'bt_config' }],
        [{ text: '\u2795 Manage Pair', callback_data: 'bt_managepair' }],
        [{ text: '\u2796 Remove Pair', callback_data: 'bt_removepair' }],
        [{ text: '\u25b6\ufe0f Run Backtest', callback_data: 'bt_run' }],
        [{ text: '\ud83d\udd19 Main Menu', callback_data: 'bt_mainback' }],
      ]
    }
  });
}

function showBtConfigMenu(bot, chatId, msgId) {
  const sl = getFeatConfig('bt', 'slPercent', '-2');
  const tp1 = getFeatConfig('bt', 'tp1Percent', '1');
  const tp2 = getFeatConfig('bt', 'tp2Percent', '200');
  const mode = getFeatConfig('bt', 'mode', 'trades');
  const limit = getFeatConfig('bt', 'limit', '1000');
  const startDate = getFeatConfig('bt', 'startDate', '2024-01-01');
  const endDate = getFeatConfig('bt', 'endDate', '2025-12-31');
  const text = `\u2699\ufe0f <b>Backtest ST Config</b>\n\n\ud83d\udcc9 SL: ${sl}%\n\ud83d\udcc8 TP1: ${tp1}%\n\ud83c\udfaf TP2: ${tp2}%\n\ud83d\udcca Mode: ${mode}\n\ud83d\udd22 Limit: ${limit}\n\ud83d\udcc5 Mulai: ${startDate}\n\ud83d\udcc5 Akhir: ${endDate}`;
  sendMenu(bot, chatId, msgId, text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: `\ud83d\udcc9 SL ${sl}%`, callback_data: 'bt_config_sl' }],
        [{ text: `\ud83d\udcc8 TP1 ${tp1}%`, callback_data: 'bt_config_tp1' }],
        [{ text: `\ud83c\udfaf TP2 ${tp2}%`, callback_data: 'bt_config_tp2' }],
        [{ text: `\ud83d\udcca Mode: ${mode}`, callback_data: 'bt_config_mode' }],
        [{ text: `\ud83d\udd22 Limit: ${limit}`, callback_data: 'bt_config_limit' }],
        [{ text: `\ud83d\udcc5 Mulai: ${startDate}`, callback_data: 'bt_config_startdate' }],
        [{ text: `\ud83d\udcc5 Akhir: ${endDate}`, callback_data: 'bt_config_enddate' }],
        [{ text: '\ud83d\udd19 Back', callback_data: 'bt_config_back' }],
      ]
    }
  });
}

function showBtManagePair(bot, chatId, msgId) {
  const pairs = loadPairsFor('bt_pairs');
  const keys = Object.keys(pairs);
  const rows = [];
  for (const t of keys) {
    rows.push([{ text: `\u274c ${t} (${pairs[t].join(',')})`, callback_data: `bt_removepair_${t}` }]);
  }
  rows.push([{ text: '\u2795 Add New Pair', callback_data: 'bt_addpair' }]);
  rows.push([{ text: '\ud83d\udd19 Back', callback_data: 'bt_config_back' }]);
  const text = keys.length ? 'Pilih pair untuk dihapus, atau Add New:' : 'Belum ada pair. Ketik nama ticker untuk menambah (contoh: BTCUSDT):';
  sendMenu(bot, chatId, msgId, text, { reply_markup: { inline_keyboard: rows } });
}

function showBtRemovePair(bot, chatId, msgId) {
  const rows = db.prepare("SELECT DISTINCT ticker,timeframe FROM backtest_summary ORDER BY ticker").all();
  if (!rows.length) {
    return sendMenu(bot, chatId, msgId, 'Belum ada data backtest.', { reply_markup: { inline_keyboard: [[{ text: '\ud83d\udd19 Back', callback_data: 'bt_config_back' }]] } });
  }
  const grouped = {};
  for (const r of rows) {
    if (!grouped[r.ticker]) grouped[r.ticker] = [];
    grouped[r.ticker].push(r.timeframe);
  }
  const buttons = [];
  for (const [ticker, tfs] of Object.entries(grouped)) {
    buttons.push([{ text: `\ud83d\uddd1 ${ticker} (${tfs.join(',')})`, callback_data: `bt_removepair_${ticker}` }]);
  }
  buttons.push([{ text: '\ud83d\udd19 Back', callback_data: 'bt_config_back' }]);
  sendMenu(bot, chatId, msgId, 'Pilih pair yang data backtestnya akan dihapus:', { reply_markup: { inline_keyboard: buttons } });
}

async function handleBtRun(bot, chatId, msgId, conv) {
  const ticker = conv && conv.data && conv.data.ticker ? conv.data.ticker : null;
  const tf = conv && conv.data && conv.data.tf ? conv.data.tf : null;
  const msg = await sendMenu(bot, chatId, null, `\u23f3 Running backtest ${ticker || 'semua pair'}${tf ? ' ' + tf : ''}...`);
  const resultText = await runBacktest(ticker, tf, bot, chatId, msg ? msg.message_id : msgId);
  sendMenu(bot, chatId, null, resultText, { parse_mode: 'HTML' });
}

module.exports = {
  runBacktest,
  register(bot) {
    const conv = {};

    function handleCallback(query) {
      const chatId = query.message.chat.id;
      const msgId = query.message.message_id;
      const data = query.data;

      try {
        if (data === 'bt_status') {
          sendMenu(bot, chatId, msgId, formatSummaryMessage(), { parse_mode: 'HTML' });
          return { action: null };
        }
        if (data === 'bt_config') {
          showBtConfigMenu(bot, chatId, msgId);
          return { action: null };
        }
        if (data === 'bt_managepair') {
          showBtManagePair(bot, chatId, msgId);
          return { action: null };
        }
        if (data === 'bt_removepair') {
          showBtRemovePair(bot, chatId, msgId);
          return { action: null };
        }
        if (data === 'bt_run') {
          conv[chatId] = { cmd: 'bt_run', step: 'ticker', data: {} };
          sendMenu(bot, chatId, msgId, 'Masukkan ticker (atau gunakan <code>semua</code> untuk semua pair):', {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: '\u274c Batal', callback_data: 'bt_config_back' }]] }
          });
          return { action: null };
        }
        if (data === 'bt_mainback') {
          return { action: 'main_back' };
        }
        if (data === 'bt_config_sl' || data === 'bt_config_tp1' || data === 'bt_config_tp2') {
          const stepMap = { bt_config_sl: 'slPercent', bt_config_tp1: 'tp1Percent', bt_config_tp2: 'tp2Percent' };
          const labelMap = { bt_config_sl: 'SL', bt_config_tp1: 'TP1', bt_config_tp2: 'TP2' };
          const defMap = { bt_config_sl: '-2', bt_config_tp1: '1', bt_config_tp2: '200' };
          const cur = getFeatConfig('bt', stepMap[data], defMap[data]);
          conv[chatId] = { cmd: 'bt_config', step: stepMap[data], data: {} };
          sendMenu(bot, chatId, msgId, `${labelMap[data]} saat ini: ${cur}%\nMasukkan nilai baru (contoh: ${data === 'bt_config_sl' ? '-5' : '3'}):`, {
            reply_markup: { inline_keyboard: [[{ text: '\u274c Batal', callback_data: 'bt_config_back' }]] }
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
          conv[chatId] = { cmd: 'bt_config', step: 'limit', data: {} };
          sendMenu(bot, chatId, msgId, `Limit saat ini: ${cur}\nMasukkan angka baru (jumlah trade/hari):`, {
            reply_markup: { inline_keyboard: [[{ text: '\u274c Batal', callback_data: 'bt_config_back' }]] }
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
        if (data === 'bt_config_back') {
          showBtFeatureMenu(bot, chatId, msgId);
          return { action: null };
        }

        if (data.startsWith('bt_removepair_')) {
          const ticker = data.replace('bt_removepair_', '');
          try {
            db.prepare('DELETE FROM bt_pairs WHERE ticker = ?').run(ticker);
            db.prepare('DELETE FROM backtest_trades WHERE ticker = ?').run(ticker);
            db.prepare('DELETE FROM backtest_summary WHERE ticker = ?').run(ticker);
            sendMenu(bot, chatId, msgId, `\u2705 ${ticker} dan data backtest-nya dihapus.`);
          } catch (e) {
            sendMenu(bot, chatId, msgId, `\u274c Gagal menghapus: ${e.message}`);
          }
          return { action: null };
        }

        if (data === 'bt_addpair') {
          conv[chatId] = { cmd: 'bt_managepair', step: 'ticker', data: {} };
          sendMenu(bot, chatId, msgId, 'Masukkan ticker yang ingin ditambahkan (contoh: BTCUSDT):', {
            reply_markup: { inline_keyboard: [[{ text: '\u274c Batal', callback_data: 'bt_config_back' }]] }
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
              sendMenu(bot, chatId, null, `\u2705 Tanggal ${s.calTarget === 'bt_startDate' ? 'mulai' : 'akhir'} disimpan: ${dateStr}`);
            }
          } else if (calData === 'del') {
            if (s.calDate) {
              delete s.calDate;
              showCalendar(bot, chatId, null, s.calTarget, s);
            } else {
              upsertConfig(s.calTarget, '');
              delete conv[chatId];
              sendMenu(bot, chatId, null, `\u2705 Tanggal ${s.calTarget === 'bt_startDate' ? 'mulai' : 'akhir'} dihapus`);
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
          if (session.step === 'slPercent' || session.step === 'tp1Percent' || session.step === 'tp2Percent' || session.step === 'limit') {
            const val = session.step === 'limit' ? parseInt(text, 10) : parseFloat(text);
            if (isNaN(val)) {
              sendMenu(bot, chatId, null, '\u274c Masukkan angka yang valid.');
              return true;
            }
            const key = session.step === 'limit' ? 'bt_limit' : `bt_${session.step}`;
            upsertConfig(key, val);
            const label = { slPercent: 'SL', tp1Percent: 'TP1', tp2Percent: 'TP2', limit: 'Limit' }[session.step] || session.step;
            delete conv[chatId];
            sendMenu(bot, chatId, null, `\u2705 ${label} diubah ke ${val}${session.step === 'limit' ? '' : '%'}`);
            showBtConfigMenu(bot, chatId, null);
            return true;
          }
        }

        if (session.cmd === 'bt_managepair') {
          if (session.step === 'ticker') {
            const ticker = text.toUpperCase();
            session.data = { ticker };
            session.step = 'timeframes';
            sendMenu(bot, chatId, null, `Ticker: ${ticker}\nMasukkan timeframe (pisahkan koma). Contoh: <code>15m,1h,4h</code>`, { parse_mode: 'HTML' });
            return true;
          }
          if (session.step === 'timeframes') {
            const tfs = text.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
            const invalid = tfs.filter(tf => !VALID_TIMEFRAMES.includes(tf));
            if (invalid.length) {
              sendMenu(bot, chatId, null, `\u274c Timeframe tidak valid: ${invalid.join(', ')}`);
              return true;
            }
            const ticker = session.data.ticker;
            const insPair = db.prepare('INSERT OR IGNORE INTO bt_pairs (ticker, timeframe) VALUES (?, ?)');
            db.transaction(() => {
              for (const tf of tfs) insPair.run(ticker, tf);
            })();
            delete conv[chatId];
            sendMenu(bot, chatId, null, `\u2705 ${ticker} ditambahkan: ${tfs.join(', ')}`);
            return true;
          }
        }

        if (session.cmd === 'bt_run') {
          const raw = text.toUpperCase();
          if (raw === 'SEMUA') {
            session.data = { ticker: null, tf: null };
          } else {
            const parts = raw.split(/\s+/);
            session.data = { ticker: parts[0], tf: parts[1] ? parts[1].toLowerCase() : null };
          }
          delete conv[chatId];
          await handleBtRun(bot, chatId, null, session);
          return true;
        }
      } catch (e) {
        console.error('BT message handler error:', e.message);
        try { sendMenu(bot, chatId, null, `\u274c Error: ${e.message}`); } catch (_) {}
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
