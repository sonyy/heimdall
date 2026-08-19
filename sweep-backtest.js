const { getConfig, getFeatConfig, getTfConfig, loadPairsFor } = require('./lib/db');
const { fetchKlinesRange, tfToMinutes } = require('./lib/exchange');
const { ATR } = require('technicalindicators');

function calcSupertrend(candles, period, multiplier) {
  const high = candles.map(c => c.high);
  const low = candles.map(c => c.low);
  const close = candles.map(c => c.close);
  const atrValues = ATR.calculate({ high, low, close, period });
  const hl2 = high.map((h, i) => (h + low[i]) / 2);
  const atrOffset = close.length - atrValues.length;
  let finalUpperBand = 0, finalLowerBand = 0, direction = 1, prevDirection = 1;
  for (let i = atrOffset; i < close.length; i++) {
    const atr = atrValues[i - atrOffset];
    const basicUpperBand = hl2[i] + multiplier * atr;
    const basicLowerBand = hl2[i] - multiplier * atr;
    if (i === atrOffset) {
      finalUpperBand = basicUpperBand;
      finalLowerBand = basicLowerBand;
      direction = close[i] > hl2[i] ? 1 : -1;
    } else {
      prevDirection = direction;
      finalUpperBand = (basicUpperBand < finalUpperBand || close[i - 1] > finalUpperBand) ? basicUpperBand : finalUpperBand;
      finalLowerBand = (basicLowerBand > finalLowerBand || close[i - 1] < finalLowerBand) ? basicLowerBand : finalLowerBand;
      direction = direction === 1 ? (close[i] > finalLowerBand ? 1 : -1) : (close[i] < finalUpperBand ? -1 : 1);
    }
  }
  return { isBullish: direction === 1, wasBullish: prevDirection === 1 };
}

function calcPnl(direction, entry, close, leverage, feePct) {
  const raw = direction === 'LONG' ? ((close - entry) / entry) * 100 : ((entry - close) / entry) * 100;
  return raw * (leverage || 1) - (feePct || 0.05);
}

function calcLiqPrice(direction, entry, leverage) {
  const liqGap = entry / (leverage || 1);
  return direction === 'LONG' ? entry - liqGap : entry + liqGap;
}

async function main() {
  const ticker = 'BTCUSDT';
  const tf = '1h';
  const globalPeriod = Number(getConfig('supertrendPeriod', '10'));
  const globalMultiplier = Number(getConfig('supertrendMultiplier', '3'));
  const tfCfg = getTfConfig(tf, globalPeriod, globalMultiplier);
  const leverage = Number(getFeatConfig('bt', 'leverage_' + ticker, '10'));
  const startDate = getFeatConfig('bt', 'startDate', '2026-01-01');
  const endDate = getFeatConfig('bt', 'endDate', '2026-07-18');

  console.log(`Fetching klines for ${ticker} ${tf} (${startDate} → ${endDate})...`);
  const startTs = new Date(startDate).getTime();
  const endTs = new Date(endDate).getTime() + 86400000;
  const candleLimit = Math.min(Math.ceil((endTs - startTs) / (60000 * tfToMinutes(tf))), 200000) + 200;
  const result = await fetchKlinesRange(ticker, tf, startTs, endTs, candleLimit);
  const data = result.data;
  if (!data || !data.length) { console.error('No kline data!'); process.exit(1); }
  console.log(`Got ${data.length} candles`);

  const btPairs = loadPairsFor('bt_pairs');
  const guardTfs = (btPairs[ticker] || []).filter(g => g !== tf);
  const guardSignals = {};

  for (const g of guardTfs) {
    console.log(`Pre-computing ST for guard TF ${g}...`);
    const gCfg = getTfConfig(g, globalPeriod, globalMultiplier);
    const gResult = await fetchKlinesRange(ticker, g, startTs, endTs, candleLimit);
    if (!gResult.data || !gResult.data.length) continue;
    const gData = gResult.data;
    const gPeriod = gCfg.period;
    const signals = [];
    for (let j = gPeriod; j < gData.length; j++) {
      const st = calcSupertrend(gData.slice(0, j + 1), gPeriod, gCfg.multiplier);
      signals.push({ isBullish: st?.isBullish ?? false, openTime: gData[j].openTime });
    }
    guardSignals[g] = signals;
  }

  console.log('Pre-computing main TF ST...');
  const period = tfCfg.period;
  const mainSignals = [];
  for (let idx = period; idx < data.length; idx++) {
    const st = calcSupertrend(data.slice(0, idx + 1), period, tfCfg.multiplier);
    mainSignals.push({
      isBullish: st?.isBullish ?? false,
      wasBullish: st?.wasBullish ?? false,
      price: data[idx].close,
      low: data[idx].low,
      high: data[idx].high,
      openTime: data[idx].openTime || 0,
    });
  }

  const SL_VALS = [-20, -40, -60, -80, -100];
  const TP_VALS = [10, 20, 40, 80, 120, 160];
  const START_CAPITAL = 1000;

  const combos = [];
  for (const sl of SL_VALS) {
    for (const tp of TP_VALS) {
      for (const mode of ['fixed', 'percent']) {
        const amounts = mode === 'fixed' ? [50, 100, 200, 300, 500] : [5, 10, 20, 30, 50];
        for (const amt of amounts) {
          combos.push({ sl, tp, mode, amount: amt });
        }
      }
    }
  }

  console.log(`Running ${combos.length} parameter combinations...`);
  const t0 = Date.now();
  const results = [];

  for (const c of combos) {
    const isCompound = c.mode === 'percent';
    const getMargin = (cap) => isCompound ? cap * (c.amount / 100) : c.amount;
    let capital = START_CAPITAL;
    let openTrade = null;
    const trades = [];
    const gIdx = {};
    guardTfs.forEach(g => { gIdx[g] = 0; });
    let prevBullish = null;

    for (const sig of mainSignals) {
      let aligned = true;
      for (const g of guardTfs) {
        const sigs = guardSignals[g];
        if (!sigs?.length) continue;
        while (gIdx[g] + 1 < sigs.length && sigs[gIdx[g] + 1].openTime <= sig.openTime) gIdx[g]++;
        if (!sigs[gIdx[g]]?.isBullish) { aligned = false; break; }
      }

      const nowBullish = sig.isBullish && aligned;

      if ((isCompound ? capital > 0 : capital >= c.amount) && prevBullish !== null && !prevBullish && nowBullish && !openTrade) {
        const sl = sig.price * (1 + (c.sl / leverage) / 100);
        const tp1 = sig.price * (1 + (c.tp / leverage) / 100);
        openTrade = { entry: sig.price, sl, tp1, direction: 'LONG', marginSize: getMargin(capital) };
      }

      if ((isCompound ? capital > 0 : capital >= c.amount) && prevBullish !== null && prevBullish && !sig.isBullish && aligned && !openTrade) {
        const sl = sig.price * (1 - (c.sl / leverage) / 100);
        const tp1 = sig.price * (1 - (c.tp / leverage) / 100);
        openTrade = { entry: sig.price, sl, tp1, direction: 'SHORT', marginSize: getMargin(capital) };
      }

      if (openTrade) {
        const liq = calcLiqPrice(openTrade.direction, openTrade.entry, leverage);
        const m = openTrade.marginSize;
        let closed = false;

        if (openTrade.direction === 'LONG' && sig.low <= liq) {
          trades.push({ pnl: -100, marginSize: m }); capital += -m; closed = true;
        } else if (openTrade.direction === 'SHORT' && sig.high >= liq) {
          trades.push({ pnl: -100, marginSize: m }); capital += -m; closed = true;
        } else if (openTrade.direction === 'LONG') {
          if (sig.low <= openTrade.sl) {
            const pnl = calcPnl('LONG', openTrade.entry, openTrade.sl, leverage);
            trades.push({ pnl, marginSize: m }); capital += (pnl / 100) * m; closed = true;
          } else if (sig.high >= openTrade.tp1) {
            const pnl = calcPnl('LONG', openTrade.entry, openTrade.tp1, leverage);
            trades.push({ pnl, marginSize: m }); capital += (pnl / 100) * m; closed = true;
          }
        } else {
          if (sig.high >= openTrade.sl) {
            const pnl = calcPnl('SHORT', openTrade.entry, openTrade.sl, leverage);
            trades.push({ pnl, marginSize: m }); capital += (pnl / 100) * m; closed = true;
          } else if (sig.low <= openTrade.tp1) {
            const pnl = calcPnl('SHORT', openTrade.entry, openTrade.tp1, leverage);
            trades.push({ pnl, marginSize: m }); capital += (pnl / 100) * m; closed = true;
          }
        }
        if (closed) openTrade = null;
      }
      prevBullish = nowBullish;
    }

    if (openTrade) {
      const lastPrice = data[data.length - 1].close;
      const liq = calcLiqPrice(openTrade.direction, openTrade.entry, leverage);
      const liquidated = (openTrade.direction === 'LONG' && lastPrice <= liq) || (openTrade.direction === 'SHORT' && lastPrice >= liq);
      const pnl = liquidated ? -100 : calcPnl(openTrade.direction, openTrade.entry, lastPrice, leverage);
      const m = openTrade.marginSize;
      trades.push({ pnl, marginSize: m });
      capital += (pnl / 100) * m;
    }

    const totalTrades = trades.length;
    const wins = trades.filter(t => t.pnl > 0).length;
    const loses = trades.filter(t => t.pnl <= 0).length;
    const totalPnlPct = trades.reduce((s, t) => s + t.pnl, 0);
    const totalPnlUsdt = trades.reduce((s, t) => s + (t.pnl / 100) * t.marginSize, 0);
    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
    const avgPnl = totalTrades > 0 ? totalPnlPct / totalTrades : 0;
    const maxWin = wins ? Math.max(...trades.filter(t => t.pnl > 0).map(t => t.pnl)) : 0;
    const maxLose = loses ? Math.min(...trades.filter(t => t.pnl <= 0).map(t => t.pnl)) : 0;

    results.push({
      ...c, totalTrades, wins, loses,
      winRate: winRate.toFixed(1),
      totalPnlPct: totalPnlPct.toFixed(2),
      totalPnlUsdt: totalPnlUsdt.toFixed(2),
      avgPnl: avgPnl.toFixed(2),
      maxWin: maxWin.toFixed(2),
      maxLose: maxLose.toFixed(2),
      endCapital: capital.toFixed(2),
      capitalReturn: ((capital - START_CAPITAL) / START_CAPITAL * 100).toFixed(2),
    });

    if (results.length % 50 === 0) {
      const el = ((Date.now() - t0) / 1000).toFixed(1);
      process.stdout.write(`  ${results.length}/${combos.length} (${el}s)\n`);
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsed}s\n`);

  const W = 145;
  const hdr = 'Rank  SL%   TP%   Mode    Amt     Trades W/L     WR%    AvgPnL%  TotalPnL%  TotalPnL$  EndCap$    Ret%     MaxW%   MaxL%';
  const sep = '='.repeat(W);

  results.sort((a, b) => parseFloat(b.totalPnlUsdt) - parseFloat(a.totalPnlUsdt));
  console.log(sep);
  console.log('TOP 30 MOST PROFITABLE (by Total PnL USDT)');
  console.log(sep);
  console.log(hdr);
  console.log('-'.repeat(W));
  for (let i = 0; i < Math.min(30, results.length); i++) {
    const r = results[i];
    const a = r.mode === 'fixed' ? '$' + r.amount : r.amount + '%';
    console.log(`${String(i+1).padEnd(5)}${(r.sl+'%').padEnd(6)}${(r.tp+'%').padEnd(6)}${r.mode.padEnd(8)}${a.padEnd(8)}${String(r.totalTrades).padEnd(7)}${(r.wins+'/'+r.loses).padEnd(8)}${(r.winRate+'%').padEnd(7)}${(r.avgPnl+'%').padEnd(9)}${(r.totalPnlPct+'%').padEnd(11)}${('$'+r.totalPnlUsdt).padEnd(11)}${('$'+r.endCapital).padEnd(11)}${(r.capitalReturn+'%').padEnd(9)}${(r.maxWin+'%').padEnd(8)}${(r.maxLose+'%').padEnd(8)}`);
  }

  const wr = results.filter(r => r.totalTrades >= 10).sort((a, b) => parseFloat(b.winRate) - parseFloat(a.winRate) || parseFloat(b.totalPnlUsdt) - parseFloat(a.totalPnlUsdt));
  console.log('\n' + sep);
  console.log('TOP 30 BY WIN RATE (min 10 trades)');
  console.log(sep);
  console.log(hdr);
  console.log('-'.repeat(W));
  for (let i = 0; i < Math.min(30, wr.length); i++) {
    const r = wr[i];
    const a = r.mode === 'fixed' ? '$' + r.amount : r.amount + '%';
    console.log(`${String(i+1).padEnd(5)}${(r.sl+'%').padEnd(6)}${(r.tp+'%').padEnd(6)}${r.mode.padEnd(8)}${a.padEnd(8)}${String(r.totalTrades).padEnd(7)}${(r.wins+'/'+r.loses).padEnd(8)}${(r.winRate+'%').padEnd(7)}${(r.avgPnl+'%').padEnd(9)}${(r.totalPnlPct+'%').padEnd(11)}${('$'+r.totalPnlUsdt).padEnd(11)}${('$'+r.endCapital).padEnd(11)}${(r.capitalReturn+'%').padEnd(9)}${(r.maxWin+'%').padEnd(8)}${(r.maxLose+'%').padEnd(8)}`);
  }

  const avg = results.filter(r => r.totalTrades >= 10).sort((a, b) => parseFloat(b.avgPnl) - parseFloat(a.avgPnl));
  console.log('\n' + sep);
  console.log('TOP 30 BY AVG PNL (min 10 trades)');
  console.log(sep);
  console.log(hdr);
  console.log('-'.repeat(W));
  for (let i = 0; i < Math.min(30, avg.length); i++) {
    const r = avg[i];
    const a = r.mode === 'fixed' ? '$' + r.amount : r.amount + '%';
    console.log(`${String(i+1).padEnd(5)}${(r.sl+'%').padEnd(6)}${(r.tp+'%').padEnd(6)}${r.mode.padEnd(8)}${a.padEnd(8)}${String(r.totalTrades).padEnd(7)}${(r.wins+'/'+r.loses).padEnd(8)}${(r.winRate+'%').padEnd(7)}${(r.avgPnl+'%').padEnd(9)}${(r.totalPnlPct+'%').padEnd(11)}${('$'+r.totalPnlUsdt).padEnd(11)}${('$'+r.endCapital).padEnd(11)}${(r.capitalReturn+'%').padEnd(9)}${(r.maxWin+'%').padEnd(8)}${(r.maxLose+'%').padEnd(8)}`);
  }

  const noT = results.filter(r => r.totalTrades === 0).length;
  const profitable = results.filter(r => parseFloat(r.totalPnlUsdt) > 0).length;
  const losers = results.filter(r => parseFloat(r.totalPnlUsdt) < 0).length;
  console.log(`\nSummary: ${results.length} combos | ${profitable} profitable | ${losers} losers | ${noT} no trades`);
  if (results[0]) console.log(`Best $:  SL${results[0].sl}% TP${results[0].tp}% ${results[0].mode} ${results[0].mode==='fixed'?'$'+results[0].amount:results[0].amount+'%'} → $${results[0].totalPnlUsdt} (${results[0].capitalReturn}%) [${results[0].totalTrades}T ${results[0].winRate}%WR]`);
  if (wr[0]) console.log(`Best WR: SL${wr[0].sl}% TP${wr[0].tp}% ${wr[0].mode} ${wr[0].mode==='fixed'?'$'+wr[0].amount:wr[0].amount+'%'} → ${wr[0].winRate}% WR, $${wr[0].totalPnlUsdt}`);
  if (avg[0]) console.log(`Best Avg: SL${avg[0].sl}% TP${avg[0].tp}% ${avg[0].mode} ${avg[0].mode==='fixed'?'$'+avg[0].amount:avg[0].amount+'%'} → Avg ${avg[0].avgPnl}%, $${avg[0].totalPnlUsdt}`);
}

main().catch(e => { console.error(e); process.exit(1); });
