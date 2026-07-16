# Heimdall

Telegram bot for Supertrend breakout/breakdown alerts with simulated trading and backtesting.

## What It Does

- **Real-time alerts**: Supertrend (ST) breakout/breakdown detection
- **Simulation mode**: Dry-run trading with ST signals
- **Backtesting**: Historical performance testing of strategies
- **Perpetual monitoring**: Continuous market signal generation
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

## Configuration

Edit `config.json`:

```json
{
  "pollIntervalMs": 5000,
  "supertrendPeriod": 10,
  "supertrendMultiplier": 3,
  "pairs": ["BTC/USDT", "ETH/USDT"],
  "timeframes": ["5m", "15m", "1h"]
}
```

## Storage

- `state.json`: Application state
- `heimdall.db`: SQLite database for market data

## Commands

- `/status` - Check positions and status
- `/signals` - View recent signals
- `/backtest` - Run backtest on pairs
- `/start` - Start monitoring

## Development

```bash
tail -f logs/*.log   # Check logs
node testdb.js       # Test database
```