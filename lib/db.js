const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'indikratos.db');

const db = new Database(DB_PATH, {});
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS st_pairs (
    ticker TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    PRIMARY KEY (ticker, timeframe)
  );

  CREATE TABLE IF NOT EXISTS bt_pairs (
    ticker TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    PRIMARY KEY (ticker, timeframe)
  );

  CREATE TABLE IF NOT EXISTS perp_pairs (
    ticker TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    PRIMARY KEY (ticker, timeframe)
  );

  CREATE TABLE IF NOT EXISTS sim_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    entry_price REAL NOT NULL,
    entry_signal TEXT NOT NULL,
    close_price REAL,
    pnl REAL,
    sl_price REAL NOT NULL,
    tp1_price REAL NOT NULL,
    tp2_price REAL NOT NULL,
    tp1_hit REAL,
    tp2_hit REAL,
    result TEXT,
    opened_at TEXT DEFAULT (datetime('now')),
    closed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS backtest_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    entry_price REAL NOT NULL,
    close_price REAL,
    pnl REAL,
    sl_price REAL NOT NULL,
    tp1_price REAL NOT NULL,
    tp2_price REAL NOT NULL,
    tp1_hit REAL,
    tp2_hit REAL,
    result TEXT,
    opened_at TEXT,
    closed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS backtest_summary (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    total_trades INTEGER DEFAULT 0,
    win INTEGER DEFAULT 0,
    lose INTEGER DEFAULT 0,
    win_rate REAL DEFAULT 0,
    total_pnl REAL DEFAULT 0,
    avg_pnl REAL DEFAULT 0,
    max_win REAL DEFAULT 0,
    max_lose REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(ticker, timeframe)
  );

  CREATE TABLE IF NOT EXISTS perp_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL,
    direction TEXT NOT NULL,
    entry_price REAL NOT NULL,
    close_price REAL,
    pnl REAL,
    sl_price REAL NOT NULL,
    tp_price REAL NOT NULL,
    tp_hit REAL,
    result TEXT,
    entry_signal TEXT,
    source TEXT DEFAULT 'live',
    opened_at TEXT DEFAULT (datetime('now')),
    closed_at TEXT
  );
`);

// add source column if missing (existing db migration)
try { db.exec("ALTER TABLE perp_trades ADD COLUMN source TEXT DEFAULT 'live'"); } catch (e) {}

// ── One-time migration from old shared pairs ─────────────────────────────
const hasPairs = db.prepare("SELECT COUNT(*) as c FROM st_pairs").get().c > 0;
const oldTbl = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='symbol_timeframes'").get();
if (!hasPairs && oldTbl) {
  const oldRows = db.prepare(`
    SELECT s.ticker, t.name as tf FROM symbols s
    JOIN symbol_timeframes st ON st.symbol_id = s.id
    JOIN timeframes t ON t.id = st.timeframe_id
  `).all();
  const ins = db.prepare('INSERT OR IGNORE INTO st_pairs (ticker, timeframe) VALUES (?, ?)');
  const ins2 = db.prepare('INSERT OR IGNORE INTO bt_pairs (ticker, timeframe) VALUES (?, ?)');
  const ins3 = db.prepare('INSERT OR IGNORE INTO perp_pairs (ticker, timeframe) VALUES (?, ?)');
  const tx = db.transaction(() => {
    for (const r of oldRows) { ins.run(r.ticker, r.tf); ins2.run(r.ticker, r.tf); ins3.run(r.ticker, r.tf); }
  });
  tx();
  console.log('Migrated', oldRows.length, 'old shared pairs to st_pairs, bt_pairs, perp_pairs');
  for (const t of ['symbol_timeframes','symbols','timeframes','supertrend_state'])
    try { db.exec('DROP TABLE IF EXISTS ' + t); } catch(e){}
}

function upsertConfig(key, value) {
  db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, String(value));
}

function getConfig(key, def) {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  return row ? row.value : def;
}

function getFeatConfig(feat, key, def) {
  const v = getConfig(`${feat}_${key}`);
  return v !== undefined && v !== null ? v : def;
}

function getTfConfig(tf, globalPeriod, globalMultiplier) {
  return {
    period: Number(getConfig(`supertrendPeriod_${tf}`, String(globalPeriod))),
    multiplier: Number(getConfig(`supertrendMultiplier_${tf}`, String(globalMultiplier))),
  };
}

function loadPairsFor(table) {
  const rows = db.prepare(`SELECT ticker, timeframe FROM ${table} ORDER BY ticker`).all();
  const pairs = {};
  for (const r of rows) {
    if (!pairs[r.ticker]) pairs[r.ticker] = [];
    pairs[r.ticker].push(r.timeframe);
  }
  return pairs;
}

// === Migrate shared config to feature-specific keys ===
const _oldSl = getConfig('slPercent', '-2');
const _oldTp1 = getConfig('tp1Percent', '2');
const _oldTp2 = getConfig('tp2Percent', '4');
for (const _f of ['st', 'bt', 'perp']) {
  if (getConfig(`${_f}_slPercent`) === undefined) upsertConfig(`${_f}_slPercent`, _oldSl);
  if (getConfig(`${_f}_tp1Percent`) === undefined) upsertConfig(`${_f}_tp1Percent`, _oldTp1);
  if (getConfig(`${_f}_tp2Percent`) === undefined) upsertConfig(`${_f}_tp2Percent`, _oldTp2);
}
if (getConfig('bt_mode') === undefined) upsertConfig('bt_mode', getConfig('backtestMode', 'trades'));
if (getConfig('bt_limit') === undefined) upsertConfig('bt_limit', getConfig('backtestLimit', '100'));
if (getConfig('bt_startDate') === undefined) upsertConfig('bt_startDate', getConfig('backtestStartDate', ''));
if (getConfig('bt_endDate') === undefined) upsertConfig('bt_endDate', getConfig('backtestEndDate', ''));
if (getConfig('perp_btEnabled') === undefined) upsertConfig('perp_btEnabled', getConfig('btPerpEnabled', '0'));
if (getConfig('perp_running') === undefined) upsertConfig('perp_running', getConfig('perpRunning', '0'));
if (getConfig('perp_waitMode') === undefined) upsertConfig('perp_waitMode', getConfig('perpWaitMode', 'trend'));
if (getConfig('perp_swingLookback') === undefined) upsertConfig('perp_swingLookback', getConfig('perpSwingLookback', '5'));
if (getConfig('perp_volumeThreshold') === undefined) upsertConfig('perp_volumeThreshold', getConfig('perpVolumeThreshold', '150'));
if (getConfig('perp_startDate') === undefined) upsertConfig('perp_startDate', getConfig('perpStartDate', ''));
if (getConfig('perp_endDate') === undefined) upsertConfig('perp_endDate', getConfig('perpEndDate', ''));

module.exports = {
  db,
  upsertConfig,
  getConfig,
  getFeatConfig,
  getTfConfig,
  loadPairsFor,
};
