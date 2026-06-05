require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { db, upsertConfig, getConfig, getFeatConfig, loadPairsFor } = require('./lib/db');
const { normalizeTf } = require('./lib/exchange');
const stSim = require('./lib/st-simulasi');
const btSt = require('./lib/backtest-st');
const perpMs = require('./lib/perpetual-ms');

const BOT_TOKEN = process.env.BOT_TOKEN || '8867777426:AAHqm3HohKGrNFYSU94sP5ssHh0LizQGjaA';
const CHAT_ID = process.env.CHAT_ID || '5444480485';
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ─── Register feature modules ────────────────────────────────────────────────
const st = stSim.register(bot, CHAT_ID);
const bt = btSt.register(bot, CHAT_ID);
const perp = perpMs.register(bot, CHAT_ID);

const features = [st, bt, perp];

// ─── Shared sendMenu ─────────────────────────────────────────────────────────
async function sendMenu(chatId, msgId, text, opts) {
  if (msgId) {
    try { return await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, ...opts }); } catch (e) {}
  } else {
    try { return await bot.sendMessage(chatId, text, opts); } catch (e) {}
  }
}

// ─── Main Menu ───────────────────────────────────────────────────────────────
function showMainMenu(chatId, msgId) {
  const stPairs = loadPairsFor('st_pairs');
  const btPairs = loadPairsFor('bt_pairs');
  const perpPairs = loadPairsFor('perp_pairs');
  const stRunning = getFeatConfig('st', 'running', '1') === '1';
  const perpRunning = getFeatConfig('perp', 'running', '0') === '1';
  const btCount = db.prepare("SELECT COUNT(*) as c FROM backtest_summary").get().c;

  sendMenu(chatId, msgId,
    `━━━ <b>INDIKRATOS</b> ━━━\n\n` +
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
}

// ─── Command Handlers ────────────────────────────────────────────────────────
bot.onText(/\/start|\/menu|\/config/, (msg) => showMainMenu(msg.chat.id));

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
  bot.answerCallbackQuery(query.id).catch(() => {});

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

setTimeout(poll, 5000);

console.log('🤖 Indikratos running — decoupled', features.map(f => f.prefix.replace('_','')));
