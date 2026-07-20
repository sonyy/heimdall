const { db, getFeatConfig, getTfConfig, getConfig, upsertConfig, loadPairsFor } = require('./db');
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

function openSimTrade(ticker, timeframe, price, slPrice, tp1Price, tp2Price, signal, marginSize, capitalEntry) {
  try {
    db.prepare(`INSERT INTO sim_trades (ticker,timeframe,entry_price,entry_signal,sl_price,tp1_price,tp2_price,margin_size,capital_entry) VALUES (?,?,?,?,?,?,?,?,?)`).run(ticker, timeframe, price, signal, slPrice, tp1Price, tp2Price, marginSize || null, capitalEntry || null);
    console.log(`ST TRADE OPEN: ${ticker} ${timeframe} @ $${price} (SL: $${slPrice.toFixed(2)}, TP: $${tp1Price.toFixed(2)}, TP2: $${tp2Price.toFixed(2)}) margin=$${marginSize || '-'}`);
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
    try {
      return await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, ...opts });
    } catch (e) {
      // edit failed (stale msg, rate limit) — send fresh
      const fresh = await bot.sendMessage(chatId, text, opts).catch(e2 => {
        console.error('ST sendMenu edit+send err:', e.message, '/', e2.message);
        return null;
      });
      return fresh;
    }
  } else {
    try { return await bot.sendMessage(chatId, text, opts); } catch (e) {
      console.error('ST sendMenu send err:', e.message);
    }
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
    `🔔 <b>Notifikasi Supertrend</b>\n` +
    `${running ? '✅ Running' : '❌ Idle'} · ${pairCount} pairs · ${openCount} open trades\n` +
    `SL ${sl}% · TP ${tp1}% · TP2 ${tp2}%\n\n` +
    (pairLines ? `<b>Pairs:</b>\n${pairLines}\n\n` : '') +
    `Pilih aksi:`;
  sendMenu(bot, chatId, msgId, text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '📋 Status', callback_data: 'st_status' }],
        [{ text: '⚙️ Config', callback_data: 'st_config' }],
        [{ text: '➕ Add/Edit Pair', callback_data: 'st_managepair' }],
        [{ text: running ? '⏹ Stop' : '▶️ Start', callback_data: 'st_run' }],
        [{ text: '🔙 Kembali', callback_data: 'st_mainback' }],
      ]
    }
  });
}

async function showStStatus(bot, chatId, msgId) {
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
            const tfCfg = getTfConfig(tf, Number(getConfig('supertrendPeriod', '10')), Number(getConfig('supertrendMultiplier', '3')));
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
    sendMenu(bot, chatId, msgId,
      `📈 <b>Notifikasi ST Status</b>\n\nRunning: ${running ? '✅ Yes' : '❌ No'}` +
      `\n\nPairs:\n${pairText}\n\nOpen trades: ${openCount}\nClosed trades: ${closedCount}`,
      { parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'st_config_back' }]] }
      });
  } catch (e) { console.error('showStStatus error:', e.message); }
}

function showStConfig(bot, chatId, msgId) {
  const sl = getFeatConfig('st', 'slPercent', '-2');
  const tp1 = getFeatConfig('st', 'tp1Percent', '2');
  const tp2 = getFeatConfig('st', 'tp2Percent', '4');
  const running = getFeatConfig('st', 'running', '1') === '1';
  const text = `\u2699\ufe0f <b>Notifikasi ST Config</b>\n\nSL: ${sl}%\nTP: ${tp1}%\nTP2: ${tp2}%\nRunning: ${running ? '\u2705' : '\u274c'}`;
  sendMenu(bot, chatId, msgId, text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: `\ud83d\udcc9 SL ${sl}%`, callback_data: 'st_config_sl' }],
        [{ text: `\ud83d\udcc8 TP ${tp1}%`, callback_data: 'st_config_tp1' }],
        [{ text: `\ud83c\udfaf TP2 ${tp2}%`, callback_data: 'st_config_tp2' }],
        [{ text: running ? '\u23f9 Stop' : '\u25b6\ufe0f Start', callback_data: 'st_config_toggle' }],
        [{ text: '\ud83d\udd19 Back', callback_data: 'st_config_back' }],
      ]
    }
  });
}

function showStManagePair(bot, chatId, msgId) {
  const pairs = loadPairsFor('st_pairs');
  const keys = Object.keys(pairs);
  if (keys.length) {
    const rows = keys.map(t => [{ text: `\ud83d\udcdd ${t}`, callback_data: `st_managepair_edit_${t}` }]);
    rows.push([{ text: '\u2795 Add New', callback_data: 'st_managepair_new' }]);
    rows.push([{ text: '\ud83d\udd19 Back', callback_data: 'st_config_back' }]);
    sendMenu(bot, chatId, msgId, 'Pilih pair untuk diedit:', {
      reply_markup: { inline_keyboard: rows }
    });
  } else {
    conv[chatId] = { cmd: 'st_managepair', step: 'ticker', data: {} };
    sendMenu(bot, chatId, msgId, 'Belum ada pair. Masukkan ticker (contoh: BTCUSDT):', {
      reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'st_config_back' }]] }
    });
  }
}

function getNotifTargets(ticker) {
  const row = db.prepare('SELECT notif_targets FROM st_pairs WHERE ticker = ? LIMIT 1').get(ticker);
  return row?.notif_targets ? JSON.parse(row.notif_targets) : null;
}

function setNotifTargets(ticker, targets) {
  const json = JSON.stringify(targets);
  db.prepare('UPDATE st_pairs SET notif_targets = ? WHERE ticker = ?').run(json, ticker);
}

function getGroupChats() {
  try {
    const v = getFeatConfig('st', 'group_chats', '[]');
    return JSON.parse(v);
  } catch { return []; }
}

function addGroupChat(chatId) {
  const chats = getGroupChats();
  if (!chats.includes(chatId)) {
    chats.push(chatId);
    upsertConfig('st_group_chats', JSON.stringify(chats));
  }
}

async function sendNotif(bot, chatIdIndiv, ticker, text, opts) {
  const targets = ticker ? getNotifTargets(ticker) : null;
  const send = async (id) => {
    try { return await bot.sendMessage(id, text, opts); } catch (e) {
      console.error(`sendNotif to ${id} err:`, e.message);
      return null;
    }
  };
  if (!targets || !targets.length) {
    return send(chatIdIndiv);
  }
  const results = [];
  if (targets.includes('individual')) {
    results.push(await send(chatIdIndiv));
  }
  if (targets.includes('group')) {
    const groups = getGroupChats();
    if (groups.length) {
      for (const gid of groups) {
        results.push(await send(gid));
      }
    } else {
      results.push(await send(chatIdIndiv));
      console.warn(`sendNotif ${ticker}: target group tp blm ada grup terdaftar, fallback ke individu`);
    }
  }
  return results.flat();
}

function showTfSelector(bot, chatId, ticker, preselected, msgId) {
  const lines = [`\u23f0 <b>${ticker}</b> — Tap TF untuk toggle & simpan langsung`];
  const rows = [];
  const tfs = VALID_TIMEFRAMES;
  for (let i = 0; i < tfs.length; i += 4) {
    const row = tfs.slice(i, i + 4).map(tf => ({
      text: `${preselected.includes(tf) ? '\u2705' : '\u26aa'} ${tf}`,
      callback_data: `st_tf_tgl_${ticker}_${tf}`,
    }));
    rows.push(row);
  }
  rows.push([
    { text: '\ud83d\udd19 Kembali ke detail', callback_data: `st_tf_done_${ticker}` },
  ]);
  sendMenu(bot, chatId, msgId, lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: rows }
  });
}

function showStPairDetail(bot, chatId, msgId, ticker) {
  const pairs = loadPairsFor('st_pairs');
  const tfs = sortTfs(pairs[ticker] || []);
  const targets = getNotifTargets(ticker) || [];
  const hasIndiv = targets.includes('individual');
  const hasGroup = targets.includes('group');
  const totGroups = getGroupChats().length;
  const lines = [
    `\ud83d\udcdd <b>${ticker}</b>`,
    `Timeframes: ${tfs.join(', ') || '-'}`,
    '',
    `\ud83d\udd14 Target Notif:`,
    `  \ud83d\udc64 Individu: ${hasIndiv ? '\u2705' : '\u274c'}`,
    `  \ud83d\udc65 Grup: ${hasGroup ? '\u2705' : '\u274c'}${hasGroup && !totGroups ? ' \u26a0\ufe0f' : ''}`,
  ];
  if (hasGroup && !totGroups) {
    lines.push(`   \u26a0\ufe0f Kirim /menu dr grup utk daftarin grup`);
  }
  const rows = [
    [{ text: `\u23f0 Edit Timeframes`, callback_data: `st_edit_tf_${ticker}` }],
    [{ text: `\ud83d\udc64 Individu ${hasIndiv ? '\u2705' : '\u274c'}`, callback_data: `st_notif_indiv_${ticker}` },
     { text: `\ud83d\udc65 Grup ${hasGroup ? '\u2705' : '\u274c'}`, callback_data: `st_notif_group_${ticker}` }],
    [{ text: `\ud83d\uddd1\ufe0f Hapus Pair`, callback_data: `st_delete_${ticker}` }],
    [{ text: '\ud83d\udd19 Back', callback_data: 'st_managepair' }],
  ];
  sendMenu(bot, chatId, msgId, lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: rows }
  });
}

// ─── Register ─────────────────────────────────────────────────────────────────

module.exports = {
  register(bot, chatId) {
    const alignedState = {};
    const tfState = {};
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
            sendMenu(bot, chatId, session.promptMsgId, `Ticker: ${ticker} (${exists ? 'existing, akan diganti' : 'baru'})\nMasukkan timeframe (pisahkan koma).\nValid: <code>${VALID_TIMEFRAMES.join(', ')}</code>`, { parse_mode: 'HTML' });
            return true;
          }
          if (session.step === 'timeframes') {
            const tfs = text.split(',').map(s => normalizeTf(s.trim())).filter(Boolean);
            const invalid = text.split(',').map(s => s.trim()).filter(s => !normalizeTf(s));
            if (invalid.length) { sendMenu(bot, chatId, null, `\u274c Timeframe tidak valid: ${invalid.join(', ')}`); return true; }
            const { ticker, exists } = session.data;
            db.transaction(() => {
              const nt = exists ? db.prepare('SELECT notif_targets FROM st_pairs WHERE ticker = ? LIMIT 1').get(ticker)?.notif_targets : null;
              if (exists) db.prepare('DELETE FROM st_pairs WHERE ticker = ?').run(ticker);
              const ins = db.prepare('INSERT OR IGNORE INTO st_pairs (ticker, timeframe, notif_targets) VALUES (?, ?, ?)');
              for (const tf of tfs) ins.run(ticker, tf, nt);
            })();
            const promptId = session.promptMsgId;
            delete conv[chatId];
            showStManagePair(bot, chatId, promptId);
            return true;
          }
        } else if (session.cmd === 'st_config') {
          const val = parseFloat(text);
          if (isNaN(val)) { sendMenu(bot, chatId, null, '\u274c Masukkan angka yang valid.'); return true; }
          upsertConfig(`st_${session.step}`, val);
          const label = { slPercent: 'SL', tp1Percent: 'TP', tp2Percent: 'TP2' }[session.step] || session.step;
          const promptId = session.promptMsgId;
          delete conv[chatId];
          showStConfig(bot, chatId, promptId);
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
            const tfCfg = getTfConfig(tf, Number(getConfig('supertrendPeriod', '10')), Number(getConfig('supertrendMultiplier', '3')));
            // Use closed candles (exclude current forming candle) to avoid false flips
            const closed = data.length > tfCfg.period + 2 ? data.slice(0, -1) : data;
            const st = calcSupertrend(closed, tfCfg.period, tfCfg.multiplier);
            if (st) results[tf] = st;
          }
          if (!Object.keys(results).length) continue;
          const sortedTfs = sortTfs(Object.keys(results));
          const price = results[sortedTfs[0]]?.price || Object.values(results)[0].price;
          currentPrices[ticker] = price;
          const nowAligned = timeframes.every(t => results[t]?.isBullish === true);
          const prevAligned = alignedState[ticker];

          // Per-TF flip detection — data is from closed candles so no flip-flop
          const prevTfs = tfState[ticker] || {};
          const flipTfs = [];
          const prevDirs = {}; // save old direction for arrow display
          for (const tf of timeframes) {
            const cur = results[tf]?.isBullish;
            if (cur === undefined) continue;
            const prev = prevTfs[tf];
            if (prev !== undefined && prev !== cur) {
              flipTfs.push(tf);
              prevDirs[tf] = prev;
            }
            prevTfs[tf] = cur;
          }
          tfState[ticker] = prevTfs;  // commit state BEFORE notification to prevent duplicates
          if (flipTfs.length > 0 && stRunning === '1') {
            const allState = sortTfs(Object.keys(results)).map(tf => {
              const cur = results[tf]?.isBullish;
              if (cur === undefined) return null;
              if (flipTfs.includes(tf)) {
                const old = prevDirs[tf];
                return `${tf} ${old ? '🟢→🔴' : '🔴→🟢'}`;
              }
              return `${tf} ${cur ? '🟢' : '🔴'}`;
            }).filter(Boolean).join('\n');
            sendNotif(bot, chatId, ticker,
              `🔄 <b>ST Flip</b> ${ticker}\n${allState}\nPrice: $${price}`,
              { parse_mode: 'HTML' }
            );
            console.log(`ST FLIP ${ticker}: ${flipTfs.join(', ')} @ $${price}`);
          }

          const allState = sortTfs(Object.keys(results)).map(
            tf => `${tf} ${results[tf]?.isBullish ? '🟢' : '🔴'}`
          ).join('\n');
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
              const startCap = Number(getFeatConfig('st', 'startCapital', '1000'));
              const marginSize = Number(getFeatConfig('st', 'usdtPerTrade', '100'));
              const allClosed = db.prepare("SELECT * FROM sim_trades WHERE result IS NOT NULL ORDER BY id").all();
              let runCap = startCap;
              for (const ct of allClosed) {
                const m = ct.margin_size || marginSize;
                runCap += (parseFloat(ct.pnl || 0) / 100) * m;
              }
              const capitalEntry = runCap;
              openSimTrade(ticker, 'all', price, slPrice, tp1Price, tp2Price, 'ST Bullish (multi-tf)', marginSize, capitalEntry);
              sendNotif(bot, chatId, ticker, `🟢 <b>ST OPEN</b>\n${ticker} @ $${price}\n${allState}\nSL: $${slPrice} | TP: $${tp1Price} | TP2: $${tp2Price}\nMargin: $${marginSize} | Capital: $${capitalEntry.toFixed(2)}`, { parse_mode: 'HTML' });
              console.log(`ST ALIGNMENT ENTRY: ${ticker} @ $${price} margin=$${marginSize}`);
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
            sendNotif(bot, chatId, t.ticker, `🔴 <b>ST CLOSE (SL)</b>\n${t.ticker} #${t.id}\nEntry: $${t.entry_price} → Close: $${price}\nPnL: ${((price - t.entry_price) / t.entry_price * 100).toFixed(2)}%`, { parse_mode: 'HTML' });
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
            sendNotif(bot, chatId, t.ticker, `🟢 <b>ST CLOSE (TP2)</b>\n${t.ticker} #${t.id}\nEntry: $${t.entry_price} → Close: $${price}\nPnL: ${((price - t.entry_price) / t.entry_price * 100).toFixed(2)}%`, { parse_mode: 'HTML' });
            continue;
          }
          if (price >= t.tp1_price && !t.tp1_hit) {
            db.prepare('UPDATE sim_trades SET tp1_hit=? WHERE id=?').run(t.tp1_price, t.id);
            sendNotif(bot, chatId, t.ticker, `ℹ️ <b>ST TP HIT</b>\n${t.ticker} #${t.id} @ $${price}`, { parse_mode: 'HTML' });
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
            console.log(`ST TP HIT: trade #${t.id} @ $${price}`);
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
      console.log('ST callback:', data, 'chatId:', chatId);

      try {
        if (data === 'st_status') {
          showStStatus(bot, chatId, msgId).catch(e => console.error('ST status err:', e.message));
          return { action: null };
        }
        if (data === 'st_config') {
          showStConfig(bot, chatId, msgId);
          return { action: null };
        }
        if (data === 'st_run') {
          const cur = getFeatConfig('st', 'running', '1') === '1';
          upsertConfig('st_running', cur ? '0' : '1');
          showStFeatureMenu(bot, chatId, msgId);
          return { action: null };
        }
        if (data === 'st_managepair') {
          showStManagePair(bot, chatId, msgId);
          return { action: null };
        }
        if (data === 'st_managepair_new') {
          conv[chatId] = { cmd: 'st_managepair', step: 'ticker', data: {}, promptMsgId: msgId };
          sendMenu(bot, chatId, msgId, 'Masukkan ticker (contoh: BTCUSDT):', {
            reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'st_config_back' }]] }
          });
          return { action: null };
        }
        if (data.startsWith('st_managepair_edit_')) {
          const ticker = data.replace('st_managepair_edit_', '');
          showStPairDetail(bot, chatId, msgId, ticker);
          return { action: null };
        }
        if (data.startsWith('st_edit_tf_')) {
          const ticker = data.replace('st_edit_tf_', '');
          const existing = db.prepare('SELECT timeframe FROM st_pairs WHERE ticker = ?').all(ticker).map(r => r.timeframe);
          const initTfs = existing.length ? existing : ['1m'];
          showTfSelector(bot, chatId, ticker, initTfs, msgId).then(() => {}).catch(() => {});
          return { action: null };
        }
        if (data.startsWith('st_tf_tgl_')) {
          const rest = data.replace('st_tf_tgl_', '');
          const underscoreIdx = rest.lastIndexOf('_');
          if (underscoreIdx < 0) return { action: null };
          const tf = rest.slice(underscoreIdx + 1);
          const ticker = rest.slice(0, underscoreIdx);
          const cur = db.prepare('SELECT timeframe FROM st_pairs WHERE ticker = ?').all(ticker).map(r => r.timeframe);
          const has = cur.includes(tf);
          if (cur.length <= 1 && has) {
            bot.answerCallbackQuery(query.id, { text: '\u274c Minimal 1 timeframe', show_alert: false }).catch(() => {});
            return { action: null };
          }
          const next = has ? cur.filter(x => x !== tf) : [...cur, tf];
          db.transaction(() => {
            const oldRow = db.prepare('SELECT notif_targets FROM st_pairs WHERE ticker = ? LIMIT 1').get(ticker);
            const nt = oldRow?.notif_targets || null;
            db.prepare('DELETE FROM st_pairs WHERE ticker = ?').run(ticker);
            const ins = db.prepare('INSERT OR IGNORE INTO st_pairs (ticker, timeframe, notif_targets) VALUES (?, ?, ?)');
            for (const t of next) ins.run(ticker, t, nt);
          })();
          showTfSelector(bot, chatId, ticker, next, msgId);
          return { action: null };
        }
        if (data.startsWith('st_tf_done_')) {
          const ticker = data.replace('st_tf_done_', '');
          showStPairDetail(bot, chatId, msgId, ticker);
          return { action: null };
        }
        if (data.startsWith('st_notif_indiv_')) {
          const ticker = data.replace('st_notif_indiv_', '');
          const cur = getNotifTargets(ticker) || [];
          const next = cur.includes('individual') ? cur.filter(x => x !== 'individual') : [...cur, 'individual'];
          setNotifTargets(ticker, next);
          showStPairDetail(bot, chatId, msgId, ticker);
          return { action: null };
        }
        if (data.startsWith('st_notif_group_')) {
          const ticker = data.replace('st_notif_group_', '');
          const cur = getNotifTargets(ticker) || [];
          const next = cur.includes('group') ? cur.filter(x => x !== 'group') : [...cur, 'group'];
          setNotifTargets(ticker, next);
          showStPairDetail(bot, chatId, msgId, ticker);
          return { action: null };
        }
        if (data.startsWith('st_delete_')) {
          const ticker = data.replace('st_delete_', '');
          try {
            db.prepare('DELETE FROM st_pairs WHERE ticker = ?').run(ticker);
            showStManagePair(bot, chatId, msgId);
          } catch (e) {
            bot.sendMessage(chatId, `\u274c Gagal menghapus: ${e.message}`);
          }
          return { action: null };
        }
        if (data === 'st_mainback') {
          return { action: 'main_back' };
        }
        if (data === 'st_config_sl' || data === 'st_config_tp1' || data === 'st_config_tp2') {
          const stepMap = { st_config_sl: 'slPercent', st_config_tp1: 'tp1Percent', st_config_tp2: 'tp2Percent' };
          const labelMap = { st_config_sl: 'SL', st_config_tp1: 'TP', st_config_tp2: 'TP2' };
          const defMap = { st_config_sl: '-2', st_config_tp1: '2', st_config_tp2: '4' };
          const cur = getFeatConfig('st', stepMap[data], defMap[data]);
          conv[chatId] = { cmd: 'st_config', step: stepMap[data], data: {}, promptMsgId: msgId };
          sendMenu(bot, chatId, msgId, `${labelMap[data]} saat ini: ${cur}%\nMasukkan nilai baru (contoh: ${data === 'st_config_sl' ? '-5' : '3'}):`, {
            reply_markup: { inline_keyboard: [[{ text: '\u274c Batal', callback_data: 'st_config_cancel' }]] }
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
  },
  addGroupChat,
};
