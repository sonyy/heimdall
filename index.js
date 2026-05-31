require('dotenv').config();
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const STATE_PATH = path.join(__dirname, 'state.json');

const BINANCE_API = 'https://api.binance.com';

const SYMBOL_MAP = {
  BTC: 'BTCUSDT',
  ETH: 'ETHUSDT',
  SOL: 'SOLUSDT',
  HYPE: 'HYPEUSDT',
};

const VALID_TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M'];

let config = loadConfig();
let bot;
let pollTimer = null;
let running = true;
const conv = {}; // chatId -> { cmd, step, data }

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {
      pollIntervalMs: 60000,
      supertrendPeriod: 10,
      supertrendMultiplier: 3,
      pairs: { BTC: ['15m', '1h'], ETH: ['4h', '1d', '1w'], SOL: ['5m', '15m'], HYPE: ['15m', '1h', '4h'] },
    };
  }
}

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function calcSupertrend(klines, period, multiplier) {
  const high = klines.map(k => parseFloat(k[2]));
  const low = klines.map(k => parseFloat(k[3]));
  const close = klines.map(k => parseFloat(k[4]));
  const len = klines.length;

  if (len < period + 1) return null;

  const tr = new Array(len);
  tr[0] = high[0] - low[0];
  for (let i = 1; i < len; i++) {
    tr[i] = Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1]));
  }

  const atr = new Array(len);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  atr[period - 1] = sum / period;
  for (let i = period; i < len; i++) {
    atr[i] = (tr[i] + atr[i - 1] * (period - 1)) / period;
  }

  const direction = new Array(len).fill(1);
  const upperBand = new Array(len).fill(0);
  const lowerBand = new Array(len).fill(0);

  for (let i = period - 1; i < len; i++) {
    const hl2 = (high[i] + low[i]) / 2;
    let upper = hl2 + multiplier * atr[i];
    let lower = hl2 - multiplier * atr[i];

    if (i === period - 1) {
      direction[i] = close[i] > hl2 ? 1 : -1;
    } else {
      if (direction[i - 1] === 1 && close[i] <= upperBand[i - 1]) direction[i] = -1;
      else if (direction[i - 1] === -1 && close[i] >= lowerBand[i - 1]) direction[i] = 1;
      else direction[i] = direction[i - 1];

      if (direction[i] === 1) lower = Math.max(lower, lowerBand[i - 1]);
      else upper = Math.min(upper, upperBand[i - 1]);
    }

    upperBand[i] = upper;
    lowerBand[i] = lower;
  }

  return { isBullish: direction[len - 1] === 1, wasBullish: direction[len - 2] === 1, price: close[len - 1] };
}

async function fetchKlines(symbol, interval, limit = 200) {
  const { data } = await axios.get(`${BINANCE_API}/api/v3/klines`, {
    params: { symbol, interval, limit },
    timeout: 10000,
  });
  return data;
}

async function checkPair(ticker, timeframes) {
  const symbol = SYMBOL_MAP[ticker];
  if (!symbol) throw new Error(`Unknown ticker: ${ticker}`);

  const results = {};
  for (const tf of timeframes) {
    const klines = await fetchKlines(symbol, tf);
    const st = calcSupertrend(klines, config.supertrendPeriod, config.supertrendMultiplier);
    if (!st) continue;
    results[tf] = st;
  }
  return results;
}

function formatNotification(ticker, price, results) {
  const parts = [`${ticker} $${price.toFixed(2)}`];
  for (const [tf, r] of Object.entries(results)) {
    parts.push(`· ${tf} ${r.isBullish ? '🟢' : '🔴'}`);
  }
  return parts.join(' ');
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

    for (const [ticker, timeframes] of Object.entries(config.pairs)) {
      try {
        const results = await checkPair(ticker, timeframes);

        let hasChange = false;
        for (const [tf, r] of Object.entries(results)) {
          const key = `${ticker}_${tf}`;
          const prev = state[key];
          if (prev !== undefined && prev !== r.isBullish) hasChange = true;
          state[key] = r.isBullish;
        }

        if (hasChange) {
          const price = Object.values(results)[0]?.price || 0;
          changedPairs.push(formatNotification(ticker, price, results));
        }
      } catch (e) {
        console.error(`Error checking ${ticker}:`, e.message);
      }
    }

    saveState(state);

    if (changedPairs.length) {
      await sendMessage(changedPairs.join('\n'));
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
    bot.sendMessage(chatId, 'Masukkan ticker:');
  }

  function askTimeframes(chatId) {
    conv[chatId].step = 'timeframes';
    bot.sendMessage(chatId, 'Masukkan timeframe (pisahkan dengan koma, misal: 15m,1h,4h):');
  }

  function handleAdd(chatId, ticker, tfs) {
    const invalid = tfs.filter(tf => !VALID_TIMEFRAMES.includes(tf));
    if (invalid.length) return bot.sendMessage(chatId, `❌ Timeframe tidak valid: ${invalid.join(', ')}`);
    if (!config.pairs[ticker]) config.pairs[ticker] = [];
    for (const tf of tfs) {
      if (!config.pairs[ticker].includes(tf)) config.pairs[ticker].push(tf);
    }
    saveConfig();
    bot.sendMessage(chatId, `✅ ${ticker} ditambahkan: ${config.pairs[ticker].join(', ')}`);
  }

  function handleRemove(chatId, ticker) {
    if (!config.pairs[ticker]) return bot.sendMessage(chatId, `❌ ${ticker} tidak ada.`);
    delete config.pairs[ticker];
    saveConfig();
    bot.sendMessage(chatId, `✅ ${ticker} dihapus dari monitoring.`);
  }

  function handleAddtf(chatId, ticker, tfs) {
    if (!config.pairs[ticker]) return bot.sendMessage(chatId, `❌ ${ticker} tidak ada.`);
    const invalid = tfs.filter(tf => !VALID_TIMEFRAMES.includes(tf));
    if (invalid.length) return bot.sendMessage(chatId, `❌ Timeframe tidak valid: ${invalid.join(', ')}`);
    for (const tf of tfs) {
      if (!config.pairs[ticker].includes(tf)) config.pairs[ticker].push(tf);
    }
    saveConfig();
    bot.sendMessage(chatId, `✅ ${ticker} timeframes: ${config.pairs[ticker].join(', ')}`);
  }

  function handleRemovetf(chatId, ticker, tfs) {
    if (!config.pairs[ticker]) return bot.sendMessage(chatId, `❌ ${ticker} tidak ada.`);
    config.pairs[ticker] = config.pairs[ticker].filter(tf => !tfs.includes(tf));
    if (!config.pairs[ticker].length) delete config.pairs[ticker];
    saveConfig();
    bot.sendMessage(chatId, `✅ ${ticker} timeframes: ${config.pairs[ticker]?.join(', ') || '(semua dihapus, gunakan /remove untuk hapus pair)'}`);
  }

  const cmdList = [
    '/status — cek supertrend semua pair',
    '/check — cek supertrend pair tertentu',
    '/add — tambah pair & timeframe',
    '/remove — hapus pair',
    '/addtf — tambah timeframe ke pair',
    '/removetf — hapus timeframe dari pair',
    '/config — lihat konfigurasi',
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

  bot.onText(/\/check/, (msg) => askTicker(msg.chat.id, 'check'));
  bot.onText(/\/add/, (msg) => askTicker(msg.chat.id, 'add'));
  bot.onText(/\/remove/, (msg) => askTicker(msg.chat.id, 'remove'));
  bot.onText(/\/addtf/, (msg) => askTicker(msg.chat.id, 'addtf'));
  bot.onText(/\/removetf/, (msg) => askTicker(msg.chat.id, 'removetf'));

  bot.onText(/\/config/, (msg) => {
    const chatId = msg.chat.id;
    const lines = ['<b>Konfigurasi:</b>'];
    for (const [ticker, tfs] of Object.entries(config.pairs)) {
      lines.push(`  ${ticker}: ${tfs.join(', ')}`);
    }
    lines.push(`\nInterval: ${config.pollIntervalMs / 1000}s`);
    lines.push(`Supertrend: period ${config.supertrendPeriod}, multiplier ${config.supertrendMultiplier}`);
    bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
  });

  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    if (!text || text.startsWith('/')) return;

    const session = conv[chatId];
    if (!session) return;

    if (session.step === 'ticker') {
      const ticker = text.toUpperCase();
      session.data.ticker = ticker;

      if (session.cmd === 'check') {
        delete conv[chatId];
        const result = await checkAndSend(ticker);
        return bot.sendMessage(chatId, result);
      }

      if (session.cmd === 'remove') {
        delete conv[chatId];
        return handleRemove(chatId, ticker);
      }

      if (session.cmd === 'add' || session.cmd === 'addtf' || session.cmd === 'removetf') {
        return askTimeframes(chatId);
      }
    }

    if (session.step === 'timeframes') {
      const tfs = text.split(',').map(s => s.trim()).filter(Boolean);
      const { ticker } = session.data;
      delete conv[chatId];

      if (!tfs.length) return bot.sendMessage(chatId, '❌ Timeframe tidak boleh kosong.');

      if (session.cmd === 'add') return handleAdd(chatId, ticker, tfs);
      if (session.cmd === 'addtf') return handleAddtf(chatId, ticker, tfs);
      if (session.cmd === 'removetf') return handleRemovetf(chatId, ticker, tfs);
    }
  });

  startPolling();
}

init();
