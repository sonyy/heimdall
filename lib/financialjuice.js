const { db, getFeatConfig, getConfig, upsertConfig } = require('./db');
const { chromium } = require('playwright');

const FJ_URL = 'https://www.financialjuice.com/';

// ─── Browser lifecycle ──────────────────────────────────────────────────────
// Launch a fresh browser per pollTick, close after extraction.
// Safe for memory; interval is 5min so cold-start cost is fine.

const TARGET_FILTERS = ['Bonds', 'Commodities'];
const LOOKBACK_MS = 2 * 24 * 60 * 60 * 1000;
const MAX_SCROLLS = 8;

function parseFjTime(timeStr) {
  if (!timeStr) return null;
  const m = timeStr.match(/(\d{1,2}):(\d{2})\s+(\w+)\s+(\d{1,2})/);
  if (!m) return null;
  const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  const now = new Date();
  const d = new Date(now.getFullYear(), months[m[3]] ?? now.getMonth(), parseInt(m[4]), parseInt(m[1]), parseInt(m[2]));
  if (d > now) d.setFullYear(d.getFullYear() - 1);
  return d;
}

async function scrapeCriticalItems() {
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
    });
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
    });
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    const page = await ctx.newPage();
    await page.goto(FJ_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });

    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const count = await page.evaluate(() =>
        document.querySelectorAll('.media.feedWrap').length
      );
      if (count > 5) break;
      await page.waitForTimeout(2000);
    }

    const allItems = [];
    const cutoffMs = Date.now() - LOOKBACK_MS;

    for (const filterName of TARGET_FILTERS) {
      await page.evaluate((name) => {
        const items = document.querySelectorAll('.feeds-list li');
        for (const li of items) {
          if (li.textContent.trim().includes(name)) {
            const link = li.querySelector('a');
            if (link) { link.click(); return; }
            li.click();
            return;
          }
        }
      }, filterName);

      await page.waitForTimeout(4000);

      let prevCount = 0;
      for (let i = 0; i < MAX_SCROLLS; i++) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(2000);
        const count = await page.evaluate(() => document.querySelectorAll('.media.feedWrap').length);
        if (count === prevCount && i > 3) break;
        prevCount = count;
      }

      const filterItems = await page.evaluate(({ category, cutoff }) => {
        const results = [];
        document.querySelectorAll('.media.feedWrap.active-critical').forEach(el => {
          if (el.offsetParent === null) return;

          const title = el.querySelector('.headline-title-nolink')?.textContent?.trim() || '';
          if (!title) return;

          const time = el.querySelector('.time')?.textContent?.trim() || '';
          const labels = [];
          el.querySelectorAll('.news-label').forEach(l => labels.push(l.textContent.trim()));
          const link = el.querySelector('a[href*="News"]')?.href || '';

          results.push({ text: title, time, link, labels, category });
        });
        return results;
      }, { category: filterName, cutoff: cutoffMs });

      allItems.push(...filterItems);
    }

    const deduped = [];
    const seen = new Set();
    for (const item of allItems) {
      const key = Buffer.from(item.text).toString('base64').substring(0, 64);
      if (seen.has(key)) continue;
      seen.add(key);

      const parsed = parseFjTime(item.time);
      if (parsed && parsed.getTime() >= cutoffMs) {
        deduped.push(item);
      }
    }

    return deduped;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ─── Dedup ──────────────────────────────────────────────────────────────────
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

// ─── UI helpers ─────────────────────────────────────────────────────────────
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
    `Filter: <b>Red background only</b> (active-critical)\n` +
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

// ─── Module registration ────────────────────────────────────────────────────
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

      const interval = Number(getFeatConfig('fj', 'interval', '30000'));
      const now = Date.now();
      if (now - lastPollAt < interval) return;

      try {
        const items = await scrapeCriticalItems();
        lastPollAt = Date.now();
        let sentCount = 0;

        for (const item of items) {
          const newsId = Buffer.from(item.text).toString('base64').substring(0, 64);
          if (isAlreadySent(newsId)) continue;

          const tags = (item.labels || []).filter(l => !['US Bonds', 'US Indexes', 'USD'].includes(l));
          const tagStr = tags.length ? tags.map(t => `#${t.replace(/\s+/g, '')}`).join(' ') : '';
          const cat = item.category || '';

          const lines = [
            `🔴 <b>${item.text}</b>`,
            tagStr ? `${tagStr}` : '',
            item.time ? `🕐 ${item.time}` : '',
            item.link ? `<a href="${item.link}">source</a>` : '',
          ].filter(Boolean);

          const msg = lines.join('\n');
          await bot.sendMessage(chatId, msg, { parse_mode: 'HTML', disable_web_page_preview: true }).catch(e => {
            console.error('FJ send error:', e.message);
          });

          markSent(newsId);
          sentCount++;
        }

        if (sentCount > 0) {
          console.log(`FJ: Sent ${sentCount} critical news items`);
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
