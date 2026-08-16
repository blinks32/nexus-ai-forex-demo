'use strict';

// Live MetaTrader (MT4/MT5) adapter via MetaApi cloud SDK.
// Requires env vars: METAAPI_TOKEN, METAAPI_ACCOUNT_ID.
// Uses streaming connection when possible, falls back to RPC polling.

const SDK = require('metaapi.cloud-sdk');
const MetaApi = SDK.default || SDK.MetaApi;
const { emaSeries, rsiLast, buildDecision } = require('./indicators');

const SYMBOLS = ['EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD'];
const FALLBACK_PIP = { EURUSD: 0.0001, GBPUSD: 0.0001, USDJPY: 0.01, XAUUSD: 0.1 };
const FALLBACK_CONTRACT = { EURUSD: 100000, GBPUSD: 100000, USDJPY: 100000, XAUUSD: 100 };
const CANDLE_SECONDS = 60;
const HISTORY_CANDLES = 150;
const SL_PIPS = 15;
const TP_PIPS = 26;
const MAX_POSITIONS = 3;
const MIN_LOTS = 0.01;
const MAX_LOTS = 0.1;
const SIGNAL_COOLDOWN_MS = 12000;

class MetaTraderAdapter {
  constructor(bot) {
    this.bot = bot;
    this.ready = false;
    this.mode = null;
    this.api = null;
    this.mtAccount = null;
    this.conn = null;
    this.historyConn = null;
    this.symbols = [];
    this.candles = {};
    this.prevPrice = {};
    this.ema9 = {};
    this.ema21 = {};
    this.rsi = {};
    this.lastSignal = {};
    this.accountInfo = null;
    this.posMap = {};          // sdk position id -> dashboard position
    this.closedIds = new Set();
    this.history = [];
    this.lastDealTime = Date.now() - 60000;
    this.tickCounter = 0;
    this.sessionOpen = {};
    this.sessionHigh = {};
    this.sessionLow = {};
    this.errorStreak = 0;
  }

  logLine(msg) { this.bot.logLine(msg); }

  async start() {
    const token = process.env.METAAPI_TOKEN;
    const accountId = process.env.METAAPI_ACCOUNT_ID;
    this.api = new MetaApi(token);
    this.mtAccount = await this.api.metatraderAccountApi.getAccount(accountId);
    this.logLine('MetaApi: waiting for MetaTrader terminal to connect to broker…');
    await withTimeout(this.mtAccount.waitConnected(), 90000);

    try {
      this.conn = this.mtAccount.getStreamingConnection();
      await withTimeout(this.conn.connect(), 60000);
      await withTimeout(this.conn.waitSynchronized(), 60000);
      this.mode = 'streaming';
    } catch (err) {
      this.logLine(`streaming unavailable (${err.message}), using RPC mode`);
      this.conn = this.mtAccount.getRPCConnection();
      await withTimeout(this.conn.connect(), 60000);
      await withTimeout(this.conn.waitSynchronized(), 60000);
      this.mode = 'rpc';
    }

    const specs = (this.conn.terminalState && this.conn.terminalState.specifications) || {};
    this.symbols = SYMBOLS.filter(s => !Object.keys(specs).length || specs[s]);
    if (!this.symbols.length) this.symbols = SYMBOLS;
    this.logLine(`MetaApi ${this.mode.toUpperCase()} connection established for ${this.mtAccount.name} (${this.mtAccount.server})`);

    if (this.mode === 'streaming') {
      for (const s of this.symbols) {
        try { await this.conn.subscribeToMarketData(s); } catch (e) { /* ignore */ }
      }
    }

    await this.seedHistory();
    this.accountInfo = await this.readAccountInfo();
    const login = this.accountInfo && this.accountInfo.login;
    this.logLine(`LIVE MODE ACTIVE — MetaTrader demo account ${login || accountId}, symbols: ${this.symbols.join(', ')}`);

    for (const s of this.symbols) {
      const px = this.priceOf(s);
      if (px) {
        this.sessionOpen[s] = px.bid;
        this.sessionHigh[s] = px.bid;
        this.sessionLow[s] = px.bid;
      }
    }
    this.ready = true;
  }

  async seedHistory() {
    try {
      this.historyConn = this.mtAccount.getRPCConnection();
      await withTimeout(this.historyConn.connect(), 30000);
      await withTimeout(this.historyConn.waitSynchronized(), 30000);
      for (const s of this.symbols) {
        try {
          const candles = await this.historyConn.getCandles(s, '1m', Date.now() - HISTORY_CANDLES * CANDLE_SECONDS * 1000, HISTORY_CANDLES);
          if (candles && candles.length) {
            this.candles[s] = candles.map(c => ({ t: c.time, o: c.open, h: c.high, l: c.low, c: c.close }));
            this.computeIndicators(s);
          }
        } catch (e) { /* candle history unavailable, build from quotes */ }
      }
    } catch (e) {
      this.historyConn = null;
    }
  }

  /* ---------- reads ---------- */

  priceOf(sym) {
    if (!this.conn) return null;
    if (this.mode === 'streaming') {
      const px = this.conn.terminalState.price(sym);
      if (!px) return null;
      const time = typeof px.time === 'string' ? Date.parse(px.time) : px.time;
      return { bid: px.bid, ask: px.ask, time };
    }
    return (this.rpcPrices && this.rpcPrices[sym]) || null;
  }

  specOf(sym) {
    try {
      if (this.mode === 'streaming') {
        const spec = this.conn.terminalState.specification(sym);
        if (spec) return { pip: spec.pipSize, contract: spec.contractSize };
      }
      if (this.specs) { const s = this.specs[sym]; if (s) return { pip: s.pipSize, contract: s.contractSize }; }
    } catch (e) { /* ignore */ }
    return { pip: FALLBACK_PIP[sym], contract: FALLBACK_CONTRACT[sym] };
  }

  async readAccountInfo() {
    try {
      if (this.mode === 'streaming') {
        const info = this.conn.terminalState.accountInformation;
        if (info) return info;
      }
      return await this.conn.getAccountInformation();
    } catch (e) { return null; }
  }

  async readPositions() {
    try {
      if (this.mode === 'streaming') {
        const ps = this.conn.terminalState.positions;
        if (ps) return ps;
      }
      return await this.conn.getPositions();
    } catch (e) { return []; }
  }

  async pollRpcPrices() {
    const out = {};
    for (const s of this.symbols) {
      try {
        const px = await this.conn.getSymbolPrice(s);
        if (px) out[s] = { bid: px.bid, ask: px.ask, time: Date.now() };
      } catch (e) { /* ignore */ }
    }
    this.rpcPrices = out;
  }

  /* ---------- candles & indicators ---------- */

  updateCandle(sym, px) {
    if (!this.candles[sym]) this.candles[sym] = [];
    const arr = this.candles[sym];
    const bucket = Math.floor(px.time / (CANDLE_SECONDS * 1000));
    if (!arr.length) {
      arr.push({ t: bucket * CANDLE_SECONDS * 1000, o: px.bid, h: px.bid, l: px.bid, c: px.bid });
    }
    const last = arr[arr.length - 1];
    const lastBucket = Math.floor(last.t / (CANDLE_SECONDS * 1000));
    if (bucket > lastBucket) {
      arr.push({ t: bucket * CANDLE_SECONDS * 1000, o: px.bid, h: px.bid, l: px.bid, c: px.bid });
      if (arr.length > HISTORY_CANDLES) arr.shift();
    } else {
      last.c = px.bid;
      if (px.bid > last.h) last.h = px.bid;
      if (px.bid < last.l) last.l = px.bid;
    }
    this.computeIndicators(sym);
  }

  computeIndicators(sym) {
    const arr = this.candles[sym];
    if (!arr || arr.length < 22) return;
    const closes = arr.map(c => c.c);
    this.prevPrice[sym] = this.prevPrice[sym] !== undefined ? this.prevPrice[sym] : closes[closes.length - 2];
    const e9 = emaSeries(closes, 9);
    const e21 = emaSeries(closes, 21);
    this.ema9[sym] = e9[e9.length - 1];
    this.ema21[sym] = e21[e21.length - 1];
    this.rsi[sym] = rsiLast(closes);
  }

  /* ---------- tick loop ---------- */

  async onTick() {
    if (!this.ready) return;
    this.tickCounter++;
    try {
      if (this.mode === 'rpc') {
        if (this.tickCounter % 4 === 0) await this.pollRpcPrices();
        if (this.tickCounter % 40 === 0) {
          this.accountInfo = await this.readAccountInfo();
          await this.syncPositions(await this.readPositions());
          await this.fetchNewDeals();
        }
      } else {
        if (this.tickCounter % 40 === 0) {
          this.accountInfo = this.conn.terminalState.accountInformation || this.accountInfo;
          await this.syncPositions(this.conn.terminalState.positions || []);
          await this.fetchNewDeals();
        }
      }
      this.processQuotes();
      this.evaluateSignals();
      this.errorStreak = 0;
    } catch (err) {
      this.errorStreak++;
      if (this.errorStreak === 1 || this.errorStreak % 120 === 0) {
        this.logLine(`MetaApi error: ${err.message} (streak ${this.errorStreak})`);
      }
    }
  }

  processQuotes() {
    for (const s of this.symbols) {
      const px = this.priceOf(s);
      if (!px || px.bid === undefined) continue;
      const prev = this.prevPrice[s];
      if (prev !== undefined && prev === px.bid) continue;
      this.prevPrice[s] = px.bid;
      this.updateCandle(s, px);
      if (this.sessionHigh[s] === undefined) {
        this.sessionOpen[s] = px.bid; this.sessionHigh[s] = px.bid; this.sessionLow[s] = px.bid;
      } else {
        if (px.bid > this.sessionHigh[s]) this.sessionHigh[s] = px.bid;
        if (px.bid < this.sessionLow[s]) this.sessionLow[s] = px.bid;
      }
    }
  }

  evaluateSignals() {
    if (this.bot.paused) return;
    const now = Date.now();
    for (const s of this.symbols) {
      if (this.ema9[s] === undefined) continue;
      const px = this.priceOf(s);
      if (!px) continue;
      const prev = this.prevPrice[s];
      const e9 = this.ema9[s], e21 = this.ema21[s];
      const crossedUp = prev <= this.ema9Prev(s) && px.bid > e9;
      const crossedDown = prev >= this.ema9Prev(s) && px.bid < e9;
      const last = this.lastSignal[s] || 0;
      if (crossedUp && e9 > e21 && this.rsi[s] > 35 && this.rsi[s] < 68 && now - last > SIGNAL_COOLDOWN_MS) {
        this.lastSignal[s] = now;
        this.tryOpen(s, 'BUY', px);
      } else if (crossedDown && e9 < e21 && this.rsi[s] > 32 && this.rsi[s] < 65 && now - last > SIGNAL_COOLDOWN_MS) {
        this.lastSignal[s] = now;
        this.tryOpen(s, 'SELL', px);
      }
    }
  }

  ema9Prev(s) {
    const arr = this.candles[s];
    if (!arr || arr.length < 23) return this.prevPrice[s];
    const closes = arr.map(c => c.c);
    const e9 = emaSeries(closes.slice(0, -1), 9);
    return e9[e9.length - 1];
  }

  decide() {
    let best = null;
    for (const s of this.symbols) {
      if (this.ema9[s] === undefined) continue;
      const px = this.priceOf(s);
      if (!px) continue;
      const { pip } = this.specOf(s);
      const d = buildDecision(s, this.ema9[s], this.ema21[s], this.rsi[s], px.bid, pip);
      if (d && (!best || d.confidence > best.confidence)) best = d;
    }
    return best;
  }

  async tryOpen(sym, side, px) {
    try {
      const open = this.posMap;
      const count = Object.values(open).filter(p => p.symbol === sym).length;
      if (count >= 1 || Object.keys(open).length >= MAX_POSITIONS) return;
      const { pip, contract } = this.specOf(sym);
      const equity = this.accountInfo ? (this.accountInfo.equity || 0) : 0;
      if (!equity || equity <= 0) return;
      const pipValue = pip * contract;
      const risk = equity * 0.002;
      let lots = Math.round((risk / (SL_PIPS * pipValue)) * 100) / 100;
      lots = Math.max(MIN_LOTS, Math.min(MAX_LOTS, lots));
      const entry = side === 'BUY' ? px.ask : px.bid;
      const sl = side === 'BUY' ? entry - SL_PIPS * pip : entry + SL_PIPS * pip;
      const tp = side === 'BUY' ? entry + TP_PIPS * pip : entry - TP_PIPS * pip;
      const result = side === 'BUY'
        ? await this.conn.createMarketBuyOrder(sym, lots, sl, tp, { comment: 'NEXUS-AI' })
        : await this.conn.createMarketSellOrder(sym, lots, sl, tp, { comment: 'NEXUS-AI' });
      const rsi = this.rsi[sym] !== undefined ? this.rsi[sym].toFixed(1) : '?';
      if (result && result.stringCode === 'TRADE_RETCODE_DONE') {
        this.logLine(`${side} ${lots.toFixed(2)} ${sym} @ ${entry.toFixed(5)} — real order sent, SL ${sl.toFixed(5)} TP ${tp.toFixed(5)} (RSI ${rsi})`);
      } else {
        this.logLine(`${side} ${sym} rejected: ${result ? result.stringCode : 'no result'}`);
      }
    } catch (err) {
      this.logLine(`${side} ${sym} order error: ${err.message}`);
    }
  }

  async syncPositions(sdkPositions) {
    const current = {};
    for (const p of sdkPositions || []) {
      const isBuy = p.type === 'POSITION_TYPE_BUY';
      current[p.id] = {
        id: p.id,
        symbol: p.symbol,
        side: isBuy ? 'BUY' : 'SELL',
        lots: p.volume,
        open: p.openPrice,
        current: p.currentPrice,
        sl: p.stopLoss,
        tp: p.takeProfit,
        profit: p.profit,
        pips: ((isBuy ? p.currentPrice - p.openPrice : p.openPrice - p.currentPrice) / this.specOf(p.symbol).pip),
        openTime: p.time,
      };
    }
    const removedIds = Object.keys(this.posMap).filter(id => !current[id]);
    for (const id of removedIds) {
      const was = this.posMap[id];
      if (was && !this.closedIds.has(id)) {
        this.closedIds.add(id);
        this.logLine(`POSITION CLOSED ${was.side} ${was.lots.toFixed(2)} ${was.symbol} #${id}`);
      }
    }
    this.posMap = current;
  }

  async fetchNewDeals() {
    if (!this.historyConn) return;
    try {
      const since = this.lastDealTime;
      let deals;
      try { deals = await this.historyConn.getDeals(0, since, Date.now()); }
      catch (e) { deals = await this.historyConn.getDeals(since, Date.now()); }
      if (!deals || !deals.length) return;
      for (const d of deals) {
        if (d.time > this.lastDealTime) this.lastDealTime = d.time;
        const isOut = d.entry === 'DEAL_ENTRY_OUT';
        if (!isOut) continue;
        const pip = this.specOf(d.symbol).pip;
        const pips = d.price && d.positionId && this.posMap[d.positionId]
          ? ((d.type === 'DEAL_TYPE_BUY' ? d.price - this.posMap[d.positionId].open : this.posMap[d.positionId].open - d.price) / pip)
          : 0;
        const pos = this.posMap[d.positionId];
        const entry = pos ? pos.open : d.price;
        const side = d.type === 'DEAL_TYPE_BUY' ? 'BUY' : 'SELL';
        const closePips = ((side === 'BUY' ? d.price - entry : entry - d.price) / pip);
        const reason = pos && pos.sl !== undefined && pos.tp !== undefined
          ? (side === 'BUY' ? (d.price <= pos.sl ? 'SL' : d.price >= pos.tp ? 'TP' : 'EXIT') : (d.price >= pos.sl ? 'SL' : d.price <= pos.tp ? 'TP' : 'EXIT'))
          : 'EXIT';
        this.history.unshift({
          id: d.id,
          symbol: d.symbol,
          side,
          lots: d.volume,
          open: entry,
          close: d.price,
          profit: d.profit,
          pips: closePips,
          reason,
          openTime: pos ? pos.openTime : d.time,
          closeTime: d.time,
          durationSec: pos ? Math.max(0, Math.round((d.time - pos.openTime) / 1000)) : 0,
        });
        if (this.history.length > 60) this.history.pop();
        const icon = d.profit >= 0 ? '+' : '';
        this.logLine(`TRADE CLOSED ${side} ${d.volume.toFixed(2)} ${d.symbol} @ ${d.price} — ${reason} | P/L ${icon}${d.profit.toFixed(2)} USD (${closePips >= 0 ? '+' : ''}${closePips.toFixed(1)} pips)`);
      }
      this.lastDealTime = Math.max(...deals.map(d => d.time), this.lastDealTime);
    } catch (e) { /* ignore */ }
  }

  /* ---------- snapshot ---------- */

  stats() {
    const s = { trades: 0, wins: 0, losses: 0, grossProfit: 0, grossLoss: 0, best: 0, worst: 0 };
    for (const h of this.history) {
      s.trades++;
      if (h.profit >= 0) { s.wins++; s.grossProfit += h.profit; if (h.profit > s.best) s.best = h.profit; }
      else { s.losses++; s.grossLoss += -h.profit; if (h.profit < s.worst) s.worst = h.profit; }
    }
    return {
      trades: s.trades,
      wins: s.wins,
      losses: s.losses,
      winRate: s.trades ? (s.wins / s.trades) * 100 : 0,
      profitFactor: s.grossLoss > 0 ? s.grossProfit / s.grossLoss : s.grossProfit > 0 ? Infinity : 0,
      grossProfit: s.grossProfit,
      grossLoss: s.grossLoss,
      best: s.best,
      worst: s.worst,
    };
  }

  snapshot() {
    const info = this.accountInfo || {};
    const positions = Object.values(this.posMap);
    const floating = positions.reduce((a, p) => a + (p.profit || 0), 0);
    const ticker = {};
    for (const s of this.symbols) {
      const px = this.priceOf(s);
      const { pip } = this.specOf(s);
      if (px) {
        ticker[s] = {
          bid: px.bid,
          ask: px.ask,
          spread: (px.ask - px.bid) / pip,
          changePct: this.sessionOpen[s] ? ((px.bid - this.sessionOpen[s]) / this.sessionOpen[s]) * 100 : 0,
          high: this.sessionHigh[s] !== undefined ? this.sessionHigh[s] : px.bid,
          low: this.sessionLow[s] !== undefined ? this.sessionLow[s] : px.bid,
        };
      }
    }
    return {
      meta: {
        serverTime: Date.now(),
        botName: 'NEXUS-AI · LIVE MT',
        status: this.bot.paused ? 'PAUSED' : 'ACTIVE',
        speed: 1,
        accountNo: String(info.login || process.env.METAAPI_ACCOUNT_ID || ''),
        broker: `${this.mtAccount.name} · ${this.mtAccount.server}`,
        adapter: 'live',
      },
      account: {
        balance: info.balance || 0,
        equity: info.equity || 0,
        floatingPL: floating,
        margin: info.margin || 0,
        freeMargin: info.freeMargin || 0,
        marginLevel: info.marginLevel || 0,
        currency: info.currency || 'USD',
      },
      stats: this.stats(),
      positions,
      history: this.history,
      ticker,
      botLog: this.bot.log,
    };
  }
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

module.exports = { MetaTraderAdapter };