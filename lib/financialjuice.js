const { db, getFeatConfig, getConfig, upsertConfig } = require('./db');
const axios = require('axios');

const RSS_URL = 'https://www.financialjuice.com/feed.ashx?xy=rss';

const IMPORTANT_KEYWORDS = [
  'FOMC', 'FED', 'FEDERAL RESERVE', 'CPI', 'GDP', 'INFLATION', 'ECB', 'PBOC', 'BOJ', 'BOE', 'RBA',
  'OPEC', 'OIL', 'CRUDE', 'WTI', 'BRENT', 'GOLD', 'SILVER', 'COPPER', 'NATURAL GAS',
  'TREASURY', 'YIELD', 'BOND', 'RATE', 'HIKE', 'CUT',
  'TARIFF', 'TRADE WAR', 'SANCTIONS',
  'BREAKING', 'FLASH', 'URGENT',
];

const BONDS_KEYWORDS = [
  'TREASURY', 'BUND', 'OAT', 'GILT', 'YIELD', 'BOND', 'NOTE', 'BILL', 'DEBT', 'SOVEREIGN',
];

const COMMODITIES_KEYWORDS = [
  'OIL', 'CRUDE', 'WTI', 'BRENT', 'GOLD', 'SILVER', 'COPPER', 'IRON ORE', 'NATURAL GAS', 'LNG',
  'COMMODITY', 'OPEC', 'AGRICULTURAL', 'WHEAT', 'CORN', 'SOYBEAN',
];

function parseRSSItems(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const get = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      return m ? m[1].trim() : '';
    };
    const title = get('title').replace(/^FinancialJuice:\s*/i, '');
    const link = get('link');
    const pubDate = get('pubDate');
    const guid = get('guid');
    const description = get('description');
    if (guid && title) {
      items.push({ title, link, pubDate, guid, description });
    }
  }
  return items;
}

function matchesKeywords(text, keywords) {
  const upper = text.toUpperCase();
  return keywords.some(kw => upper.includes(kw));
}

function classifyNews(title, description) {
  const combined = `${title} ${description}`;
  const important = matchesKeywords(combined, IMPORTANT_KEYWORDS);
  if (!important) return null;

  const isBonds = matchesKeywords(combined, BONDS_KEYWORDS);
  const isCommodities = matchesKeywords(combined, COMMODITIES_KEYWORDS);

  if (isBonds) return '🏦 Bonds';
  if (isCommodities) return '🛢️ Commodities';
  return null;
}

function formatTime(dateStr) {
  try {
    const d = new Date(dateStr);
    return d.toLocaleString('en-GB', { timeZone: 'Asia/Shanghai', hour12: false, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return dateStr; }
}

function isAlreadySent(newsId) {
  const row = db.prepare('SELECT 1 FROM sent_news WHERE news_id = ?').get(newsId);
  return !!row;
}

function markSent(newsId) {
  db.prepare('INSERT OR IGNORE INTO sent_news (news_id) VALUES (?)').run(newsId);
}

function cleanupOldNews() {
  db.prepare("DELETE FROM sent_news WHERE sent_at < datetime('now', '-7 days')").run();
}

async function sendMenu(bot, chatId, msgId, text, opts) {
  if (msgId) {
    try {
      return await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, ...opts });
    } catch (e) {
      const fresh = await bot.sendMessage(chatId, text, opts).catch(e2 => {
        console.error('FJ sendMenu edit+send err:', e.message, '/', e2.message);
        return null;
      });
      return fresh;
    }
  } else {
    try { return await bot.sendMessage(chatId, text, opts); } catch (e) {
      console.error('FJ sendMenu send err:', e.message);
    }
  }
}

function showFeatureMenu(bot, chatId, msgId) {
  const enabled = getFeatConfig('fj', 'enabled', '1') === '1';
  const interval = Number(getFeatConfig('fj', 'interval', '300000'));
  const totalSent = db.prepare('SELECT COUNT(*) as c FROM sent_news').get().c;

  const text =
    `📰 <b>FinancialJuice News</b>\n` +
    `${enabled ? '✅ Running' : '❌ Idle'}\n` +
    `Interval: ${(interval / 1000).toFixed(0)}s · Sent: ${totalSent} news\n\n` +
    `Filter: Bonds &amp; Commodities (important only)\n` +
    `Pilih aksi:`;

  sendMenu(bot, chatId, msgId, text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: enabled ? '⏹ Stop' : '▶️ Start', callback_data: 'fj_toggle' }],
        [{ text: '⏱ Interval', callback_data: 'fj_interval' }],
        [{ text: '🧹 Cleanup', callback_data: 'fj_cleanup' }],
        [{ text: '🔙 Kembali', callback_data: 'fj_mainback' }],
      ]
    }
  });
}

module.exports = {
  register(bot, chatId) {
    let lastPollAt = 0;
    const fjConv = {};

    async function handleCallback(query) {
      const chatId = query.message.chat.id;
      const msgId = query.message.message_id;
      const data = query.data;

      if (!data.startsWith('fj_')) return { action: null };

      try {
        if (data === 'fj_toggle') {
          const cur = getFeatConfig('fj', 'enabled', '1') === '1';
          upsertConfig('fj_enabled', cur ? '0' : '1');
          showFeatureMenu(bot, chatId, msgId);
          return { action: null };
        }
        if (data === 'fj_interval') {
          fjConv[chatId] = { action: 'fj_interval_input' };
          sendMenu(bot, chatId, msgId, 'Masukkan interval baru dalam detik (contoh: 300):', {
            reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'fj_config_back' }]] }
          });
          return { action: 'fj_interval_input' };
        }
        if (data === 'fj_cleanup') {
          const before = db.prepare('SELECT COUNT(*) as c FROM sent_news').get().c;
          cleanupOldNews();
          const after = db.prepare('SELECT COUNT(*) as c FROM sent_news').get().c;
          sendMenu(bot, chatId, msgId, `🧹 Cleanup selesai.\n${before - after} old entries removed.`, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'fj_back' }]] }
          });
          return { action: null };
        }
        if (data === 'fj_back' || data === 'fj_config_back' || data === 'fj_mainback') {
          delete fjConv[chatId];
          showFeatureMenu(bot, chatId, msgId);
          return { action: null };
        }
      } catch (e) {
        console.error('FJ handleCallback error:', e.message);
      }
      return { action: null };
    }

    async function handleMessage(text, chatId) {
      if (fjConv[chatId]?.action === 'fj_interval_input') {
        delete fjConv[chatId];
        const sec = parseInt(text, 10);
        if (isNaN(sec) || sec < 30) {
          bot.sendMessage(chatId, '❌ Minimal 30 detik.').catch(() => {});
          return true;
        }
        upsertConfig('fj_interval', String(sec * 1000));
        bot.sendMessage(chatId, `✅ Interval diubah ke ${sec}s`).catch(() => {});
        return true;
      }
      return false;
    }

    async function pollTick() {
      const enabled = getFeatConfig('fj', 'enabled', '1') === '1';
      if (!enabled) return;

      const interval = Number(getFeatConfig('fj', 'interval', '300000'));
      const now = Date.now();
      if (now - lastPollAt < interval) return;
      lastPollAt = now;

      try {
        const resp = await axios.get(RSS_URL, {
          timeout: 15000,
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' },
          validateStatus: (s) => s < 500,
        });
        if (resp.status === 429) {
          const retryAfter = Number(resp.headers['retry-after'] || 60);
          console.error(`FJ: Cloudflare rate limited, retry after ${retryAfter}s`);
          lastPollAt = Date.now() + (retryAfter * 1000) - interval;
          return;
        }
        const data = resp.data;
        if (typeof data !== 'string' || !data.includes('<rss')) {
          console.error('FJ: Response is not RSS XML, status:', resp.status, 'len:', String(data).length);
          return;
        }
        const items = parseRSSItems(data);
        let sentCount = 0;

        for (const item of items) {
          if (isAlreadySent(item.guid)) continue;

          const category = classifyNews(item.title, item.description);
          if (!category) {
            markSent(item.guid);
            continue;
          }

          const time = formatTime(item.pubDate);
          const msg =
            `${category} | <b>${item.title}</b>\n` +
            `🕐 ${time}\n` +
            `🔗 <a href="${item.link}">Read more</a>`;

          await bot.sendMessage(chatId, msg, { parse_mode: 'HTML', disable_web_page_preview: true }).catch(e => {
            console.error('FJ send error:', e.message);
          });

          markSent(item.guid);
          sentCount++;
        }

        if (sentCount > 0) {
          console.log(`FJ: Sent ${sentCount} news items`);
        }

        cleanupOldNews();
      } catch (e) {
        console.error('FJ pollTick error:', e.message);
      }
    }

    return {
      prefix: 'fj_',
      handleCallback,
      handleMessage,
      pollTick,
      showFeatureMenu: (chatId, msgId) => showFeatureMenu(bot, chatId, msgId),
    };
  },
};
