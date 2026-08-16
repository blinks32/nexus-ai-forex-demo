'use strict';

const $ = id => document.getElementById(id);
let viewerId = localStorage.getItem('vp_viewer_id');
if (!viewerId) {
  viewerId = 'v_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  localStorage.setItem('vp_viewer_id', viewerId);
}
const fmt = (n, d = 2) => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtUSD = n => (n >= 0 ? '+' : '') + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = n => (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
const fmtTime = t => new Date(t).toLocaleTimeString('en-GB');
const fmtDur = s => {
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
};

const PAIR_META = {
  EURUSD: { digits: 5, pip: 0.0001, name: 'Euro / US Dollar' },
  GBPUSD: { digits: 5, pip: 0.0001, name: 'Pound / US Dollar' },
  USDJPY: { digits: 3, pip: 0.01, name: 'US Dollar / Yen' },
  XAUUSD: { digits: 2, pip: 0.1, name: 'Gold Spot / USD' },
};

const state = {
  pair: 'EURUSD',
  candles: {},          // symbol -> [{t,o,h,l,c}]
  snap: null,
  prevPrices: {},
  lastNewsId: 0,
  connOk: false,
  decisionId: null,
  viewerId,
};

/* ---------------- SSE ---------------- */
const es = new EventSource('/stream');

es.addEventListener('init', e => {
  const data = JSON.parse(e.data);
  for (const sym in data.candles) {
    state.candles[sym] = data.candles[sym].map(c => ({ t: c[0], o: c[1], h: c[2], l: c[3], c: c[4] }));
  }
  applySnap(data.snap);
  if (data.news) showNews(data.news);
  setConn(true);
  buildTicker(data.snap.ticker);
  buildTabs(data.snap.ticker);
  renderAll();
});

es.addEventListener('snap', e => {
  const data = JSON.parse(e.data);
  applySnap(data.snap);
  if (data.news && data.news.id !== state.lastNewsId) showNews(data.news);
});

es.onopen = () => setConn(true);
es.onerror = () => setConn(false);

/* ---------------- state updates ---------------- */
function applySnap(snap) {
  state.snap = snap;
  for (const sym in snap.ticker) {
    const c = snap.ticker[sym];
    if (state.candles[sym] && state.candles[sym].length) {
      const last = state.candles[sym][state.candles[sym].length - 1];
      last.c = c.bid; last.h = Math.max(last.h, c.bid); last.l = Math.min(last.l, c.bid);
    }
    const prev = state.prevPrices[sym];
    state.prevPrices[sym] = c.bid;
    if (prev !== undefined && prev !== c.bid) {
      const el = $(`tick-price-${sym}`);
      if (el) {
        el.classList.remove('flash-up', 'flash-down');
        void el.offsetWidth;
        el.classList.add(c.bid > prev ? 'flash-up' : 'flash-down');
      }
    }
  }
  updatePanels(snap);
  renderAll();
}

function updatePanels(snap) {
  const a = snap.account;
  $('a-balance').textContent = fmt(a.balance) + ' USD';
  $('a-equity').textContent = fmt(a.equity) + ' USD';
  const pl = $('a-pl');
  pl.textContent = fmtUSD(a.floatingPL) + ' USD';
  pl.className = 'acct-value mono ' + (a.floatingPL >= 0 ? 'pos' : 'neg');
  $('a-margin').textContent = fmt(a.margin) + ' USD';
  $('a-free').textContent = fmt(a.freeMargin) + ' USD';
  const lvl = $('a-level');
  lvl.textContent = fmt(a.marginLevel, 0) + '%';
  lvl.className = 'acct-value mono ' + (a.marginLevel < 150 ? 'neg' : a.marginLevel < 300 ? '' : 'pos');
  $('margin-bar').style.width = Math.min(100, a.marginLevel / 5) + '%';

  const s = snap.stats;
  $('s-trades').textContent = s.trades;
  $('s-wl').textContent = s.wins + ' / ' + s.losses;
  $('s-winrate').textContent = s.trades ? fmt(s.winRate, 1) + '%' : '—';
  $('s-pf').textContent = s.profitFactor === Infinity ? '∞' : fmt(s.profitFactor, 2);
  $('s-gp').textContent = fmt(s.grossProfit, 2);
  $('s-gl').textContent = fmt(s.grossLoss, 2);
  $('s-best').textContent = fmtUSD(s.best);
  $('s-worst').textContent = fmtUSD(s.worst);

  $('account-no').textContent = snap.meta.accountNo;
  $('broker').textContent = snap.meta.broker;
  $('bot-version').textContent = snap.meta.botName;
  const isLive = snap.meta.adapter === 'live';
  const badge = $('mode-badge');
  badge.textContent = isLive ? 'LIVE MT' : 'DEMO';
  badge.className = 'badge ' + (isLive ? 'live' : 'demo');
  const slider = $('speed-slider');
  slider.disabled = isLive;
  slider.style.opacity = isLive ? 0.35 : 1;
  $('speed-val').textContent = isLive ? 'LIVE' : snap.meta.speed + 'x';
  $('foot-mode').textContent = isLive
    ? 'NEXUS-AI connected to a real MetaTrader DEMO account via MetaApi — prices and orders are live, funds are virtual.'
    : 'NEXUS-AI simulated demo engine — no real funds involved.';
  const btn = $('btn-pause');
  const paused = snap.meta.status === 'PAUSED';
  btn.textContent = paused ? 'RESUME' : 'PAUSE';
  btn.classList.toggle('paused', paused);

  renderTicker(snap.ticker);
  renderPositions(snap.positions);
  renderHistory(snap.history);
  renderLog(snap.botLog);
  renderDecision(snap.decision);
}

/* ---------------- AI decision + copy ---------------- */
function renderDecision(d) {
  const body = $('decision-body');
  const age = $('decision-age');
  if (!d) {
    body.innerHTML = '<div class="decision-waiting">Scanning all pairs for the strongest setup…</div>';
    age.textContent = 'analyzing…';
    state.decisionId = null;
    return;
  }
  const ageSec = Math.max(0, Math.round((Date.now() - d.time) / 1000));
  age.textContent = ageSec + 's ago';
  if (state.decisionId === d.id) return;
  state.decisionId = d.id;
  const sym = d.symbol.replace('/', '');
  const sideCls = d.side.toLowerCase();
  const copied = copiedDecisions.has(d.id);
  body.innerHTML = `
    <div class="decision-line">
      <span class="decision-side ${sideCls}">${d.side}</span>
      <span class="decision-symbol mono">${sym.slice(0, 3)}/${sym.slice(3)}</span>
      <span class="decision-entry mono">@ ${d.entry.toFixed(PAIR_META[sym] ? PAIR_META[sym].digits : 5)}</span>
    </div>
    <div class="decision-conf-row">
      <span class="muted">Confidence</span>
      <span class="mono"><b>${d.confidence}%</b></span>
    </div>
    <div class="conf-bar"><div class="conf-fill ${sideCls}" style="width:${d.confidence}%"></div></div>
    <div class="decision-reason">${d.reason}</div>
    <div class="decision-chips">
      <span class="chip">RISK ${d.riskPct}%</span>
      <span class="chip">SL ${d.slPips} pips</span>
      <span class="chip">TP ${d.tpPips} pips</span>
    </div>
    <button id="btn-copy" class="btn btn-copy ${copied ? 'copied' : ''}" ${copied ? 'disabled' : ''}>
      ${copied ? '✓ COPIED' : 'COPY AI TRADE'}
    </button>
    <div id="copy-msg" class="copy-msg"></div>`;
  const btn = $('btn-copy');
  if (btn && !copied) btn.addEventListener('click', doCopy);
}

const copiedDecisions = new Set(JSON.parse(localStorage.getItem('vp_copied') || '[]'));

function persistCopied() {
  localStorage.setItem('vp_copied', JSON.stringify(Array.from(copiedDecisions)));
}

async function doCopy() {
  const btn = $('btn-copy');
  const msg = $('copy-msg');
  btn.disabled = true;
  btn.textContent = 'COPYING…';
  try {
    const res = await fetch('/api/copy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ viewerId: state.viewerId, decisionId: state.decisionId }),
    });
    const data = await res.json();
    if (!res.ok) {
      msg.className = 'copy-msg neg';
      msg.textContent = data.error || 'Copy failed';
      btn.disabled = false;
      btn.textContent = 'COPY AI TRADE';
      return;
    }
    copiedDecisions.add(state.decisionId);
    persistCopied();
    const pos = data.portfolio.positions[data.portfolio.positions.length - 1];
    msg.className = 'copy-msg pos';
    msg.textContent = `Copied! ${pos.side} ${pos.symbol} ${pos.lots} lots @ ${pos.entry.toFixed(5)} in your virtual account.`;
    btn.textContent = '✓ COPIED';
    renderPortfolio(data.portfolio);
  } catch (e) {
    msg.className = 'copy-msg neg';
    msg.textContent = 'Copy failed — check connection';
    btn.disabled = false;
    btn.textContent = 'COPY AI TRADE';
  }
}

/* ---------------- virtual portfolio ---------------- */
async function pollPortfolio() {
  try {
    const res = await fetch('/api/portfolio?viewer=' + encodeURIComponent(state.viewerId));
    if (res.ok) renderPortfolio(await res.json());
  } catch (e) { /* ignore */ }
}

function renderPortfolio(vp) {
  $('vp-balance').textContent = fmt(vp.balance, 2) + ' USD';
  const eq = $('vp-equity');
  eq.textContent = 'Equity ' + fmt(vp.equity, 2) + ' USD';
  const fl = $('vp-floating');
  fl.textContent = fmtUSD(vp.floatingPL) + ' USD';
  fl.className = 'mono ' + (vp.floatingPL >= 0 ? 'pos' : 'neg');
  $('vp-count').textContent = vp.positions.length;
  const tb = document.querySelector('#vp-table tbody');
  tb.innerHTML = '';
  if (!vp.positions.length) {
    tb.innerHTML = '<tr><td colspan="10" class="muted" style="text-align:center;padding:18px">No copied trades yet — press COPY AI TRADE when a decision appears.</td></tr>';
    return;
  }
  for (const p of vp.positions) {
    const d = PAIR_META[p.symbol].digits;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><b>${p.symbol}</b></td>
      <td><span class="pill-side ${p.side}">${p.side}</span></td>
      <td>${fmt(p.lots, 2)}</td>
      <td>${fmt(p.entry, d)}</td>
      <td class="${p.profit >= 0 ? 'pos' : 'neg'}">${fmt(p.current, d)}</td>
      <td class="muted">${fmt(p.sl, d)}</td>
      <td class="muted">${fmt(p.tp, d)}</td>
      <td class="${p.profit >= 0 ? 'pos' : 'neg'}"><b>${fmtUSD(p.profit)}</b></td>
      <td class="muted">${fmtDur((Date.now() - p.openTime) / 1000)}</td>
      <td><button class="btn btn-mini" data-close="${p.id}">CLOSE</button></td>`;
    tb.appendChild(tr);
  }
  tb.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => closeVirtual(b.dataset.close)));
}

async function closeVirtual(positionId) {
  try {
    const res = await fetch('/api/portfolio/close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ viewerId: state.viewerId, positionId }),
    });
    if (res.ok) renderPortfolio((await res.json()).portfolio);
  } catch (e) { /* ignore */ }
}

setInterval(pollPortfolio, 2000);

/* ---------------- ticker ---------------- */
function buildTicker(snapTicker) {
  const el = $('ticker');
  el.innerHTML = '';
  const syms = snapTicker ? Object.keys(snapTicker) : Object.keys(PAIR_META);
  if (!syms.length) syms.push('EURUSD');
  for (const sym of syms) {
    if (!PAIR_META[sym]) continue;
    const d = document.createElement('div');
    d.className = 'tick-card' + (sym === state.pair ? ' active' : '');
    d.dataset.sym = sym;
    d.innerHTML = `
      <div>
        <div class="tick-sym">${sym}</div>
        <div class="tick-sub">${PAIR_META[sym].name}</div>
        <div class="tick-hl">H <span id="tick-high-${sym}">—</span> · L <span id="tick-low-${sym}">—</span></div>
      </div>
      <div style="text-align:right">
        <div class="tick-price" id="tick-price-${sym}">—</div>
        <div class="tick-delta" id="tick-delta-${sym}">—</div>
      </div>`;
    d.addEventListener('click', () => selectPair(sym));
    el.appendChild(d);
  }
}

function renderTicker(ticker) {
  for (const sym in ticker) {
    const t = ticker[sym];
    const digits = PAIR_META[sym].digits;
    $('tick-price-' + sym).textContent = fmt(t.bid, digits);
    const d = $('tick-delta-' + sym);
    d.textContent = fmtPct(t.changePct);
    d.className = 'tick-delta ' + (t.changePct >= 0 ? 'pos' : 'neg');
    $('tick-high-' + sym).textContent = fmt(t.high, digits);
    $('tick-low-' + sym).textContent = fmt(t.low, digits);
  }
}

function buildTabs(snapTicker) {
  const el = $('pair-tabs');
  el.innerHTML = '';
  const syms = snapTicker ? Object.keys(snapTicker) : Object.keys(PAIR_META);
  if (!syms.length) syms.push('EURUSD');
  for (const sym of syms) {
    if (!PAIR_META[sym]) continue;
    const b = document.createElement('button');
    b.className = 'pair-tab' + (sym === state.pair ? ' active' : '');
    b.textContent = sym;
    b.addEventListener('click', () => selectPair(sym));
    el.appendChild(b);
  }
}

function selectPair(sym) {
  state.pair = sym;
  document.querySelectorAll('.tick-card').forEach(c => c.classList.toggle('active', c.dataset.sym === sym));
  document.querySelectorAll('.pair-tab').forEach(t => t.classList.toggle('active', t.textContent === sym));
  $('pair-name').textContent = PAIR_META[sym].name;
  renderChart();
}

/* ---------------- chart ---------------- */
const canvas = $('chart');
const ctx = canvas.getContext('2d');
const tip = $('chart-tip');
let crossX = null, crossY = null;

function resizeChart() {
  const wrap = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = wrap.clientWidth * dpr;
  canvas.height = wrap.clientHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', () => { resizeChart(); renderChart(); });

function emaSeries(arr, period) {
  const k = 2 / (period + 1);
  const out = [];
  let e = arr[0];
  out.push(e);
  for (let i = 1; i < arr.length; i++) { e = arr[i] * k + e * (1 - k); out.push(e); }
  return out;
}

function renderChart() {
  const W = canvas.width / (window.devicePixelRatio || 1);
  const H = canvas.height / (window.devicePixelRatio || 1);
  if (!W || !H) return;
  ctx.clearRect(0, 0, W, H);

  const candles = state.candles[state.pair] || [];
  if (!candles.length) return;
  const meta = PAIR_META[state.pair];

  const padL = 8, padR = 70, padT = 14, padB = 22;
  const step = 8, cw = 5.5;
  const plotW = W - padL - padR;
  const visible = Math.max(10, Math.floor(plotW / step));
  const start = Math.max(0, candles.length - visible);
  const view = candles.slice(start);

  const ema9 = emaSeries(view.map(c => c.c), 9);
  const ema21 = emaSeries(view.map(c => c.c), 21);

  let lo = Infinity, hi = -Infinity;
  for (const c of view) { lo = Math.min(lo, c.l); hi = Math.max(hi, c.h); }
  for (const v of ema9) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  for (const v of ema21) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const padPx = (hi - lo) * 0.06 || 0.001;
  lo -= padPx; hi += padPx;
  const y = price => padT + (hi - price) / (hi - lo) * (H - padT - padB);
  const x = i => padL + i * step + step / 2;

  // grid + price labels
  ctx.font = '10px Cascadia Mono, Consolas, monospace';
  ctx.lineWidth = 1;
  const rows = 6;
  for (let r = 0; r <= rows; r++) {
    const price = hi - (hi - lo) * r / rows;
    const yy = y(price);
    ctx.strokeStyle = 'rgba(28,41,66,.55)';
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(W - padR, yy); ctx.stroke();
    ctx.fillStyle = '#6b7a99';
    ctx.textAlign = 'left';
    ctx.fillText(price.toFixed(meta.digits), W - padR + 6, yy + 3);
  }
  // vertical time grid
  ctx.fillStyle = '#3d4f73';
  ctx.textAlign = 'center';
  const every = Math.max(1, Math.floor(visible / 6));
  for (let i = 0; i < view.length; i += every) {
    const xx = x(i);
    ctx.strokeStyle = 'rgba(28,41,66,.3)';
    ctx.beginPath(); ctx.moveTo(xx, padT); ctx.lineTo(xx, H - padB); ctx.stroke();
    ctx.fillText(fmtTime(view[i].t), xx, H - 8);
  }

  // candles
  for (let i = 0; i < view.length; i++) {
    const c = view[i];
    const up = c.c >= c.o;
    const color = up ? '#26d07c' : '#ff4d5e';
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1;
    const xx = x(i);
    ctx.beginPath(); ctx.moveTo(xx, y(c.h)); ctx.lineTo(xx, y(c.l)); ctx.stroke();
    const yo = y(c.o), yc = y(c.c);
    const bodyTop = Math.min(yo, yc), bodyH = Math.max(1, Math.abs(yo - yc));
    ctx.fillRect(xx - cw / 2, bodyTop, cw, bodyH);
  }

  // EMA lines
  ctx.lineWidth = 1.4;
  const plotLine = (arr, color) => {
    ctx.strokeStyle = color;
    ctx.beginPath();
    for (let i = 0; i < arr.length; i++) {
      const px = x(i), py = y(arr[i]);
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.stroke();
  };
  plotLine(ema9, 'rgba(45,212,247,.9)');
  plotLine(ema21, 'rgba(192,132,252,.9)');

  // trade markers from open positions + history on this pair
  const snap = state.snap;
  if (snap) {
    const placeMark = (openTime, entry, side) => {
      const found = view.findIndex(c => c.t >= openTime);
      if (found < 0) return;
      const yy = y(entry);
      const xx = x(found);
      ctx.fillStyle = side === 'BUY' ? '#26d07c' : '#ff4d5e';
      ctx.beginPath();
      if (side === 'BUY') {
        ctx.moveTo(xx, yy + 5); ctx.lineTo(xx - 4, yy - 1); ctx.lineTo(xx + 4, yy - 1);
      } else {
        ctx.moveTo(xx, yy - 5); ctx.lineTo(xx - 4, yy + 1); ctx.lineTo(xx + 4, yy + 1);
      }
      ctx.fill();
    };
    for (const p of snap.positions) if (p.symbol === state.pair) placeMark(p.openTime, p.open, p.side);
    for (const h of snap.history) if (h.symbol === state.pair) placeMark(h.openTime, h.open, h.side);
  }

  // crosshair
  if (crossX !== null && crossY !== null) {
    ctx.strokeStyle = 'rgba(107,122,153,.4)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(crossX, padT); ctx.lineTo(crossX, H - padB); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(padL, crossY); ctx.lineTo(W - padR, crossY); ctx.stroke();
    ctx.setLineDash([]);
  }
}

function chartMouse(e) {
  const rect = canvas.getBoundingClientRect();
  crossX = e.clientX - rect.left;
  crossY = e.clientY - rect.top;
  const candles = state.candles[state.pair] || [];
  const W = rect.width;
  const padL = 8, padR = 70, step = 8;
  const visible = Math.max(10, Math.floor((W - padL - padR) / step));
  const start = Math.max(0, candles.length - visible);
  const idx = Math.floor((crossX - padL) / step);
  const c = candles[start + idx];
  if (c) {
    const meta = PAIR_META[state.pair];
    const d = meta.digits;
    const ema9 = emaSeries(candles.slice(start, start + visible).map(x => x.c), 9);
    tip.innerHTML =
      `<div>${fmtTime(c.t)}</div>` +
      `<div>O <span class="pos">${fmt(c.o, d)}</span>  H <span class="pos">${fmt(c.h, d)}</span></div>` +
      `<div>L <span class="neg">${fmt(c.l, d)}</span>  C <span>${fmt(c.c, d)}</span></div>` +
      `<div class="muted">EMA9 ${fmt(ema9[idx], d)}</div>`;
    tip.classList.remove('hidden');
    tip.style.left = Math.min(crossX + 12, W - 180) + 'px';
    tip.style.top = Math.max(6, crossY - 40) + 'px';
  } else {
    tip.classList.add('hidden');
  }
  renderChart();
}
canvas.addEventListener('mousemove', chartMouse);
canvas.addEventListener('mouseleave', () => { crossX = crossY = null; tip.classList.add('hidden'); renderChart(); });

/* ---------------- tables ---------------- */
function renderPositions(positions) {
  const tb = document.querySelector('#positions-table tbody');
  $('pos-count').textContent = positions.length;
  tb.innerHTML = '';
  if (!positions.length) {
    tb.innerHTML = '<tr><td colspan="11" class="muted" style="text-align:center;padding:18px">No open positions — AI engine scanning for signals…</td></tr>';
    return;
  }
  for (const p of positions) {
    const d = PAIR_META[p.symbol].digits;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="muted">#${p.id}</td>
      <td><b>${p.symbol}</b></td>
      <td><span class="pill-side ${p.side}">${p.side}</span></td>
      <td>${fmt(p.lots, 2)}</td>
      <td>${fmt(p.open, d)}</td>
      <td class="${p.profit >= 0 ? 'pos' : 'neg'}">${fmt(p.current, d)}</td>
      <td class="muted">${fmt(p.sl, d)}</td>
      <td class="muted">${fmt(p.tp, d)}</td>
      <td class="${p.pips >= 0 ? 'pos' : 'neg'}">${p.pips >= 0 ? '+' : ''}${fmt(p.pips, 1)}</td>
      <td class="${p.profit >= 0 ? 'pos' : 'neg'}"><b>${fmtUSD(p.profit)}</b></td>
      <td class="muted">${fmtDur((Date.now() - p.openTime) / 1000)}</td>`;
    tb.appendChild(tr);
  }
}

function renderHistory(history) {
  const tb = document.querySelector('#history-table tbody');
  tb.innerHTML = '';
  if (!history.length) {
    tb.innerHTML = '<tr><td colspan="10" class="muted" style="text-align:center;padding:18px">No trades closed yet.</td></tr>';
    return;
  }
  for (const h of history) {
    const d = PAIR_META[h.symbol].digits;
    const win = h.profit >= 0;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><b>${h.symbol}</b></td>
      <td><span class="pill-side ${h.side}">${h.side}</span></td>
      <td>${fmt(h.lots, 2)}</td>
      <td>${fmt(h.open, d)}</td>
      <td>${fmt(h.close, d)}</td>
      <td><span class="pill-result ${h.reason === 'SL' ? 'loss' : win ? 'win' : 'timeout'}">${h.reason === 'SL' ? 'STOP LOSS' : h.reason === 'TP' ? 'TAKE PROFIT' : 'EXIT'}</span></td>
      <td class="${h.pips >= 0 ? 'pos' : 'neg'}">${h.pips >= 0 ? '+' : ''}${fmt(h.pips, 1)}</td>
      <td class="${win ? 'pos' : 'neg'}"><b>${fmtUSD(h.profit)}</b></td>
      <td class="muted">${fmtDur(h.durationSec)}</td>
      <td class="muted">${fmtTime(h.closeTime)}</td>`;
    tb.appendChild(tr);
  }
}

/* ---------------- log ---------------- */
let lastLogLen = 0;
function renderLog(log) {
  const el = $('bot-log');
  const onlyNew = log.length > lastLogLen;
  const slice = onlyNew ? log.slice(lastLogLen) : log;
  if (!slice.length) return;
  for (const line of slice) {
    const div = document.createElement('div');
    div.className = 'log-line';
    const isWin = /CLOSED/.test(line.msg) && /P\/L \+/.test(line.msg);
    const isLoss = /CLOSED/.test(line.msg) && /P\/L -/.test(line.msg);
    if (isWin) div.classList.add('win');
    if (isLoss) div.classList.add('loss');
    const t = new Date(line.t).toLocaleTimeString('en-GB');
    div.innerHTML = `<span class="lt">[${t}]</span> <span class="lq">${line.msg}</span>`;
    el.appendChild(div);
  }
  lastLogLen = log.length;
  while (el.children.length > 60) el.removeChild(el.firstChild);
  el.scrollTop = el.scrollHeight;
}

/* ---------------- news ---------------- */
function showNews(news) {
  if (news.id === state.lastNewsId) return;
  state.lastNewsId = news.id;
  const b = $('news-banner');
  $('news-text').innerHTML = `<b>${news.headline}</b> <span class="muted">— ${news.pair} · impact ${news.impact} · risk filter 8s</span>`;
  b.classList.remove('hidden');
  const tape = $('news-tape');
  tape.innerHTML = '◈ ' + news.headline + ' — AI risk filter active, new entries suspended';
  tape.classList.add('show');
  setTimeout(() => { b.classList.add('hidden'); tape.classList.remove('show'); }, 12000);
}
$('news-close').addEventListener('click', () => { $('news-banner').classList.add('hidden'); $('news-tape').classList.remove('show'); });

/* ---------------- clock + controls ---------------- */
setInterval(() => { $('server-clock').textContent = new Date().toLocaleTimeString('en-GB'); }, 1000);

function setConn(ok) {
  state.connOk = ok;
  $('conn-dot').style.background = ok ? '#26d07c' : '#ff4d5e';
  $('chart-status').textContent = ok ? '● live stream connected' : '○ reconnecting…';
  $('chart-status').style.color = ok ? '#26d07c' : '#ff4d5e';
}

$('btn-pause').addEventListener('click', () => {
  const paused = $('btn-pause').textContent === 'RESUME';
  fetch('/api/control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: paused ? 'resume' : 'pause' }),
  });
});

$('speed-slider').addEventListener('input', e => {
  $('speed-val').textContent = e.target.value + 'x';
  fetch('/api/control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'speed', value: +e.target.value }),
  });
});

/* ---------------- render loop ---------------- */
let dirty = true;
function renderAll() { dirty = true; }
function loop() {
  if (dirty) { renderChart(); dirty = false; }
  requestAnimationFrame(loop);
}
loop();

setTimeout(() => { resizeChart(); renderAll(); }, 50);