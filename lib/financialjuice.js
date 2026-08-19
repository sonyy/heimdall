const { db, getFeatConfig, getConfig, upsertConfig } = require('./db');
const { chromium } = require('playwright');
const Groq = require('groq-sdk');

const FJ_URL = 'https://www.financialjuice.com/';
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const groq = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;

// ─── Browser lifecycle ──────────────────────────────────────────────────────
// Launch a fresh browser per pollTick, close after extraction.
// Safe for memory; interval is 5min so cold-start cost is fine.

const LOOKBACK_MS = 2 * 24 * 60 * 60 * 1000;
const MAX_SCROLLS = 40;

function parseFjTime(timeStr) {
  if (!timeStr) return null;
  const m = timeStr.match(/(\d{1,2}):(\d{2})\s+(\w+)\s+(\d{1,2})/);
  if (!m) return null;
  const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  // FJ renders time in WIB (browser TZ). Create "now" in WIB too for consistent comparison.
  const nowWib = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const d = new Date(Date.UTC(nowWib.getUTCFullYear(), months[m[3]] ?? nowWib.getUTCMonth(), parseInt(m[4]), parseInt(m[1]), parseInt(m[2])));
  if (d > nowWib) d.setUTCFullYear(d.getUTCFullYear() - 1);
  return d;
}

async function safeWait(page, ms) {
  try { await page.waitForTimeout(ms); } catch {}
}

// ─── Groq Sentiment Classification ─────────────────────────────────────────
async function classifySentiment(headline) {
  if (!groq) return { sentiment: 'neutral', score: 0 };
  try {
    const completion = await Promise.race([
      groq.chat.completions.create({
        messages: [
          {
            role: 'system',
            content: `You are a crypto market sentiment classifier. Classify headlines by their potential impact on Bitcoin/crypto markets.

Reply ONLY with valid JSON: {"sentiment": "bullish|bearish|neutral", "score": 1-3}
- Score 1 = minimal impact
- Score 2 = moderate impact  
- Score 3 = significant impact

Examples:
- "US Fed cuts rates by 50bps" → {"sentiment":"bullish","score":3}
- "Bitcoin ETF sees record inflows" → {"sentiment":"bullish","score":2}
- "Major bank collapses" → {"sentiment":"bearish","score":3}
- "Iran tensions escalate in Middle East" → {"sentiment":"bearish","score":2}
- "Oil prices stable" → {"sentiment":"neutral","score":1}`
          },
          {
            role: 'user',
            content: `Classify this headline's impact on Bitcoin/crypto:\n"${headline}"`
          }
        ],
        model: 'allam-2-7b',
        temperature: 0.1,
        max_tokens: 50,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Groq timeout')), 10000)),
    ]);

    const response = completion.choices[0]?.message?.content?.trim();
    const parsed = JSON.parse(response);
    return {
      sentiment: ['bullish', 'bearish', 'neutral'].includes(parsed.sentiment) ? parsed.sentiment : 'neutral',
      score: Math.min(3, Math.max(1, parseInt(parsed.score) || 1)),
    };
  } catch (e) {
    console.error('FJ classifySentiment error:', e.message);
    return { sentiment: 'neutral', score: 0 };
  }
}

function sentimentEmoji(sentiment, score) {
  if (sentiment === 'bullish') return '🟢'.repeat(score);
  if (sentiment === 'bearish') return '🔴'.repeat(score);
  return '⚪';
}

async function scrapeFilter(browser, filterName) {
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    timezoneId: 'Asia/Jakarta',
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
  const page = await ctx.newPage();
  try {
    await page.goto(FJ_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const count = await page.evaluate(() => document.querySelectorAll('.media.feedWrap').length);
      if (count > 5) break;
      await page.waitForTimeout(2000);
    }

    const clicked = await page.evaluate((name) => {
      const items = document.querySelectorAll('.feeds-list li a');
      for (const a of items) {
        if (a.textContent.trim() === name) { a.click(); return true; }
      }
      const lis = document.querySelectorAll('.feeds-list li');
      for (const li of lis) {
        if (li.textContent.trim().includes(name)) {
          const link = li.querySelector('a');
          if (link) { link.click(); return true; }
          li.click(); return true;
        }
      }
      return false;
    }, filterName);
    console.log(`[FJ:${filterName}] filter=${clicked}`);

    await safeWait(page, 3000);
    const filterDeadline = Date.now() + 30000;
    while (Date.now() < filterDeadline) {
      const count = await page.evaluate(() => document.querySelectorAll('.media.feedWrap').length);
      if (count > 0) break;
      await safeWait(page, 2000);
    }
    await safeWait(page, 5000);

    let prevCount = 0;
    let sameCount = 0;
    for (let i = 0; i < MAX_SCROLLS; i++) {
      await page.evaluate(() => { document.documentElement.scrollTop = document.documentElement.scrollHeight; });
      await safeWait(page, 3000);
      const count = await page.evaluate(() => document.querySelectorAll('.media.feedWrap').length);
      if (count === prevCount) {
        sameCount++;
        if (sameCount >= 5) break;
      } else {
        sameCount = 0;
      }
      prevCount = count;
      console.log(`[FJ:${filterName}] scroll ${i + 1}: ${count} items, sameCount=${sameCount}`);
    }

    const results = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('.media.feedWrap.active-critical').forEach(el => {
        if (el.offsetParent === null) return;
        const title = el.querySelector('.headline-title-nolink')?.textContent?.trim() || '';
        if (!title) return;
        const time = el.querySelector('.time')?.textContent?.trim() || '';
        const labels = [];
        el.querySelectorAll('.news-label').forEach(l => labels.push(l.textContent.trim()));
        const link = el.querySelector('a[href*="News"]')?.href || '';
        out.push({ text: title, time, link, labels });
      });
      return out;
    });
    console.log(`[FJ:${filterName}] ${results.length} critical/active, ${prevCount} items loaded`);
    return results;
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function scrapeCriticalItems() {
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
    });

    const cutoffMs = Date.now() - LOOKBACK_MS;
    const allItems = [];

    for (const filterName of ['Bonds', 'Commodities']) {
      try {
        const items = await scrapeFilter(browser, filterName);
        allItems.push(...items);
      } catch (e) {
        console.error(`[FJ:${filterName}] failed:`, e.message);
      }
    }

    const seen = new Set();
    const filtered = allItems
      .filter(item => {
        const key = Buffer.from(item.text).toString('base64').substring(0, 64);
        if (seen.has(key)) return false;
        seen.add(key);
        const parsed = parseFjTime(item.time);
        return parsed && parsed.getTime() >= cutoffMs;
      })
      .sort((a, b) => {
        const ta = parseFjTime(a.time);
        const tb = parseFjTime(b.time);
        return (tb?.getTime() || 0) - (ta?.getTime() || 0);
      });
    return filtered;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ─── Dedup ──────────────────────────────────────────────────────────────────
function isAlreadySent(newsId) {
  const row = db.prepare('SELECT 1 FROM sent_news WHERE news_id = ?').get(newsId);
  return !!row;
}

function markSent(newsId, title, labels, fjTime, sentiment = 'neutral', sentimentScore = 0) {
  db.prepare('INSERT INTO sent_news (news_id, title, labels, fj_time, sentiment, sentiment_score) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(news_id) DO UPDATE SET title = excluded.title, labels = excluded.labels, fj_time = excluded.fj_time, sentiment = excluded.sentiment, sentiment_score = excluded.sentiment_score').run(newsId, title || '', labels || '', fjTime || '', sentiment, sentimentScore);
}

function cleanupOldNews() {
  db.prepare("DELETE FROM sent_news WHERE sent_at < datetime('now', '-7 days')").run();
}

function clearSentNews() {
  const count = db.prepare('SELECT COUNT(*) as c FROM sent_news').get().c;
  db.prepare('DELETE FROM sent_news').run();
  return count;
}

function getFjNotifTargets() {
  try {
    const v = getFeatConfig('fj', 'notif_targets', '["individual"]');
    return JSON.parse(v);
  } catch { return ['individual']; }
}

function setFjNotifTargets(targets) {
  upsertConfig('fj_notif_targets', JSON.stringify(targets));
}

function getFjGroupChats() {
  try {
    const v = getFeatConfig('fj', 'group_chats', '[]');
    return JSON.parse(v);
  } catch { return []; }
}

function addFjGroupChat(chatId) {
  const chats = getFjGroupChats();
  if (!chats.includes(chatId)) {
    chats.push(chatId);
    upsertConfig('fj_group_chats', JSON.stringify(chats));
  }
}

async function sendFjNotif(bot, chatIdIndiv, text, opts) {
  const targets = getFjNotifTargets();
  const send = async (id) => {
    try { return await bot.sendMessage(id, text, opts); } catch (e) {
      console.error(`sendFjNotif to ${id} err:`, e.message);
      return null;
    }
  };
  const results = [];
  if (targets.includes('individual')) {
    results.push(await send(chatIdIndiv));
  }
  if (targets.includes('group')) {
    const groups = getFjGroupChats();
    if (groups.length) {
      for (const gid of groups) {
        results.push(await send(gid));
      }
    } else {
      results.push(await send(chatIdIndiv));
      console.warn('sendFjNotif: target group tp blm ada grup terdaftar, fallback ke individu');
    }
  }
  return results.flat();
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
  const interval = Number(getFeatConfig('fj', 'interval', '30000'));

  const recentRows = db.prepare(
    "SELECT title, labels, fj_time, sentiment, sentiment_score FROM sent_news WHERE title != '' ORDER BY sent_at DESC LIMIT 8"
  ).all();

  recentRows.sort((a, b) => {
    const ta = parseFjTime(a.fj_time);
    const tb = parseFjTime(b.fj_time);
    return (tb?.getTime() || 0) - (ta?.getTime() || 0);
  });

  let newsList = '';
  if (recentRows.length > 0) {
    const lines = recentRows.map((r) => {
      let labels = [];
      try { labels = JSON.parse(r.labels || '[]'); } catch {}
      const labelStr = labels.join(', ');
      const emoji = sentimentEmoji(r.sentiment || 'neutral', r.sentiment_score || 0);
      return `${emoji} ${r.title}\n${r.fj_time}\n${labelStr}`;
    });
    newsList = '\n\n' + lines.join('\n\n');
  }

  const notifTargets = getFjNotifTargets();
  const hasIndiv = notifTargets.includes('individual');
  const hasGroup = notifTargets.includes('group');
  const totGroups = getFjGroupChats().length;

  const text =
    `📰 <b>FinancialJuice News</b>\n` +
    `${enabled ? '✅ Running' : '❌ Idle'}\n` +
    `Interval: ${(interval / 1000).toFixed(0)}s\n` +
    `Filter: Bonds · Commodities · Critical only\n` +
    `\ud83d\udd14 Target Notif:\n` +
    `  \ud83d\udc64 Individu: ${hasIndiv ? '\u2705' : '\u274c'}\n` +
    `  \ud83d\udc65 Grup: ${hasGroup ? '\u2705' : '\u274c'}${hasGroup && !totGroups ? ' \u26a0\ufe0f' : ''}` +
    (hasGroup && !totGroups ? '\n   \u26a0\ufe0f Kirim /fj dr grup utk daftarin grup' : '') +
    newsList;

  sendMenu(bot, chatId, msgId, text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: enabled ? '⏹ Stop' : '▶️ Start', callback_data: 'fj_toggle' }],
        [{ text: '⏱ Interval', callback_data: 'fj_interval' }],
        [{ text: `\ud83d\udc64 Individu ${hasIndiv ? '\u2705' : '\u274c'}`, callback_data: 'fj_notif_indiv' },
         { text: `\ud83d\udc65 Grup ${hasGroup ? '\u2705' : '\u274c'}`, callback_data: 'fj_notif_group' }],
        [{ text: '🗑️ Clear News', callback_data: 'fj_clear' }],
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
          sendMenu(bot, chatId, msgId, 'Masukkan interval baru dalam detik (contoh: 30):', {
            reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'fj_config_back' }]] }
          });
          return { action: 'fj_interval_input' };
        }
        if (data === 'fj_notif_indiv') {
          const cur = getFjNotifTargets();
          const next = cur.includes('individual') ? cur.filter(x => x !== 'individual') : [...cur, 'individual'];
          setFjNotifTargets(next);
          showFeatureMenu(bot, chatId, msgId);
          return { action: null };
        }
        if (data === 'fj_notif_group') {
          const cur = getFjNotifTargets();
          const next = cur.includes('group') ? cur.filter(x => x !== 'group') : [...cur, 'group'];
          setFjNotifTargets(next);
          showFeatureMenu(bot, chatId, msgId);
          return { action: null };
        }
        if (data === 'fj_clear') {
          const count = clearSentNews();
          bot.sendMessage(chatId, `🗑️ Cleared ${count} sent news records.`).catch(() => {});
          showFeatureMenu(bot, chatId, msgId);
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

      console.log('FJ: scrape cycle');
      try {
        const items = await scrapeCriticalItems();
        lastPollAt = Date.now();
        let sentCount = 0;

        for (const item of items) {
          const newsId = Buffer.from(item.text).toString('base64').substring(0, 64);
          if (isAlreadySent(newsId)) continue;

          const { sentiment, score } = await classifySentiment(item.text);
          const emoji = sentimentEmoji(sentiment, score);
          const tags = item.labels || [];
          const labelStr = tags.join(', ');

          const lines = [
            `${emoji} <b>${item.text}</b>`,
            item.time || '',
            labelStr || '',
            item.link ? `<a href="${item.link}">source</a>` : '',
          ].filter(Boolean);

          const msg = lines.join('\n');
          await sendFjNotif(bot, chatId, msg, { parse_mode: 'HTML', disable_web_page_preview: true });

          markSent(newsId, item.text, JSON.stringify(item.labels || []), item.time || '', sentiment, score);
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
  addFjGroupChat,
  clearSentNews,
};
