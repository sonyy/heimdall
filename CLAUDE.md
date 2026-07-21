# Heimdall — CLAUDE.md

Telegram trading-signal bot (Node.js) untuk simulasi Supertrend (ST), backtest, dan Perpetual MS. Poll loop menjalankan fitur ST-Sim / Backtest / Perp secara berkala; menu inline via `node-telegram-bot-api`.

> **Audience**: future agents/sessions yang perlu memahami atau memodifikasi bot ini.

## TL;DR
- Entry: `node index.js` (poll loop + Telegram), `node webui-sim.js` (sim UI).
- Config: `config.json` (`pollIntervalMs`, `supertrendPeriod=10`, `supertrendMultiplier=3`, `pairs` + timeframes).
- Fitur: ST Simulasi, Backtest ST, Perpetual MS — masing-masing modul di `lib/`.
- State: `state.json`, `heimdall.db` (SQLite).

## ⚡ Communication Rules

- **High-level only** — skip implementation details unless asked
- **Bahasa manusia** — jangan pakai technical jargon yang tidak perlu
- **Jawab yang ditanya** — kalau ditanya A, jawab A. Jangan ditambah B, C, D
- **Singkat & padat** — 1-3 paragraf cukup untuk kebanyakan pertanyaan
- **Contoh konkret** lebih baik dari penjelasan panjang
- **Jangan output log mentah** — cukup bilang hasilnya, jangan paste seluruh output
- **Kalau butuh aksi user, bilang eksplisit** — contoh: "Mau saya X?" atau "Tolong Y"
- **Direct tools untuk lookup sederhana** — cari identifier/konstan sederhana (grep, find constant) pakai tools langsung (`grep`, `read`), jangan spawn sub-agent. Sub-agent untuk search kompleks multi-repo, bukan lookup satu value.

## ⚡ Parallel Execution (multi-worker)

Gunakan multiple worker secara paralel dalam mengerjakan task yang diberikan ke kamu. Kalau ada banyak langkah independen — baca beberapa file, jalankan beberapa backtest/perhitungan, analisis beberapa pair sekaligus — jalankan bersamaan, jangan serial satu per satu. Manfaatkan mekanisme sub-agent / parallel tool calls untuk throughput maksimal.

### ⚠️ Failure mode (learned from experience)

**Before proposing ANY change — including answering "what should we do?" — you MUST:**

1. **Check data first.** Baca file state yang relevan (`state.json`, `heimdall.db`) dan cross-reference dengan klaimmu. JANGAN extrapolasi dari kode saja.
2. **If user asks a question, answer the question.** Jangan implement, suggest, atau config-change kecuali user secara eksplisit meminta aksi.
3. **Zero config changes without analysis.** Jangan sentuh `config.json` atau ubah parameter (pairs, timeframes, supertrend) tanpa:
   - Membaca data performa historis yang mendukung perubahan
   - Mempertimbangkan dampak ke pair/timeframe lain
   - Memastikan perubahan tidak menghalangi pola profitable yang sudah ter-identifikasi
4. **When unsure, say "saya perlu liat data dulu" before proposing anything.**

## ⚡ Live vs Dry-Run parity (HARD RULE)

- **Pastikan mode live dan dry-run SELALU SAMA.** Setiap perubahan logika,
  parameter, atau flow yang dibuat saat simulasi/dry-run HARUS juga diterapkan
  ke mode live — dan sebaliknya. Kedua mode tidak boleh divergen dalam
  pengambilan keputusan.
- Dry-run/simulasi hanya me-skip eksekusi aktual (kirim tx / tulis DB mutasi).
  Ia TIDAK boleh me-skip screening, perhitungan (ST/backtest/perp), safety
  check, atau logging apa pun yang juga dijalankan live.
- Sebelum menyelesaikan perubahan, pastikan path simulasi vs live pada kode
  yang disentuh menghasilkan keputusan yang sama. Jangan biarkan fix menetap di
  dry-run saja tanpa juga masuk ke live.
