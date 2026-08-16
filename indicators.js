'use strict';

// Pure indicator helpers shared by the simulation engine and the live MT adapter.

const SL_PIPS = 15;
const TP_PIPS = 26;

function emaSeries(closes, period) {
  const k = 2 / (period + 1);
  const out = [];
  let e = closes[0];
  out.push(e);
  for (let i = 1; i < closes.length; i++) {
    e = closes[i] * k + e * (1 - k);
    out.push(e);
  }
  return out;
}

function rsiLast(closes) {
  let avgG = null, avgL = null;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    if (avgG === null) { avgG = g; avgL = l; }
    else { avgG = (avgG * 13 + g) / 14; avgL = (avgL * 13 + l) / 14; }
  }
  if (avgG === null) return 50;
  return avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
}

function buildDecision(sym, e9, e21, rsi, price, pip) {
  const spreadPips = Math.abs(e9 - e21) / pip;
  let side = null, reason = '', momentum = 0;
  if (e9 > e21 && rsi < 85) {
    side = 'BUY';
    momentum = Math.max(0, rsi - 50);
    reason = `EMA9 (${e9.toFixed(5)}) above EMA21 (${e21.toFixed(5)}) — bullish alignment with RSI ${rsi.toFixed(1)} confirming upside momentum.`;
  } else if (e9 < e21 && rsi > 15) {
    side = 'SELL';
    momentum = Math.max(0, 50 - rsi);
    reason = `EMA9 (${e9.toFixed(5)}) below EMA21 (${e21.toFixed(5)}) — bearish alignment with RSI ${rsi.toFixed(1)} confirming downside momentum.`;
  } else {
    return null;
  }
  const conf = Math.round(Math.min(96, 55 + Math.min(22, spreadPips * 0.9) + Math.min(15, momentum * 0.4)));
  return {
    id: 'd' + Date.now(),
    time: Date.now(),
    symbol: sym,
    side,
    confidence: conf,
    reason,
    riskPct: 1,
    slPips: SL_PIPS,
    tpPips: TP_PIPS,
    entry: price,
  };
}

module.exports = { emaSeries, rsiLast, buildDecision };