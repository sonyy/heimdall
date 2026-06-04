const { db, getFeatConfig, upsertConfig, loadPairsFor } = require('./db');
const { fetchKlines, fetchKlinesRange, fetchCandles, VALID_TIMEFRAMES, tfToMinutes } = require('./exchange');

const PERP_SIGNAL_TIMEOUT = 200;
const PERP_COOLDOWN = 5;
const PERP_EXTEND_CANCEL_PCT = 4;

function calcPerpPnl(direction, entry, exit) {
  if (direction === 'LONG') return ((exit - entry) / entry) * 100;
  return ((entry - exit) / entry) * 100;
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

function openPerpTrade(ticker, direction, price, signal, slPrice, tpPrice, source) {
  db.prepare(`INSERT INTO perp_trades (ticker,direction,entry_price,sl_price,tp_price,entry_signal,source) VALUES (?,?,?,?,?,?,?)`)
    .run(ticker, direction, price, slPrice, tpPrice, signal, source || 'live');
}

function closePerpTrade(id, closePrice, result) {
  const t = db.prepare('SELECT * FROM perp_trades WHERE id=?').get(id);
  if (!t) return;
  const pnl = calcPerpPnl(t.direction, t.entry_price, closePrice);
  db.prepare(`UPDATE perp_trades SET close_price=?, pnl=?, result=?, closed_at=datetime('now') WHERE id=?`)
    .run(closePrice, pnl.toFixed(2), result, id);
}

async function sendMenu(bot, chatId, msgId, text, opts) {
  if (msgId) {
    try { return await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, ...opts }); } catch (e) {}
  } else {
    try { return await bot.sendMessage(chatId, text, opts); } catch (e) {}
  }
}

function showPerpFeatureMenu(bot, chatId, msgId) {
  const running = getFeatConfig('perp', 'running', '0') === '1';
  const pairs = loadPairsFor('perp_pairs');
  const pairCount = Object.keys(pairs).length;
  const openCount = db.prepare("SELECT COUNT(*) as c FROM perp_trades WHERE result IS NULL AND source='live'").get().c;
  const text = `\ud83d\udd01 <b>Perpetual MS</b>\n${running ? '\u2705 Running' : '\u274c Idle'} \u00b7 ${pairCount} pairs \u00b7 ${openCount} open trades\n\nPilih aksi:`;
  sendMenu(bot, chatId, msgId, text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '\ud83d\udccb Status', callback_data: 'perp_status' }],
        [{ text: '\u2699\ufe0f Config', callback_data: 'perp_config' }],
        [{ text: '\u2795 Add Pair', callback_data: 'perp_managepair' }],
        [{ text: '\u2796 Remove Pair', callback_data: 'perp_removepair' }],
        [{ text: running ? '\u23f9 Stop' : '\u25b6\ufe0f Start', callback_data: 'perp_run' }],
        [{ text: '\ud83d\udd19 Main Menu', callback_data: 'perp_mainback' }],
      ]
    }
  });
}

function showPerpConfig(bot, chatId, msgId) {
  const sl = getFeatConfig('perp', 'slPercent', '-2');
  const tp1 = getFeatConfig('perp', 'tp1Percent', '1');
  const tp2 = getFeatConfig('perp', 'tp2Percent', '200');
  const waitMode = getFeatConfig('perp', 'waitMode', 'trend');
  const lookback = getFeatConfig('perp', 'swingLookback', '2');
  const volumeThreshold = getFeatConfig('perp', 'volumeThreshold', '150');
  const running = getFeatConfig('perp', 'running', '0') === '1';
  const btEnabled = getFeatConfig('perp', 'btEnabled', '1') === '1';
  const startDate = getFeatConfig('perp', 'startDate', '');
  const endDate = getFeatConfig('perp', 'endDate', '');
  const text = `\u2699\ufe0f <b>Perpetual MS Config</b>\n\nSL: ${sl}%\nTP1: ${tp1}%\nTP2: ${tp2}%\nWait Mode: ${waitMode}\nSwing Lookback: ${lookback}\nVolume Threshold: ${volumeThreshold}%\nRunning: ${running ? '\u2705' : '\u274c'}\nBTP Enabled: ${btEnabled ? '\u2705' : '\u274c'}\nStart: ${startDate || '\u2014'}\nEnd: ${endDate || '\u2014'}`;
  sendMenu(bot, chatId, msgId, text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: `\ud83d\udcc9 SL ${sl}%`, callback_data: 'perp_config_sl' }, { text: `\ud83d\udcc8 TP1 ${tp1}%`, callback_data: 'perp_config_tp1' }],
        [{ text: `\ud83c\udfaf TP2 ${tp2}%`, callback_data: 'perp_config_tp2' }],
        [{ text: `\u23f3 Wait: ${waitMode}`, callback_data: 'perp_config_waitmode' }, { text: `\ud83d\udccf Lookback ${lookback}`, callback_data: 'perp_config_lookback' }],
        [{ text: `\ud83d\udd0a VolThr ${volumeThreshold}%`, callback_data: 'perp_config_volumethreshold' }],
        [{ text: running ? '\u23f9 Stop' : '\u25b6\ufe0f Start', callback_data: 'perp_config_toggle' }, { text: `BTP ${btEnabled ? '\u2705' : '\u274c'}`, callback_data: 'perp_config_btp_toggle' }],
        [{ text: `\ud83d\udcc5 Mulai: ${startDate || '\u2014'}`, callback_data: 'perp_config_startdate' }, { text: `\ud83d\udcc5 Akhir: ${endDate || '\u2014'}`, callback_data: 'perp_config_enddate' }],
        [{ text: '\u25b6\ufe0f Run BTP', callback_data: 'perp_btp' }],
        [{ text: '\ud83d\udd19 Back', callback_data: 'perp_config_back' }],
      ]
    }
  });
}

function showCalendar(bot, chatId, target, conv) {
  const s = conv[chatId];
  if (!s) return;
  const year = s.calYear;
  const month = s.calMonth;
  const monthNames = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'];
  const dayNames = ['Sn','Mn','Rn','Km','Jm','Sb','Mg'];
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const rows = [];
  rows.push([
    { text: '\u25c0', callback_data: 'perp_cal_prev' },
    { text: monthNames[month] + ' ' + year, callback_data: 'perp_cal_nop' },
    { text: '\u25b6', callback_data: 'perp_cal_next' },
  ]);
  rows.push([
    { text: '\u23ea', callback_data: 'perp_cal_pyear' },
    { text: String(year), callback_data: 'perp_cal_nop' },
    { text: '\u23e9', callback_data: 'perp_cal_nyear' },
  ]);
  const weekRow = [];
  for (let d = 0; d < 7; d++) weekRow.push({ text: dayNames[d], callback_data: 'perp_cal_nop' });
  rows.push(weekRow);
  let week = [];
  const startOffset = (firstDay + 6) % 7;
  for (let i = 0; i < startOffset; i++) week.push({ text: ' ', callback_data: 'perp_cal_nop' });
  for (let day = 1; day <= daysInMonth; day++) {
    const ds = year + ('0' + (month + 1)).slice(-2) + ('0' + day).slice(-2);
    const isSelected = s.calDate === ds;
    week.push({ text: (isSelected ? '[' : '') + day + (isSelected ? ']' : ''), callback_data: 'perp_cal_set_' + ds });
    if (week.length === 7) { rows.push(week); week = []; }
  }
  if (week.length) rows.push(week);
  const bottom = [];
  if (s.calDate) {
    const d = s.calDate;
    bottom.push({ text: `\u2705 ${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`, callback_data: 'perp_cal_ok' });
  }
  bottom.push({ text: '\ud83d\uddd1 Hapus', callback_data: 'perp_cal_del' });
  bottom.push({ text: '\u274c Batal', callback_data: 'perp_cal_cancel' });
  rows.push(bottom);
  const label = target === 'start' ? 'mulai' : 'akhir';
  if (s.calMsgId) {
    bot.editMessageText(`\ud83d\udcc5 Pilih tanggal ${label}:`, { chat_id: chatId, message_id: s.calMsgId, reply_markup: { inline_keyboard: rows } }).catch(() => {});
  } else {
    bot.sendMessage(chatId, `\ud83d\udcc5 Pilih tanggal ${label}:`, { reply_markup: { inline_keyboard: rows } }).then(m => { s.calMsgId = m.message_id; }).catch(() => {});
  }
}

async function showPerpStatus(bot, chatId) {
  try {
    const running = getFeatConfig('perp', 'running', '0') === '1';
    const waitMode = getFeatConfig('perp', 'waitMode', 'trend');
    const lookback = getFeatConfig('perp', 'swingLookback', '2');
    const openTrades = db.prepare("SELECT * FROM perp_trades WHERE result IS NULL AND source='live'").all();
    const liveClosed = db.prepare("SELECT COUNT(*) as c FROM perp_trades WHERE result IS NOT NULL AND source='live'").get().c;
    const btClosed = db.prepare("SELECT COUNT(*) as c FROM perp_trades WHERE result IS NOT NULL AND source='backtest'").get().c;
    const liveWin = db.prepare("SELECT COUNT(*) as c FROM perp_trades WHERE result='WIN' AND source='live'").get().c;
    const liveLose = db.prepare("SELECT COUNT(*) as c FROM perp_trades WHERE result='LOSE' AND source='live'").get().c;
    const btWin = db.prepare("SELECT COUNT(*) as c FROM perp_trades WHERE result='WIN' AND source='backtest'").get().c;
    const btLose = db.prepare("SELECT COUNT(*) as c FROM perp_trades WHERE result='LOSE' AND source='backtest'").get().c;
    const lines = [
      `\ud83d\udd01 <b>Perpetual MS Status</b>`,
      ``,
      `Status: ${running ? '\u2705 Running' : '\u274c Idle'}`,
      `Wait Mode: ${waitMode}`,
      `Swing Lookback: ${lookback}`,
      ``,
    ];
    if (openTrades.length) {
      lines.push('<b>Open Positions:</b>');
      for (const t of openTrades) {
        const pnl = calcPerpPnl(t.direction, t.entry_price, t.entry_price); // placeholder
        const unrealized = db.prepare('SELECT pnl FROM perp_trades WHERE id=?').get(t.id)?.pnl || '0';
        lines.push(`  ${t.ticker} ${t.direction} @ ${t.entry_price} SL:${t.sl_price} TP:${t.tp_price} PnL:${unrealized}%`);
      }
      lines.push('');
    }
    lines.push(`<b>Trade History:</b>`);
    lines.push(`  Live: ${liveWin}W / ${liveLose}L (${liveWin + liveLose} total, ${liveClosed} closed)`);
    lines.push(`  Backtest: ${btWin}W / ${btLose}L (${btWin + btLose} total, ${btClosed} closed)`);
    bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
  } catch (e) {
    console.error('perp status error:', e.message);
  }
}

async function processPerpetual(pairs, bot) {
  const running = getFeatConfig('perp', 'running', '0');
  if (running === '0') return;

  const swingLookback = Number(getFeatConfig('perp', 'swingLookback', '2'));
  const waitMode = getFeatConfig('perp', 'waitMode', 'trend');
  const volumeThreshold = Number(getFeatConfig('perp', 'volumeThreshold', '150'));
  const slPct = Number(getFeatConfig('perp', 'slPercent', '-2'));
  const tp1Pct = Number(getFeatConfig('perp', 'tp1Percent', '1'));
  const tp2Pct = Number(getFeatConfig('perp', 'tp2Percent', '200'));

  for (const [ticker, timeframes] of Object.entries(pairs)) {
    if (!timeframes || !timeframes.length) continue;
    const tf = timeframes[0];
    try {
      const { data: candles } = await fetchCandles(ticker, tf, 200);
      if (!candles || candles.length < swingLookback * 2 + 5) continue;

      const levels = findSwingLevels(candles, swingLookback);
      const lastCandle = candles[candles.length - 1];
      const price = lastCandle.close;
      const lowPrice = lastCandle.low;
      const highPrice = lastCandle.high;
      const volume = lastCandle.volume;

      const openTrade = db.prepare("SELECT * FROM perp_trades WHERE ticker=? AND result IS NULL AND source='live'").get(ticker);

      if (openTrade) {
        const pnl = calcPerpPnl(openTrade.direction, openTrade.entry_price, price);
        db.prepare('UPDATE perp_trades SET pnl=? WHERE id=?').run(pnl.toFixed(2), openTrade.id);
        if (openTrade.direction === 'LONG') {
          if (lowPrice <= openTrade.sl_price) { closePerpTrade(openTrade.id, openTrade.sl_price, 'LOSE'); continue; }
          if (highPrice >= openTrade.tp_price) { closePerpTrade(openTrade.id, openTrade.tp_price, 'WIN'); continue; }
        } else {
          if (highPrice >= openTrade.sl_price) { closePerpTrade(openTrade.id, openTrade.sl_price, 'LOSE'); continue; }
          if (lowPrice <= openTrade.tp_price) { closePerpTrade(openTrade.id, openTrade.tp_price, 'WIN'); continue; }
        }
        continue;
      }

      if (levels.highs.length < 2 || levels.lows.length < 2) continue;

      const lastHigh = levels.highs[levels.highs.length - 1].price;
      const prevHigh = levels.highs[levels.highs.length - 2].price;
      const lastLow = levels.lows[levels.lows.length - 1].price;
      const prevLow = levels.lows[levels.lows.length - 2].price;

      const sig = perpSignals[ticker];

      if (sig && sig.entryState === 'inactive') {
        sig.cooldownCount--;
        if (sig.cooldownCount <= 0) delete perpSignals[ticker];
        continue;
      }

      if (sig && sig.entryState === 'pending_long' && sig.breakLevel) {
        sig.signalCandleCount = (sig.signalCandleCount || 0) + 1;
        if (sig.signalCandleCount > PERP_SIGNAL_TIMEOUT) {
          sig.entryState = 'inactive';
          sig.cooldownCount = PERP_COOLDOWN;
          continue;
        }
        if (price > sig.breakLevel * (1 + PERP_EXTEND_CANCEL_PCT / 100)) {
          sig.entryState = 'inactive';
          sig.cooldownCount = PERP_COOLDOWN;
          continue;
        }
        if (price < sig.breakLevel * 0.995) {
          delete perpSignals[ticker];
          continue;
        }
        if (waitMode === 'trend') {
          if (!sig.retested && lowPrice <= sig.breakLevel * 1.005) sig.retested = true;
          if (sig.retested && price > sig.breakLevel) {
            const sl = price * (1 + slPct / 100);
            const tp = price * (1 + tp2Pct / 100);
            openPerpTrade(ticker, 'LONG', price, 'BOS-L (retest)', sl, tp, 'live');
            delete perpSignals[ticker];
            continue;
          }
        }
        continue;
      }

      if (sig && sig.entryState === 'pending_short' && sig.breakLevel) {
        sig.signalCandleCount = (sig.signalCandleCount || 0) + 1;
        if (sig.signalCandleCount > PERP_SIGNAL_TIMEOUT) {
          sig.entryState = 'inactive';
          sig.cooldownCount = PERP_COOLDOWN;
          continue;
        }
        if (price < sig.breakLevel * (1 - PERP_EXTEND_CANCEL_PCT / 100)) {
          sig.entryState = 'inactive';
          sig.cooldownCount = PERP_COOLDOWN;
          continue;
        }
        if (price > sig.breakLevel * 1.005) {
          delete perpSignals[ticker];
          continue;
        }
        if (waitMode === 'trend') {
          if (!sig.retested && highPrice >= sig.breakLevel * 0.995) sig.retested = true;
          if (sig.retested && price < sig.breakLevel) {
            const sl = price * (1 - slPct / 100);
            const tp = price * (1 - tp1Pct / 100);
            openPerpTrade(ticker, 'SHORT', price, 'BOS-S (retest)', sl, tp, 'live');
            delete perpSignals[ticker];
            continue;
          }
        }
        continue;
      }

      if (sig && sig.entryState === 'pending_long' && !sig.breakLevel) {
        if (price > lastHigh) {
          sig.breakLevel = lastHigh;
          sig.signalCandleCount = 0;
          if (waitMode === 'volume') {
            const avgVol = avgVolume(candles, 20);
            if (volume >= avgVol * (volumeThreshold / 100)) {
              const sl = price * (1 + slPct / 100);
              const tp = price * (1 + tp2Pct / 100);
              openPerpTrade(ticker, 'LONG', price, `BOS-L (vol ${(volume/avgVol*100).toFixed(0)}%)`, sl, tp, 'live');
              delete perpSignals[ticker];
              continue;
            }
          }
        }
        continue;
      }

      if (sig && sig.entryState === 'pending_short' && !sig.breakLevel) {
        if (price < lastLow) {
          sig.breakLevel = lastLow;
          sig.signalCandleCount = 0;
          if (waitMode === 'volume') {
            const avgVol = avgVolume(candles, 20);
            if (volume >= avgVol * (volumeThreshold / 100)) {
              const sl = price * (1 - slPct / 100);
              const tp = price * (1 - tp1Pct / 100);
              openPerpTrade(ticker, 'SHORT', price, `BOS-S (vol ${(volume/avgVol*100).toFixed(0)}%)`, sl, tp, 'live');
              delete perpSignals[ticker];
              continue;
            }
          }
        }
        continue;
      }

      if (!sig) {
        const higherHigh = lastHigh > prevHigh;
        const higherLow = lastLow > prevLow;
        const lowerHigh = lastHigh < prevHigh;
        const lowerLow = lastLow < prevLow;

        if (higherHigh && higherLow) {
          perpSignals[ticker] = {
            entryState: 'pending_long',
            pendingHigh: lastHigh,
            pendingLow: lastLow,
            breakLevel: null,
            signalCandleCount: 0,
            retested: false,
            cooldownCount: 0,
          };
        } else if (lowerHigh && lowerLow) {
          perpSignals[ticker] = {
            entryState: 'pending_short',
            pendingHigh: lastHigh,
            pendingLow: lastLow,
            breakLevel: null,
            signalCandleCount: 0,
            retested: false,
            cooldownCount: 0,
          };
        }
      }
    } catch (e) {
      console.error(`Perpetual error ${ticker}:`, e.message);
    }
  }
}

async function runBacktestPerp(ticker, bot, chatId, msgId) {
  const swingLookback = Number(getFeatConfig('perp', 'swingLookback', '2'));
  const waitMode = getFeatConfig('perp', 'waitMode', 'trend');
  const volumeThreshold = Number(getFeatConfig('perp', 'volumeThreshold', '150'));
  const slPct = Number(getFeatConfig('perp', 'slPercent', '-2'));
  const tp1Pct = Number(getFeatConfig('perp', 'tp1Percent', '1'));
  const tp2Pct = Number(getFeatConfig('perp', 'tp2Percent', '200'));
  const btStartDate = getFeatConfig('perp', 'startDate', '');
  const btEndDate = getFeatConfig('perp', 'endDate', '');
  const useDateRange = !!(btStartDate && btEndDate);

  const insTrade = db.prepare(`INSERT INTO perp_trades (ticker,direction,entry_price,close_price,pnl,sl_price,tp_price,result,entry_signal,source,opened_at,closed_at) VALUES (?,?,?,?,?,?,?,?,?,'backtest',?,?)`);

  db.prepare("DELETE FROM perp_trades WHERE source='backtest'").run();

  const pairs = ticker
    ? { [ticker]: loadPairsFor('perp_pairs')[ticker] || [] }
    : loadPairsFor('perp_pairs');

  const tickers = Object.keys(pairs).filter(t => pairs[t] && pairs[t].length);
  const results = [];

  for (let ti = 0; ti < tickers.length; ti++) {
    const t = tickers[ti];
    const tf = pairs[t][0];
    const progress = Math.round(((ti + 1) / tickers.length) * 100);
    if (chatId && msgId && (ti % Math.max(1, Math.floor(tickers.length / 10)) === 0 || ti === tickers.length - 1)) {
      try {
        await bot.editMessageText(`\u23f3 Backtest Perpetual: ${progress}% (${t})`, { chat_id: chatId, message_id: msgId });
      } catch (e) {}
    }

    try {
      let candleLimit, endTime, startTime;
      if (useDateRange) {
        const startTs = new Date(btStartDate).getTime();
        const endTs = new Date(btEndDate).getTime() + 86400000;
        const tfMin = tfToMinutes(tf);
        candleLimit = Math.min(Math.ceil((endTs - startTs) / (60000 * tfMin)), 100000) + 200;
        endTime = endTs;
        startTime = startTs;
      } else {
        candleLimit = 2000;
        endTime = null;
        startTime = null;
      }

      const { data: candles } = await fetchKlinesRange(t, tf, candleLimit, endTime, startTime);
      if (!candles || candles.length < 100) {
        results.push(`\u26a0\ufe0f ${t}: insufficient data`);
        continue;
      }

      let openTrade = null;
      let signal = null;
      let cooldown = 0;
      let tradeCount = 0;
      const BACKTEST_ANALYSIS_START = 60;

      for (let i = BACKTEST_ANALYSIS_START; i < candles.length; i++) {
        const windowData = candles.slice(Math.max(0, i - 120), i + 1);
        const levels = findSwingLevels(windowData, swingLookback);

        const c = candles[i];
        const price = c.close;
        const lowPrice = c.low;
        const highPrice = c.high;
        const volume = c.volume;
        const ts = new Date(candles[i].openTime || Date.now()).toISOString().replace('T', ' ').slice(0, 19);

        if (openTrade) {
          let closed = false;
          if (openTrade.direction === 'LONG') {
            if (lowPrice <= openTrade.sl) {
              const cp = openTrade.sl;
              const pnl = calcPerpPnl('LONG', openTrade.entry, cp);
              insTrade.run(t, 'LONG', openTrade.entry, cp, pnl.toFixed(2), openTrade.sl, openTrade.tp, 'LOSE', openTrade.signal, openTrade.openAt, ts);
              tradeCount++;
              closed = true;
            } else if (highPrice >= openTrade.tp) {
              const cp = openTrade.tp;
              const pnl = calcPerpPnl('LONG', openTrade.entry, cp);
              insTrade.run(t, 'LONG', openTrade.entry, cp, pnl.toFixed(2), openTrade.sl, openTrade.tp, 'WIN', openTrade.signal, openTrade.openAt, ts);
              tradeCount++;
              closed = true;
            }
          } else {
            if (highPrice >= openTrade.sl) {
              const cp = openTrade.sl;
              const pnl = calcPerpPnl('SHORT', openTrade.entry, cp);
              insTrade.run(t, 'SHORT', openTrade.entry, cp, pnl.toFixed(2), openTrade.sl, openTrade.tp, 'LOSE', openTrade.signal, openTrade.openAt, ts);
              tradeCount++;
              closed = true;
            } else if (lowPrice <= openTrade.tp) {
              const cp = openTrade.tp;
              const pnl = calcPerpPnl('SHORT', openTrade.entry, cp);
              insTrade.run(t, 'SHORT', openTrade.entry, cp, pnl.toFixed(2), openTrade.sl, openTrade.tp, 'WIN', openTrade.signal, openTrade.openAt, ts);
              tradeCount++;
              closed = true;
            }
          }
          if (closed) { openTrade = null; signal = null; continue; }
          continue;
        }

        if (signal) {
          if (i - signal.since > PERP_SIGNAL_TIMEOUT) { signal = null; cooldown = i; continue; }
          if (signal.direction === 'LONG') {
            if (price > signal.level * (1 + PERP_EXTEND_CANCEL_PCT / 100)) { signal = null; cooldown = i; continue; }
            if (price < signal.level * 0.995) { signal = null; continue; }
            if (waitMode === 'trend') {
              if (!signal.retested && lowPrice <= signal.level * 1.005) signal.retested = true;
              if (signal.retested && price > signal.level) {
                openTrade = { entry: price, sl: price * (1 + slPct / 100), tp: price * (1 + tp2Pct / 100), direction: 'LONG', signal: 'BOS-L (retest)', openAt: ts };
                signal = null;
                continue;
              }
            }
          } else {
            if (price < signal.level * (1 - PERP_EXTEND_CANCEL_PCT / 100)) { signal = null; cooldown = i; continue; }
            if (price > signal.level * 1.005) { signal = null; continue; }
            if (waitMode === 'trend') {
              if (!signal.retested && highPrice >= signal.level * 0.995) signal.retested = true;
              if (signal.retested && price < signal.level) {
                openTrade = { entry: price, sl: price * (1 - slPct / 100), tp: price * (1 - tp1Pct / 100), direction: 'SHORT', signal: 'BOS-S (retest)', openAt: ts };
                signal = null;
                continue;
              }
            }
          }
          continue;
        }

        if (cooldown && i - cooldown < PERP_COOLDOWN) continue;

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
            if (waitMode === 'volume') {
              const avgVol = avgVolume(windowData, 20);
              if (volume >= avgVol * (volumeThreshold / 100)) {
                openTrade = { entry: price, sl: price * (1 + slPct / 100), tp: price * (1 + tp2Pct / 100), direction: 'LONG', signal: `BOS-L (vol ${(volume/avgVol*100).toFixed(0)}%)`, openAt: ts };
                continue;
              }
            }
            signal = { direction: 'LONG', level: lastHigh, since: i, retested: false };
          }
        } else if (lowerHigh && lowerLow) {
          if (price < lastLow) {
            if (waitMode === 'volume') {
              const avgVol = avgVolume(windowData, 20);
              if (volume >= avgVol * (volumeThreshold / 100)) {
                openTrade = { entry: price, sl: price * (1 - slPct / 100), tp: price * (1 - tp1Pct / 100), direction: 'SHORT', signal: `BOS-S (vol ${(volume/avgVol*100).toFixed(0)}%)`, openAt: ts };
                continue;
              }
            }
            signal = { direction: 'SHORT', level: lastLow, since: i, retested: false };
          }
        }
      }

      if (openTrade) {
        const lastPrice = candles[candles.length - 1].close;
        const pnl = calcPerpPnl(openTrade.direction, openTrade.entry, lastPrice);
        const lastTs = new Date(candles[candles.length - 1].openTime || Date.now()).toISOString().replace('T', ' ').slice(0, 19);
        const r = pnl > 0 ? 'WIN' : 'LOSE';
        insTrade.run(t, openTrade.direction, openTrade.entry, lastPrice, pnl.toFixed(2), openTrade.sl, openTrade.tp, r, openTrade.signal, openTrade.openAt, lastTs);
        tradeCount++;
      }

      if (tradeCount) {
        const btTrades = db.prepare("SELECT result FROM perp_trades WHERE ticker=? AND source='backtest' AND result IS NOT NULL").all(t);
        const win = btTrades.filter(r => r.result === 'WIN').length;
        const lose = btTrades.filter(r => r.result === 'LOSE').length;
        const total = win + lose;
        const totalPnl = btTrades.reduce((s, r) => {
          const row = db.prepare("SELECT pnl FROM perp_trades WHERE ticker=? AND source='backtest' AND result=?").get(t, r.result);
          return s + parseFloat(row?.pnl || 0);
        }, 0);
        const wr = total ? ((win / total) * 100).toFixed(1) : '0';
        results.push(`${t}: ${total} trade (${win}W/${lose}L) ${wr}% WR`);
      } else {
        results.push(`${t}: no trades`);
      }
    } catch (e) {
      console.error(`Backtest perp ${t}:`, e.message);
      results.push(`\u26a0\ufe0f ${t}: ${e.message}`);
    }
  }

  if (chatId && msgId) {
    try {
      await bot.editMessageText(`\u2705 Backtest Perpetual selesai`, { chat_id: chatId, message_id: msgId });
    } catch (e) {}
  }

  return results;
}

module.exports = {
  register(bot) {
    const perpSignals = {};
    const conv = {};

    function handleMessage(text, chatId) {
      if (!text || text.startsWith('/')) return false;
      const session = conv[chatId];
      if (!session) return false;

      try {
        if (session.cmd === 'perp_managepair') {
          if (session.step === 'ticker') {
            const ticker = text.toUpperCase();
            session.data = { ticker };
            session.step = 'timeframes';
            bot.sendMessage(chatId, `Ticker: ${ticker}\nMasukkan timeframe (pisahkan koma). Contoh: <code>15m,1h,4h</code>`, { parse_mode: 'HTML' });
            return true;
          }
          if (session.step === 'timeframes') {
            const tfs = text.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
            const invalid = tfs.filter(tf => !VALID_TIMEFRAMES.includes(tf));
            if (invalid.length) { bot.sendMessage(chatId, `\u274c Timeframe tidak valid: ${invalid.join(', ')}`); return true; }
            const ticker = session.data.ticker;
            const insPair = db.prepare('INSERT OR IGNORE INTO perp_pairs (ticker, timeframe) VALUES (?, ?)');
            db.transaction(() => {
              for (const tf of tfs) insPair.run(ticker, tf);
            })();
            delete conv[chatId];
            bot.sendMessage(chatId, `\u2705 ${ticker} ditambahkan: ${tfs.join(', ')}`);
            return true;
          }
        } else if (session.cmd === 'perp_removepair') {
          const ticker = text.toUpperCase();
          const count = db.prepare('SELECT COUNT(*) as c FROM perp_pairs WHERE ticker = ?').get(ticker).c;
          if (!count) { bot.sendMessage(chatId, `\u274c ${ticker} tidak ditemukan.`); return true; }
          db.prepare('DELETE FROM perp_pairs WHERE ticker = ?').run(ticker);
          delete conv[chatId];
          bot.sendMessage(chatId, `\u2705 ${ticker} dihapus.`);
          return true;
        } else if (session.cmd === 'perp_config') {
          const val = parseFloat(text);
          if (isNaN(val)) { bot.sendMessage(chatId, '\u274c Masukkan angka yang valid.'); return true; }
          upsertConfig(`perp_${session.step}`, val);
          const labelMap = { slPercent: 'SL', tp1Percent: 'TP1', tp2Percent: 'TP2', swingLookback: 'Lookback', volumeThreshold: 'Volume Threshold' };
          const label = labelMap[session.step] || session.step;
          delete conv[chatId];
          bot.sendMessage(chatId, `\u2705 ${label} diubah ke ${val}${['slPercent','tp1Percent','tp2Percent'].includes(session.step) ? '%' : ''}`);
          showPerpConfig(bot, chatId);
          return true;
        }
      } catch (e) {
        console.error('Perp message handler error:', e.message);
        try { bot.sendMessage(chatId, `\u274c Error: ${e.message}`); } catch (_) {}
      }
      return false;
    }

    function handleCallback(query) {
      const chatId = query.message.chat.id;
      const msgId = query.message.message_id;
      const data = query.data;

      try {
        if (data === 'perp_status') {
          showPerpStatus(bot, chatId);
          return { action: null };
        }
        if (data === 'perp_config') {
          showPerpConfig(bot, chatId, msgId);
          return { action: null };
        }
        if (data === 'perp_managepair') {
          conv[chatId] = { cmd: 'perp_managepair', step: 'ticker', data: {} };
          bot.sendMessage(chatId, 'Masukkan ticker yang ingin ditambahkan (contoh: BTCUSDT):');
          return { action: null };
        }
        if (data === 'perp_removepair') {
          const pairs = loadPairsFor('perp_pairs');
          const keys = Object.keys(pairs);
          if (keys.length) {
            const rows = keys.map(t => [{ text: `\u274c ${t}`, callback_data: `perp_managepair_remove_${t}` }]);
            rows.push([{ text: '\u2795 Add New', callback_data: 'perp_managepair' }]);
            rows.push([{ text: '\ud83d\udd19 Back', callback_data: 'perp_config_back' }]);
            bot.sendMessage(chatId, 'Pilih pair untuk dihapus, atau Add New untuk menambah:', {
              reply_markup: { inline_keyboard: rows }
            });
          } else {
            bot.sendMessage(chatId, 'Belum ada pair. Kirim nama ticker untuk menambah (contoh: BTCUSDT):');
          }
          return { action: null };
        }
        if (data === 'perp_run') {
          const cur = getFeatConfig('perp', 'running', '0') === '1';
          upsertConfig('perp_running', cur ? '0' : '1');
          if (!cur) Object.assign(perpSignals, {});
          bot.sendMessage(chatId, cur ? '\u23f9 Perpetual MS dihentikan.' : '\u25b6\ufe0f Perpetual MS dimulai.');
          showPerpFeatureMenu(bot, chatId, msgId);
          return { action: null };
        }
        if (data === 'perp_mainback') {
          return { action: 'main_back' };
        }
        if (data === 'perp_btp') {
          const btEnabled = getFeatConfig('perp', 'btEnabled', '1') === '1';
          if (btEnabled !== true) {
            bot.sendMessage(chatId, '\u274c BTP disabled. Aktifkan di Config.');
            return { action: null };
          }
          bot.sendMessage(chatId, '\u23f3 Running backtest perpetual...').then(m => {
            runBacktestPerp(null, bot, chatId, m.message_id).then(res => {
              const msgText = ['<b>Backtest Perpetual selesai</b>', ...res].join('\n');
              bot.sendMessage(chatId, msgText, { parse_mode: 'HTML' });
            }).catch(e => {
              bot.sendMessage(chatId, `\u274c BTP error: ${e.message}`);
            });
          });
          return { action: null };
        }
        if (data === 'perp_config_sl' || data === 'perp_config_tp1' || data === 'perp_config_tp2') {
          const stepMap = { perp_config_sl: 'slPercent', perp_config_tp1: 'tp1Percent', perp_config_tp2: 'tp2Percent' };
          const labelMap = { perp_config_sl: 'SL', perp_config_tp1: 'TP1', perp_config_tp2: 'TP2' };
          const defMap = { perp_config_sl: '-2', perp_config_tp1: '1', perp_config_tp2: '200' };
          const cur = getFeatConfig('perp', stepMap[data], defMap[data]);
          conv[chatId] = { cmd: 'perp_config', step: stepMap[data], data: {} };
          bot.sendMessage(chatId, `${labelMap[data]} saat ini: ${cur}%\nMasukkan nilai baru (contoh: ${data === 'perp_config_sl' ? '-5' : '3'}):`, {
            reply_markup: { inline_keyboard: [[{ text: '\u274c Batal', callback_data: 'perp_mainback' }]] }
          });
          return { action: null };
        }
        if (data === 'perp_config_waitmode') {
          const cur = getFeatConfig('perp', 'waitMode', 'trend');
          conv[chatId] = { cmd: 'perp_config', step: 'waitmode', data: {} };
          bot.sendMessage(chatId, `Mode saat ini: ${cur}\nPilih mode konfirmasi:`, {
            reply_markup: {
              inline_keyboard: [
                [{ text: '\ud83d\udd04 Continue Trend (retest)', callback_data: 'perp_waitmode_set_trend' }],
                [{ text: '\ud83d\udd0a Volume', callback_data: 'perp_waitmode_set_volume' }],
                [{ text: '\u274c Batal', callback_data: 'perp_mainback' }],
              ]
            }
          });
          return { action: null };
        }
        if (data.startsWith('perp_waitmode_set_')) {
          const mode = data.replace('perp_waitmode_set_', '');
          upsertConfig('perp_waitMode', mode);
          delete conv[chatId];
          bot.sendMessage(chatId, `\u2705 Wait mode diubah ke ${mode}`);
          showPerpConfig(bot, chatId, msgId);
          return { action: null };
        }
        if (data === 'perp_config_lookback') {
          const cur = getFeatConfig('perp', 'swingLookback', '2');
          conv[chatId] = { cmd: 'perp_config', step: 'swingLookback', data: {} };
          bot.sendMessage(chatId, `Swing lookback saat ini: ${cur}\nMasukkan angka baru (2\u201320):`, {
            reply_markup: { inline_keyboard: [[{ text: '\u274c Batal', callback_data: 'perp_mainback' }]] }
          });
          return { action: null };
        }
        if (data === 'perp_config_volumethreshold') {
          const cur = getFeatConfig('perp', 'volumeThreshold', '150');
          conv[chatId] = { cmd: 'perp_config', step: 'volumeThreshold', data: {} };
          bot.sendMessage(chatId, `Volume threshold saat ini: ${cur}%\nMasukkan angka baru (0\u20131000):`, {
            reply_markup: { inline_keyboard: [[{ text: '\u274c Batal', callback_data: 'perp_mainback' }]] }
          });
          return { action: null };
        }
        if (data === 'perp_config_toggle') {
          const cur = getFeatConfig('perp', 'running', '0') === '1';
          upsertConfig('perp_running', cur ? '0' : '1');
          if (!cur) Object.assign(perpSignals, {});
          showPerpConfig(bot, chatId, msgId);
          return { action: null };
        }
        if (data === 'perp_config_btp_toggle') {
          const cur = getFeatConfig('perp', 'btEnabled', '1') === '1';
          upsertConfig('perp_btEnabled', cur ? '0' : '1');
          showPerpConfig(bot, chatId, msgId);
          return { action: null };
        }
        if (data === 'perp_config_startdate' || data === 'perp_config_enddate') {
          const target = data === 'perp_config_startdate' ? 'start' : 'end';
          const now = new Date();
          conv[chatId] = { cmd: 'perp_config', step: 'calendar', calTarget: target, calYear: now.getFullYear(), calMonth: now.getMonth(), calDate: null, calMsgId: null };
          showCalendar(bot, chatId, target, conv);
          return { action: null };
        }
        if (data === 'perp_config_back') {
          showPerpFeatureMenu(bot, chatId, msgId);
          return { action: null };
        }
        if (data.startsWith('perp_managepair_remove_')) {
          const ticker = data.replace('perp_managepair_remove_', '');
          try {
            db.prepare('DELETE FROM perp_pairs WHERE ticker = ?').run(ticker);
            bot.sendMessage(chatId, `\u2705 ${ticker} dihapus.`);
          } catch (e) {
            bot.sendMessage(chatId, `\u274c Gagal menghapus: ${e.message}`);
          }
          return { action: null };
        }
        if (data === 'perp_managepair') {
          conv[chatId] = { cmd: 'perp_managepair', step: 'ticker', data: {} };
          bot.sendMessage(chatId, 'Masukkan ticker yang ingin ditambahkan (contoh: BTCUSDT):');
          return { action: null };
        }
        if (data === 'perp_cal_nop') return { action: null };
        if (data === 'perp_cal_prev' || data === 'perp_cal_next' || data === 'perp_cal_pyear' || data === 'perp_cal_nyear') {
          const s = conv[chatId];
          if (s && s.step === 'calendar') {
            if (data === 'perp_cal_prev') { s.calMonth--; if (s.calMonth < 0) { s.calMonth = 11; s.calYear--; } }
            else if (data === 'perp_cal_next') { s.calMonth++; if (s.calMonth > 11) { s.calMonth = 0; s.calYear++; } }
            else if (data === 'perp_cal_pyear') s.calYear--;
            else if (data === 'perp_cal_nyear') s.calYear++;
            showCalendar(bot, chatId, s.calTarget, conv);
          }
          return { action: null };
        }
        if (data.startsWith('perp_cal_set_')) {
          const s = conv[chatId];
          if (s && s.step === 'calendar') {
            s.calDate = data.replace('perp_cal_set_', '');
            showCalendar(bot, chatId, s.calTarget, conv);
          }
          return { action: null };
        }
        if (data === 'perp_cal_del') {
          const s = conv[chatId];
          if (s && s.step === 'calendar') {
            const key = s.calTarget === 'start' ? 'perp_startDate' : 'perp_endDate';
            upsertConfig(key, '');
            delete conv[chatId];
            bot.sendMessage(chatId, `\u2705 Tanggal ${s.calTarget === 'start' ? 'mulai' : 'akhir'} dihapus`);
            showPerpConfig(bot, chatId);
          }
          return { action: null };
        }
        if (data === 'perp_cal_ok') {
          const s = conv[chatId];
          if (s && s.step === 'calendar' && s.calDate) {
            const d = s.calDate;
            const dateStr = `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`;
            const key = s.calTarget === 'start' ? 'perp_startDate' : 'perp_endDate';
            upsertConfig(key, dateStr);
            delete conv[chatId];
            bot.sendMessage(chatId, `\u2705 Tanggal ${s.calTarget === 'start' ? 'mulai' : 'akhir'} disimpan: ${dateStr}`);
            showPerpConfig(bot, chatId);
          }
          return { action: null };
        }
        if (data === 'perp_cal_cancel') {
          delete conv[chatId];
          showPerpConfig(bot, chatId, msgId);
          return { action: null };
        }
      } catch (e) {
        console.error('Perp handleCallback error:', e.message);
      }

      return { action: null };
    }

    async function pollTick() {
      try {
        const pairs = loadPairsFor('perp_pairs');
        await processPerpetual(pairs, bot);
      } catch (e) {
        console.error('Perp pollTick error:', e.message);
      }
    }

    async function runBacktestNow(ticker) {
      return runBacktestPerp(ticker, bot, null, null);
    }

    return {
      prefix: 'perp_',
      handleCallback,
      pollTick,
      runBacktestNow,
      handleMessage,
      showFeatureMenu: (chatId, msgId) => showPerpFeatureMenu(bot, chatId, msgId),
    };
  }
};
