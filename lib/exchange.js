const axios = require('axios');

const API_BASE = 'https://api.binance.com';
const FAPI_BASE = 'https://fapi.binance.com';
const VALID_TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M', '12M'];

const EXCHANGES = [
  { name: 'Binance', url: (t, tf, l) => `${API_BASE}/api/v3/klines?symbol=${t}&interval=${tf}&limit=${l}` },
  { name: 'OKX', url: (t, tf, l) => `https://www.okx.com/api/v5/market/candles?instId=${t}-USDT&bar=${tfMapOkx(tf)}&limit=${l}` },
  { name: 'MEXC', url: (t, tf, l) => `https://api.mexc.com/api/v3/klines?symbol=${t}&interval=${tf}&limit=${l}` },
  { name: 'Bitget', url: (t, tf, l) => `https://api.bitget.com/api/v2/market/candles?symbol=${t}USDT&granularity=${tfMapBitget(tf)}&limit=${l}&productType=USDT-FUTURES` },
];

function tfMapOkx(tf) {
  const m = { '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1H', '2h': '2H', '4h': '4H', '6h': '6H', '8h': '8H', '12h': '12H', '1d': '1D', '3d': '3D', '1w': '1W', '1M': '1M' };
  return m[tf] || tf;
}

function tfMapBitget(tf) {
  const m = { '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1H', '2h': '2H', '4h': '4H', '6h': '6H', '8h': '8H', '12h': '12H', '1d': '1D', '3d': '3D', '1w': '1W', '1M': '1M' };
  return m[tf] || tf;
}

function tfToMinutes(tf) {
  const m = tf.match(/^(\d+)([mhdwM])$/);
  if (!m) return 60;
  const n = parseInt(m[1]);
  if (m[2] === 'm') return n;
  if (m[2] === 'h') return n * 60;
  if (m[2] === 'd') return n * 1440;
  if (m[2] === 'w') return n * 10080;
  if (m[2] === 'M') return n * 43200;
  return 60;
}

function parseCandle(raw, exchange) {
  if (exchange === 'Binance' || exchange === 'MEXC') {
    return { openTime: raw[0], open: parseFloat(raw[1]), high: parseFloat(raw[2]), low: parseFloat(raw[3]), close: parseFloat(raw[4]), volume: parseFloat(raw[5]) };
  }
  if (exchange === 'OKX') {
    return { openTime: raw[0], open: parseFloat(raw[1]), high: parseFloat(raw[2]), low: parseFloat(raw[3]), close: parseFloat(raw[4]), volume: parseFloat(raw[5]) };
  }
  if (exchange === 'Bitget') {
    return { openTime: raw[0], open: parseFloat(raw[1]), high: parseFloat(raw[2]), low: parseFloat(raw[3]), close: parseFloat(raw[4]), volume: parseFloat(raw[5]) };
  }
  return null;
}

async function fetchCandles(ticker, timeframe, limit) {
  const errors = [];
  for (const ex of EXCHANGES) {
    try {
      const url = ex.url(ticker, timeframe, limit);
      const res = await axios.get(url, { timeout: 10000 });
      const data = Array.isArray(res.data) ? res.data : res.data.data;
      if (!data || !data.length) continue;
      const candles = data.map(r => parseCandle(r, ex.name)).filter(Boolean);
      if (candles.length < 2) continue;
      return { exchange: ex.name, data: ex.name === 'OKX' ? candles.reverse() : candles };
    } catch (e) {
      errors.push(`${ex.name}: ${e.message}`);
    }
  }
  throw new Error(`Candle fetch failed: ${errors.join('; ')}`);
}

async function fetchKlines(ticker, timeframe) {
  return fetchCandles(ticker, timeframe, 200);
}

async function fetchKlinesRange(ticker, timeframe, startTime, endTime, limit) {
  const MAX_PER_PAGE = 1000;
  const requestedLimit = limit || 1000;
  const intervalMs = tfToMinutes(timeframe) * 60000;
  const errors = [];

  for (const ex of EXCHANGES) {
    try {
      let allCandles = [];
      let cursor = startTime || 0;
      let remaining = requestedLimit;

      while (remaining > 0) {
        const batchSize = Math.min(remaining, MAX_PER_PAGE);
        let url;
        if (ex.name === 'Binance') {
          url = `${API_BASE}/api/v3/klines?symbol=${ticker}&interval=${timeframe}&limit=${batchSize}`;
          if (cursor) url += `&startTime=${cursor}`;
          if (endTime) url += `&endTime=${endTime}`;
        } else if (ex.name === 'OKX') {
          url = `https://www.okx.com/api/v5/market/candles?instId=${ticker}-USDT&bar=${tfMapOkx(timeframe)}&limit=${batchSize}`;
          if (cursor) url += `&before=${cursor}`;
        } else if (ex.name === 'MEXC') {
          url = `https://api.mexc.com/api/v3/klines?symbol=${ticker}&interval=${timeframe}&limit=${batchSize}`;
          if (cursor) url += `&startTime=${cursor}`;
        } else if (ex.name === 'Bitget') {
          url = `https://api.bitget.com/api/v2/market/candles?symbol=${ticker}USDT&granularity=${tfMapBitget(timeframe)}&limit=${batchSize}&productType=USDT-FUTURES`;
          if (cursor) url += `&startTime=${cursor}`;
        }

        const res = await axios.get(url, { timeout: 15000 });
        const data = Array.isArray(res.data) ? res.data : res.data.data;
        if (!data || !data.length) break;

        const candles = data.map(r => parseCandle(r, ex.name)).filter(Boolean);
        if (candles.length < 1) break;

        // OKX returns newest-first, reverse each batch so oldest is first
        if (ex.name === 'OKX') candles.reverse();

        allCandles.push(...candles);
        remaining -= candles.length;

        // If we got fewer than requested, no more data available
        if (candles.length < batchSize) break;

        // Advance cursor past the last candle's openTime
        const lastOpenTime = candles[candles.length - 1].openTime;
        if (!lastOpenTime) break;
        cursor = lastOpenTime + intervalMs;

        // If cursor passed endTime, stop
        if (endTime && cursor > endTime) break;

        // Safety: avoid infinite loops
        if (allCandles.length > requestedLimit + 500) break;
      }

      if (allCandles.length >= 2) {
        return { exchange: ex.name, data: allCandles.slice(0, requestedLimit) };
      }
    } catch (e) {
      errors.push(`${ex.name}: ${e.message}`);
    }
  }
  throw new Error(`Range fetch failed: ${errors.join('; ')}`);
}

function normalizeTf(input) {
  const exact = VALID_TIMEFRAMES.find(tf => tf === input);
  if (exact) return exact;
  return VALID_TIMEFRAMES.find(tf => tf.toLowerCase() === input.toLowerCase()) || null;
}

// ─── Binance USDT-M futures klines (public, no auth) ─────────────────────
// Futures-only pairs (HYPEUSDT, TRUTHUSDT, ...) are NOT on spot — these
// fetchers use fapi.binance.com so the RSI bot can backtest/trade them.

function parseFuturesCandle(raw) {
  return { openTime: raw[0], open: parseFloat(raw[1]), high: parseFloat(raw[2]), low: parseFloat(raw[3]), close: parseFloat(raw[4]), volume: parseFloat(raw[5]) };
}

async function fetchFuturesKlines(ticker, timeframe, limit = 200) {
  const tf = normalizeTf(timeframe) || timeframe;
  const res = await axios.get(`${FAPI_BASE}/fapi/v1/klines`, { params: { symbol: ticker, interval: tf, limit }, timeout: 10000 });
  if (!Array.isArray(res.data) || !res.data.length) throw new Error(`No futures klines for ${ticker} ${tf}`);
  return { exchange: 'BinanceFutures', data: res.data.map(parseFuturesCandle) };
}

async function fetchFuturesKlinesRange(ticker, timeframe, startTime, endTime, limit) {
  const tf = normalizeTf(timeframe) || timeframe;
  const intervalMs = tfToMinutes(tf) * 60000;
  const MAX_PER_PAGE = 1500;
  const requestedLimit = Math.min(limit || 1000, 1500 * 50);
  let allCandles = [];
  let cursor = startTime || 0;

  while (allCandles.length < requestedLimit) {
    const params = { symbol: ticker, interval: tf, limit: MAX_PER_PAGE };
    if (cursor) params.startTime = cursor;
    if (endTime) params.endTime = endTime;
    const res = await axios.get(`${FAPI_BASE}/fapi/v1/klines`, { params, timeout: 15000 });
    const batch = (Array.isArray(res.data) ? res.data : []).map(parseFuturesCandle);
    if (!batch.length) break;
    allCandles.push(...batch);
    if (batch.length < MAX_PER_PAGE) break;
    cursor = batch[batch.length - 1].openTime + intervalMs;
    if (endTime && cursor > endTime) break;
    if (allCandles.length > requestedLimit + 500) break;
  }
  if (allCandles.length < 2) throw new Error(`Futures range fetch failed for ${ticker} ${tf}`);
  return { exchange: 'BinanceFutures', data: allCandles.slice(0, requestedLimit) };
}

// Futures-first with spot fallback — for symbols that trade on both, futures
// klines match spot; for futures-only symbols the spot chain is skipped.
async function fetchCandlesFlex(ticker, timeframe, limit) {
  try { return await fetchFuturesKlines(ticker, timeframe, limit); } catch (e) { /* fall through to spot chain */ }
  return fetchCandles(ticker, timeframe, limit);
}

async function fetchKlinesRangeFlex(ticker, timeframe, startTime, endTime, limit) {
  try { return await fetchFuturesKlinesRange(ticker, timeframe, startTime, endTime, limit); } catch (e) { /* fall through to spot chain */ }
  return fetchKlinesRange(ticker, timeframe, startTime, endTime, limit);
}

module.exports = {
  VALID_TIMEFRAMES,
  normalizeTf,
  fetchCandles,
  fetchKlines,
  fetchKlinesRange,
  fetchFuturesKlines,
  fetchFuturesKlinesRange,
  fetchCandlesFlex,
  fetchKlinesRangeFlex,
  tfToMinutes,
};
