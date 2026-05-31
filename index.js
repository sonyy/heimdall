require('dotenv').config();
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const { ATR } = require('technicalindicators');
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'indikratos.db');

const BINANCE_API = 'https://api.binance.com';
const OKX_API = 'https://www.okx.com';
const MEXC_API = 'https://api.mexc.com';
const BITGET_API = 'https://api.bitget.com';

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS symbols (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL UNIQUE,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS timeframes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
  );

  CREATE TABLE IF NOT EXISTS symbol_timeframes (
    symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
    timeframe_id INTEGER NOT NULL REFERENCES timeframes(id) ON DELETE CASCADE,
    PRIMARY KEY (symbol_id, timeframe_id)
  );

  CREATE TABLE IF NOT EXISTS supertrend_state (
    symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
    timeframe_id INTEGER NOT NULL REFERENCES timeframes(id) ON DELETE CASCADE,
    is_bullish INTEGER NOT NULL,
    updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (symbol_id, timeframe_id)
  );

  CREATE TABLE IF NOT EXISTS sim_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    entry_price REAL NOT NULL,
    entry_signal TEXT NOT NULL,
    close_price REAL,
    pnl REAL,
    peak_price REAL,
    peak_pct REAL,
    sl_price REAL NOT NULL,
    tp2_price REAL NOT NULL,
    tp2_hit REAL,
    tp4_price REAL NOT NULL,
    tp4_hit REAL,
    result TEXT,
    opened_at TEXT DEFAULT (datetime('now')),
    closed_at TEXT
  );
`);

// Seed timeframes if table is empty
const tfCount = db.prepare('SELECT COUNT(*) as c FROM timeframes').get().c;
if (tfCount === 0) {
  const ins = db.prepare('INSERT OR IGNORE INTO timeframes (name) VALUES (?)');
  for (const name of ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M']) {
    ins.run(name);
  }
}

// Migrate from old flat pairs/state tables if they exist
const hasOldPairs = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pairs'").get();
if (hasOldPairs) {
  const oldPairs = db.prepare('SELECT ticker, timeframe FROM pairs').all();
  const oldState = db.prepare('SELECT ticker, timeframe, is_bullish FROM state').all();
  const oldCfg = db.prepare('SELECT key, value FROM config').all();

  const insSym = db.prepare('INSERT OR IGNORE INTO symbols (ticker) VALUES (?)');
  const getTfId = db.prepare('SELECT id FROM timeframes WHERE name = ?');
  const insST = db.prepare('INSERT OR IGNORE INTO symbol_timeframes (symbol_id, timeframe_id) VALUES (?, ?)');
  const insSs = db.prepare('INSERT OR REPLACE INTO supertrend_state (symbol_id, timeframe_id, is_bullish) VALUES (?, ?, ?)');

  const tx = db.transaction(() => {
    const symIds = {};
    for (const r of oldPairs) {
      if (!symIds[r.ticker]) {
        insSym.run(r.ticker);
        symIds[r.ticker] = db.prepare('SELECT id FROM symbols WHERE ticker = ?').get(r.ticker).id;
      }
      const tf = getTfId.get(r.timeframe);
      if (tf) insST.run(symIds[r.ticker], tf.id);
    }
    for (const r of oldState) {
      if (!symIds[r.ticker]) {
        insSym.run(r.ticker);
        symIds[r.ticker] = db.prepare('SELECT id FROM symbols WHERE ticker = ?').get(r.ticker).id;
      }
      const tf = getTfId.get(r.timeframe);
      if (tf && r.ticker) insSs.run(symIds[r.ticker], tf.id, r.is_bullish);
    }
  });
  tx();

  db.exec('DROP TABLE IF EXISTS pairs; DROP TABLE IF EXISTS state;');
}

// Migrate from JSON files if config table is empty (fresh DB, no migration from old tables)
const cfgCount = db.prepare('SELECT COUNT(*) as c FROM config').get().c;
if (cfgCount === 0) {
  const fs = require('fs');
  const cfgPath = path.join(__dirname, 'config.json');
  const stPath = path.join(__dirname, 'state.json');

  if (fs.existsSync(cfgPath)) {
    try {
      const oldCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      upsertConfig('pollIntervalMs', oldCfg.pollIntervalMs ?? 60000);
      upsertConfig('supertrendPeriod', oldCfg.supertrendPeriod ?? 10);
      upsertConfig('supertrendMultiplier', oldCfg.supertrendMultiplier ?? 3);

      const insSym = db.prepare('INSERT OR IGNORE INTO symbols (ticker) VALUES (?)');
      const getSym = db.prepare('SELECT id FROM symbols WHERE ticker = ?');
      const getTf = db.prepare('SELECT id FROM timeframes WHERE name = ?');
      const insST = db.prepare('INSERT OR IGNORE INTO symbol_timeframes (symbol_id, timeframe_id) VALUES (?, ?)');

      for (const [ticker, tfs] of Object.entries(oldCfg.pairs || {})) {
        insSym.run(ticker);
        const sym = getSym.get(ticker);
        for (const tf of tfs) {
          const t = getTf.get(tf);
          if (t) insST.run(sym.id, t.id);
        }
      }
    } catch (e) { console.error('Migrate config.json error:', e.message); }
  }

  if (fs.existsSync(stPath)) {
    try {
      const oldState = JSON.parse(fs.readFileSync(stPath, 'utf8'));
      const getSym = db.prepare('SELECT id FROM symbols WHERE ticker = ?');
      const getTf = db.prepare('SELECT id FROM timeframes WHERE name = ?');
      const insSs = db.prepare('INSERT OR REPLACE INTO supertrend_state (symbol_id, timeframe_id, is_bullish) VALUES (?, ?, ?)');

      for (const [key, bullish] of Object.entries(oldState)) {
        const parts = key.split('_');
        const ticker = parts.slice(0, -1).join('_'); // handle tickers with underscores
        const timeframe = parts[parts.length - 1];
        if (!ticker || !timeframe) continue;

        const sym = getSym.get(ticker);
        if (!sym) continue;
        const t = getTf.get(timeframe);
        if (!t) continue;
        insSs.run(sym.id, t.id, bullish ? 1 : 0);
      }
    } catch (e) { console.error('Migrate state.json error:', e.message); }
  }
}

function upsertConfig(key, value) {
  db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, String(value));
}

function getConfig(key, def) {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  return row ? row.value : def;
}

function loadConfig() {
  return {
    pollIntervalMs: Number(getConfig('pollIntervalMs', '60000')),
    supertrendPeriod: Number(getConfig('supertrendPeriod', '10')),
    supertrendMultiplier: Number(getConfig('supertrendMultiplier', '3')),
    pairs: loadPairs(),
  };
}

function saveConfig() {
  upsertConfig('pollIntervalMs', config.pollIntervalMs);
  upsertConfig('supertrendPeriod', config.supertrendPeriod);
  upsertConfig('supertrendMultiplier', config.supertrendMultiplier);
  savePairs();
}

function loadPairs() {
  const rows = db.prepare(`
    SELECT s.ticker, t.name as timeframe
    FROM symbols s
    JOIN symbol_timeframes st ON st.symbol_id = s.id
    JOIN timeframes t ON t.id = st.timeframe_id
    ORDER BY s.ticker, t.id
  `).all();
  const pairs = {};
  for (const r of rows) {
    if (!pairs[r.ticker]) pairs[r.ticker] = [];
    pairs[r.ticker].push(r.timeframe);
  }
  return pairs;
}

function savePairs() {
  const insSym = db.prepare('INSERT OR IGNORE INTO symbols (ticker) VALUES (?)');
  const getSym = db.prepare('SELECT id FROM symbols WHERE ticker = ?');
  const getTf = db.prepare('SELECT id FROM timeframes WHERE name = ?');
  const insST = db.prepare('INSERT OR IGNORE INTO symbol_timeframes (symbol_id, timeframe_id) VALUES (?, ?)');

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM symbol_timeframes').run();
    for (const [ticker, tfs] of Object.entries(config.pairs)) {
      insSym.run(ticker);
      const sym = getSym.get(ticker);
      for (const tf of tfs) {
        const t = getTf.get(tf);
        if (t) insST.run(sym.id, t.id);
      }
    }
    db.prepare('DELETE FROM symbols WHERE id NOT IN (SELECT DISTINCT symbol_id FROM symbol_timeframes)').run();
  });
  tx();
}

function loadState() {
  const rows = db.prepare(`
    SELECT s.ticker, t.name as timeframe, ss.is_bullish
    FROM supertrend_state ss
    JOIN symbols s ON s.id = ss.symbol_id
    JOIN timeframes t ON t.id = ss.timeframe_id
  `).all();
  const state = {};
  for (const r of rows) {
    state[`${r.ticker}_${r.timeframe}`] = Boolean(r.is_bullish);
  }
  return state;
}

function saveState(state) {
  const getSym = db.prepare('SELECT id FROM symbols WHERE ticker = ?');
  const getTf = db.prepare('SELECT id FROM timeframes WHERE name = ?');
  const insSs = db.prepare('INSERT OR REPLACE INTO supertrend_state (symbol_id, timeframe_id, is_bullish) VALUES (?, ?, ?)');

  db.prepare('DELETE FROM supertrend_state').run();
  const tx = db.transaction(() => {
    for (const [key, bullish] of Object.entries(state)) {
      const parts = key.split('_');
      const ticker = parts.slice(0, -1).join('_');
      const timeframe = parts[parts.length - 1];
      const sym = getSym.get(ticker);
      const t = getTf.get(timeframe);
      if (sym && t) insSs.run(sym.id, t.id, bullish ? 1 : 0);
    }
  });
  tx();
}

let config = loadConfig();
let bot;
let pollTimer = null;
let running = true;
const conv = {};

function calcSupertrend(klines, period, multiplier) {
  const high = klines.map(k => parseFloat(k[2]));
  const low = klines.map(k => parseFloat(k[3]));
  const close = klines.map(k => parseFloat(k[4]));

  const atrValues = ATR.calculate({ high, low, close, period });
  const hl2 = high.map((h, i) => (h + low[i]) / 2);
  const startIdx = close.length - atrValues.length;

  let finalUpper = 0;
  let finalLower = 0;
  let direction = 1;
  let prevDirection = 1;

  for (let i = startIdx; i < close.length; i++) {
    const atr = atrValues[i - startIdx];
    const basicUpper = hl2[i] + multiplier * atr;
    const basicLower = hl2[i] - multiplier * atr;

    if (i === startIdx) {
      finalUpper = basicUpper;
      finalLower = basicLower;
      direction = close[i] > hl2[i] ? 1 : -1;
    } else {
      const prevFU = finalUpper;
      const prevFL = finalLower;
      finalUpper = (basicUpper < prevFU || close[i - 1] > prevFU) ? basicUpper : prevFU;
      finalLower = (basicLower > prevFL || close[i - 1] < prevFL) ? basicLower : prevFL;

      prevDirection = direction;
      if (direction === 1) {
        direction = close[i] > finalLower ? 1 : -1;
      } else {
        direction = close[i] < finalUpper ? -1 : 1;
      }
    }
  }

  return { isBullish: direction === 1, wasBullish: prevDirection === 1, price: close[close.length - 1] };
}

async function fetchBinance(symbol, interval, limit) {
  const { data } = await axios.get(`${BINANCE_API}/api/v3/klines`, {
    params: { symbol, interval, limit },
    timeout: 10000,
  });
  return data;
}

async function fetchOkx(symbol, interval, limit) {
  const instId = symbol.replace('USDT', '-USDT');
  const bar = interval.replace(/h$/, 'H').replace(/d$/, 'D').replace(/w$/, 'W');
  const { data } = await axios.get(`${OKX_API}/api/v5/market/candles`, {
    params: { instId, bar, limit },
    timeout: 10000,
  });
  if (data.code !== '0') throw new Error(`OKX error: ${data.msg}`);
  return data.data;
}

async function fetchBitget(symbol, interval, limit) {
  const { data } = await axios.get(`${BITGET_API}/api/v2/market/candles`, {
    params: { symbol, granularity: interval, limit },
    timeout: 10000,
  });
  if (data.code !== '00000') throw new Error(`Bitget error: ${data.msg}`);
  return data.data;
}

async function fetchMexc(symbol, interval, limit) {
  const { data } = await axios.get(`${MEXC_API}/api/v3/klines`, {
    params: { symbol, interval, limit },
    timeout: 10000,
  });
  return data;
}

async function fetchKlines(symbol, interval, limit = 200) {
  const errors = [];
  try { const d = await fetchBinance(symbol, interval, limit); return { exchange: 'Binance', data: d }; }
  catch (e) { errors.push(`Binance: ${e.message}`); }

  try { const d = await fetchOkx(symbol, interval, limit); return { exchange: 'OKX', data: d }; }
  catch (e) { errors.push(`OKX: ${e.message}`); }

  try { const d = await fetchMexc(symbol, interval, limit); return { exchange: 'MEXC', data: d }; }
  catch (e) { errors.push(`MEXC: ${e.message}`); }

  try { const d = await fetchBitget(symbol, interval, limit); return { exchange: 'Bitget', data: d }; }
  catch (e) { errors.push(`Bitget: ${e.message}`); }

  // Retry with USDT suffix if original symbol doesn't end with USDT
  if (!symbol.endsWith('USDT')) {
    const usdtSymbol = symbol + 'USDT';
    const usdtErrors = [];
    try { const d = await fetchBinance(usdtSymbol, interval, limit); return { exchange: 'Binance', data: d }; }
    catch (e) { usdtErrors.push(`Binance: ${e.message}`); }
    try { const d = await fetchOkx(usdtSymbol, interval, limit); return { exchange: 'OKX', data: d }; }
    catch (e) { usdtErrors.push(`OKX: ${e.message}`); }
    try { const d = await fetchMexc(usdtSymbol, interval, limit); return { exchange: 'MEXC', data: d }; }
    catch (e) { usdtErrors.push(`MEXC: ${e.message}`); }
    try { const d = await fetchBitget(usdtSymbol, interval, limit); return { exchange: 'Bitget', data: d }; }
    catch (e) { usdtErrors.push(`Bitget: ${e.message}`); }
    errors.push(`with USDT: ${usdtErrors.join('; ')}`);
  }

  throw new Error(`All candle sources failed: ${errors.join('; ')}`);
}

async function checkPair(ticker, timeframes) {
  const results = {};
  for (const tf of timeframes) {
    const { exchange, data } = await fetchKlines(ticker, tf);
    const st = calcSupertrend(data, config.supertrendPeriod, config.supertrendMultiplier);
    if (!st) continue;
    st.exchange = exchange;
    results[tf] = st;
  }
  return results;
}

function formatNotification(ticker, price, results) {
  const exchange = Object.values(results)[0]?.exchange || '';
  const priceStr = price < 0.01 ? price.toFixed(8) : price.toFixed(2);
  const parts = [ticker, ...Object.entries(results).map(([tf, r]) => `${tf}${r.isBullish ? '🟢' : '🔴'}`), `$${priceStr}`, exchange].filter(Boolean);
  return parts.join(' ');
}

async function fetchCurrentPrice(ticker) {
  const errors = [];
  try { const { data } = await axios.get(`${BINANCE_API}/api/v3/ticker/price`, { params: { symbol: ticker }, timeout: 10000 }); return parseFloat(data.price); }
  catch (e) { errors.push(`Binance: ${e.message}`); }
  try { const { data } = await axios.get(`${OKX_API}/api/v5/market/ticker`, { params: { instId: ticker.replace('USDT', '-USDT') }, timeout: 10000 }); if (data.code === '0') return parseFloat(data.data[0].last); }
  catch (e) { errors.push(`OKX: ${e.message}`); }
  try { const { data } = await axios.get(`${MEXC_API}/api/v3/ticker/price`, { params: { symbol: ticker }, timeout: 10000 }); return parseFloat(data.price); }
  catch (e) { errors.push(`MEXC: ${e.message}`); }
  throw new Error(`Price fetch failed: ${errors.join('; ')}`);
}

function openSimTrade(ticker, timeframe, price, signal) {
  const slPrice = price * 0.98;
  const tp2Price = price * 1.02;
  const tp4Price = price * 1.04;
  db.prepare(`INSERT INTO sim_trades (ticker,timeframe,entry_price,entry_signal,peak_price,peak_pct,sl_price,tp2_price,tp4_price) VALUES (?,?,?,?,?,?,?,?,?)`).run(ticker, timeframe, price, signal, price, 0, slPrice, tp2Price, tp4Price);
  console.log(`SIM TRADE OPEN: ${ticker} ${timeframe} @ $${price} (SL: $${slPrice.toFixed(2)}, TP4: $${tp4Price.toFixed(2)})`);
}

function closeSimTrade(id, closePrice, result) {
  const pnl = ((closePrice - db.prepare('SELECT entry_price FROM sim_trades WHERE id=?').get(id).entry_price) / db.prepare('SELECT entry_price FROM sim_trades WHERE id=?').get(id).entry_price) * 100;
  db.prepare(`UPDATE sim_trades SET close_price=?, pnl=?, result=?, closed_at=datetime('now') WHERE id=?`).run(closePrice, pnl.toFixed(2), result, id);
  console.log(`SIM TRADE CLOSE #${id}: ${result} @ $${closePrice} (${pnl.toFixed(2)}%)`);
}

async function processSimTrades(currentPrices) {
  const openTrades = db.prepare("SELECT * FROM sim_trades WHERE result IS NULL").all();
  for (const t of openTrades) {
    let price = currentPrices[t.ticker];
    if (!price) {
      try { price = await fetchCurrentPrice(t.ticker); } catch (e) { continue; }
    }
    if (!price || price <= 0) continue;

    // Update peak
    if (price > t.peak_price) {
      const peakPct = ((price - t.entry_price) / t.entry_price) * 100;
      db.prepare('UPDATE sim_trades SET peak_price=?, peak_pct=? WHERE id=?').run(price, peakPct.toFixed(2), t.id);
    }

    // Check SL (-2%)
    if (price <= t.sl_price) {
      return closeSimTrade(t.id, price, 'LOSE');
    }

    // Check TP 4% (win)
    if (price >= t.tp4_price) {
      if (!t.tp2_hit) {
        db.prepare('UPDATE sim_trades SET tp2_hit=? WHERE id=?').run(t.tp2_price, t.id);
      }
      if (!t.tp4_hit) {
        db.prepare('UPDATE sim_trades SET tp4_hit=? WHERE id=?').run(t.tp4_price, t.id);
      }
      return closeSimTrade(t.id, price, 'WIN');
    }

    // Check TP 2% (milestone only)
    if (price >= t.tp2_price && !t.tp2_hit) {
      db.prepare('UPDATE sim_trades SET tp2_hit=? WHERE id=?').run(t.tp2_price, t.id);
      console.log(`SIM TRADE #${t.id}: TP 2% hit @ $${price}`);
    }
  }
}

async function sendMessage(text) {
  try {
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!chatId) return;
    await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
  } catch (e) {
    console.error('Send message error:', e.message);
  }
}

async function poll() {
  try {
    const state = loadState();
    const changedPairs = [];
    const currentPrices = {};

    for (const [ticker, timeframes] of Object.entries(config.pairs)) {
      try {
        const results = await checkPair(ticker, timeframes);

        currentPrices[ticker] = Object.values(results)[0]?.price || 0;

        let hasChange = false;
        let hasNew = false;
        for (const [tf, r] of Object.entries(results)) {
          const key = `${ticker}_${tf}`;
          const prev = state[key];
          if (prev === undefined) { hasNew = true; }
          else if (prev !== r.isBullish) { hasChange = true; }

          // Entry signal: ST flipped from bearish to bullish
          if (prev !== undefined && prev === false && r.isBullish === true) {
            const existing = db.prepare("SELECT id FROM sim_trades WHERE ticker=? AND timeframe=? AND result IS NULL").get(ticker, tf);
            if (!existing) {
              openSimTrade(ticker, tf, r.price, `${tf} ST Bullish`);
            }
          }

          state[key] = r.isBullish;
        }

        if (hasChange || hasNew) {
          const price = currentPrices[ticker];
          changedPairs.push(formatNotification(ticker, price, results));
        }
      } catch (e) {
        console.error(`Error checking ${ticker}:`, e.message);
        changedPairs.push(`⚠️ ${ticker}: ${e.message}`);
      }
    }

    saveState(state);

    await processSimTrades(currentPrices);

    if (changedPairs.length) {
      await sendMessage(changedPairs.join('\n'));
      console.log('Sent changes:', changedPairs.join(' | '));
    }
  } catch (e) {
    console.error('Poll error:', e.message);
  }
}

async function checkAndSend(ticker) {
  const timeframes = config.pairs[ticker];
  if (!timeframes) return `❌ ${ticker} tidak ada di monitoring.`;

  try {
    const results = await checkPair(ticker, timeframes);
    const price = Object.values(results)[0]?.price || 0;
    return formatNotification(ticker, price, results);
  } catch (e) {
    return `❌ Error cek ${ticker}: ${e.message}`;
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(poll, config.pollIntervalMs);
  console.log(`Polling started every ${config.pollIntervalMs}ms`);
}

function init() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('TELEGRAM_BOT_TOKEN not set');
    process.exit(1);
  }

  bot = new TelegramBot(token, { polling: true });
  console.log('Supertrend bot started');

  function askTicker(chatId, cmd) {
    conv[chatId] = { cmd, step: 'ticker', data: {} };
    const pairList = Object.keys(config.pairs);
    if ((cmd === 'remove' || cmd === 'managepair') && pairList.length) {
      const rows = [];
      for (let i = 0; i < pairList.length; i += 2) {
        const row = [{ text: pairList[i], callback_data: `ticker_${cmd}_${pairList[i]}` }];
        if (pairList[i + 1]) row.push({ text: pairList[i + 1], callback_data: `ticker_${cmd}_${pairList[i + 1]}` });
        rows.push(row);
      }
      bot.sendMessage(chatId, cmd === 'managepair'
        ? 'Pilih ticker untuk edit, atau ketik ticker baru:'
        : 'Pilih ticker atau ketik manual:', {
        reply_markup: { inline_keyboard: rows }
      });
    } else {
      bot.sendMessage(chatId, 'Masukkan ticker:');
    }
  }

  function askTimeframes(chatId) {
    conv[chatId].step = 'timeframes';
    bot.sendMessage(chatId, 'Masukkan timeframe (pisahkan dengan koma):\n\n'
      + '<b>Menit:</b> 1m, 3m, 5m, 15m, 30m\n'
      + '<b>Jam:</b> 1h, 2h, 4h, 6h, 8h, 12h\n'
      + '<b>Hari:</b> 1d, 3d\n'
      + '<b>Minggu:</b> 1w\n'
      + '<b>Bulan:</b> 1M\n\n'
      + 'Contoh: <code>15m,1h,4h</code>\n'
      + '<i>* Jika pair sudah ada, timeframe akan diganti total (overwrite)</i>', { parse_mode: 'HTML' });
  }

  const VALID_TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M'];

  async function handleEditPair(chatId, ticker, tfs) {
    const invalid = tfs.filter(tf => !VALID_TIMEFRAMES.includes(tf));
    if (invalid.length) return bot.sendMessage(chatId, `❌ Timeframe tidak valid: ${invalid.join(', ')}`);

    if (config.pairs[ticker]) {
      config.pairs[ticker] = tfs;
      saveConfig();
      bot.sendMessage(chatId, `✅ ${ticker} diupdate: ${config.pairs[ticker].join(', ')}`);
    } else {
      config.pairs[ticker] = tfs;
      saveConfig();
      bot.sendMessage(chatId, `✅ ${ticker} ditambahkan: ${config.pairs[ticker].join(', ')}`);
    }
    const status = await checkAndSend(ticker);
    sendMessage(status);
  }

  function handleRemove(chatId, ticker) {
    if (!config.pairs[ticker]) return bot.sendMessage(chatId, `❌ ${ticker} tidak ada.`);
    delete config.pairs[ticker];
    saveConfig();
    bot.sendMessage(chatId, `✅ ${ticker} dihapus dari monitoring.`);
  }

  function showIntervalPrompt(chatId) {
    bot.sendMessage(chatId, 'Masukkan interval dalam detik (10–3600):', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '❌ Batal', callback_data: 'config_cancel' }],
        ]
      }
    });
    conv[chatId] = { cmd: 'config', step: 'interval_input', data: {} };
  }

  const cmdList = [
    '/status — cek supertrend semua pair',
    '/managepair — tambah/edit timeframe pair',
    '/remove — hapus pair',
    '/config — lihat & ubah konfigurasi',
  ].join('\n');

  bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, `<b>Indikratos</b>\nMonitor breakout/breakdown supertrend.\n\n<b>Commands:</b>\n${cmdList}`, { parse_mode: 'HTML' });
  });

  bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    const lines = [];
    for (const [ticker] of Object.entries(config.pairs)) {
      lines.push(await checkAndSend(ticker));
    }
    bot.sendMessage(chatId, lines.join('\n'));
  });

  bot.onText(/\/managepair/, (msg) => askTicker(msg.chat.id, 'managepair'));
  bot.onText(/\/remove/, (msg) => askTicker(msg.chat.id, 'remove'));

  function showConfigMenu(chatId) {
    const lines = ['<b>Konfigurasi:</b>'];
    for (const [ticker, tfs] of Object.entries(config.pairs)) {
      lines.push(`  ${ticker}: ${tfs.join(', ')}`);
    }
    lines.push(`\nInterval: ${config.pollIntervalMs / 1000}s`);
    lines.push(`Supertrend: period ${config.supertrendPeriod}, multiplier ${config.supertrendMultiplier}`);
    bot.sendMessage(chatId, lines.join('\n'), {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '⚙️ Ubah interval', callback_data: 'config_interval' }],
          [{ text: '❌ Tutup', callback_data: 'config_close' }],
        ]
      }
    });
  }

  bot.onText(/\/config/, (msg) => showConfigMenu(msg.chat.id));

  bot.on('callback_query', (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const data = callbackQuery.data;
    bot.answerCallbackQuery(callbackQuery.id);

    if (data === 'config_interval') {
      showIntervalPrompt(chatId);
    } else if (data === 'config_close') {
      bot.sendMessage(chatId, '❌ Config ditutup.');
    } else if (data === 'config_cancel') {
      delete conv[chatId];
      bot.sendMessage(chatId, '❌ Interval tidak diubah.');
    } else if (data.startsWith('ticker_')) {
      const parts = data.split('_');
      const cmd = parts[1];
      const ticker = parts.slice(2).join('_');
      const session = conv[chatId];
      if (session && session.step === 'ticker' && session.cmd === cmd) {
        if (cmd === 'remove') { delete conv[chatId]; return handleRemove(chatId, ticker); }
        if (cmd === 'managepair') { session.data.ticker = ticker; return askTimeframes(chatId); }
      }
    }
  });

  bot.on('message', async (msg) => {
    try {
      const chatId = msg.chat.id;
      const text = msg.text;
      if (!text || text.startsWith('/')) return;

      const session = conv[chatId];
      if (!session) return;

      if (session.cmd === 'config') {
        if (session.step === 'interval_input') {
          delete conv[chatId];
          const secs = parseInt(text, 10);
          if (isNaN(secs) || secs < 10 || secs > 3600) return bot.sendMessage(chatId, '❌ Interval harus angka 10–3600.');
          config.pollIntervalMs = secs * 1000;
          saveConfig();
          startPolling();
          bot.sendMessage(chatId, `✅ Interval polling diubah ke ${secs}s`);
          return showConfigMenu(chatId);
        }
      }

      if (session.step === 'ticker') {
        const ticker = text.toUpperCase();
        session.data.ticker = ticker;

        if (session.cmd === 'managepair') {
          return askTimeframes(chatId);
        }

        if (session.cmd === 'remove') {
          delete conv[chatId];
          return handleRemove(chatId, ticker);
        }
      }

      if (session.step === 'timeframes') {
        const raw = text.trim();
        const tfs = raw === '.' ? ['1h','4h','1d'] : raw.split(',').map(s => s.trim()).filter(Boolean);
        const { ticker } = session.data;
        delete conv[chatId];

        if (!tfs.length) return bot.sendMessage(chatId, '❌ Timeframe tidak boleh kosong.');

        if (session.cmd === 'managepair') {
          if (raw === '.') await bot.sendMessage(chatId, 'ℹ️ Pakai default: 1h,4h,1d');
          return handleEditPair(chatId, ticker, tfs);
        }
      }
    } catch (e) {
      console.error('Message handler error:', e);
      bot.sendMessage(msg.chat.id, `❌ Error: ${e.message}`);
    }
  });

  startPolling();
}

init();
