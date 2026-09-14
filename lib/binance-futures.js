const Binance = require('binance-api-node').default;
const { getFeatConfig } = require('./db');

let client = null;

function getClient() {
  if (client) return client;

  const apiKey = process.env.BINANCE_API_KEY;
  const apiSecret = process.env.BINANCE_API_SECRET;

  if (!apiKey || !apiSecret) {
    throw new Error('BINANCE_API_KEY/BINANCE_API_SECRET belum di-set di .env');
  }

  const testnet = getFeatConfig('rsi', 'testnet', '1') === '1';

  client = Binance({
    apiKey,
    apiSecret,
    testnet,
  });

  return client;
}

function invalidate() {
  client = null;
}

function isConfigured() {
  return !!(process.env.BINANCE_API_KEY && process.env.BINANCE_API_SECRET);
}

function getInfo() {
  const testnet = getFeatConfig('rsi', 'testnet', '1') === '1';
  return {
    configured: isConfigured(),
    testnet,
    baseUrl: testnet ? 'https://demo-fapi.binance.com' : 'https://fapi.binance.com',
  };
}

async function setLeverage(symbol, leverage) {
  const c = getClient();
  try {
    await c.futuresLeverage({ symbol, leverage });
  } catch (e) {
    const msg = e?.body?.msg || e?.message || '';
    if (msg.includes('-4046') || msg.includes('leverage not modified')) {
      console.warn('[BINANCE] leverage already set:', symbol, leverage);
      return;
    }
    console.error('[BINANCE]', e.message);
    throw new Error('Binance: ' + (e?.body?.msg || e?.message));
  }
}

async function setMarginType(symbol, marginType = 'ISOLATED') {
  const c = getClient();
  const mt = String(marginType || 'ISOLATED').toUpperCase() === 'CROSS' ? 'CROSS' : 'ISOLATED';
  try {
    await c.futuresMarginType({ symbol, marginType: mt });
  } catch (e) {
    const msg = e?.body?.msg || e?.message || '';
    if (msg.includes('-4006') || msg.includes('margin type not modified')) {
      console.warn('[BINANCE] margin type already set:', symbol, mt);
      return;
    }
    console.error('[BINANCE]', e.message);
    throw new Error('Binance: ' + (e?.body?.msg || e?.message));
  }
}

async function openMarket(symbol, side, qty) {
  const c = getClient();
  try {
    return await c.futuresOrder({ symbol, side, type: 'MARKET', quantity: qty });
  } catch (e) {
    console.error('[BINANCE]', e.message);
    throw new Error('Binance: ' + (e?.body?.msg || e?.message));
  }
}

async function closeMarket(symbol, side, qty) {
  const c = getClient();
  try {
    return await c.futuresOrder({ symbol, side, type: 'MARKET', quantity: qty, reduceOnly: true });
  } catch (e) {
    console.error('[BINANCE]', e.message);
    throw new Error('Binance: ' + (e?.body?.msg || e?.message));
  }
}

async function getPositions(symbol) {
  const c = getClient();
  try {
    const params = symbol ? { symbol } : {};
    const positions = await c.futuresPositionRisk(params);
    return positions.filter(p => parseFloat(p.positionAmt) !== 0);
  } catch (e) {
    console.error('[BINANCE]', e.message);
    throw new Error('Binance: ' + (e?.body?.msg || e?.message));
  }
}

async function getBalance() {
  const c = getClient();
  try {
    return await c.futuresAccountBalance();
  } catch (e) {
    console.error('[BINANCE]', e.message);
    throw new Error('Binance: ' + (e?.body?.msg || e?.message));
  }
}

async function getRealizedPnl(symbol, limit = 100) {
  const c = getClient();
  try {
    const params = { incomeType: 'REALIZED_PNL', limit };
    if (symbol) params.symbol = symbol;
    const income = await c.futuresIncome(params);
    return income.reduce((sum, item) => sum + parseFloat(item.income), 0);
  } catch (e) {
    console.error('[BINANCE]', e.message);
    throw new Error('Binance: ' + (e?.body?.msg || e?.message));
  }
}

async function getUnrealizedPnl() {
  const positions = await getPositions();
  return positions.reduce((sum, p) => sum + parseFloat(p.unRealizedProfit || 0), 0);
}

module.exports = {
  isConfigured,
  getInfo,
  invalidate,
  setLeverage,
  setMarginType,
  openMarket,
  closeMarket,
  getPositions,
  getBalance,
  getRealizedPnl,
  getUnrealizedPnl,
};