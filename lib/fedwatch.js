const { db, getFeatConfig, upsertConfig } = require('./db');
const { execFile } = require('child_process');

// ─── Sumber data ─────────────────────────────────────────────────────────────
// SUMBER: kolom "NOW" tool FedWatch (QuikStrike) langsung dari website.
// CME memblokir akses server (403) & QuikStrike menolak tanpa referer
// cmegroup.com, jadi tool dimuat via Playwright dgn referer di request goto.
// Hanya tab meeting terdekat yg di-scrape (bukan semua tab). Bila scrape gagal,
// fetch dilempar error — tidak ada fallback settlement (data EOD dianggap tidak
// akurat/berguna utk notif). FRED (EFFR) bisa diakses langsung.
const FW_URL = 'https://www.cmegroup.com/markets/interest-rates/cme-fedwatch-tool.html';
const QS_TOOL_URL = 'https://cmegroup-tools.quikstrike.net/User/QuikStrikeTools.aspx?viewitemid=IntegratedFedWatchTool&userId=lwolf&jobRole=&company=&companyType=&userId=&jobRole=&company=&companyType=';
const JINA_BASE = 'https://r.jina.ai/';
const CME_SETTLE_URL = 'https://www.cmegroup.com/CmeWS/mvc/Settlements/Futures/Settlements/305/FUT';
const FRED_CSV_URL = 'https://fred.stlouisfed.org/graph/fredgraph.csv';

// ─── Kalender FOMC (tanggal keputusan/akhir meeting) ────────────────────────
// Source: https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm
// (sama dgn referensi cme-fedwatch; perlu diupdate manual saat hampir habis)
const FOMC_MEETINGS = [
  '2025-01-29', '2025-03-19', '2025-05-07', '2025-06-18', '2025-07-30',
  '2025-09-17', '2025-10-29', '2025-12-10',
  '2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17', '2026-07-29',
  '2026-09-16', '2026-10-28', '2026-12-09',
  '2027-01-27', '2027-03-17', '2027-04-28', '2027-06-09', '2027-07-28',
  '2027-09-15', '2027-10-27', '2027-12-08',
  '2028-01-26',
].map(s => new Date(s + 'T00:00:00Z'));

const MONTH_NAMES = { 1: 'JAN', 2: 'FEB', 3: 'MAR', 4: 'APR', 5: 'MAY', 6: 'JUN', 7: 'JUL', 8: 'AUG', 9: 'SEP', 10: 'OCT', 11: 'NOV', 12: 'DEC' };
const MONTH_CODES = { 1: 'F', 2: 'G', 3: 'H', 4: 'J', 5: 'K', 6: 'M', 7: 'N', 8: 'Q', 9: 'U', 10: 'V', 11: 'X', 12: 'Z' };

// ─── HTTP helper ─────────────────────────────────────────────────────────────
// r.jina.ai memakai Cloudflare dan menantang request yg User-Agent-nya mengaku
// Chrome tapi TLS fingerprint-nya bukan browser (termasuk https Node.js dan
// `curl -H "User-Agent: Mozilla/5.0..."`). UA default curl konsisten dgn
// fingerprint curl → selalu lolos dari server ini. 403 transient saat burst
// ditangani dgn retry backoff.
async function httpGetText(urlString, headers = {}, timeoutMs = 45000) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const raw = await new Promise((resolve, reject) => {
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
      return raw;
    } catch (e) {
      const retriable = e.code === 403 || e.code === 429 || (e.code >= 500 && e.code < 600) || e.code === undefined;
      if (!retriable || attempt === 3) throw new Error(`${e.message} dari ${urlString.slice(0, 90)}: ${e.body || ''}`);
      await sleep(4000 * attempt);
    }
  }
}

// jina membungkus payload dgn blok header pseudo-markdown; ambil JSON di dalamnya.
function extractJsonFromJina(text) {
  const marker = 'Markdown Content:';
  const idx = text.indexOf(marker);
  const body = idx >= 0 ? text.slice(idx + marker.length) : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('tidak ada JSON dalam respon jina');
  return JSON.parse(body.slice(start, end + 1));
}

function fmtTradeDate(d) {
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${d.getUTCFullYear()}`;
}

// CME Settlements feed hanya tersedia utk hari kerja; retry satu hari ke belakang.
async function fetchCmeSettlements(tradeDateStr) {
  const target = `${CME_SETTLE_URL}?tradeDate=${tradeDateStr}`;
  const text = await httpGetText(JINA_BASE + target, { 'x-no-cache': 'true' });
  const data = extractJsonFromJina(text);
  if (data.empty || !Array.isArray(data.settlements) || data.settlements.length === 0) {
    const [m, d, y] = tradeDateStr.split('/').map(Number);
    const prev = new Date(Date.UTC(y, m - 1, d - 1));
    while (prev.getUTCDay() === 0 || prev.getUTCDay() === 6) prev.setUTCDate(prev.getUTCDate() - 1);
    const prevStr = fmtTradeDate(prev);
    const text2 = await httpGetText(JINA_BASE + `${CME_SETTLE_URL}?tradeDate=${prevStr}`, { 'x-no-cache': 'true' });
    const data2 = extractJsonFromJina(text2);
    if (data2.empty || !Array.isArray(data2.settlements) || data2.settlements.length === 0) {
      throw new Error(`CME settlements kosong utk ${tradeDateStr} & ${prevStr}`);
    }
    return { settlements: data2.settlements, tradeDate: prevStr };
  }
  return { settlements: data.settlements, tradeDate: tradeDateStr };
}

// FRED CSV: "DATE,VALUE" — ambil value non-kosong terakhir.
async function fetchFredSeries(seriesId) {
  const end = new Date();
  const start = new Date(Date.now() - 12 * 86400000);
  const cosd = start.toISOString().slice(0, 10);
  const coed = end.toISOString().slice(0, 10);
  const text = await httpGetText(`${FRED_CSV_URL}?id=${seriesId}&cosd=${cosd}&coed=${coed}`);
  const lines = text.trim().split('\n');
  for (let i = lines.length - 1; i >= 1; i--) {
    const parts = lines[i].split(',');
    if (parts.length === 2 && parts[1] && parts[1] !== '.') {
      return parseFloat(parts[1]);
    }
  }
  throw new Error(`FRED ${seriesId} tidak punya data`);
}

// ─── Helper tanggal & kontrak (replikasi fomc.py) ────────────────────────────
function daysInMonth(d) { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); }

function prevMonthKey(d) {
  const y = d.getUTCMonth() === 0 ? d.getUTCFullYear() - 1 : d.getUTCFullYear();
  const m = d.getUTCMonth() === 0 ? 12 : d.getUTCMonth();
  return `${MONTH_NAMES[m]} ${y % 100}`;
}

function nextMonthKey(d) {
  const y = d.getUTCMonth() === 11 ? d.getUTCFullYear() + 1 : d.getUTCFullYear();
  const m = d.getUTCMonth() === 11 ? 1 : d.getUTCMonth() + 2;
  return `${MONTH_NAMES[m]} ${y % 100}`;
}

function meetingMonthKey(d) { return `${MONTH_NAMES[d.getUTCMonth() + 1]} ${d.getUTCFullYear() % 100}`; }

function meetingContractCode(d) { return `ZQ${MONTH_CODES[d.getUTCMonth() + 1]}${d.getUTCFullYear() % 10}`; }

// ─── Kalkulasi probabilitas (replikasi calc.py) ──────────────────────────────
function rangeLabel(lowerBps) { return `${(lowerBps / 100).toFixed(2)}%-${((lowerBps + 25) / 100).toFixed(2)}%`; }

function currentTargetRange(effr) {
  const lowerBps = Math.floor((effr * 100) / 25) * 25;
  return { lowerBps, label: rangeLabel(lowerBps) };
}

function movesToProbabilities(preRate, postRate, currentLowerBps) {
  const preBps = preRate * 100;
  const preLower = Math.floor(preBps / 25) * 25;
  const expectedMoves = (postRate - preRate) / 0.25;
  const floorM = Math.floor(expectedMoves);
  const pCeil = Math.max(0, Math.min(1, expectedMoves - floorM));
  const pFloor = 1 - pCeil;
  const targetFloor = preLower + floorM * 25;
  const targetCeil = preLower + (floorM + 1) * 25;

  const probs = {};
  if (pFloor > 0.001) probs[rangeLabel(targetFloor)] = Math.round(pFloor * 1000) / 10;
  if (pCeil > 0.001) probs[rangeLabel(targetCeil)] = Math.round(pCeil * 1000) / 10;
  return { probs, currentLowerBps };
}

function calculateProbabilities(settlements, meetings, currentRate) {
  const settleMap = {};
  for (const s of settlements) {
    const v = parseFloat(s.settle);
    if (!isNaN(v) && s.month !== 'Total') settleMap[s.month] = v;
  }
  const cur = currentTargetRange(currentRate);
  const results = [];

  for (const meeting of meetings) {
    const monthKey = meetingMonthKey(meeting);
    if (!(monthKey in settleMap)) continue;

    const settlePrice = settleMap[monthKey];
    const implied = 100 - settlePrice;
    const d = meeting.getUTCDate();
    const D = daysInMonth(meeting);
    const nPost = D - d + 1;

    const prevKey = prevMonthKey(meeting);
    const preRate = prevKey in settleMap ? 100 - settleMap[prevKey] : currentRate;

    const nextKey = nextMonthKey(meeting);
    let postRate;
    if (nPost <= 3 && nextKey in settleMap) {
      postRate = 100 - settleMap[nextKey];
    } else {
      const nPre = d - 1;
      postRate = nPost > 0 ? (implied * D - preRate * nPre) / nPost : implied;
    }

    const { probs, currentLowerBps } = movesToProbabilities(preRate, postRate, cur.lowerBps);
    results.push({
      date: meeting.toISOString().slice(0, 10),
      contract: meetingContractCode(meeting),
      monthKey,
      probs,
      currentLowerBps,
    });
  }
  return { targetRange: cur.label, results };
}

// Tolak distribusi artefak: tool kadang render placeholder "range current 100%,
// sisanya 0" (atau sum != 100) saat kolom NOW belum stabil. Bukan data pasar.
function assertSaneDistribution(probs) {
  const entries = Object.entries(probs);
  if (!entries.length) throw new Error('distribusi probabilitas kosong');
  const nonZero = entries.filter(([, p]) => Number(p) > 0.05);
  const sum = entries.reduce((a, [, p]) => a + Number(p), 0);
  if (nonZero.length === 1 && nonZero[0][1] >= 99.5) {
    throw new Error(`distribusi degenerat: ${nonZero[0][0]} ${nonZero[0][1]}% -> artefak scrape`);
  }
  if (Math.abs(sum - 100) > 1.5) {
    throw new Error(`sum probabilitas ${sum.toFixed(1)}% != 100%`);
  }
}

// ─── Scrape live: kolom "NOW" dari tool QuikStrike ──────────────────────────
const FW_MONTH = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };

function fmtWebRange(label) {
  const m = label.replace(/\s*\(Current\)\s*/i, '').match(/(\d+(?:\.\d+)?)\s*[-–—]\s*(\d+(?:\.\d+)?)/);
  if (!m) return null;
  return `${(parseFloat(m[1]) / 100).toFixed(2)}%-${(parseFloat(m[2]) / 100).toFixed(2)}%`;
}

async function parseFedWatchMeeting(page) {
  return page.evaluate(() => {
    const txt = document.body.innerText;
    let date = null;
    let contract = null;
    const mi = txt.match(/MEETING DATE[\s\S]{0,140}?\n\s*(\d{1,2}\s+\w{3}\s+\d{4})\s+(\S+)/);
    if (mi) { date = mi[1]; contract = mi[2]; }

    const ranges = [];
    for (const tb of document.querySelectorAll('table')) {
      const t = tb.innerText || '';
      if (!/TARGET RATE/i.test(t) || !/PROBABILITY/i.test(t)) continue;
      for (const tr of tb.querySelectorAll('tr')) {
        const cells = [...tr.querySelectorAll('td, th')].map((c) => (c.innerText || '').trim());
        if (cells.length < 2) continue;
        if (!/^\d+(\.\d+)?\s*[-–—]\s*\d+/.test(cells[0])) continue;
        const pct = parseFloat((cells[1] || '').replace(/[^\d.]/g, ''));
        if (!isNaN(pct)) ranges.push({ label: cells[0], pct });
      }
      if (ranges.length) break;
    }
    return { date, contract, ranges };
  });
}

async function fetchLiveFedWatch() {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let lastErr = null;
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      let ctx = null;
      try {
        ctx = await browser.newContext({
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          viewport: { width: 1920, height: 1080 },
          timezoneId: 'America/Chicago',
        });
        await ctx.addInitScript(() => {
          Object.defineProperty(navigator, 'webdriver', { get: () => false });
        });
        const page = await ctx.newPage();
        await page.goto(QS_TOOL_URL, { timeout: 90000, waitUntil: 'domcontentloaded', referer: FW_URL });

        const deadline = Date.now() + 90000;
        while (Date.now() < deadline) {
          const ok = await page.evaluate(() => {
            const t = document.body ? document.body.innerText : '';
            return t.includes('PROBABILITIES') && t.includes('TARGET RATE');
          }).catch(() => false);
          if (ok) break;
          await page.waitForTimeout(2000);
        }

        // Tunggu sebentar agar kolom NOW terisi nilai aktual, bukan placeholder.
        await page.waitForTimeout(2500);

        const v = await parseFedWatchMeeting(page).catch(() => null);
        if (!v || !v.date || !v.ranges.length) throw new Error('tidak ada data meeting terbaca dari tool');

        const iso = v.date.replace(/^(\d{1,2})\s+(\w{3})\s+(\d{4})$/, (mm, d, mon, y) => `${y}-${FW_MONTH[mon] || '00'}-${d.padStart(2, '0')}`);
        const probs = {};
        let currentLabel = null;
        for (const r of v.ranges) {
          const key = fmtWebRange(r.label);
          if (!key) continue;
          probs[key] = r.pct;
          if (/\(Current\)/i.test(r.label)) currentLabel = key;
        }

        assertSaneDistribution(probs);

        const meetings = [{ date: iso, contract: v.contract || '', probs, currentLabel }];
        return { meetings, targetRange: currentLabel || '' };
      } catch (e) {
        lastErr = e;
        if (attempt === 3) throw new Error(`FedWatch scrape gagal setelah ${attempt} percobaan: ${e.message}`);
        await sleep(5000);
      } finally {
        await (ctx && ctx.close().catch(() => {}));
      }
    }
    throw lastErr;
  } finally {
    await browser.close().catch(() => {});
  }
}

// ─── Orchestrasi fetch (dipanggil tiap poll) ─────────────────────────────────
async function fetchFedWatchData() {
  const live = await fetchLiveFedWatch();
  let effr = null;
  try { effr = await fetchFredSeries('EFFR'); } catch (e) { console.warn('FW: FRED EFFR gagal:', e.message); }
  const tr = live.targetRange;
  if (!Number.isFinite(effr) && tr) {
    const lo = parseFloat(tr.split('-')[0]);
    const hi = parseFloat(tr.split('-')[1]);
    effr = Number.isFinite(lo) && Number.isFinite(hi) ? (lo + hi) / 2 : 3.63;
  }
  if (!Number.isFinite(effr)) effr = 3.63;
  return {
    effr,
    tradeDate: 'live',
    targetRange: tr,
    meetings: live.meetings.map((m) => ({ date: m.date, contract: m.contract, probs: m.probs })),
    fetchedAt: new Date().toISOString(),
  };
}

// ─── Fingerprint perubahan ────────────────────────────────────────────────────
function fingerprint(data) {
  return JSON.stringify(data.meetings.map((m) => [m.date, m.probs]));
}

// Returns true if any meeting's probability changed by >= threshold (percentage points)
function significantChange(last, now, threshold = 5) {
  if (!last || !now) return true;
  const lastMeetings = new Map(last.meetings.map(m => [m.date, m.probs]));
  const nowMeetings = new Map(now.meetings.map(m => [m.date, m.probs]));
  let maxDiff = 0;
  for (const [date, probsNow] of nowMeetings) {
    const probsLast = lastMeetings.get(date);
    if (!probsLast) {
      return true;
    }
    for (const [outcome, strNow] of Object.entries(probsNow)) {
      const lastStr = probsLast[outcome];
      if (lastStr === undefined) continue;
      const nowVal = parseFloat(strNow);
      const lastVal = parseFloat(lastStr);
      if (isNaN(nowVal) || isNaN(lastVal)) continue;
      const diff = Math.abs(nowVal - lastVal);
      if (diff > maxDiff) maxDiff = diff;
      if (diff >= threshold) return true;
    }
  }
  for (const [date, probsLast] of lastMeetings) {
    if (!nowMeetings.has(date)) {
      return true;
    }
  }
  return false;
}

function getLastSnapshot() {
  const row = db.prepare('SELECT snapshot_json, sent_at FROM fw_sent ORDER BY id DESC LIMIT 1').get();
  return row || null;
}

function saveSnapshot(fingerprintStr) {
  db.prepare('INSERT INTO fw_sent (snapshot_json) VALUES (?)').run(fingerprintStr);
}

function clearFwSent() {
  const count = db.prepare('SELECT COUNT(*) as c FROM fw_sent').get().c;
  db.prepare('DELETE FROM fw_sent').run();
  return count;
}

function fmtDateLabel(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d} ${names[m - 1]} ${y}`;
}

function fmtTimestamp(iso) {
  const d = new Date(iso);
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return d.toLocaleString('en-GB', {
    timeZone: 'Asia/Jakarta',
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }) + ' WIB';
}

// Offset New York (menit) terhadap UTC pada instant tertentu (DST-aware).
function nyOffsetMinutes(utcDate) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(utcDate).reduce((a, p) => (a[p.type] = p.value, a), {});
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  return (asUtc - utcDate.getTime()) / 60000;
}

// Instant UTC saat statement FOMC rilis: 14:00 waktu New York hari keputusan.
// FOMC selalu mengumumkan statement 14:00 ET (DST-aware) di hari kedua meeting.
function fomcStatementUtc(dateStr) {
  const wallAsUtc = Date.parse(`${dateStr}T14:00:00Z`);
  let ts = wallAsUtc;
  for (let i = 0; i < 3; i++) {
    const next = wallAsUtc - nyOffsetMinutes(new Date(ts)) * 60000;
    if (next === ts) break;
    ts = next;
  }
  return new Date(ts);
}

function nextFomcLine() {
  const now = new Date();
  const next = FOMC_MEETINGS.find((m) => m >= now);
  if (!next) return '';
  const dateStr = next.toISOString().slice(0, 10);
  const dateLabel = fmtDateLabel(dateStr);
  const stmt = fomcStatementUtc(dateStr);
  const wib = stmt.toLocaleString('en-GB', {
    timeZone: 'Asia/Jakarta',
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }) + ' WIB';

  const diffMin = Math.floor((stmt - now) / 60000);
  if (diffMin <= 0) return `⏭ FOMC ${dateLabel} — statement sudah rilis (${wib})`;

  const d = Math.floor(diffMin / 1440);
  const h = Math.floor((diffMin % 1440) / 60);
  const m = diffMin % 60;
  const left = d > 0 ? `${d} hari ${h} jam ${m} mnt` : `${h} jam ${m} mnt`;
  return `⏭ FOMC ${dateLabel} · statement ${wib} (~${left} lagi)`;
}

function buildFwMsg(data) {
  const curLabel = data.targetRange || '';
  const curBps = curLabel ? Math.round(parseFloat(curLabel.split('-')[0]) * 100) : NaN;

  const lines = [
    '🦅 <b>CME FedWatch</b>',
    `💰 EFFR: ${data.effr.toFixed(2)}%`,
  ];

  const first = data.meetings[0];
  if (first) {
    const rows = Object.entries(first.probs).filter(([, p]) => p > 0).sort((a, b) => b[1] - a[1]);
    const topLabel = rows.length ? rows[0][0] : null;
    const fmt = (label, p, arrow) => {
      const bold = label === topLabel;
      const body = bold ? `<b>${label}: ${p}%</b>` : `${label}: ${p}%`;
      return `${arrow} ${body}`;
    };

    const curRow = rows.find(([l]) => Math.round(parseFloat(l.split('-')[0]) * 100) === curBps);
    if (curRow) {
      lines.push(fmt(curRow[0], curRow[1], '➖'));
    }
    for (const [label, p] of rows) {
      const lower = Math.round(parseFloat(label.split('-')[0]) * 100);
      if (lower === curBps) continue;
      lines.push(fmt(label, p, lower > curBps ? '📈' : '📉'));
    }
  }

  lines.push(nextFomcLine());
  lines.push('━━━━━━━━');
  lines.push(`📅 Update: ${fmtTimestamp(data.fetchedAt)}`);
  lines.push(`🔗 <a href="${FW_URL}">CME FedWatch</a>`);
  return lines.join('\n');
}

// ─── Config helpers (sama pola dgn fs) ───────────────────────────────────────
function getFwNotifTargets() {
  try { return JSON.parse(getFeatConfig('fw', 'notif_targets', '["individual"]')); } catch { return ['individual']; }
}
function setFwNotifTargets(targets) { upsertConfig('fw_notif_targets', JSON.stringify(targets)); }
function getFwGroupChats() {
  try { return JSON.parse(getFeatConfig('fw', 'group_chats', '[]')); } catch { return []; }
}
function addFwGroupChat(chatId) {
  const chats = getFwGroupChats();
  if (!chats.includes(chatId)) {
    chats.push(chatId);
    upsertConfig('fw_group_chats', JSON.stringify(chats));
  }
}
async function sendFwNotif(bot, chatIdIndiv, text, opts) {
  const targets = getFwNotifTargets();
  const send = async (id) => {
    try { return await bot.sendMessage(id, text, opts); } catch (e) { console.error(`sendFwNotif to ${id} err:`, e.message); return null; }
  };
  const results = [];
  if (targets.includes('individual')) results.push(await send(chatIdIndiv));
  if (targets.includes('group')) {
    const groups = getFwGroupChats();
    if (groups.length) for (const gid of groups) results.push(await send(gid));
    else {
      results.push(await send(chatIdIndiv));
      console.warn('sendFwNotif: target grup tp blm ada grup terdaftar, fallback ke individu');
    }
  }
  return results.flat();
}

// ─── UI helpers ───────────────────────────────────────────────────────────────
async function sendMenu(bot, chatId, msgId, text, opts) {
  if (msgId) {
    try { return await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, ...opts }); } catch (e) {
      const fresh = await bot.sendMessage(chatId, text, opts).catch(e2 => {
        console.error('FW sendMenu edit+send err:', e.message, '/', e2.message);
        return null;
      });
      return fresh;
    }
  } else {
    try { return await bot.sendMessage(chatId, text, opts); } catch (e) { console.error('FW sendMenu send err:', e.message); }
  }
}

function showFeatureMenu(bot, chatId, msgId) {
  const enabled = getFeatConfig('fw', 'enabled', '1') === '1';
  const interval = Number(getFeatConfig('fw', 'interval', '1800000'));
  const snap = getLastSnapshot();
  const lastUpdate = snap ? snap.sent_at : '—';

  const notifTargets = getFwNotifTargets();
  const hasIndiv = notifTargets.includes('individual');
  const hasGroup = notifTargets.includes('group');
  const totGroups = getFwGroupChats().length;

  const text =
    `🦅 <b>CME FedWatch (Suku Bunga)</b>\n` +
    `${enabled ? '✅ Running' : '❌ Idle'}\n` +
    `Interval: ${(interval / 60000).toFixed(0)}m\n` +
    `Source: CME Settlements + FRED\n` +
    `📅 Notif terakhir: ${lastUpdate}\n` +
    `🔔 Target Notif:\n` +
    `  👤 Individu: ${hasIndiv ? '✅' : '❌'}\n` +
    `  👥 Grup: ${hasGroup ? '✅' : '❌'}${hasGroup && !totGroups ? ' ⚠️' : ''}` +
    (hasGroup && !totGroups ? '\n   ⚠️ Kirim /fw dr grup utk daftarin grup' : '');

  sendMenu(bot, chatId, msgId, text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: enabled ? '⏹ Stop' : '▶️ Start', callback_data: 'fw_toggle' }],
        [{ text: '⏱ Interval', callback_data: 'fw_interval' }],
        [{ text: `👤 Individu ${hasIndiv ? '✅' : '❌'}`, callback_data: 'fw_notif_indiv' },
         { text: `👥 Grup ${hasGroup ? '✅' : '❌'}`, callback_data: 'fw_notif_group' }],
        [{ text: '🗑️ Reset Baseline', callback_data: 'fw_clear' }],
        [{ text: '🔙 Kembali', callback_data: 'fw_mainback' }],
      ]
    }
  });
}

// ─── Module registration ────────────────────────────────────────────────────
module.exports = {
  fetchFedWatchData,
  fetchCmeSettlements,
  fetchFredSeries,
  calculateProbabilities,
  currentTargetRange,
  assertSaneDistribution,
  buildFwMsg,
  register(bot, chatId) {
    let lastPollAt = 0;
    let fetching = false;
    const fwConv = {};

    async function handleCallback(query) {
      const chatId = query.message.chat.id;
      const msgId = query.message.message_id;
      const data = query.data;

      if (!data.startsWith('fw_')) return { action: null };

      try {
        if (data === 'fw_toggle') {
          const cur = getFeatConfig('fw', 'enabled', '1') === '1';
          upsertConfig('fw_enabled', cur ? '0' : '1');
          showFeatureMenu(bot, chatId, msgId);
          return { action: null };
        }
        if (data === 'fw_interval') {
          fwConv[chatId] = { action: 'fw_interval_input' };
          sendMenu(bot, chatId, msgId, 'Masukkan interval baru dalam MENIT (contoh: 30):', {
            reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'fw_config_back' }]] }
          });
          return { action: 'fw_interval_input' };
        }
        if (data === 'fw_notif_indiv') {
          const cur = getFwNotifTargets();
          const next = cur.includes('individual') ? cur.filter(x => x !== 'individual') : [...cur, 'individual'];
          setFwNotifTargets(next);
          showFeatureMenu(bot, chatId, msgId);
          return { action: null };
        }
        if (data === 'fw_notif_group') {
          const cur = getFwNotifTargets();
          const next = cur.includes('group') ? cur.filter(x => x !== 'group') : [...cur, 'group'];
          setFwNotifTargets(next);
          showFeatureMenu(bot, chatId, msgId);
          return { action: null };
        }
        if (data === 'fw_clear') {
          const count = clearFwSent();
          bot.sendMessage(chatId, `🗑️ Reset baseline: ${count} record dihapus. Notif berikutnya akan dikirim sbg baseline baru.`).catch(() => {});
          showFeatureMenu(bot, chatId, msgId);
          return { action: null };
        }
        if (data === 'fw_back' || data === 'fw_config_back' || data === 'fw_mainback') {
          delete fwConv[chatId];
          showFeatureMenu(bot, chatId, msgId);
          return { action: null };
        }
      } catch (e) {
        console.error('FW handleCallback error:', e.message);
      }
      return { action: null };
    }

    async function handleMessage(text, chatId) {
      if (fwConv[chatId]?.action === 'fw_interval_input') {
        delete fwConv[chatId];
        const min = parseInt(text, 10);
        if (isNaN(min) || min < 10) {
          bot.sendMessage(chatId, '❌ Minimal 10 menit.').catch(() => {});
          return true;
        }
        upsertConfig('fw_interval', String(min * 60000));
        bot.sendMessage(chatId, `✅ Interval diubah ke ${min} menit`).catch(() => {});
        return true;
      }
      return false;
    }

    async function pollTick() {
      const enabled = getFeatConfig('fw', 'enabled', '1') === '1';
      if (!enabled) return;

      const interval = Number(getFeatConfig('fw', 'interval', '1800000'));
      const now = Date.now();
      if (now - lastPollAt < interval) return;
      if (fetching) { console.log('FW: skip — previous fetch still running'); return; }

      fetching = true;
      console.log('FW: fetch cycle');
      try {
        const data = await fetchFedWatchData();
        lastPollAt = now;
        const fp = fingerprint(data);
        const last = getLastSnapshot();

        // Belum ada baseline (first boot / abis /fwclear): kirim 1 pesan sbg baseline
        if (!last) {
          const msg = buildFwMsg(data);
          await sendFwNotif(bot, chatId, msg, { parse_mode: 'HTML', disable_web_page_preview: true });
          saveSnapshot(fp);
          console.log('FW: baseline terkirim (snapshot di-save)');
          return;
        }

        const lastMeetingsArr = JSON.parse(last.snapshot_json); // [[date, probs], ...]
        const lastData = { meetings: lastMeetingsArr.map(([date, probs]) => ({ date, probs })) };
        if (!significantChange(lastData, data, 5)) {
          console.log('FW: perubahan kecil (< 5pp) di-skip');
          return;
        }

        const msg = buildFwMsg(data);
        await sendFwNotif(bot, chatId, msg, { parse_mode: 'HTML', disable_web_page_preview: true });
        saveSnapshot(fp);
        console.log('FW: perubahan probabilitas → notif terkirim');
      } catch (e) {
        console.error('FW pollTick error:', e.message);
      } finally {
        fetching = false;
      }
    }

    async function showNow(chatId) {
      await bot.sendMessage(chatId, '⏳ Mengambil data FedWatch...').catch(() => {});
      try {
        const data = await fetchFedWatchData();
        const msg = buildFwMsg(data);
        const enabled = getFeatConfig('fw', 'enabled', '1') === '1';
        const notifTargets = getFwNotifTargets();
        const hasIndiv = notifTargets.includes('individual');
        const hasGroup = notifTargets.includes('group');
        await bot.sendMessage(chatId, msg, {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: {
            inline_keyboard: [
              [{ text: enabled ? '⏹ Stop' : '▶️ Start', callback_data: 'fw_toggle' }],
              [{ text: '⏱ Interval', callback_data: 'fw_interval' }],
              [{ text: `👤 Individu ${hasIndiv ? '✅' : '❌'}`, callback_data: 'fw_notif_indiv' },
               { text: `👥 Grup ${hasGroup ? '✅' : '❌'}`, callback_data: 'fw_notif_group' }],
              [{ text: '🗑️ Reset Baseline', callback_data: 'fw_clear' }],
            ]
          }
        }).catch(() => {});
      } catch (e) {
        console.error('FW showNow error:', e.message);
        bot.sendMessage(chatId, '❌ Gagal mengambil data FedWatch: ' + e.message.slice(0, 120)).catch(() => {});
      }
    }

    return {
      prefix: 'fw_',
      handleCallback,
      handleMessage,
      pollTick,
      showNow,
      addFwGroupChat,
      clearFwSent,
      showFeatureMenu: (chatId, msgId) => showFeatureMenu(bot, chatId, msgId),
    };
  },
  addFwGroupChat,
  clearFwSent,
};