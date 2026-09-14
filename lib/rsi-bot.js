const { db, getFeatConfig, upsertConfig, loadPairsFor } = require('./db');
const { fetchCandlesFlex, fetchKlinesRangeFlex, fetchKlines, fetchKlinesRange, tfToMinutes, normalizeTf, VALID_TIMEFRAMES } = require('./exchange');
const { RSI } = require('technicalindicators');
const bins = require('./binance-futures');

function detectSignal(prevRsi, currRsi, buyLevel, sellLevel) {
  if (currRsi >= buyLevel && prevRsi < buyLevel) return 'LONG';
  if (currRsi <= sellLevel && prevRsi > sellLevel) return 'SHORT';
  return null;
}

async function sendMenu(bot, chatId, msgId, text, opts) {
  if (msgId) {
    try {
      return await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, ...opts });
    } catch (e) {
      const fresh = await bot.sendMessage(chatId, text, opts).catch(e2 => {
        console.error('RSI sendMenu edit+send err:', e.message, '/', e2.message);
        return null;
      });
      return fresh;
    }
  } else {
    try { return await bot.sendMessage(chatId, text, opts); } catch (e) {
      console.error('RSI sendMenu send err:', e.message);
    }
  }
}

module.exports = {
  register(bot, chatId) {
    const conv = {};
    let busy = false;

    // ── Internal Logic ──────────────────────────────────────────────

    function getOpenTrade(ticker, tf) {
      return db.prepare("SELECT * FROM rsi_trades WHERE ticker=? AND timeframe=? AND result IS NULL").get(ticker, tf);
    }

    function getOpenTicker(ticker) {
      return db.prepare("SELECT * FROM rsi_trades WHERE ticker=? AND result IS NULL ORDER BY id DESC LIMIT 1").get(ticker);
    }

    function qtyFor(symbol, price, usdtPerTrade, leverage) {
      const qty = usdtPerTrade * leverage / price;
      const floored = Math.floor(qty * 10000) / 10000;
      if (floored < 0.0001) return null;
      return floored;
    }

    async function getRsiSnapshot(ticker, tf) {
      const { data } = await fetchCandlesFlex(ticker, tf, 200);
      const period = Number(getFeatConfig('rsi', 'period', '14'));
      const forming = data[data.length - 1].openTime + tfToMinutes(tf) * 60000 > Date.now();
      const closed = data.length > period + 2 ? (forming ? data.slice(0, -1) : data) : data;
      const closes = closed.map(c => c.close);
      const rsiArr = RSI.calculate({ period, values: closes });
      if (rsiArr.length < 2) return null;
      return {
        prevRsi: rsiArr[rsiArr.length - 2],
        currRsi: rsiArr[rsiArr.length - 1],
        price: closes[closes.length - 1],
        high: closed[closed.length - 1].high,
        low: closed[closed.length - 1].low,
      };
    }

    async function placeOpen(ticker, tf, direction, snapshot, cfg) {
      const entryPrice = snapshot.price;
      const entryRsi = snapshot.currRsi;
      const usdtPerTrade = Number(cfg.usdtPerTrade);
      const leverage = Number(cfg.leverage);
      const qty = qtyFor(ticker, entryPrice, usdtPerTrade, leverage);
      if (!qty) {
        console.error(`RSI placeOpen qty too small: ${ticker} ${tf} price=${entryPrice}`);
        return null;
      }
      const capital = Number(cfg.capital);
      const marginUsed = db.prepare('SELECT COALESCE(SUM(margin_usdt),0) as m FROM rsi_trades WHERE result IS NULL').get().m;
      if (capital > 0 && marginUsed + usdtPerTrade > capital) {
        await bot.sendMessage(chatId, `❌ Modal tidak cukup: butuh $${usdtPerTrade}, tersisa $${(capital - marginUsed).toFixed(2)} dari capital $${capital}`).catch(() => {});
        console.error(`RSI placeOpen insufficient capital: used=${marginUsed} need=${usdtPerTrade} capital=${capital}`);
        return null;
      }
      const slPercent = Number(cfg.slPercent);
      const tpPercent = Number(cfg.tpPercent);
      const slPrice = slPercent > 0 ? (direction === 'LONG' ? entryPrice * (1 - slPercent / 100) : entryPrice * (1 + slPercent / 100)) : null;
      const tpPrice = tpPercent > 0 ? (direction === 'LONG' ? entryPrice * (1 + tpPercent / 100) : entryPrice * (1 - tpPercent / 100)) : null;

      if (cfg.mode === 'live') {
        if (!bins.isConfigured()) {
          await bot.sendMessage(chatId, '❌ Set BINANCE_API_KEY & BINANCE_API_SECRET di .env untuk mode LIVE').catch(() => {});
          return null;
        }
        try {
          await bins.setMarginType(ticker, cfg.marginMode);
          await bins.setLeverage(ticker, leverage);
          await bins.openMarket(ticker, direction === 'LONG' ? 'BUY' : 'SELL', qty);
        } catch (e) {
          await bot.sendMessage(chatId, `❌ Gagal buka order ${direction}: ${e.message}`).catch(() => {});
          console.error('RSI placeOpen openMarket error:', e.message);
          return null;
        }
      }

      try {
        const ins = db.prepare(`INSERT INTO rsi_trades (ticker,timeframe,mode,direction,entry_price,entry_rsi,qty,margin_usdt,leverage,margin_mode,sl_price,tp_price) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
        ins.run(ticker, tf, cfg.mode, direction, entryPrice, entryRsi, qty, usdtPerTrade, leverage, cfg.marginMode || 'cross', slPrice, tpPrice);
        const id = db.prepare('SELECT last_insert_rowid() as id').get().id;
        const trade = db.prepare('SELECT * FROM rsi_trades WHERE id=?').get(id);
        const emoji = direction === 'LONG' ? '🟢' : '🔴';
        await bot.sendMessage(chatId,
          `${emoji} <b>RSI ${direction}</b>\n${ticker} ${tf} @ $${entryPrice.toFixed(2)}\nRSI: ${entryRsi.toFixed(1)}\nQty: ${qty} | Margin: $${usdtPerTrade} | Lev: ${leverage}x`,
          { parse_mode: 'HTML' }
        ).catch(() => {});
        console.log(`RSI OPEN ${ticker} ${tf} ${direction} @ $${entryPrice} RSI=${entryRsi.toFixed(1)}`);
        return trade;
      } catch (e) {
        console.error('RSI placeOpen db error:', e.message);
        return null;
      }
    }

    async function placeClose(trade, closePrice, reason, cfg) {
      try {
        const entry = trade.entry_price;
        const movePct = trade.direction === 'LONG' ? (closePrice - entry) / entry * 100 : (entry - closePrice) / entry * 100;
        const margin = Number(trade.margin_usdt);
        const leverage = Number(trade.leverage);
        const pnlUsdt = movePct / 100 * leverage * margin - 2 * 0.05 / 100 * (margin * leverage);
        const pnlPct = pnlUsdt / margin * 100;
        const result = pnlUsdt >= 0 ? 'WIN' : 'LOSE';

        if (cfg.mode === 'live') {
          if (!bins.isConfigured()) {
            await bot.sendMessage(chatId, '❌ Set BINANCE_API_KEY & BINANCE_API_SECRET di .env untuk mode LIVE').catch(() => {});
            return;
          }
          let qty = trade.qty;
          try {
            const positions = await bins.getPositions(trade.ticker);
            const pos = positions.find(p => p.symbol === trade.ticker);
            if (pos && parseFloat(pos.positionAmt) !== 0) {
              qty = Math.abs(parseFloat(pos.positionAmt));
            }
          } catch (e) {
            console.error('RSI placeClose getPositions error:', e.message);
          }
          await bins.closeMarket(trade.ticker, trade.direction === 'LONG' ? 'SELL' : 'BUY', qty).catch(e => {
            console.error('RSI placeClose closeMarket error:', e.message);
          });
        }

        db.prepare(`UPDATE rsi_trades SET close_price=?, close_rsi=?, close_reason=?, pnl_usdt=?, pnl_pct=?, result=?, closed_at=datetime('now') WHERE id=?`).run(
          closePrice, null, reason, pnlUsdt, pnlPct, result, trade.id
        );
        await bot.sendMessage(chatId,
          `${result === 'WIN' ? '🟢' : '🔴'} <b>RSI CLOSE (${reason})</b>\n${trade.ticker} ${trade.tf} @ $${closePrice.toFixed(2)}\nPnL: ${pnlUsdt.toFixed(2)} USDT (${pnlPct.toFixed(2)}%)`,
          { parse_mode: 'HTML' }
        ).catch(() => {});
        console.log(`RSI CLOSE ${trade.ticker} ${trade.tf} #${trade.id} ${reason}: ${result} ${pnlUsdt.toFixed(2)}%`);
      } catch (e) {
        console.error('RSI placeClose error:', e.message);
      }
    }

    async function manageOpen(trade, snapshot, cfg) {
      const direction = trade.direction;
      const high = snapshot.high;
      const low = snapshot.low;

      if (direction === 'LONG') {
        if (trade.sl_price != null && low <= trade.sl_price) {
          await placeClose(trade, trade.sl_price, 'SL', cfg);
          return;
        }
        if (trade.tp_price != null && high >= trade.tp_price) {
          await placeClose(trade, trade.tp_price, 'TP', cfg);
          return;
        }
      } else {
        if (trade.sl_price != null && high >= trade.sl_price) {
          await placeClose(trade, trade.sl_price, 'SL', cfg);
          return;
        }
        if (trade.tp_price != null && low <= trade.tp_price) {
          await placeClose(trade, trade.tp_price, 'TP', cfg);
          return;
        }
      }

      const price = snapshot.price;
      const signal = detectSignal(snapshot.prevRsi, snapshot.currRsi, Number(cfg.buyLevel), Number(cfg.sellLevel));
      if (signal && signal !== direction) {
        await placeClose(trade, price, 'REVERSE', cfg);
        await placeOpen(trade.ticker, trade.timeframe, signal, snapshot, cfg);
      }
    }

    async function handleSignal(ticker, tf, snapshot, cfg) {
      const openTrade = getOpenTrade(ticker, tf);
      if (openTrade) {
        await manageOpen(openTrade, snapshot, cfg);
        return;
      }
      const openAnyTf = getOpenTicker(ticker);
      const signal = detectSignal(snapshot.prevRsi, snapshot.currRsi, Number(cfg.buyLevel), Number(cfg.sellLevel));
      if (signal && openAnyTf) {
        console.log(`RSI SKIP open ${ticker} ${tf}: masih ada posisi open di ${openAnyTf.timeframe}`);
        return;
      }
      if (signal) {
        await placeOpen(ticker, tf, signal, snapshot, cfg);
      }
    }

    // ── Telegram UI ──────────────────────────────────────────────────

    function showFeatureMenu(bot, chatId, msgId) {
      const running = getFeatConfig('rsi', 'running', '0') === '1';
      const mode = getFeatConfig('rsi', 'mode', 'dry');
      const pairs = loadPairsFor('rsi_pairs');
      const pairCount = Object.keys(pairs).length;
      const openCount = db.prepare("SELECT COUNT(*) as c FROM rsi_trades WHERE result IS NULL").get().c;
      const buy = getFeatConfig('rsi', 'buyLevel', '30');
      const sell = getFeatConfig('rsi', 'sellLevel', '70');
      const period = getFeatConfig('rsi', 'period', '14');
      const text =
        `🤖 <b>RSI Auto Trading</b>\n` +
        `${running ? '✅ Running' : '❌ Idle'} · Mode: ${mode.toUpperCase()} · ${pairCount} pairs · ${openCount} open\n` +
        `RSI ${period} · Buy ${buy} · Sell ${sell}\n\n` +
        `Pilih aksi:`;
      sendMenu(bot, chatId, msgId, text, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '📋 Status', callback_data: 'rsi_status' }],
            [{ text: '⚙️ Config', callback_data: 'rsi_config' }],
            [{ text: '📝 Pairs', callback_data: 'rsi_managepair' }],
            [{ text: '🧪 Backtest', callback_data: 'rsi_backtest' }],
            [{ text: running ? '⏹ Stop' : '▶️ Start', callback_data: 'rsi_run' }],
            [{ text: '🔙 Kembali', callback_data: 'rsi_mainback' }],
          ],
        },
      });
    }

    function showStatus(bot, chatId, msgId) {
      (async () => {
        try {
          const running = getFeatConfig('rsi', 'running', '0') === '1';
          const mode = getFeatConfig('rsi', 'mode', 'dry');
          const openTrades = db.prepare("SELECT * FROM rsi_trades WHERE result IS NULL ORDER BY id DESC").all();
          const lines = [];
          let unrealized = 0;
          for (const t of openTrades) {
            let price = t.entry_price;
            let pnlPct = 0;
            try {
              const snap = await getRsiSnapshot(t.ticker, t.timeframe);
              if (snap) {
                price = snap.price;
                const movePct = t.direction === 'LONG' ? (price - t.entry_price) / t.entry_price * 100 : (t.entry_price - price) / t.entry_price * 100;
                pnlPct = movePct;
                unrealized += movePct / 100 * Number(t.leverage) * Number(t.margin_usdt);
              }
            } catch (e) {
              console.error('RSI status snapshot error:', e.message);
            }
            lines.push(`• ${t.ticker} ${t.timeframe} ${t.direction} @ $${t.entry_price.toFixed(2)} (now $${price.toFixed(2)}, RSI ${t.entry_rsi.toFixed(1)}) ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`);
          }
          const realized = db.prepare("SELECT COALESCE(SUM(pnl_usdt),0) as s FROM rsi_trades WHERE result IS NOT NULL").get().s;
          let realizedLive = realized;
          if (mode === 'live' && bins.isConfigured()) {
            try { realizedLive = Number(realized) + Number(await bins.getRealizedPnl()); } catch (e) { console.error('RSI realized error:', e.message); }
          }
          const text =
            `📋 <b>RSI Status</b>\n` +
            `Running: ${running ? '✅ Yes' : '❌ No'} · Mode: ${mode.toUpperCase()}\n\n` +
            `Open positions:\n${lines.length ? lines.join('\n') : '  —'}\n\n` +
            `💵 Total PnL (realized): ${Number(realizedLive).toFixed(2)} USDT\n` +
            `📈 Open unrealized: ${unrealized.toFixed(2)} USDT`;
          sendMenu(bot, chatId, msgId, text, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'rsi_mainback' }]] },
          });
        } catch (e) {
          console.error('RSI showStatus error:', e.message);
        }
      })();
    }

    function showConfig(bot, chatId, msgId) {
      const running = getFeatConfig('rsi', 'running', '0') === '1';
      const mode = getFeatConfig('rsi', 'mode', 'dry');
      const testnet = getFeatConfig('rsi', 'testnet', '1');
      const period = getFeatConfig('rsi', 'period', '14');
      const buy = getFeatConfig('rsi', 'buyLevel', '30');
      const sell = getFeatConfig('rsi', 'sellLevel', '70');
      const leverage = getFeatConfig('rsi', 'leverage', '5');
      const usdt = getFeatConfig('rsi', 'usdtPerTrade', '100');
      const capital = getFeatConfig('rsi', 'capital', '1000');
      const marginMode = getFeatConfig('rsi', 'marginMode', 'cross');
      const sl = getFeatConfig('rsi', 'slPercent', '0');
      const tp = getFeatConfig('rsi', 'tpPercent', '0');
      const bdays = getFeatConfig('rsi', 'bt_days', '30');
      const text =
        `⚙️ <b>RSI Config</b>\n\n` +
        `Running: ${running ? '✅' : '❌'} · Mode: ${mode}\n` +
        `Testnet: ${testnet === '1' ? '✅' : '❌'}\n\n` +
        `Period: ${period}\n` +
        `Buy Level: ${buy}\n` +
        `Sell Level: ${sell}\n` +
        `Leverage: ${leverage}\n` +
        `USDT/Trade: ${usdt}\n` +
        `Capital: $${capital}\n` +
        `Margin Mode: ${marginMode}\n` +
        `SL %: ${sl}\n` +
        `TP %: ${tp}\n` +
        `Backtest Days: ${bdays}`;
      sendMenu(bot, chatId, msgId, text, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: `Mode: ${mode.toUpperCase()}`, callback_data: 'rsi_config_mode' }],
            [{ text: `Testnet: ${testnet === '1' ? 'On' : 'Off'}`, callback_data: 'rsi_config_testnet' }],
            [{ text: `📊 Period: ${period}`, callback_data: 'rsi_config_period' }],
            [{ text: `🛒 Buy Level: ${buy}`, callback_data: 'rsi_config_buylevel' }],
            [{ text: `💹 Sell Level: ${sell}`, callback_data: 'rsi_config_selllevel' }],
            [{ text: `🔧 Leverage: ${leverage}`, callback_data: 'rsi_config_leverage' }],
            [{ text: `💵 USDT/Trade: ${usdt}`, callback_data: 'rsi_config_usdt' }],
            [{ text: `💰 Capital: $${capital}`, callback_data: 'rsi_config_capital' }],
            [{ text: `⚖️ Margin Mode: ${marginMode}`, callback_data: 'rsi_config_marginmode' }],
            [{ text: `🛑 SL %: ${sl}`, callback_data: 'rsi_config_sl' }],
            [{ text: `🎯 TP %: ${tp}`, callback_data: 'rsi_config_tp' }],
            [{ text: `📅 BT Days: ${bdays}`, callback_data: 'rsi_config_bt_days' }],
            [{ text: '🔙 Back', callback_data: 'rsi_config_back' }],
          ],
        },
      });
    }

    function showManagePair(bot, chatId, msgId) {
      const pairs = loadPairsFor('rsi_pairs');
      const keys = Object.keys(pairs);
      if (keys.length) {
        // build rows properly
        const actualRows = keys.map(t => {
          const tfs = pairs[t].join(',');
          return { text: `📝 ${t}: ${tfs}`, callback_data: `rsi_managepair_edit_${t}` };
        });
        actualRows.push({ text: '➕ Add Pair', callback_data: 'rsi_managepair_new' });
        actualRows.push({ text: '🔙 Kembali', callback_data: 'rsi_mainback' });
        sendMenu(bot, chatId, msgId, 'Pilih pair:', { reply_markup: { inline_keyboard: actualRows } });
      } else {
        conv[chatId] = { cmd: 'rsi_managepair', step: 'ticker', data: {}, promptMsgId: msgId };
        sendMenu(bot, chatId, msgId, 'Belum ada pair. Masukkan ticker (contoh: BTCUSDT):', {
          reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'rsi_config_back' }]] },
        });
      }
    }

    // ── Message Handler ──────────────────────────────────────────────

    function handleMessage(text, chatIdRcvd) {
      if (!text || text.startsWith('/')) return false;
      const session = conv[chatIdRcvd];
      if (!session) return false;

      try {
        if (session.cmd === 'rsi_managepair') {
          if (session.step === 'ticker') {
            const ticker = text.toUpperCase();
            const exists = db.prepare('SELECT COUNT(*) as c FROM rsi_pairs WHERE ticker = ?').get(ticker).c > 0;
            session.data = { ticker, exists };
            session.step = 'timeframe';
            sendMenu(bot, chatIdRcvd, session.promptMsgId, `Ticker: ${ticker} (${exists ? 'existing, akan diganti' : 'baru'})\nMasukkan timeframe (pisahkan koma).\nValid: <code>${VALID_TIMEFRAMES.join(', ')}</code>`, { parse_mode: 'HTML' });
            return true;
          }
          if (session.step === 'timeframe') {
            const tfs = text.split(',').map(s => normalizeTf(s.trim())).filter(Boolean);
            const invalid = text.split(',').map(s => s.trim()).filter(s => !normalizeTf(s));
            if (invalid.length) { sendMenu(bot, chatIdRcvd, null, `❌ Timeframe tidak valid: ${invalid.join(', ')}`); return true; }
            const { ticker, exists } = session.data;
            db.transaction(() => {
              if (exists) db.prepare('DELETE FROM rsi_pairs WHERE ticker = ?').run(ticker);
              const ins = db.prepare('INSERT OR IGNORE INTO rsi_pairs (ticker, timeframe) VALUES (?, ?)');
              for (const tf of tfs) ins.run(ticker, tf);
            })();
            const promptId = session.promptMsgId;
            delete conv[chatIdRcvd];
            showManagePair(bot, chatIdRcvd, promptId);
            return true;
          }
        } else if (session.cmd === 'rsi_config') {
          const val = parseFloat(text);
          if (isNaN(val)) { sendMenu(bot, chatIdRcvd, null, '❌ Masukkan angka yang valid.'); return true; }
          upsertConfig(`rsi_${session.step}`, val);
          const promptId = session.promptMsgId;
          delete conv[chatIdRcvd];
          showConfig(bot, chatIdRcvd, promptId);
          return true;
        } else if (session.cmd === 'rsi_backtest') {
          const days = Number(text);
          if (!Number.isFinite(days) || days <= 0) { sendMenu(bot, chatIdRcvd, null, '❌ Masukkan jumlah hari yang valid.'); return true; }
          const promptId = session.promptMsgId;
          delete conv[chatIdRcvd];
          (async () => {
            try {
              await runRsiBacktestFlow(bot, chatIdRcvd, days);
            } catch (e) {
              console.error('RSI backtest flow error:', e.message);
            }
          })();
          return true;
        }
      } catch (e) {
        console.error('RSI message handler error:', e.message);
        try { bot.sendMessage(chatIdRcvd, `❌ Error: ${e.message}`); } catch (_) {}
      }
      return false;
    }

    // ── Callback Handler ─────────────────────────────────────────────

    function handleCallback(query) {
      const cId = query.message.chat.id;
      const msgId = query.message.message_id;
      const data = query.data;
      console.log('RSI callback:', data, 'chatId:', cId);

      try {
        if (data === 'rsi_status') {
          showStatus(bot, cId, msgId);
          return { action: null };
        }
        if (data === 'rsi_config') {
          showConfig(bot, cId, msgId);
          return { action: null };
        }
        if (data === 'rsi_run') {
          const cur = getFeatConfig('rsi', 'running', '0') === '1';
          upsertConfig('rsi_running', cur ? '0' : '1');
          showFeatureMenu(bot, cId, msgId);
          return { action: null };
        }
        if (data === 'rsi_managepair') {
          showManagePair(bot, cId, msgId);
          return { action: null };
        }
        if (data === 'rsi_managepair_new') {
          conv[cId] = { cmd: 'rsi_managepair', step: 'ticker', data: {}, promptMsgId: msgId };
          sendMenu(bot, cId, msgId, 'Masukkan ticker (contoh: BTCUSDT):', {
            reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'rsi_config_back' }]] },
          });
          return { action: null };
        }
        if (data.startsWith('rsi_managepair_edit_')) {
          const ticker = data.replace('rsi_managepair_edit_', '');
          const existing = db.prepare('SELECT timeframe FROM rsi_pairs WHERE ticker = ?').all(ticker).map(r => r.timeframe);
          if (existing.length) {
            db.prepare('DELETE FROM rsi_pairs WHERE ticker = ?').run(ticker);
            const ins = db.prepare('INSERT OR IGNORE INTO rsi_pairs (ticker, timeframe) VALUES (?, ?)');
            for (const tf of existing) ins.run(ticker, tf);
          }
          showManagePair(bot, cId, msgId);
          return { action: null };
        }
        if (data === 'rsi_backtest') {
          conv[cId] = { cmd: 'rsi_backtest', step: 'days', data: {}, promptMsgId: msgId };
          const defDays = getFeatConfig('rsi', 'bt_days', '30');
          sendMenu(bot, cId, msgId, `Berapa hari ke belakang? (default ${defDays}):`, {
            reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'rsi_mainback' }]] },
          });
          return { action: null };
        }
        if (data.startsWith('rsi_delete_')) {
          const rest = data.replace('rsi_delete_', '');
          const underscoreIdx = rest.lastIndexOf('_');
          if (underscoreIdx < 0) return { action: null };
          const tf = rest.slice(underscoreIdx + 1);
          const ticker = rest.slice(0, underscoreIdx);
          try {
            db.prepare('DELETE FROM rsi_pairs WHERE ticker = ? AND timeframe = ?').run(ticker, tf);
            showManagePair(bot, cId, msgId);
          } catch (e) {
            bot.sendMessage(cId, `❌ Gagal menghapus: ${e.message}`).catch(() => {});
          }
          return { action: null };
        }
        if (data === 'rsi_mainback') {
          return { action: 'main_back' };
        }
        if (data === 'rsi_config_back') {
          showFeatureMenu(bot, cId, msgId);
          return { action: null };
        }
        if (data === 'rsi_config_mode') {
          const cur = getFeatConfig('rsi', 'mode', 'dry');
          const next = cur === 'dry' ? 'live' : 'dry';
          upsertConfig('rsi_mode', next);
          showConfig(bot, cId, msgId);
          return { action: null };
        }
        if (data === 'rsi_config_testnet') {
          const cur = getFeatConfig('rsi', 'testnet', '1');
          upsertConfig('rsi_testnet', cur === '1' ? '0' : '1');
          showConfig(bot, cId, msgId);
          return { action: null };
        }
        if (data === 'rsi_config_marginmode') {
          const cur = getFeatConfig('rsi', 'marginMode', 'cross');
          upsertConfig('rsi_marginMode', cur === 'cross' ? 'isolated' : 'cross');
          showConfig(bot, cId, msgId);
          return { action: null };
        }
        const configSteps = {
          rsi_config_period: 'period',
          rsi_config_buylevel: 'buyLevel',
          rsi_config_selllevel: 'sellLevel',
          rsi_config_leverage: 'leverage',
          rsi_config_usdt: 'usdtPerTrade',
          rsi_config_capital: 'capital',
          rsi_config_sl: 'slPercent',
          rsi_config_tp: 'tpPercent',
          rsi_config_bt_days: 'bt_days',
        };
        if (configSteps[data]) {
          const step = configSteps[data];
          const cur = getFeatConfig('rsi', step, '14');
          conv[cId] = { cmd: 'rsi_config', step, data: {}, promptMsgId: msgId };
          sendMenu(bot, cId, msgId, `${step} saat ini: ${cur}\nMasukkan nilai baru:`, {
            reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'rsi_config_back' }]] },
          });
          return { action: null };
        }
      } catch (e) {
        console.error('RSI handleCallback error:', e.message);
      }

      return { action: null };
    }

    // ── Poll Tick ────────────────────────────────────────────────────

    async function pollTick() {
      if (busy) return;
      try {
        if (getFeatConfig('rsi', 'running', '0') !== '1') return;
        busy = true;
        const pairs = loadPairsFor('rsi_pairs');
        for (const [ticker, timeframes] of Object.entries(pairs)) {
          if (!timeframes || !timeframes.length) continue;
          for (const tf of timeframes) {
            try {
              const snapshot = await getRsiSnapshot(ticker, tf);
              if (!snapshot) continue;
              const cfg = {
                mode: getFeatConfig('rsi', 'mode', 'dry'),
                buyLevel: getFeatConfig('rsi', 'buyLevel', '30'),
                sellLevel: getFeatConfig('rsi', 'sellLevel', '70'),
                period: getFeatConfig('rsi', 'period', '14'),
                usdtPerTrade: getFeatConfig('rsi', 'usdtPerTrade', '100'),
                leverage: getFeatConfig('rsi', 'leverage', '5'),
                capital: getFeatConfig('rsi', 'capital', '1000'),
                marginMode: getFeatConfig('rsi', 'marginMode', 'cross'),
                slPercent: getFeatConfig('rsi', 'slPercent', '0'),
                tpPercent: getFeatConfig('rsi', 'tpPercent', '0'),
              };
              const signal = detectSignal(snapshot.prevRsi, snapshot.currRsi, Number(cfg.buyLevel), Number(cfg.sellLevel));
              console.log('RSI', ticker, tf, 'rsi=' + snapshot.currRsi.toFixed(1), 'signal=' + (signal || 'none'));
              await handleSignal(ticker, tf, snapshot, cfg);
            } catch (e) {
              console.error(`RSI poll ${ticker} ${tf}:`, e.message);
            }
          }
        }
      } catch (e) {
        console.error('RSI pollTick error:', e.message);
      } finally {
        busy = false;
      }
    }

    return {
      prefix: 'rsi_',
      handleCallback,
      handleMessage,
      pollTick,
      showFeatureMenu: (chatIdLocal, msgId) => showFeatureMenu(bot, chatIdLocal, msgId),
    };
  },
};

// ─── Standalone Backtest ──────────────────────────────────────────────

async function runRsiBacktest(ticker, timeframe, days, overrides = {}) {
  const cfg = (key, dflt) => (overrides[key] != null ? Number(overrides[key]) : Number(getFeatConfig('rsi', key, dflt)));
  const cfgStr = (key, dflt) => (overrides[key] != null ? String(overrides[key]) : String(getFeatConfig('rsi', key, dflt)));
  const period = cfg('period', '14');
  const buyLevel = cfg('buyLevel', '30');
  const sellLevel = cfg('sellLevel', '70');
  const leverage = cfg('leverage', '5');
  const usdtPerTrade = cfg('usdtPerTrade', '100');
  const slPercent = cfg('slPercent', '0');
  const tpPercent = cfg('tpPercent', '0');
  const capital = cfg('capital', '1000');
  const marginMode = cfgStr('marginMode', 'cross').toLowerCase() === 'isolated' ? 'isolated' : 'cross';

  const limit = Math.ceil(days * 24 * 60 / tfToMinutes(timeframe)) + period + 10;
  const startTime = Date.now() - days * 86400000;
  const endTime = Date.now();
  const { data: rawData } = await fetchKlinesRangeFlex(ticker, timeframe, startTime, endTime, limit);
  const data = rawData[rawData.length - 1].openTime + tfToMinutes(timeframe) * 60000 > Date.now()
    ? rawData.slice(0, -1)
    : rawData;

  const closes = data.map(c => c.close);
  const highs = data.map(c => c.high);
  const lows = data.map(c => c.low);
  const rsiArr = RSI.calculate({ period, values: closes });

  let trades = [];
  let equity = capital;
  let peakEquity = capital;
  let maxDd = 0;
  let openTrade = null;
  const feePerSide = 0.05 / 100;
  const isolatedLiqPrice = (direction, entry) => (direction === 'LONG' ? entry * (1 - 1 / leverage) : entry * (1 + 1 / leverage));

  for (let i = period; i < data.length; i++) {
    const prevRsi = rsiArr[i - period - 1];
    const currRsi = rsiArr[i - period];
    if (prevRsi == null) continue;
    const entryPrice = closes[i];
    const entryRsi = currRsi;
    const signal = detectSignal(prevRsi, currRsi, buyLevel, sellLevel);

    if (openTrade) {
      const high = highs[i];
      const low = lows[i];
      let exit = null;
      const slPrice = slPercent > 0 ? (openTrade.direction === 'LONG' ? openTrade.entry * (1 - slPercent / 100) : openTrade.entry * (1 + slPercent / 100)) : null;
      const tpPrice = tpPercent > 0 ? (openTrade.direction === 'LONG' ? openTrade.entry * (1 + tpPercent / 100) : openTrade.entry * (1 - tpPercent / 100)) : null;
      if (slPrice != null) {
        if (openTrade.direction === 'LONG') {
          if (low <= slPrice) exit = { price: slPrice, reason: 'SL' };
        } else {
          if (high >= slPrice) exit = { price: slPrice, reason: 'SL' };
        }
      }
      if (!exit && tpPrice != null) {
        if (openTrade.direction === 'LONG') {
          if (high >= tpPrice) exit = { price: tpPrice, reason: 'TP' };
        } else {
          if (low <= tpPrice) exit = { price: tpPrice, reason: 'TP' };
        }
      }
      if (!exit) {
        if (marginMode === 'isolated') {
          const liq = isolatedLiqPrice(openTrade.direction, openTrade.entry);
          if (openTrade.direction === 'LONG' && low <= liq) exit = { price: liq, reason: 'LIQUIDATED', liq: true };
          else if (openTrade.direction === 'SHORT' && high >= liq) exit = { price: liq, reason: 'LIQUIDATED', liq: true };
        } else {
          const worstPrice = openTrade.direction === 'LONG' ? low : high;
          const worstMovePct = openTrade.direction === 'LONG' ? (worstPrice - openTrade.entry) / openTrade.entry * 100 : (openTrade.entry - worstPrice) / openTrade.entry * 100;
          const worstPnl = worstMovePct / 100 * leverage * usdtPerTrade - feePerSide * (usdtPerTrade * leverage);
          if (equity + worstPnl <= 0) {
            const lossBudget = equity - feePerSide * (usdtPerTrade * leverage);
            const movePctLiq = openTrade.direction === 'LONG' ? -(lossBudget / (leverage * usdtPerTrade) * 100) : (lossBudget / (leverage * usdtPerTrade) * 100);
            const liqPrice = openTrade.direction === 'LONG' ? openTrade.entry * (1 + movePctLiq / 100) : openTrade.entry * (1 - movePctLiq / 100);
            exit = { price: liqPrice, reason: 'LIQUIDATED', liq: true };
          }
        }
      }
      if (!exit && signal && signal !== openTrade.direction) {
        exit = { price: closes[i], reason: 'REVERSE' };
      }
      if (exit) {
        const closePrice = exit.price;
        let pnlUsdt;
        let pnlPct;
        if (exit.liq && marginMode === 'isolated') {
          pnlUsdt = -usdtPerTrade;
          pnlPct = -100;
        } else {
          const movePct = openTrade.direction === 'LONG' ? (closePrice - openTrade.entry) / openTrade.entry * 100 : (openTrade.entry - closePrice) / openTrade.entry * 100;
          pnlUsdt = movePct / 100 * leverage * usdtPerTrade - 2 * feePerSide * (usdtPerTrade * leverage);
          pnlPct = pnlUsdt / usdtPerTrade * 100;
        }
        const result = pnlUsdt >= 0 ? 'WIN' : 'LOSE';
        equity += pnlUsdt;
        peakEquity = Math.max(peakEquity, equity);
        maxDd = Math.max(maxDd, peakEquity - equity);
        trades.push({ direction: openTrade.direction, entry: openTrade.entry, close: closePrice, reason: exit.reason, pnlUsdt, pnlPct, result, entryRsi: openTrade.entryRsi, closeRsi: currRsi });
        openTrade = null;
      }
    }

    if (!openTrade && signal && equity >= usdtPerTrade) {
      openTrade = { direction: signal, entry: entryPrice, entryRsi };
    }
  }

  const winCount = trades.filter(t => t.result === 'WIN').length;
  const totalPnl = trades.reduce((s, t) => s + t.pnlUsdt, 0);
  const totalPnlPct = usdtPerTrade ? totalPnl / usdtPerTrade * 100 : 0;
  const totalTrades = trades.length;
  const finalEquity = equity;

  const configJson = JSON.stringify({ period, buyLevel, sellLevel, leverage, usdtPerTrade, capital, marginMode, slPercent, tpPercent });
  try {
    db.prepare(`INSERT INTO rsi_bt_results (ticker,timeframe,days,config_json,total_trades,win_count,win_rate,total_pnl_pct,max_dd) VALUES (?,?,?,?,?,?,?,?,?)`).run(
      ticker, timeframe, days, configJson, totalTrades, winCount, totalTrades ? winCount / totalTrades * 100 : 0, totalPnlPct, maxDd
    );
  } catch (e) {
    console.error('runRsiBacktest save error:', e.message);
  }

  return {
    ticker,
    timeframe,
    days,
    totalTrades,
    winCount,
    winRate: totalTrades ? winCount / totalTrades * 100 : 0,
    totalPnlPct,
    maxDd,
    capital,
    marginMode,
    finalEquity,
    trades,
  };
}

async function runRsiBacktestFlow(bot, chatId, days) {
  const pairs = loadPairsFor('rsi_pairs');
  const pairKeys = Object.keys(pairs);
  if (!pairKeys.length) {
    await sendMenu(bot, chatId, null, '⚠️ Belum ada pair di rsi_pairs. Tambah dulu via Pairs.', { parse_mode: 'HTML' });
    return;
  }
  const messages = [];
  for (const [ticker, timeframes] of Object.entries(pairs)) {
    for (const tf of timeframes) {
      try {
        const report = await runRsiBacktest(ticker, tf, days);
        messages.push({ ticker, tf, report });
      } catch (e) {
        console.error(`RSI backtest ${ticker} ${tf}:`, e.message);
      }
    }
  }
  if (!messages.length) {
    await sendMenu(bot, chatId, null, '❌ Tidak ada hasil backtest.', { parse_mode: 'HTML' });
    return;
  }
  const lines = [`📊 <b>Backtest RSI (${days}d)</b>`, ''];
  for (const { ticker, tf, report } of messages) {
    lines.push(`<b>${ticker}</b> ${tf} — ${report.totalTrades} trade, ${report.winCount}W / ${report.totalTrades - report.winCount}L`);
    lines.push(`  Win Rate: ${report.winRate.toFixed(1)}% · Total PnL: ${report.totalPnlPct >= 0 ? '+' : ''}${report.totalPnlPct.toFixed(2)}% · Max DD: ${report.maxDd.toFixed(2)}%`);
  }
  await sendMenu(bot, chatId, null, lines.join('\n'), { parse_mode: 'HTML' });
}

module.exports.register = module.exports.register;
module.exports.runRsiBacktest = runRsiBacktest;
