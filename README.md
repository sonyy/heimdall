# Heimdall

Telegram bot for Supertrend breakout/breakdown alerts with backtesting.

## Quick Overview

- **Real-time alerts**: Supertrend (ST) breakout/breakdown detection
- **Simulation mode**: Dry-run trading with ST signals
- **Backtesting**: Historical performance testing of strategies (ST & MS indicators)
- **Backtest Rankings**: Leaderboard of best configs sorted by daily profit %
- **Perpetual monitoring**: Continuous market signal generation
- **Telegram interface**: Inline menu commands
- **Web UI**: Terminal-style dashboard at `http://localhost:3030`

## Tech Stack

| Component | Tech | Purpose |
|-----------|------|---------|
| Bot | Node.js | Runtime |
| Database | SQLite | Data storage |
| API | Telegram Bot API | UI + notifications |
| Indicators | technicalindicators | Supertrend calculation |

## Getting Started

### For Humans

```bash
git clone git@github.com:sonyy/heimdall.git
cd heimdall
npm install

# Configure
cp .env.example .env  # Add BOT_TOKEN and CHAT_ID

# Run
node index.js        # Starts polling + bot
node webui-sim.js    # Simulation UI at http://localhost:3030
```

### For AI Agents (via opencode)

```bash
# One-liner setup
opencode run "setup heimdall trading bot with telegram and webui"

# Or manually
opencode run "clone https://github.com/sonyy/heimdall, install deps, configure .env from .env.example, start index.js and webui-sim.js"
```

Required env vars in `.env`:
- `BOT_TOKEN` — Telegram bot token from @BotFather
- `CHAT_ID` — Your Telegram chat ID (get from @userinfobot)

## Web UI (http://localhost:3030)

Two tabs:
- **📈 Indikator Supertrend** — Live simulation status, positions, signals
- **📊 Backtest** — Results, pair configs, **🏆 Rankings** (leaderboard sorted by daily profit %, shows range dates, equity, max DD, WR, indicator config)

Auto-refreshes every 3 seconds.

## Commands

- `/notif` — Supertrend breakout/breakdown notification
- `/status` — Check positions and status
- `/signals` — View recent signals
- `/backtest` — Run backtest on pairs
- `/start` — Start monitoring
- 🏆 **Rankings** (inline button) — Top 3 backtest configs

## Configuration

Edit `config.json`:

```json
{
  "pollIntervalMs": 5000,
  "supertrendPeriod": 10,
  "supertrendMultiplier": 3,
  "pairs": ["BTCUSDT", "ETHUSDT"],
  "timeframes": ["5m", "15m", "1h", "1w", "1M"]
}
```

### Storage

- `state.json`: Application state
- `heimdall.db`: SQLite database for market data, trades, rankings

### Backtest Config (via Telegram /backtest menu)

| Key | Default | Description |
|-----|---------|-------------|
| `bt_indicator` | `st` | `st` or `ms` (Market Structure) |
| `bt_mode` | `trades` | Backtest mode |
| `bt_slPercent` | `-2` | Stop loss % |
| `bt_tp1Percent` | `1` | Take profit % |
| `bt_marginMode` | `fixed` | `fixed` or `percent` |
| `bt_marginPercent` | `10` | Margin % of capital (when percent mode) |
| `bt_usdtPerTrade` | `100` | Fixed USDT per trade (when fixed mode) |
| `bt_startDate` / `bt_endDate` | — | Backtest date range |

## Development

```bash
tail -f logs/*.log   # Check logs
node testdb.js       # Test database
sqlite3 heimdall.db  # Inspect DB directly
```
