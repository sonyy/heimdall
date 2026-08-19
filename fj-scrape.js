const { chromium } = require('playwright');

const CATEGORY_KEYWORDS = ['Energy', 'Oil', 'Gold', 'Commodities', 'Metals', 'Agriculture', 'US Bonds', 'Bonds'];

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

async function clickFilter(page, name) {
  await page.evaluate((n) => {
    const items = document.querySelectorAll('.feeds-list li');
    for (const li of items) {
      if (li.textContent.trim().includes(n)) {
        const link = li.querySelector('a');
        if (link) { link.click(); return; }
        li.click();
        return;
      }
    }
  }, name);
  await page.waitForTimeout(4000);
}

async function scrollUntilDone(page, maxScrolls) {
  let prevCount = 0;
  for (let i = 0; i < maxScrolls; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2000);
    const count = await page.evaluate(() => document.querySelectorAll('.media.feedWrap').length);
    console.log('  Scroll ' + (i + 1) + ': ' + count + ' items');
    if (count === prevCount && i > 3) break;
    prevCount = count;
  }
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 }
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  const page = await context.newPage();
  await page.goto('https://www.financialjuice.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const count = await page.evaluate(() => document.querySelectorAll('.media.feedWrap').length);
    if (count > 5) break;
    await page.waitForTimeout(2000);
  }

  for (const filterName of ['Bonds', 'Commodities']) {
    console.log('\n=== ' + filterName + ' (fresh browser) ===');

    const p = await context.newPage();
    await p.goto('https://www.financialjuice.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    const d2 = Date.now() + 15000;
    while (Date.now() < d2) {
      const c = await p.evaluate(() => document.querySelectorAll('.media.feedWrap').length);
      if (c > 5) break;
      await p.waitForTimeout(2000);
    }

    await clickFilter(p, filterName);
    await scrollUntilDone(p, 12);

    const items = await p.evaluate(() => {
      const results = [];
      document.querySelectorAll('.media.feedWrap').forEach(el => {
        if (el.offsetParent === null) return;
        const isCritical = el.classList.contains('active-critical');
        const title = el.querySelector('.headline-title-nolink')?.textContent?.trim() || '';
        const time = el.querySelector('.time')?.textContent?.trim() || '';
        const labels = [];
        el.querySelectorAll('.news-label').forEach(l => labels.push(l.textContent.trim()));
        if (title) results.push({ title: title.substring(0, 120), time, labels, critical: isCritical });
      });
      return results;
    });

    const criticals = items.filter(i => i.critical);
    console.log('  Total visible: ' + items.length + ', Critical: ' + criticals.length);
    criticals.forEach(i => console.log('    [CRIT] [' + i.time + '] ' + i.title + ' | ' + i.labels.join(',')));
    if (criticals.length === 0) {
      console.log('  Non-critical sample:');
      items.slice(0, 5).forEach(i => console.log('    [' + i.time + '] ' + i.title + ' | ' + i.labels.join(',')));
    }
    await p.close();
  }

  await browser.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
