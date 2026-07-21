# Heimdall

Telegram bot for Supertrend breakout/breakdown alerts with backtesting.

## Quick Overview

- **Real-time alerts**: Supertrend (ST) breakout/breakdown detection
- **Backtesting**: Historical performance testing of strategies
- **Web UI**: Web UI shows backtest results 
- **Telegram interface**: Inline menu commands

## Tech Stack

| Component | Tech | Purpose |
|-----------|------|---------|
| Bot | Node.js | Runtime |
| Database | SQLite | Data storage |
| API | Telegram Bot API | UI + notifications |
| Indicators | technicalindicators | Supertrend calculation |

## Getting Started

```bash
git clone git@github.com:sonyy/heimdall.git
cd heimdall
npm install

# Configure
cp .env.example .env  # Add BOT_TOKEN and CHAT_ID

# Run
node index.js  # Starts polling + bot
node webui-sim.js  # Simulation UI
```

## Commands

- `/notif` - Supertrend breakout/breakdown notification
- `/backtest` - Run backtest on pairs

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
- `heimdall.db`: SQLite database for market data

## Development

```bash
tail -f logs/*.log   # Check logs
node testdb.js       # Test database
```
