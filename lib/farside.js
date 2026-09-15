const { db, getFeatConfig, upsertConfig } = require('./db');
const { execFile } = require('child_process');

const FS_URL = 'https://farside.co.uk/btc/';
const JINA_BASE = 'https://r.jina.ai/';

// ─── Farside BTC ETF table layout ───────────────────────────────────────────
// table.etf rows:
//   [0] header (colspan)                    | "Total"
//   [1] fund names                          | IBIT FBTC BITB ARKB BTCO EZBC BRRR HODL BTCW MSBT GBTC BTC
//   [2] fee row                             | 0.25% ...
//   [3..] date rows                         | "08 Sep 2026" | per-fund flow ×12 | Total
//   trailing summary rows                   | Total | Average | Maximum | Minimum
// Values: parenthesized "(50.4)" = negative, "-" = no data (hari belum keluar),
//         "0.0" = benar-benar nol. Kolom terakhir = Total inflow hari itu (US$m).
//
// Rule finality (per user): kalau ada date row SETELAH suatu tanggal, berarti
// tanggal tsb sudah final. Baris tanggal terakhir di tabel = belum final.

const FUNDS = ['IBIT', 'FBTC', 'BITB', 'ARKB', 'BTCO', 'EZBC', 'BRRR', 'HODL', 'BTCW', 'MSBT', 'GBTC', 'BTC'];
const DATE_RE = /^(\d{1,2}) ([A-Z][a-z]{2}) (\d{4})$/;
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

function parseNum(s) {
  if (s == null) return null;
  let v = String(s).trim().replace(/,/g, '');
  if (!v || v === '-') return null;
  let neg = false;
  if (v.startsWith('(') && v.endsWith(')')) { neg = true; v = v.slice(1, -1); }
  const n = parseFloat(v);
  if (isNaN(n)) return null;
  return neg ? -n : n;
}

function parseFsDate(label) {
  const m = String(label || '').match(DATE_RE);
  if (!m) return null;
  const iso = `${m[3]}-${String(MONTHS[m[2]] + 1).padStart(2, '0')}-${String(parseInt(m[1], 10)).padStart(2, '0')}`;
  return { iso, label };
}

// ─── HTTP helper ─────────────────────────────────────────────────────────────
// r.jina.ai memakai Cloudflare dan menantang request yg User-Agent-nya mengaku
// Chrome tapi TLS fingerprint-nya bukan browser (termasuk https Node.js dan
// `curl -H "User-Agent: Mozilla/5.0..."`). UA default curl konsisten dgn
// fingerprint curl → selalu lolos. 403 transient saat burst ditangani retry.
function httpGetText(urlString, headers = {}, timeoutMs = 45000) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  return (async () => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await new Promise((resolve, reject) => {
          const args = [
            '-sS', '-m', String(Math.ceil(timeoutMs / 1000)), '--http1.1',
            '-w', '\n__HTTP__%{http_code}',
          ];
          for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
          args.push(urlString);
          execFile('curl', args, { timeout: timeoutMs + 5000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
            if (err) return reject(new Error(`curl gagal: ${err.message}`));
            const m = stdout.match(/\n__HTTP__(\d+)\s*$/);
            const code = m ? parseInt(m[1], 10) : 0;
            const body = m ? stdout.slice(0, m.index) : stdout;
            if (code >= 200 && code < 300) resolve(body);
            else reject(Object.assign(new Error(`HTTP ${code}`), { code, body: body.slice(0, 160) }));
          });
        });
      } catch (e) {
        const retriable = e.code === 403 || e.code === 429 || (e.code >= 500 && e.code < 600) || e.code === undefined;
        if (!retriable || attempt === 3) throw new Error(`${e.message} dari ${urlString.slice(0, 90)}: ${e.body || ''}`);
        await sleep(4000 * attempt);
      }
    }
  })();
}

// ─── Scrape ─────────────────────────────────────────────────────────────────
// Cloudflare memblokir plain HTTP request langsung, jadi tabel diambil via jina
// reader proxy (r.jina.ai) yg mengembalikan tabel sbg markdown pipe. Tanpa
// Chromium → hemat RAM & hilang sumber error ENOSPC. Layout kolom identik dgn
// hasil scrape HTML (sudah diverifikasi: date=c[0], funds=c[1..12], total=c[13]).
async function scrapeFlows() {
  const text = await httpGetText(JINA_BASE + FS_URL, { 'x-no-cache': 'true' });

  // Ambil SEMUA date row (termasuk placeholder dash) — finality butuh set lengkap.
  const dateRows = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map(s => s.trim());
    if (cells.length < 14) continue;
    const parsed = parseFsDate(cells[0]);
    if (!parsed) continue;
    const flows = FUNDS.map((name, i) => ({ name, value: parseNum(cells[i + 1]) }));
    const total = parseNum(cells[13]);
    const hasData = flows.some(f => f.value !== null); // "-" semua = belum ada data
    const sumFlows = flows.reduce((s, f) => s + (f.value ?? 0), 0);
    // farside selalu menjamin Total == jumlah semua fund. Kalau tidak seimbang,
    // berarti kolom belum sejajar (hari berjalan dgn data parsial di jam bursa) —
    // jangan percaya nilainya, perlakukan seperti baris placeholder (tidak dikirim,
    // tapi tetap dihitung utk finality).
    if (hasData && (total === null || Math.abs(total - sumFlows) > 1)) {
      dateRows.push({ date: parsed.iso, label: parsed.label, total: null, flows: [], hasData: false });
      continue;
    }
    dateRows.push({
      date: parsed.iso,
      label: parsed.label,
      total: hasData ? (total ?? 0) : null,
      flows: hasData ? flows.filter(f => f.value !== null && f.value !== 0) : [],
      hasData,
    });
  }

  if (!dateRows.length) throw new Error('tidak ada date row terbaca dari farside (via jina)');

  dateRows.sort((a, b) => a.date.localeCompare(b.date));

  const lastIdx = dateRows.length - 1;
  return dateRows.map((r, i) => ({ ...r, isFinal: i < lastIdx }));
}

// ─── Dedup ──────────────────────────────────────────────────────────────────
function isAlreadySent(date) {
  return !!db.prepare('SELECT 1 FROM fs_sent WHERE date = ?').get(date);
}

function markSent(row) {
  db.prepare('INSERT OR REPLACE INTO fs_sent (date, label, flow_total, is_final) VALUES (?, ?, ?, ?)')
    .run(row.date, row.label, row.total, row.isFinal ? 1 : 0);
}

function cleanupOldFlows() {
  db.prepare("DELETE FROM fs_sent WHERE sent_at < datetime('now', '-45 days')").run();
}

function clearSentFlows() {
  const count = db.prepare('SELECT COUNT(*) as c FROM fs_sent').get().c;
  db.prepare('DELETE FROM fs_sent').run();
  return count;
}

// ─── Notif targets ──────────────────────────────────────────────────────────
function getFsNotifTargets() {
  try {
    const v = getFeatConfig('fs', 'notif_targets', '["individual"]');
    return JSON.parse(v);
  } catch { return ['individual']; }
}

function setFsNotifTargets(targets) {
  upsertConfig('fs_notif_targets', JSON.stringify(targets));
}

function getFsGroupChats() {
  try {
    const v = getFeatConfig('fs', 'group_chats', '[]');
    return JSON.parse(v);
  } catch { return []; }
}

function addFsGroupChat(chatId) {
  const chats = getFsGroupChats();
  if (!chats.includes(chatId)) {
    chats.push(chatId);
    upsertConfig('fs_group_chats', JSON.stringify(chats));
  }
}

async function sendFsNotif(bot, chatIdIndiv, text, opts) {
  const targets = getFsNotifTargets();
  const send = async (id) => {
    try { return await bot.sendMessage(id, text, opts); } catch (e) {
      console.error(`sendFsNotif to ${id} err:`, e.message);
      return null;
    }
  };
  const results = [];
  if (targets.includes('individual')) {
    results.push(await send(chatIdIndiv));
  }
  if (targets.includes('group')) {
    const groups = getFsGroupChats();
    if (groups.length) {
      for (const gid of groups) {
        results.push(await send(gid));
      }
    } else {
      results.push(await send(chatIdIndiv));
      console.warn('sendFsNotif: target group tp blm ada grup terdaftar, fallback ke individu');
    }
  }
  return results.flat();
}

// ─── Message formatting ─────────────────────────────────────────────────────
function fmtFlow(v) {
  const n = Number(v) || 0;
  return `${n > 0 ? '+' : ''}${n.toFixed(1)}`.replace(/\.0$/, '');
}

function flowArrow(v) {
  return v > 0 ? '🟢' : v < 0 ? '🔴' : '⚪';
}

function getLastRealDays(rows, i, count) {
  const out = [];
  for (let j = i; j >= 0 && out.length < count; j--) {
    if (rows[j].hasData) out.push(rows[j]);
  }
  return out;
}

function buildFlowMsg(days) {
  const head = days[0];
  const rest = days.slice(1);
  const status = head.isFinal ? '✅ Final' : '⏳ Update (belum final)';
  const fundsLine = head.flows.map(f => `${f.name} ${fmtFlow(f.value)}`).join(' · ');
  const history = rest.map(r => `${flowArrow(r.total)} ${r.label} — ${fmtFlow(r.total)}M`);
  const lines = [
    `📊 <b>BTC ETF Flow — 4 Hari Terakhir</b>`,
    `🆕 <b>${head.label}</b>`,
    `💰 Total: ${flowArrow(head.total)} <b>$${Math.abs(head.total).toFixed(1).replace(/\.0$/, '')}M</b>`,
    `🔄 Status: ${status}`,
    fundsLine ? `🏦 ${fundsLine}` : '',
    history.length ? '━━━━━━━━' : '',
    ...history,
    `🔗 <a href="${FS_URL}">farside.co.uk/btc</a>`,
  ].filter(Boolean);
  return lines.join('\n');
}

// ─── UI helpers ─────────────────────────────────────────────────────────────
async function sendMenu(bot, chatId, msgId, text, opts) {
  if (msgId) {
    try {
      return await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, ...opts });
    } catch (e) {
      const fresh = await bot.sendMessage(chatId, text, opts).catch(e2 => {
        console.error('FS sendMenu edit+send err:', e.message, '/', e2.message);
        return null;
      });
      return fresh;
    }
  } else {
    try { return await bot.sendMessage(chatId, text, opts); } catch (e) {
      console.error('FS sendMenu send err:', e.message);
    }
  }
}

function showFeatureMenu(bot, chatId, msgId) {
  const enabled = getFeatConfig('fs', 'enabled', '1') === '1';
  const interval = Number(getFeatConfig('fs', 'interval', '900000'));

  const recentRows = db.prepare(
    'SELECT date, label, flow_total, is_final FROM fs_sent ORDER BY date DESC LIMIT 5'
  ).all();

  let flowList = '';
  if (recentRows.length > 0) {
    const lines = recentRows.map((r) => {
      const arrow = r.flow_total > 0 ? '🟢' : r.flow_total < 0 ? '🔴' : '⚪';
      return `${arrow} ${r.label} — $${fmtFlow(r.flow_total)}M ${r.is_final ? '(✅ final)' : '(⏳)'}`;
    });
    flowList = '\n\n' + lines.join('\n');
  }

  const notifTargets = getFsNotifTargets();
  const hasIndiv = notifTargets.includes('individual');
  const hasGroup = notifTargets.includes('group');
  const totGroups = getFsGroupChats().length;

  const text =
    `📊 <b>BTC ETF Flow (Farside)</b>\n` +
    `${enabled ? '✅ Running' : '❌ Idle'}\n` +
    `Interval: ${(interval / 60000).toFixed(0)}m\n` +
    `Source: farside.co.uk/btc\n` +
    `🔔 Target Notif:\n` +
    `  👤 Individu: ${hasIndiv ? '✅' : '❌'}\n` +
    `  👥 Grup: ${hasGroup ? '✅' : '❌'}${hasGroup && !totGroups ? ' ⚠️' : ''}` +
    (hasGroup && !totGroups ? '\n   ⚠️ Kirim /fs dr grup utk daftarin grup' : '') +
    flowList;

  sendMenu(bot, chatId, msgId, text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: enabled ? '⏹ Stop' : '▶️ Start', callback_data: 'fs_toggle' }],
        [{ text: '⏱ Interval', callback_data: 'fs_interval' }],
        [{ text: `👤 Individu ${hasIndiv ? '✅' : '❌'}`, callback_data: 'fs_notif_indiv' },
         { text: `👥 Grup ${hasGroup ? '✅' : '❌'}`, callback_data: 'fs_notif_group' }],
        [{ text: '🗑️ Clear History', callback_data: 'fs_clear' }],
        [{ text: '🔙 Kembali', callback_data: 'fs_mainback' }],
      ]
    }
  });
}

// ─── Module registration ────────────────────────────────────────────────────
module.exports = {
  register(bot, chatId) {
    let lastPollAt = 0;
    let scraping = false;
    const fsConv = {};

    async function handleCallback(query) {
      const chatId = query.message.chat.id;
      const msgId = query.message.message_id;
      const data = query.data;

      if (!data.startsWith('fs_')) return { action: null };

      try {
        if (data === 'fs_toggle') {
          const cur = getFeatConfig('fs', 'enabled', '1') === '1';
          upsertConfig('fs_enabled', cur ? '0' : '1');
          showFeatureMenu(bot, chatId, msgId);
          return { action: null };
        }
        if (data === 'fs_interval') {
          fsConv[chatId] = { action: 'fs_interval_input' };
          sendMenu(bot, chatId, msgId, 'Masukkan interval baru dalam MENIT (contoh: 15):', {
            reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'fs_config_back' }]] }
          });
          return { action: 'fs_interval_input' };
        }
        if (data === 'fs_notif_indiv') {
          const cur = getFsNotifTargets();
          const next = cur.includes('individual') ? cur.filter(x => x !== 'individual') : [...cur, 'individual'];
          setFsNotifTargets(next);
          showFeatureMenu(bot, chatId, msgId);
          return { action: null };
        }
        if (data === 'fs_notif_group') {
          const cur = getFsNotifTargets();
          const next = cur.includes('group') ? cur.filter(x => x !== 'group') : [...cur, 'group'];
          setFsNotifTargets(next);
          showFeatureMenu(bot, chatId, msgId);
          return { action: null };
        }
        if (data === 'fs_clear') {
          const count = clearSentFlows();
          bot.sendMessage(chatId, `🗑️ Cleared ${count} sent flow records.`).catch(() => {});
          showFeatureMenu(bot, chatId, msgId);
          return { action: null };
        }
        if (data === 'fs_back' || data === 'fs_config_back' || data === 'fs_mainback') {
          delete fsConv[chatId];
          showFeatureMenu(bot, chatId, msgId);
          return { action: null };
        }
      } catch (e) {
        console.error('FS handleCallback error:', e.message);
      }
      return { action: null };
    }

    async function handleMessage(text, chatId) {
      if (fsConv[chatId]?.action === 'fs_interval_input') {
        delete fsConv[chatId];
        const min = parseInt(text, 10);
        if (isNaN(min) || min < 5) {
          bot.sendMessage(chatId, '❌ Minimal 5 menit.').catch(() => {});
          return true;
        }
        upsertConfig('fs_interval', String(min * 60000));
        bot.sendMessage(chatId, `✅ Interval diubah ke ${min} menit`).catch(() => {});
        return true;
      }
      return false;
    }

    async function pollTick() {
      const enabled = getFeatConfig('fs', 'enabled', '1') === '1';
      if (!enabled) return;

      const interval = Number(getFeatConfig('fs', 'interval', '900000'));
      const now = Date.now();
      if (now - lastPollAt < interval) return;
      if (scraping) { console.log('FS: skip — previous scrape still running'); return; }

      scraping = true;
      console.log('FS: scrape cycle');
      try {
        const rows = await scrapeFlows();
        lastPollAt = now;
        let sentCount = 0;

        // fs_sent kosong (first boot / selesai /fsclear): kirim SATU ringkasan
        // 4 hari terakhir sebagai feedback, lalu tandai semua tanggal existing
        // supaya tidak spam dan tidak terkirim ulang.
        const hasBaseline = db.prepare('SELECT COUNT(*) c FROM fs_sent').get().c > 0;
        if (!hasBaseline && rows.length > 0) {
          const realRows = rows.filter(r => r.hasData);
          if (realRows.length > 0) {
            const newestIdx = rows.indexOf(realRows[realRows.length - 1]);
            const msg = buildFlowMsg(getLastRealDays(rows, newestIdx, 4));
            await sendFsNotif(bot, chatId, msg, { parse_mode: 'HTML', disable_web_page_preview: true });
            for (const row of rows) {
              if (row.hasData) markSent(row);
            }
            console.log(`FS: empty-state — kirim 1 ringkasan, tandai ${realRows.length} tanggal`);
          }
          cleanupOldFlows();
          return;
        }

        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          if (!row.hasData) continue; // hari belum keluar datanya (semua "-")
          if (isAlreadySent(row.date)) continue;

          const days = getLastRealDays(rows, i, 4); // hari ini + 3 sebelumnya
          const msg = buildFlowMsg(days);
          await sendFsNotif(bot, chatId, msg, { parse_mode: 'HTML', disable_web_page_preview: true });

          markSent(row);
          sentCount++;
        }

        if (sentCount > 0) {
          console.log(`FS: Sent ${sentCount} flow update(s)`);
        }

        cleanupOldFlows();
      } catch (e) {
        console.error('FS pollTick error:', e.message);
      } finally {
        scraping = false;
      }
    }

    return {
      prefix: 'fs_',
      handleCallback,
      handleMessage,
      pollTick,
      showFeatureMenu: (chatId, msgId) => showFeatureMenu(bot, chatId, msgId),
    };
  },
  addFsGroupChat,
  clearSentFlows,
};