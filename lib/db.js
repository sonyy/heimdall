const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'heimdall.db');

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
    liq_price REAL,
    fee REAL DEFAULT 0,
    sl_price REAL NOT NULL,
    tp1_price REAL NOT NULL,
    tp2_price REAL NOT NULL,
    tp1_hit REAL,
    tp2_hit REAL,
    result TEXT,
    direction TEXT,
    opened_at TEXT,
    closed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS backtest_summary (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    direction TEXT NOT NULL DEFAULT 'LONG',
    total_trades INTEGER DEFAULT 0,
    win INTEGER DEFAULT 0,
    lose INTEGER DEFAULT 0,
    win_rate REAL DEFAULT 0,
    total_pnl REAL DEFAULT 0,
    avg_pnl REAL DEFAULT 0,
    max_win REAL DEFAULT 0,
    max_lose REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(ticker, timeframe, direction)
  );
`);

// add source column if missing (existing db migration)
try { db.exec("ALTER TABLE backtest_trades ADD COLUMN direction TEXT DEFAULT 'LONG'"); } catch (e) {}
try { db.exec("ALTER TABLE backtest_summary ADD COLUMN direction TEXT DEFAULT 'LONG'"); } catch (e) {}
try { db.exec("ALTER TABLE backtest_trades ADD COLUMN liq_price REAL"); } catch (e) {}
try { db.exec("ALTER TABLE backtest_trades ADD COLUMN fee REAL DEFAULT 0"); } catch (e) {}
try { db.exec("ALTER TABLE backtest_trades ADD COLUMN margin_size REAL"); } catch (e) {}
try { db.exec("ALTER TABLE backtest_trades ADD COLUMN capital_entry REAL"); } catch (e) {}
try { db.exec("ALTER TABLE backtest_trades ADD COLUMN capital_exit REAL"); } catch (e) {}
try { db.exec("ALTER TABLE sim_trades ADD COLUMN margin_size REAL"); } catch (e) {}
try { db.exec("ALTER TABLE sim_trades ADD COLUMN capital_entry REAL"); } catch (e) {}

try { db.exec("ALTER TABLE st_pairs ADD COLUMN notif_targets TEXT"); } catch (e) {}

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
  const tx = db.transaction(() => {
    for (const r of oldRows) { ins.run(r.ticker, r.tf); ins2.run(r.ticker, r.tf); }
  });
  tx();
  console.log('Migrated', oldRows.length, 'old shared pairs to st_pairs, bt_pairs');
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

  if (getConfig('bt_indicator') === undefined) upsertConfig('bt_indicator', 'st');
  if (getConfig('bt_waitMode') === undefined) upsertConfig('bt_waitMode', 'trend');
  if (getConfig('bt_swingLookback') === undefined) upsertConfig('bt_swingLookback', '2');
  if (getConfig('bt_volumeThreshold') === undefined) upsertConfig('bt_volumeThreshold', '150');
  if (getConfig('bt_startCapital') === undefined) upsertConfig('bt_startCapital', '1000');
  if (getConfig('bt_usdtPerTrade') === undefined) upsertConfig('bt_usdtPerTrade', '100');
  if (getConfig('bt_marginPercent') === undefined) upsertConfig('bt_marginPercent', '10');
  if (getConfig('bt_marginMode') === undefined) upsertConfig('bt_marginMode', 'fixed');

  if (getConfig('st_usdtPerTrade') === undefined) upsertConfig('st_usdtPerTrade', '100');
  if (getConfig('st_startCapital') === undefined) upsertConfig('st_startCapital', '1000');

module.exports = {
  db,
  upsertConfig,
  getConfig,
  getFeatConfig,
  getTfConfig,
  loadPairsFor,
};
