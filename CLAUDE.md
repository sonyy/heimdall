# Indikratos — CLAUDE.md

Telegram trading-signal bot (Node.js) untuk simulasi Supertrend (ST), backtest, dan Perpetual MS. Poll loop menjalankan fitur ST-Sim / Backtest / Perp secara berkala; menu inline via `node-telegram-bot-api`.

> **Audience**: future agents/sessions yang perlu memahami atau memodifikasi bot ini.

## TL;DR
- Entry: `node index.js` (poll loop + Telegram), `node webui-sim.js` (sim UI).
- Config: `config.json` (`pollIntervalMs`, `supertrendPeriod=10`, `supertrendMultiplier=3`, `pairs` + timeframes).
- Fitur: ST Simulasi, Backtest ST, Perpetual MS — masing-masing modul di `lib/`.
- State: `state.json`, `indikratos.db` (SQLite).

## ⚡ Communication Rules
- High-level only; jawab yang ditanya; bahasa manusia; singkat & padat.
- **Direct tools untuk lookup sederhana** — cari identifier/konstan sederhana (grep, find constant) pakai tools langsung (`grep`, `read`), jangan spawn sub-agent. Sub-agent untuk search kompleks multi-repo, bukan lookup satu value.

## ⚡ Parallel Execution (multi-worker)

Gunakan multiple worker secara paralel dalam mengerjakan task yang diberikan ke kamu. Kalau ada banyak langkah independen — baca beberapa file, jalankan beberapa backtest/perhitungan, analisis beberapa pair sekaligus — jalankan bersamaan, jangan serial satu per satu. Manfaatkan mekanisme sub-agent / parallel tool calls untuk throughput maksimal.

### ⚠️ Failure mode (learned from experience)

**Before proposing ANY change — including answering "what should we do?" — you MUST:**

1. **Check data first.** Baca file state yang relevan (`state.json`, `indikratos.db`) dan cross-reference dengan klaimmu. JANGAN extrapolasi dari kode saja.
2. **If user asks a question, answer the question.** Jangan implement, suggest, atau config-change kecuali user secara eksplisit meminta aksi.
3. **Zero config changes without analysis.** Jangan sentuh `config.json` atau ubah parameter (pairs, timeframes, supertrend) tanpa:
   - Membaca data performa historis yang mendukung perubahan
   - Mempertimbangkan dampak ke pair/timeframe lain
   - Memastikan perubahan tidak menghalangi pola profitable yang sudah ter-identifikasi
4. **When unsure, say "saya perlu liat data dulu" before proposing anything.**
