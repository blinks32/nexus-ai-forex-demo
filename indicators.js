'use strict';

// Pure indicator helpers shared by the simulation engine and the live MT adapter.

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

module.exports = { emaSeries, rsiLast };