const axios = require('axios');

const API_BASE = 'https://api.binance.com';
const VALID_TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M'];

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
    return { open: parseFloat(raw[1]), high: parseFloat(raw[2]), low: parseFloat(raw[3]), close: parseFloat(raw[4]), volume: parseFloat(raw[5]) };
  }
  if (exchange === 'OKX') {
    return { open: parseFloat(raw[1]), high: parseFloat(raw[2]), low: parseFloat(raw[3]), close: parseFloat(raw[4]), volume: parseFloat(raw[5]) };
  }
  if (exchange === 'Bitget') {
    return { open: parseFloat(raw[1]), high: parseFloat(raw[2]), low: parseFloat(raw[3]), close: parseFloat(raw[4]), volume: parseFloat(raw[5]) };
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
  const errors = [];
  for (const ex of EXCHANGES) {
    try {
      let url;
      if (ex.name === 'Binance') {
        url = `${API_BASE}/api/v3/klines?symbol=${ticker}&interval=${timeframe}&limit=${limit || 1000}`;
        if (startTime) url += `&startTime=${startTime}`;
        if (endTime) url += `&endTime=${endTime}`;
      } else if (ex.name === 'OKX') {
        url = `https://www.okx.com/api/v5/market/candles?instId=${ticker}-USDT&bar=${tfMapOkx(timeframe)}&limit=${limit || 300}`;
        if (startTime) url += `&before=${startTime}`;
      } else if (ex.name === 'MEXC') {
        url = `https://api.mexc.com/api/v3/klines?symbol=${ticker}&interval=${timeframe}&limit=${limit || 1000}`;
        if (startTime) url += `&startTime=${startTime}`;
      } else if (ex.name === 'Bitget') {
        url = `https://api.bitget.com/api/v2/market/candles?symbol=${ticker}USDT&granularity=${tfMapBitget(timeframe)}&limit=${limit || 1000}&productType=USDT-FUTURES`;
        if (startTime) url += `&startTime=${startTime}`;
      }
      const res = await axios.get(url, { timeout: 15000 });
      const data = Array.isArray(res.data) ? res.data : res.data.data;
      if (!data || !data.length) continue;
      const candles = data.map(r => parseCandle(r, ex.name)).filter(Boolean);
      if (candles.length < 2) continue;
      return { exchange: ex.name, data: ex.name === 'OKX' ? candles.reverse() : candles };
    } catch (e) {
      errors.push(`${ex.name}: ${e.message}`);
    }
  }
  throw new Error(`Range fetch failed: ${errors.join('; ')}`);
}

module.exports = {
  VALID_TIMEFRAMES,
  fetchCandles,
  fetchKlines,
  fetchKlinesRange,
  tfToMinutes,
};
