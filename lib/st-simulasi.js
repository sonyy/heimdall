const { db, getFeatConfig, getTfConfig, upsertConfig, loadPairsFor } = require('./db');
const { fetchKlines, VALID_TIMEFRAMES, normalizeTf } = require('./exchange');
const { ATR } = require('technicalindicators');

function sortTfs(tfs) {
  return [...tfs].sort((a, b) => VALID_TIMEFRAMES.indexOf(a) - VALID_TIMEFRAMES.indexOf(b));
}

// ─── Core Functions ───────────────────────────────────────────────────────────

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

function openSimTrade(ticker, timeframe, price, slPrice, tp1Price, tp2Price, signal) {
  try {
    db.prepare(`INSERT INTO sim_trades (ticker,timeframe,entry_price,entry_signal,sl_price,tp1_price,tp2_price) VALUES (?,?,?,?,?,?,?)`).run(ticker, timeframe, price, signal, slPrice, tp1Price, tp2Price);
    console.log(`ST TRADE OPEN: ${ticker} ${timeframe} @ $${price} (SL: $${slPrice.toFixed(2)}, TP1: $${tp1Price.toFixed(2)}, TP2: $${tp2Price.toFixed(2)})`);
  } catch (e) { console.error('openSimTrade error:', e.message); }
}

function closeSimTrade(tradeId, closePrice) {
  try {
    const t = db.prepare('SELECT entry_price FROM sim_trades WHERE id=?').get(tradeId);
    if (!t) return;
    const pnl = ((closePrice - t.entry_price) / t.entry_price) * 100;
    const result = pnl >= 0 ? 'WIN' : 'LOSE';
    db.prepare(`UPDATE sim_trades SET close_price=?, pnl=?, result=?, closed_at=datetime('now') WHERE id=?`).run(closePrice, pnl.toFixed(2), result, tradeId);
    console.log(`ST TRADE CLOSE #${tradeId}: ${result} @ $${closePrice} (${pnl.toFixed(2)}%)`);
  } catch (e) { console.error('closeSimTrade error:', e.message); }
}

async function sendMenu(bot, chatId, msgId, text, opts) {
  if (msgId) {
    try { return await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, ...opts }); } catch (e) {}
  } else {
    try { return await bot.sendMessage(chatId, text, opts); } catch (e) {}
  }
}

// ─── Telegram Menu Renderers ──────────────────────────────────────────────────

function showStFeatureMenu(bot, chatId, msgId) {
  const running = getFeatConfig('st', 'running', '1') === '1';
  const pairs = loadPairsFor('st_pairs');
  const pairCount = Object.keys(pairs).length;
  const openCount = db.prepare("SELECT COUNT(*) as c FROM sim_trades WHERE result IS NULL").get().c;
  const sl = getFeatConfig('st', 'slPercent', '-2');
  const tp1 = getFeatConfig('st', 'tp1Percent', '2');
  const tp2 = getFeatConfig('st', 'tp2Percent', '4');
  const pairLines = Object.entries(pairs).map(([t, tfs]) => `  • ${t}: ${sortTfs(tfs).join(', ')}`).join('\n');
  const text =
    `📈 <b>ST Simulasi</b>\n` +
    `${running ? '✅ Running' : '❌ Idle'} · ${pairCount} pairs · ${openCount} open trades\n` +
    `SL ${sl}% · TP1 ${tp1}% · TP2 ${tp2}%\n\n` +
    (pairLines ? `<b>Pairs:</b>\n${pairLines}\n\n` : '') +
    `Pilih aksi:`;
  sendMenu(bot, chatId, msgId, text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '📋 Status', callback_data: 'st_status' }],
        [{ text: '⚙️ Config', callback_data: 'st_config' }],
        [{ text: '➕ Add/Edit Pair', callback_data: 'st_managepair' }],
        [{ text: '➖ Remove Pair', callback_data: 'st_removepair' }],
        [{ text: running ? '⏹ Stop' : '▶️ Start', callback_data: 'st_run' }],
        [{ text: '🔙 Main Menu', callback_data: 'st_mainback' }],
      ]
    }
  });
}

async function showStStatus(bot, chatId) {
  try {
    const running = getFeatConfig('st', 'running', '1') === '1';
    const pairs = loadPairsFor('st_pairs');
    const openCount = db.prepare("SELECT COUNT(*) as c FROM sim_trades WHERE result IS NULL").get().c;
    const closedCount = db.prepare("SELECT COUNT(*) as c FROM sim_trades WHERE result IS NOT NULL").get().c;

    let lines = [];
    for (const [ticker, tfs] of Object.entries(pairs)) {
      const sorted = sortTfs(tfs);
      const dirs = [];
      for (const tf of sorted) {
        try {
          const { data } = await fetchKlines(ticker, tf);
          if (data && data.length) {
            const tfCfg = getTfConfig(tf, 10, 3);
            const st = calcSupertrend(data, tfCfg.period, tfCfg.multiplier);
            dirs.push(`${tf} ${st.isBullish ? '🟢' : '🔴'}`);
          } else {
            dirs.push(`${tf} ⚪`);
          }
        } catch (e) {
          dirs.push(`${tf} ⚪`);
        }
      }
      lines.push(`  • ${ticker}: ${dirs.join(' | ')}`);
    }

    const pairText = lines.join('\n') || '  —';
    bot.sendMessage(chatId,
      `📈 <b>ST Simulasi Status</b>\n\nRunning: ${running ? '✅ Yes' : '❌ No'}` +
      `\n\nPairs:\n${pairText}\n\nOpen trades: ${openCount}\nClosed trades: ${closedCount}`,
      { parse_mode: 'HTML' });
  } catch (e) { console.error('showStStatus error:', e.message); }
}

function showStConfig(bot, chatId, msgId) {
  const sl = getFeatConfig('st', 'slPercent', '-2');
  const tp1 = getFeatConfig('st', 'tp1Percent', '2');
  const tp2 = getFeatConfig('st', 'tp2Percent', '4');
  const running = getFeatConfig('st', 'running', '1') === '1';
  const text = `\u2699\ufe0f <b>ST Simulasi Config</b>\n\nSL: ${sl}%\nTP1: ${tp1}%\nTP2: ${tp2}%\nRunning: ${running ? '\u2705' : '\u274c'}`;
  sendMenu(bot, chatId, msgId, text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: `\ud83d\udcc9 SL ${sl}%`, callback_data: 'st_config_sl' }],
        [{ text: `\ud83d\udcc8 TP1 ${tp1}%`, callback_data: 'st_config_tp1' }],
        [{ text: `\ud83c\udfaf TP2 ${tp2}%`, callback_data: 'st_config_tp2' }],
        [{ text: running ? '\u23f9 Stop' : '\u25b6\ufe0f Start', callback_data: 'st_config_toggle' }],
        [{ text: '\ud83d\udd19 Back', callback_data: 'st_config_back' }],
      ]
    }
  });
}

function showStManagePair(bot, chatId) {
  const pairs = loadPairsFor('st_pairs');
  const keys = Object.keys(pairs);
  if (keys.length) {
    const lines = keys.map(t => `❌ ${t} (${sortTfs(pairs[t]).join(', ')})`);
    const rows = keys.map(t => [{ text: `\u274c ${t}`, callback_data: `st_managepair_remove_${t}` }]);
    rows.push([{ text: '\u2795 Add New', callback_data: 'st_managepair_new' }]);
    rows.push([{ text: '\ud83d\udd19 Back', callback_data: 'st_config_back' }]);
    bot.sendMessage(chatId, `Pair terdaftar:\n${lines.join('\n')}\n\nPilih pair untuk dihapus, atau Add New untuk menambah:`, {
      reply_markup: { inline_keyboard: rows }
    });
  } else {
    bot.sendMessage(chatId, 'Belum ada pair. Kirim nama ticker untuk menambah (contoh: BTCUSDT):');
  }
}

// ─── Register ─────────────────────────────────────────────────────────────────

module.exports = {
  register(bot, chatId) {
    const alignedState = {};    // { ticker: boolean } — overall alignment for entry trigger
    const tfState = {};         // { ticker: { tf: boolean } } — per-TF direction for flip notifications
    const conv = {};

    // ── Message Handler (called from index.js) ──

    function handleMessage(text, chatId) {
      if (!text || text.startsWith('/')) return false;
      const session = conv[chatId];
      if (!session) return false;

      try {
        if (session.cmd === 'st_managepair') {
          if (session.step === 'ticker') {
            const ticker = text.toUpperCase();
            const exists = db.prepare('SELECT COUNT(*) as c FROM st_pairs WHERE ticker = ?').get(ticker).c > 0;
            session.data = { ticker, exists };
            session.step = 'timeframes';
            const action = exists ? 'mengganti' : 'menambah';
            bot.sendMessage(chatId, `Ticker: ${ticker} (${exists ? 'existing, akan diganti' : 'baru'})\nMasukkan timeframe (pisahkan koma).\nValid: <code>${VALID_TIMEFRAMES.join(', ')}</code>`, { parse_mode: 'HTML' });
            return true;
          }
          if (session.step === 'timeframes') {
            const tfs = text.split(',').map(s => normalizeTf(s.trim())).filter(Boolean);
            const invalid = text.split(',').map(s => s.trim()).filter(s => !normalizeTf(s));
            if (invalid.length) { bot.sendMessage(chatId, `\u274c Timeframe tidak valid: ${invalid.join(', ')}`); return true; }
            const { ticker, exists } = session.data;
            db.transaction(() => {
              if (exists) db.prepare('DELETE FROM st_pairs WHERE ticker = ?').run(ticker);
              const ins = db.prepare('INSERT OR IGNORE INTO st_pairs (ticker, timeframe) VALUES (?, ?)');
              for (const tf of tfs) ins.run(ticker, tf);
            })();
            delete conv[chatId];
            bot.sendMessage(chatId, `\u2705 ${ticker} ${exists ? 'diubah' : 'ditambahkan'}: ${tfs.join(', ')}`);
            return true;
          }
        } else if (session.cmd === 'st_removepair') {
          const ticker = text.toUpperCase();
          const count = db.prepare('SELECT COUNT(*) as c FROM st_pairs WHERE ticker = ?').get(ticker).c;
          if (!count) { bot.sendMessage(chatId, `\u274c ${ticker} tidak ditemukan.`); return true; }
          db.prepare('DELETE FROM st_pairs WHERE ticker = ?').run(ticker);
          delete conv[chatId];
          bot.sendMessage(chatId, `\u2705 ${ticker} dihapus.`);
          return true;
        } else if (session.cmd === 'st_config') {
          const val = parseFloat(text);
          if (isNaN(val)) { bot.sendMessage(chatId, '\u274c Masukkan angka yang valid.'); return true; }
          upsertConfig(`st_${session.step}`, val);
          const label = { slPercent: 'SL', tp1Percent: 'TP1', tp2Percent: 'TP2' }[session.step] || session.step;
          delete conv[chatId];
          bot.sendMessage(chatId, `\u2705 ${label} diubah ke ${val}%`);
          showStConfig(bot, chatId);
          return true;
        }
      } catch (e) {
        console.error('ST message handler error:', e.message);
        try { bot.sendMessage(chatId, `\u274c Error: ${e.message}`); } catch (_) {}
      }
      return false;
    }

    // ── Internal Logic ──

    async function checkStAlignmentInternal(pairs) {
      const currentPrices = {};
      const stRunning = getFeatConfig('st', 'running', '1');
      for (const [ticker, timeframes] of Object.entries(pairs)) {
        try {
          if (!timeframes || !timeframes.length) continue;
          const results = {};
          for (const tf of timeframes) {
            const { data } = await fetchKlines(ticker, tf);
            if (!data || !data.length) continue;
            const tfCfg = getTfConfig(tf, 10, 3);
            const st = calcSupertrend(data, tfCfg.period, tfCfg.multiplier);
            if (st) results[tf] = st;
          }
          if (!Object.keys(results).length) continue;
          const price = Object.values(results)[0].price;
          currentPrices[ticker] = price;
          const nowAligned = timeframes.every(t => results[t]?.isBullish === true);
          const prevAligned = alignedState[ticker];

          // Per-TF flip detection — arrow inline in full state line
          const prevTfs = tfState[ticker] || {};
          const flipTfs = [];
          for (const tf of timeframes) {
            const cur = results[tf]?.isBullish;
            if (cur === undefined) continue;
            const prev = prevTfs[tf];
            if (prev !== undefined && prev !== cur) flipTfs.push(tf);
            prevTfs[tf] = cur;
          }
          if (flipTfs.length > 0 && stRunning === '1') {
            const allState = sortTfs(Object.keys(results)).map(tf => {
              const cur = results[tf]?.isBullish;
              if (cur === undefined) return null;
              const prev = prevTfs[tf];
              if (flipTfs.includes(tf)) {
                return `${tf} ${!cur ? '🟢→🔴' : '🔴→🟢'}`;
              }
              return `${tf} ${cur ? '🟢' : '🔴'}`;
            }).filter(Boolean).join(' | ');
            bot.sendMessage(chatId,
              `🔄 <b>ST Flip</b> ${ticker}\n${allState}\nPrice: $${price}`,
              { parse_mode: 'HTML' }
            ).catch(() => {});
            console.log(`ST FLIP ${ticker}: ${flipTfs.join(', ')} @ $${price}`);
          }
          tfState[ticker] = prevTfs;

          const allState = sortTfs(Object.keys(results)).map(
            tf => `${tf} ${results[tf]?.isBullish ? '🟢' : '🔴'}`
          ).join(' | ');
          console.log(`ST ${ticker}: price=${price} dirs=${Object.entries(results).map(([t,r]) => `${t}=${r.isBullish?'🟢':'🔴'}`).join(',')} aligned=${nowAligned} prev=${prevAligned}`);
          if (prevAligned !== undefined && !prevAligned && nowAligned && stRunning === '1') {
            const existing = db.prepare("SELECT id FROM sim_trades WHERE ticker=? AND result IS NULL").get(ticker);
            if (!existing) {
              const slPct = Number(getFeatConfig('st', 'slPercent', '-2'));
              const tp1Pct = Number(getFeatConfig('st', 'tp1Percent', '2'));
              const tp2Pct = Number(getFeatConfig('st', 'tp2Percent', '4'));
              const slPrice = price * (1 + slPct / 100);
              const tp1Price = price * (1 + tp1Pct / 100);
              const tp2Price = price * (1 + tp2Pct / 100);
              openSimTrade(ticker, 'all', price, slPrice, tp1Price, tp2Price, 'ST Bullish (multi-tf)');
              bot.sendMessage(chatId, `🟢 <b>ST OPEN</b>\n${ticker} @ $${price}\n${allState}\nSL: $${slPrice} | TP1: $${tp1Price} | TP2: $${tp2Price}`, { parse_mode: 'HTML' }).catch(() => {});
              console.log(`ST ALIGNMENT ENTRY: ${ticker} @ $${price}`);
            }
          }
          alignedState[ticker] = nowAligned;
        } catch (e) {
          console.error(`ST alignment ${ticker}:`, e.message);
        }
      }
      return currentPrices;
    }

    async function updateSimTradesInternal(currentPrices) {
      const openTrades = db.prepare("SELECT * FROM sim_trades WHERE result IS NULL").all();
      for (const t of openTrades) {
        try {
          let price = currentPrices[t.ticker];
          if (!price || price <= 0) continue;
          const pnl = ((price - t.entry_price) / t.entry_price) * 100;
          db.prepare('UPDATE sim_trades SET pnl=? WHERE id=?').run(pnl.toFixed(2), t.id);
          try {
            if (!t.peak_price || price > t.peak_price) {
              db.prepare('UPDATE sim_trades SET peak_price=?, peak_pct=? WHERE id=?').run(price, pnl.toFixed(2), t.id);
            }
            if (!t.low_price || price < t.low_price) {
              db.prepare('UPDATE sim_trades SET low_price=?, low_pct=? WHERE id=?').run(price, pnl.toFixed(2), t.id);
            }
          } catch (_) {}
          if (price <= t.sl_price) {
            closeSimTrade(t.id, price);
            bot.sendMessage(chatId, `🔴 <b>ST CLOSE (SL)</b>\n${t.ticker} #${t.id}\nEntry: $${t.entry_price} → Close: $${price}\nPnL: ${((price - t.entry_price) / t.entry_price * 100).toFixed(2)}%`, { parse_mode: 'HTML' }).catch(() => {});
            continue;
          }
          if (price >= t.tp2_price) {
            if (!t.tp1_hit && price >= t.tp1_price) {
              db.prepare('UPDATE sim_trades SET tp1_hit=? WHERE id=?').run(t.tp1_price, t.id);
            }
            if (!t.tp2_hit) {
              db.prepare('UPDATE sim_trades SET tp2_hit=? WHERE id=?').run(t.tp2_price, t.id);
            }
            closeSimTrade(t.id, price);
            bot.sendMessage(chatId, `🟢 <b>ST CLOSE (TP2)</b>\n${t.ticker} #${t.id}\nEntry: $${t.entry_price} → Close: $${price}\nPnL: ${((price - t.entry_price) / t.entry_price * 100).toFixed(2)}%`, { parse_mode: 'HTML' }).catch(() => {});
            continue;
          }
          if (price >= t.tp1_price && !t.tp1_hit) {
            db.prepare('UPDATE sim_trades SET tp1_hit=? WHERE id=?').run(t.tp1_price, t.id);
            bot.sendMessage(chatId, `ℹ️ <b>ST TP1 HIT</b>\n${t.ticker} #${t.id} @ $${price}`, { parse_mode: 'HTML' }).catch(() => {});
          }
          if (price >= t.tp2_price) {
            if (!t.tp1_hit && price >= t.tp1_price) {
              db.prepare('UPDATE sim_trades SET tp1_hit=? WHERE id=?').run(t.tp1_price, t.id);
            }
            if (!t.tp2_hit) {
              db.prepare('UPDATE sim_trades SET tp2_hit=? WHERE id=?').run(t.tp2_price, t.id);
            }
            closeSimTrade(t.id, price);
            continue;
          }
          if (price >= t.tp1_price && !t.tp1_hit) {
            db.prepare('UPDATE sim_trades SET tp1_hit=? WHERE id=?').run(t.tp1_price, t.id);
            console.log(`ST TP1 HIT: trade #${t.id} @ $${price}`);
          }
        } catch (e) {
          console.error(`ST update trade #${t.id}:`, e.message);
        }
      }
    }

    // ── Callback Handler ──

    function handleCallback(query) {
      const chatId = query.message.chat.id;
      const msgId = query.message.message_id;
      const data = query.data;

      try {
        if (data === 'st_status') {
          showStStatus(bot, chatId);
          return { action: null };
        }
        if (data === 'st_config') {
          showStConfig(bot, chatId, msgId);
          return { action: null };
        }
        if (data === 'st_run') {
          const cur = getFeatConfig('st', 'running', '1') === '1';
          upsertConfig('st_running', cur ? '0' : '1');
          bot.sendMessage(chatId, cur ? '\u23f9 ST Simulasi dihentikan.' : '\u25b6\ufe0f ST Simulasi dimulai.');
          showStFeatureMenu(bot, chatId, msgId);
          return { action: null };
        }
        if (data === 'st_managepair') {
          const pairs = loadPairsFor('st_pairs');
          const keys = Object.keys(pairs);
          if (keys.length) {
            const lines = keys.map(t => `• ${t} (${sortTfs(pairs[t]).join(', ')})`);
            const rows = keys.map(t => [{ text: `📝 ${t}`, callback_data: `st_managepair_edit_${t}` }]);
            rows.push([{ text: '➕ Add New', callback_data: 'st_managepair_new' }]);
            rows.push([{ text: '🔙 Back', callback_data: 'st_config_back' }]);
            bot.sendMessage(chatId, `Pair terdaftar:\n${lines.join('\n')}\n\nPilih pair untuk diedit, atau Add New untuk menambah:`, {
              reply_markup: { inline_keyboard: rows }
            });
          } else {
            conv[chatId] = { cmd: 'st_managepair', step: 'ticker', data: {} };
            bot.sendMessage(chatId, 'Belum ada pair. Masukkan ticker (contoh: BTCUSDT):');
          }
          return { action: null };
        }
        if (data === 'st_managepair_new') {
          conv[chatId] = { cmd: 'st_managepair', step: 'ticker', data: {} };
          bot.sendMessage(chatId, 'Masukkan ticker (contoh: BTCUSDT):');
          return { action: null };
        }
        if (data.startsWith('st_managepair_edit_')) {
          const ticker = data.replace('st_managepair_edit_', '');
          const exists = db.prepare('SELECT COUNT(*) as c FROM st_pairs WHERE ticker = ?').get(ticker).c > 0;
          if (exists) {
            conv[chatId] = { cmd: 'st_managepair', step: 'timeframes', data: { ticker, exists: true } };
            bot.sendMessage(chatId, `Ticker: ${ticker}\nMasukkan timeframe BARU (pisahkan koma).\nValid: <code>${VALID_TIMEFRAMES.join(', ')}</code>`, { parse_mode: 'HTML' });
          } else {
            conv[chatId] = { cmd: 'st_managepair', step: 'timeframes', data: { ticker, exists: false } };
            bot.sendMessage(chatId, `Ticker: ${ticker}\nMasukkan timeframe (pisahkan koma).\nValid: <code>${VALID_TIMEFRAMES.join(', ')}</code>`, { parse_mode: 'HTML' });
          }
          return { action: null };
        }
        if (data === 'st_removepair') {
          showStManagePair(bot, chatId);
          return { action: null };
        }
        if (data === 'st_mainback') {
          return { action: 'main_back' };
        }
        if (data === 'st_config_sl' || data === 'st_config_tp1' || data === 'st_config_tp2') {
          const stepMap = { st_config_sl: 'slPercent', st_config_tp1: 'tp1Percent', st_config_tp2: 'tp2Percent' };
          const labelMap = { st_config_sl: 'SL', st_config_tp1: 'TP1', st_config_tp2: 'TP2' };
          const defMap = { st_config_sl: '-2', st_config_tp1: '2', st_config_tp2: '4' };
          const cur = getFeatConfig('st', stepMap[data], defMap[data]);
          conv[chatId] = { cmd: 'st_config', step: stepMap[data], data: {} };
          bot.sendMessage(chatId, `${labelMap[data]} saat ini: ${cur}%\nMasukkan nilai baru (contoh: ${data === 'st_config_sl' ? '-5' : '3'}):`, {
            reply_markup: { inline_keyboard: [[{ text: '\u274c Batal', callback_data: 'st_config_back' }]] }
          });
          return { action: null };
        }
        if (data === 'st_config_toggle') {
          const cur = getFeatConfig('st', 'running', '1') === '1';
          upsertConfig('st_running', cur ? '0' : '1');
          showStConfig(bot, chatId, msgId);
          return { action: null };
        }
        if (data === 'st_config_back') {
          showStFeatureMenu(bot, chatId, msgId);
          return { action: null };
        }
        if (data.startsWith('st_managepair_remove_')) {
          const ticker = data.replace('st_managepair_remove_', '');
          try {
            db.prepare('DELETE FROM st_pairs WHERE ticker = ?').run(ticker);
            bot.sendMessage(chatId, `\u2705 ${ticker} dihapus.`);
          } catch (e) {
            bot.sendMessage(chatId, `\u274c Gagal menghapus: ${e.message}`);
          }
          return { action: null };
        }
      } catch (e) {
        console.error('ST handleCallback error:', e.message);
      }

      return { action: null };
    }

    // ── Poll Tick ──

    async function pollTick() {
      try {
        const pairs = loadPairsFor('st_pairs');
        const currentPrices = await checkStAlignmentInternal(pairs);
        await updateSimTradesInternal(currentPrices);
      } catch (e) {
        console.error('ST pollTick error:', e.message);
      }
    }

    return {
      prefix: 'st_',
      handleCallback,
      handleMessage,
      pollTick,
      showFeatureMenu: (chatId, msgId) => showStFeatureMenu(bot, chatId, msgId),
    };
  }
};
