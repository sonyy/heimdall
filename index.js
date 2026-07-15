require('dotenv').config();
const { TelegramBot } = require('node-telegram-bot-api');
const { db, upsertConfig, getConfig, getFeatConfig, loadPairsFor } = require('./lib/db');
const { normalizeTf } = require('./lib/exchange');
const stSim = require('./lib/st-simulasi');
const btSt = require('./lib/backtest-st');
const perpMs = require('./lib/perpetual-ms');

// ─── Process-level safety nets (prevent silent exits) ─────────────────────
process.on('uncaughtException', (e) => {
  console.error('UNCAUGHT:', e.message, e.stack?.split('\n').slice(0,3).join(' | '));
});
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED:', reason?.message || reason);
});

const BOT_TOKEN = process.env.BOT_TOKEN || '8930990858:AAG7VO5i0LpFrq-gFq-K4Th_MyTols1L1EQ';
const CHAT_ID = process.env.CHAT_ID || '5444480485';
const bot = new TelegramBot(BOT_TOKEN, {
  polling: { params: { allowed_updates: [], timeout: 3 } }, // timeout=3s biar menu lebih responsif
});

// Clear any stale webhook/polling state so fresh polling starts clean
bot.deleteWebhook().catch(() => {});

// ─── Register feature modules ────────────────────────────────────────────────
const st = stSim.register(bot, CHAT_ID);
const bt = btSt.register(bot, CHAT_ID);
const perp = perpMs.register(bot, CHAT_ID);
const features = [st, bt, perp];

// ─── Shared sendMenu ─────────────────────────────────────────────────────────
// When editMessageText fails (stale msg, rate limit), fallback to sendMessage.
async function sendMenu(chatId, msgId, text, opts) {
  if (msgId) {
    try {
      return await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, ...opts });
    } catch (e) {
      // edit failed — send fresh message instead
      const fresh = await bot.sendMessage(chatId, text, opts).catch(e2 => {
        console.error('sendMenu edit+send err:', e.message, '/', e2.message);
        return null;
      });
      return fresh;
    }
  } else {
    try { return await bot.sendMessage(chatId, text, opts); } catch (e) { console.error('sendMenu send err:', e.message); }
  }
}

// ─── Main Menu ───────────────────────────────────────────────────────────────
function showMainMenu(chatId, msgId) {
  try {
    const stPairs = loadPairsFor('st_pairs');
    const btPairs = loadPairsFor('bt_pairs');
    const perpPairs = loadPairsFor('perp_pairs');
    const stRunning = getFeatConfig('st', 'running', '1') === '1';
    const perpRunning = getFeatConfig('perp', 'running', '0') === '1';
    const btCount = db.prepare("SELECT COUNT(*) as c FROM backtest_summary").get().c;

    sendMenu(chatId, msgId,
      `━━━ <b>HEIMDALL</b> ━━━\n\n` +
      `📈 ST Sim: ${Object.keys(stPairs).length} pairs ${stRunning ? '✅' : '❌'}\n` +
      `📊 BT: ${Object.keys(btPairs).length} pairs (${btCount} hasil)\n` +
      `🔁 Perp: ${Object.keys(perpPairs).length} pairs ${perpRunning ? '✅' : '❌'}\n\n` +
      `TF: <code>1m 3m 5m 15m 30m 1h 2h 4h 6h 8h 12h 1d 3d 1w 1M</code>` +
      `\n<code>1M</code> = monthly (bukan 1 minute)`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: `\u{1F4C8} ST Simulasi ${stRunning ? '✅' : '❌'}`, callback_data: 'main_st' }],
            [{ text: `\u{1F4CA} Backtest ST`, callback_data: 'main_bt' }],
            [{ text: `\u{1F501} Perpetual MS ${perpRunning ? '✅' : '❌'}`, callback_data: 'main_perp' }],
          ]
        }
      }
    );
  } catch (e) {
    console.error('showMainMenu error:', e.message);
  }
}

// ─── Register command list for Telegram UI ──────────────────────────────────
bot.setMyCommands([
  { command: 'menu', description: 'Menu utama' },
  { command: 'status', description: 'System status' },
  { command: 'backtest', description: 'Backtest ST' },
  { command: 'btp', description: 'Backtest perpetual' },
]).catch(() => {});

// ─── Notify user on restart ─────────────────────────────────────────────────
bot.sendMessage(CHAT_ID, '🔄 Heimdall restarted', { disable_notification: true }).catch(() => {});

// ─── Command Handlers ────────────────────────────────────────────────────────
bot.onText(/\/start|\/menu|\/config/, (msg) => {
  console.log('CMD /menu from', msg.chat.id, msg.chat.type, 'text:', msg.text);
  if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') {
    stSim.addGroupChat(msg.chat.id);
  }
  showMainMenu(msg.chat.id);
});

bot.onText(/\/backtest(?:\s+(\w+)(?:\s+(\w+))?)?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const ticker = match[1] ? match[1].toUpperCase() : null;
  const tf = match[2] ? normalizeTf(match[2]) : null;
  if (!btSt.runBacktest) return bot.sendMessage(chatId, '\u274c Backtest module unavailable');
  try {
    const m = await bot.sendMessage(chatId, `\u23f3 Running backtest ${ticker || 'semua pair'}${tf ? ' ' + tf : ''}...`);
    const result = await btSt.runBacktest(ticker, tf, bot, chatId, m.message_id);
    bot.sendMessage(chatId, result, { parse_mode: 'HTML' });
  } catch (e) { bot.sendMessage(chatId, `\u274c ${e.message}`); }
});

bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const stPairs = loadPairsFor('st_pairs');
    const btPairs = loadPairsFor('bt_pairs');
    const perpPairs = loadPairsFor('perp_pairs');
    let text = '<b>System Status</b>\n';
    text += `\n\u{1F4C8} ST Sim: ${Object.keys(stPairs).length} pairs ${getFeatConfig('st', 'running', '1') === '1' ? '✅' : '❌'}`;
    text += `\n\u{1F4CA} BT: ${Object.keys(btPairs).length} pairs, ${db.prepare("SELECT COUNT(*) as c FROM backtest_summary").get().c} hasil`;
    text += `\n\u{1F501} Perp: ${Object.keys(perpPairs).length} pairs ${getFeatConfig('perp', 'running', '0') === '1' ? '✅' : '❌'}`;
    text += `\nPoll: ${getConfig('pollIntervalMs','60000')}ms`;
    bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
  } catch (e) { bot.sendMessage(chatId, `\u274c ${e.message}`); }
});

bot.onText(/\/btp/, async (msg) => {
  const chatId = msg.chat.id;
  if (!perp.runBacktestNow) return bot.sendMessage(chatId, '\u274c Perpetual MS unavailable');
  if (getFeatConfig('perp', 'btEnabled', '1') !== '1')
    return bot.sendMessage(chatId, '\u274c BTP disabled. Aktifkan di Config Perpetual MS.');
  const m = await bot.sendMessage(chatId, '\u23f3 Running backtest perpetual...');
  try {
    const res = await perp.runBacktestNow(null);
    bot.sendMessage(chatId, `\u2705 BTP selesai\n${res.join('\n')}`, { parse_mode: 'HTML' });
  } catch (e) { bot.sendMessage(chatId, `\u274c ${e.message}`); }
});

// ─── Callback Query Dispatcher ───────────────────────────────────────────────
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const msgId = query.message.message_id;
  const data = query.data;
  console.log(`CALLBACK ${data} from ${chatId} msg=${msgId}`);

  // Await + log answerCallbackQuery so failures are visible (was fire-and-forget + silent catch)
  try {
    await bot.answerCallbackQuery(query.id);
  } catch (e) {
    console.error(`answerCallbackQuery FAILED: ${e.message} (data=${data})`);
  }

  try {
    // Main menu navigation
    if (data === 'main_menu') return showMainMenu(chatId, msgId);
    if (data === 'main_st' && st.showFeatureMenu) return st.showFeatureMenu(chatId, msgId);
    if (data === 'main_bt' && bt.showFeatureMenu) return bt.showFeatureMenu(chatId, msgId);
    if (data === 'main_perp' && perp.showFeatureMenu) return perp.showFeatureMenu(chatId, msgId);

    // Dispatch to feature modules by callback prefix
    for (const feat of features) {
      if (data.startsWith(feat.prefix)) {
        const result = typeof feat.handleCallback === 'function' ? await feat.handleCallback(query) : null;
        if (result && result.action === 'main_back') showMainMenu(chatId, msgId);
        return;
      }
    }

    console.log(`CALLBACK unhandled: ${data}`);
  } catch (e) {
    console.error('Callback error:', e.message);
    try { bot.sendMessage(chatId, `\u274c ${e.message}`); } catch (_) {}
  }
});

// ─── Message Dispatcher ──────────────────────────────────────────────────────
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const chatId = msg.chat.id;

  // Dispatch to feature modules
  for (const feat of features) {
    if (feat.handleMessage) {
      try {
        if (await feat.handleMessage(msg.text, chatId)) return;
      } catch (e) { console.error(`Msg error [${feat.prefix}]:`, e.message); }
    }
  }
});

// ─── Poll Loop ───────────────────────────────────────────────────────────────
async function poll() {
  const interval = Number(getConfig('pollIntervalMs', '60000'));
  for (const feat of features) {
    if (feat.pollTick) {
      try { await feat.pollTick(); } catch (e) { console.error(`Poll [${feat.prefix}]:`, e.message); }
    }
  }
  setTimeout(poll, interval);
}

// ─── Polling Watchdog ──────────────────────────────────────────────────────
// 409 = harmless: library reports old long-poll terminated because a new one
// started.  429/502/504 actually break polling.  Only count real errors.
const POLL_WARN_INTERVAL_MS = 300_000;
let pollErrors1h = [];
let pollLastErrorLog = 0;
let lastPollRestartAt = 0;
const MIN_POLL_RESTART_INTERVAL = 60_000;

async function restartPolling(delayMs = 2000) {
  const now = Date.now();
  if (now - lastPollRestartAt < MIN_POLL_RESTART_INTERVAL) return;
  lastPollRestartAt = now;
  console.error(`[POLL] Restarting polling in ${delayMs}ms...`);
  try { await bot.stopPolling(); } catch (_) {}
  await new Promise(r => setTimeout(r, delayMs));
  try {
    await bot.startPolling();
    pollErrors1h = [];
  } catch (e) {
    console.error('[POLL] Restart FAILED:', e.message);
  }
}

function isRealError(msg) {
  return msg.includes('429') || msg.includes('502') || msg.includes('504') || msg.includes('503');
}

bot.on('polling_error', (e) => {
  const code = e?.code;
  const msg = e?.message || '';
  const now = Date.now();

  // 409 = stale-connection noise, not a real error
  if (msg.includes('409')) {
    if (now - pollLastErrorLog > POLL_WARN_INTERVAL_MS) {
      console.error(`[POLL] 409 (harmless) — ${pollErrors1h.length} real errors in 1h`);
      pollLastErrorLog = now;
    }
    return;
  }

  if (!isRealError(msg)) return;

  pollErrors1h = pollErrors1h.filter(t => now - t < 3_600_000);
  pollErrors1h.push(now);

  if (now - pollLastErrorLog > POLL_WARN_INTERVAL_MS) {
    console.error(`[POLL] ${code} — ${msg}  (${pollErrors1h.length} in 1h)`);
    pollLastErrorLog = now;
  }

  // 429 → restart after retry-after
  if (code === 'ETELEGRAM' && msg.includes('429')) {
    const m = msg.match(/retry after (\d+)/i);
    return restartPolling(Math.min((m ? parseInt(m[1], 10) : 10) * 1000, 30_000));
  }

  // 502/504/503 storm (3+ in 5 min) → restart
  const last5min = pollErrors1h.filter(t => now - t < 300_000).length;
  if (last5min >= 3) return restartPolling(8000);
});

// Health check — if real errors >20/h, force restart
async function pollingHealthCheck() {
  const now = Date.now();
  pollErrors1h = pollErrors1h.filter(t => now - t < 3_600_000);
  if (pollErrors1h.length >= 20) {
    console.error(`[POLL] ${pollErrors1h.length} real errors in 1h — restart`);
    await restartPolling(10_000);
  }
}
setInterval(pollingHealthCheck, 600_000);

// ─── Keep event loop alive ────────────────────────────────────────────────
setInterval(() => {}, 30000);

setTimeout(poll, 5000);

console.log('🤖 Heimdall running — decoupled', features.map(f => f.prefix.replace('_','')));

