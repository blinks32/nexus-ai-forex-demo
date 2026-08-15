'use strict';

const { emaSeries, rsiLast } = require('./indicators');

const PAIRS = [
  { symbol: 'EURUSD', base: 1.08420, pip: 0.0001, vol: 0.000045, contract: 100000, digits: 5, name: 'Euro / US Dollar' },
  { symbol: 'GBPUSD', base: 1.27180, pip: 0.0001, vol: 0.000050, contract: 100000, digits: 5, name: 'Pound / US Dollar' },
  { symbol: 'USDJPY', base: 154.620, pip: 0.01,   vol: 0.0050,    contract: 100000, digits: 3, name: 'US Dollar / Yen' },
  { symbol: 'XAUUSD', base: 2412.50, pip: 0.10,   vol: 0.35,      contract: 100,    digits: 2, name: 'Gold / US Dollar' },
];

const CANDLE_SECONDS = 60;
const TICK_SECONDS = 0.25;
const HISTORY_CANDLES = 150;
const MAX_POSITIONS = 3;
const RISK_PER_TRADE = 0.004;
const SL_PIPS = 15;
const TP_PIPS = 26;
const MAX_POSITION_SECONDS = 420;
const LEVERAGE = 100;
const START_BALANCE = 10000;

class Market {
  constructor() {
    this.pairs = {};
    for (const def of PAIRS) {
      const p = {
        def,
        price: def.base,
        prevPrice: def.base,
        high: def.base,
        low: def.base,
        open: def.base,
        bias: (Math.random() - 0.5) * def.vol * 2,
        vol: def.vol,
        regimeTicksLeft: 0,
        newsImpulse: 0,
        newsTicksLeft: 0,
        candles: [],
        tickAccum: 0,
        ema9: [], ema21: [], rsi: [],
        prevEma9: null, prevEma21: null,
      };
      this.pairs[def.symbol] = p;
      this.seedCandles(p);
    }
  }

  seedCandles(p) {
    const now = Math.floor(Date.now() / 1000) - HISTORY_CANDLES * CANDLE_SECONDS;
    let t = now, o = p.price;
    for (let i = 0; i < HISTORY_CANDLES; i++) {
      const oo = o;
      const c = oo + this.step(p, 1);
      const h = Math.max(oo, c) + Math.random() * p.def.vol;
      const l = Math.min(oo, c) - Math.random() * p.def.vol;
      p.candles.push({ t, o: oo, h, l, c });
      o = c;
      p.high = Math.max(p.high, c); p.low = Math.min(p.low, c);
      t += CANDLE_SECONDS;
    }
    p.price = o;
    this.computeIndicators(p);
  }

  step(p, ticks) {
    if (p.regimeTicksLeft <= 0) {
      p.bias = (Math.random() - 0.5) * p.vol * 3;
      p.regimeTicksLeft = 60 + Math.floor(Math.random() * 90);
    }
    p.regimeTicksLeft -= ticks;
    let move = p.bias * ticks + (Math.random() - 0.5) * p.vol * 2 * Math.sqrt(ticks);
    if (p.newsTicksLeft > 0) {
      move += p.newsImpulse;
      p.newsTicksLeft -= ticks;
      if (p.newsTicksLeft <= 0) p.newsImpulse = 0;
    }
    return move;
  }

  tickAll(dtTicks) {
    for (const sym in this.pairs) {
      const p = this.pairs[sym];
      const move = this.step(p, dtTicks);
      p.prevPrice = p.price;
      p.price += move;
      p.high = Math.max(p.high, p.price);
      p.low = Math.min(p.low, p.price);
      const last = p.candles[p.candles.length - 1];
      last.c = p.price;
      if (p.price > last.h) last.h = p.price;
      if (p.price < last.l) last.l = p.price;
      p.tickAccum += TICK_SECONDS * dtTicks;
      if (p.tickAccum >= CANDLE_SECONDS) {
        p.tickAccum = 0;
        p.candles.push({ t: last.t + CANDLE_SECONDS, o: p.price, h: p.price, l: p.price, c: p.price });
        if (p.candles.length > HISTORY_CANDLES) p.candles.shift();
      }
      this.computeIndicators(p);
    }
  }

  computeIndicators(p) {
    const closes = p.candles.map(c => c.c);
    p.prevEma9 = p.ema9.length ? p.ema9[p.ema9.length - 1] : null;
    p.prevEma21 = p.ema21.length ? p.ema21[p.ema21.length - 1] : null;
    p.ema9 = emaSeries(closes, 9);
    p.ema21 = emaSeries(closes, 21);
    p.rsi = rsiLast(closes);
  }

  currentCandle(sym) {
    const p = this.pairs[sym];
    const last = p.candles[p.candles.length - 1];
    return { t: last.t, o: last.o, h: last.h, l: last.l, c: last.c };
  }

  triggerNews(pair) {
    const p = this.pairs[pair];
    const dir = Math.random() < 0.5 ? -1 : 1;
    const strength = 6 + Math.random() * 14;
    p.newsImpulse = dir * p.def.pip * strength * 0.15;
    p.newsTicksLeft = 14;
    const impact = strength > 14 ? 'HIGH' : strength > 9 ? 'MEDIUM' : 'LOW';
    const headlines = [
      `ECB rate decision surprises markets — ${pair} volatile`,
      `NFP data beats consensus — ${pair} reacts sharply`,
      `Central bank intervention suspected in ${pair}`,
      `Geopolitical tensions spike — safe-haven flows into ${pair}`,
      `Strong CPI print — ${pair} moves on rate expectations`,
      `Flash crash rumors — liquidity thin in ${pair}`,
    ];
    return {
      id: Date.now(),
      time: new Date().toISOString(),
      pair,
      impact,
      headline: headlines[Math.floor(Math.random() * headlines.length)],
    };
  }
}

class Bot {
  constructor(market) {
    this.market = market;
    this.account = { balance: START_BALANCE, currency: 'USD' };
    this.positions = [];
    this.history = [];
    this.log = [];
    this.stats = { trades: 0, wins: 0, losses: 0, grossProfit: 0, grossLoss: 0, best: 0, worst: 0 };
    this.paused = false;
    this.speed = 1;
    this.riskHoldUntil = 0;
    this.tradeId = 1;
    this.lastSignal = {};
  }

  logLine(msg) {
    this.log.push({ t: Date.now(), msg });
    if (this.log.length > 60) this.log.shift();
  }

  signalFor(p) {
    if (p.prevPrice === undefined || !p.ema9.length || !p.ema21.length) return null;
    const e9 = p.ema9[p.ema9.length - 1], e21 = p.ema21[p.ema21.length - 1];
    const crossedUp = p.prevPrice <= p.prevEma9 && p.price > e9;
    const crossedDown = p.prevPrice >= p.prevEma9 && p.price < e9;
    if (crossedUp && e9 > e21 && p.rsi > 35 && p.rsi < 68) return 'BUY';
    if (crossedDown && e9 < e21 && p.rsi > 32 && p.rsi < 65) return 'SELL';
    return null;
  }

  profitUSD(pos, price) {
    const p = this.market.pairs[pos.symbol];
    const raw = pos.side === 'BUY' ? (price - pos.open) : (pos.open - price);
    let usd = raw * pos.lots * p.def.contract;
    if (pos.symbol === 'USDJPY') usd = usd / price;
    return usd;
  }

  floatingPL() {
    let sum = 0;
    for (const pos of this.positions) {
      const p = this.market.pairs[pos.symbol];
      sum += this.profitUSD(pos, p.price);
    }
    return sum;
  }

  marginUsed() {
    let sum = 0;
    for (const pos of this.positions) {
      const p = this.market.pairs[pos.symbol];
      sum += pos.open * pos.lots * p.def.contract / LEVERAGE;
    }
    return sum;
  }

  evaluate() {
    const now = Date.now();
    if (this.paused) return;

    for (const sym in this.market.pairs) {
      const p = this.market.pairs[sym];
      const sig = this.signalFor(p);
      const last = this.lastSignal[sym] || 0;
      if (sig && now - last > 12000 && now > this.riskHoldUntil) {
        this.lastSignal[sym] = now;
        this.tryOpen(sym, sig);
      }
    }

    for (let i = this.positions.length - 1; i >= 0; i--) {
      const pos = this.positions[i];
      const p = this.market.pairs[pos.symbol];
      const price = p.price;
      let closePrice = null, reason = null;
      if (pos.side === 'BUY') {
        if (price <= pos.sl) { closePrice = pos.sl; reason = 'SL'; }
        else if (price >= pos.tp) { closePrice = pos.tp; reason = 'TP'; }
      } else {
        if (price >= pos.sl) { closePrice = pos.sl; reason = 'SL'; }
        else if (price <= pos.tp) { closePrice = pos.tp; reason = 'TP'; }
      }
      if (!closePrice && now - pos.openedAt > MAX_POSITION_SECONDS * 1000) {
        closePrice = price; reason = 'TIMEOUT';
      }
      if (closePrice !== null) this.closePosition(i, closePrice, reason);
    }
  }

  tryOpen(sym, side) {
    if (this.positions.length >= MAX_POSITIONS) return;
    if (this.positions.some(x => x.symbol === sym)) return;
    const p = this.market.pairs[sym];
    const equity = this.account.balance + this.floatingPL();
    const riskUSD = equity * RISK_PER_TRADE;
    const slDist = SL_PIPS * p.def.pip;
    const lotsUSD = side === 'BUY'
      ? riskUSD / (slDist * p.def.contract)
      : riskUSD / (slDist * p.def.contract);
    let lots = Math.max(0.01, Math.floor(lotsUSD * 100) / 100);
    lots = Math.min(lots, 1.0);
    const entry = p.price;
    const pos = {
      id: this.tradeId++,
      symbol: sym, side, lots,
      open: entry,
      sl: side === 'BUY' ? entry - slDist : entry + slDist,
      tp: side === 'BUY' ? entry + TP_PIPS * p.def.pip : entry - TP_PIPS * p.def.pip,
      openedAt: Date.now(),
      closePrice: null, profit: null, pips: null, reason: null, closedAt: null,
    };
    this.positions.push(pos);
    const rsi = p.rsi.toFixed(1);
    const reason = side === 'BUY'
      ? `price broke above EMA9, EMA aligned, RSI ${rsi} — momentum long`
      : `price broke below EMA9, EMA aligned, RSI ${rsi} — momentum short`;
    this.logLine(`${side} ${lots.toFixed(2)} ${sym} @ ${entry.toFixed(p.def.digits)} — ${reason}`);
  }

  closePosition(idx, price, reason) {
    const pos = this.positions[idx];
    const profit = this.profitUSD(pos, price);
    const p = this.market.pairs[pos.symbol];
    const pips = (pos.side === 'BUY' ? price - pos.open : pos.open - price) / p.def.pip;
    pos.closePrice = price;
    pos.profit = profit;
    pos.pips = pips;
    pos.reason = reason;
    pos.closedAt = Date.now();
    this.account.balance += profit;
    this.stats.trades++;
    if (profit >= 0) this.stats.wins++; else this.stats.losses++;
    if (profit > 0) this.stats.grossProfit += profit; else this.stats.grossLoss += -profit;
    if (profit > this.stats.best) this.stats.best = profit;
    if (profit < this.stats.worst) this.stats.worst = profit;
    const icon = profit >= 0 ? '+' : '';
    this.logLine(`CLOSED ${pos.side} ${pos.lots.toFixed(2)} ${pos.symbol} @ ${price.toFixed(p.def.digits)} — ${reason} | P/L ${icon}${profit.toFixed(2)} USD (${pips >= 0 ? '+' : ''}${pips.toFixed(1)} pips)`);
    this.positions.splice(idx, 1);
    this.history.unshift(pos);
    if (this.history.length > 60) this.history.pop();
    return pos;
  }

  snapshot() {
    const floating = this.floatingPL();
    const margin = this.marginUsed();
    const equity = this.account.balance + floating;
    const s = this.stats;
    const ticker = {};
    for (const sym in this.market.pairs) {
      const p = this.market.pairs[sym];
      const dayChange = p.open ? ((p.price - p.open) / p.open) * 100 : 0;
      const sp = p.def.vol * 2.5;
      ticker[sym] = {
        bid: p.price, ask: p.price + sp,
        spread: sp / p.def.pip,
        changePct: dayChange,
        high: p.high, low: p.low,
      };
    }
    return {
      meta: {
        serverTime: Date.now(),
        botName: 'NEXUS-AI · v3.2',
        status: this.paused ? 'PAUSED' : 'ACTIVE',
        speed: this.speed,
        accountNo: 'DEMO-887341',
        broker: 'NexusFX Demo · mt5',
      },
      account: {
        balance: this.account.balance,
        equity,
        floatingPL: floating,
        margin,
        freeMargin: equity - margin,
        marginLevel: margin > 0 ? (equity / margin) * 100 : 0,
        currency: this.account.currency,
      },
      stats: {
        trades: s.trades,
        wins: s.wins,
        losses: s.losses,
        winRate: s.trades ? (s.wins / s.trades) * 100 : 0,
        profitFactor: s.grossLoss > 0 ? s.grossProfit / s.grossLoss : s.grossProfit > 0 ? Infinity : 0,
        grossProfit: s.grossProfit,
        grossLoss: s.grossLoss,
        best: s.best,
        worst: s.worst,
      },
      positions: this.positions.map(pos => {
        const p = this.market.pairs[pos.symbol];
        const profit = this.profitUSD(pos, p.price);
        return {
          id: pos.id, symbol: pos.symbol, side: pos.side, lots: pos.lots,
          open: pos.open, current: p.price, sl: pos.sl, tp: pos.tp,
          profit, pips: (pos.side === 'BUY' ? p.price - pos.open : pos.open - p.price) / p.def.pip,
          openTime: pos.openedAt,
        };
      }),
      history: this.history.map(h => ({
        id: h.id, symbol: h.symbol, side: h.side, lots: h.lots,
        open: h.open, close: h.closePrice, profit: h.profit, pips: h.pips,
        reason: h.reason, openTime: h.openedAt, closeTime: h.closedAt,
        durationSec: Math.round((h.closedAt - h.openedAt) / 1000),
      })),
      ticker,
      botLog: this.log,
    };
  }
}

class Engine {
  constructor() {
    this.market = new Market();
    this.bot = new Bot(this.market);
    this.live = null;
    this.news = null;
    this.nextNewsAt = Date.now() + 25000 + Math.random() * 60000;
    this.tickClock = 0;
    this.lastSnap = this.bot.snapshot();
    setInterval(() => this.tick(), 250);
  }

  async init() {
    if (process.env.METAAPI_TOKEN && process.env.METAAPI_ACCOUNT_ID) {
      const { MetaTraderAdapter } = require('./metaapi');
      const adapter = new MetaTraderAdapter(this.bot);
      try {
        await withTimeout(adapter.start(), 120000);
        if (!adapter.ready) throw new Error('adapter did not become ready');
        this.live = adapter;
        this.lastSnap = this.live.snapshot();
      } catch (err) {
        this.bot.logLine(`MetaApi connection failed (${err.message}) — continuing in simulation mode`);
        this.live = null;
      }
    } else {
      this.bot.logLine('Simulation mode — set METAAPI_TOKEN + METAAPI_ACCOUNT_ID env vars to trade a real MT demo account');
    }
  }

  tick() {
    if (this.live) {
      if (this.bot.paused) return;
      this.live.onTick();
      this.lastSnap = this.live.snapshot();
      return;
    }
    const bot = this.bot;
    if (bot.paused) {
      bot.lastSignal = {};
      return;
    }
    const dt = bot.speed;
    this.market.tickAll(dt);
    bot.evaluate();
    if (Date.now() > this.nextNewsAt) {
      const pair = PAIRS[Math.floor(Math.random() * PAIRS.length)].symbol;
      this.news = this.market.triggerNews(pair);
      bot.riskHoldUntil = Date.now() + 8000;
      bot.logLine(`NEWS EVENT [${this.news.impact}] ${this.news.headline} — risk filter engaged (8s)`);
      this.nextNewsAt = Date.now() + 60000 + Math.random() * 90000;
    }
    this.lastSnap = bot.snapshot();
  }

  control(action, value) {
    switch (action) {
      case 'pause': this.bot.paused = true; break;
      case 'resume': this.bot.paused = false; break;
      case 'speed': if (!this.live) this.bot.speed = Math.max(1, Math.min(4, value || 1)); break;
    }
    this.bot.logLine(this.bot.paused
      ? 'BOT PAUSED by operator — positions held, entries blocked'
      : this.live ? 'BOT RESUMED — live trading enabled'
      : `BOT RESUMED — speed ${this.bot.speed}x`);
  }

  snapshot() {
    if (this.live) return this.live.snapshot();
    return this.bot.snapshot();
  }

  candlesSnapshot() {
    if (this.live) {
      const out = {};
      for (const sym of this.live.symbols) {
        if (this.live.candles[sym]) out[sym] = this.live.candles[sym].map(c => [c.t, c.o, c.h, c.l, c.c]);
      }
      return out;
    }
    const out = {};
    for (const sym in this.market.pairs) {
      const p = this.market.pairs[sym];
      out[sym] = p.candles.map(c => [c.t, c.o, c.h, c.l, c.c]);
    }
    return out;
  }
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

module.exports = { Engine, PAIRS };