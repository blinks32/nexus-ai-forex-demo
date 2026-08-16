'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Engine, PAIRS } = require('./engine');

loadEnv();

function loadEnv() {
  const envFile = path.join(__dirname, '.env');
  if (!fs.existsSync(envFile)) return;
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

/* ---------- per-viewer virtual accounts ---------- */

const VIRTUAL_START_BALANCE = 10000;
const viewers = new Map();

function viewerFor(id) {
  if (!id || typeof id !== 'string' || id.length > 64) return null;
  let v = viewers.get(id);
  if (!v) {
    v = { balance: VIRTUAL_START_BALANCE, positions: [], history: [], copied: new Set(), nextId: 1 };
    viewers.set(id, v);
  }
  return v;
}

function pipValuePerLot(sym, price) {
  const contract = engine.contractOf(sym);
  const pip = engine.pipOf(sym);
  const perLot = pip * contract;
  return sym === 'USDJPY' && price ? perLot / price : perLot;
}

function positionProfit(pos, price) {
  const contract = engine.contractOf(pos.symbol);
  const raw = pos.side === 'BUY' ? (price - pos.entry) : (pos.entry - price);
  let usd = raw * pos.lots * contract;
  if (pos.symbol === 'USDJPY') usd = usd / price;
  return usd;
}

function refreshPortfolio(v) {
  for (const pos of v.positions) {
    const px = engine.priceOf(pos.symbol);
    if (!px) continue;
    const price = pos.side === 'BUY' ? px.bid : px.ask;
    pos.current = price;
    pos.profit = positionProfit(pos, price);
    pos.pips = (pos.side === 'BUY' ? price - pos.entry : pos.entry - price) / engine.pipOf(pos.symbol);
    if (pos.side === 'BUY' ? price <= pos.sl : price >= pos.sl) closeVirtualPosition(v, pos.id, 'SL');
    else if (pos.side === 'BUY' ? price >= pos.tp : price <= pos.tp) closeVirtualPosition(v, pos.id, 'TP');
  }
  return v;
}

function closeVirtualPosition(v, positionId, reason) {
  const idx = v.positions.findIndex(p => p.id === positionId);
  if (idx < 0) return null;
  const pos = v.positions[idx];
  pos.close = pos.current;
  pos.reason = reason;
  pos.closedAt = Date.now();
  pos.durationSec = Math.round((pos.closedAt - pos.openTime) / 1000);
  v.balance += pos.profit;
  v.positions.splice(idx, 1);
  v.history.unshift(pos);
  if (v.history.length > 60) v.history.pop();
  return pos;
}

function portfolioView(v) {
  refreshPortfolio(v);
  const floating = v.positions.reduce((a, p) => a + (p.profit || 0), 0);
  return {
    balance: v.balance,
    equity: v.balance + floating,
    floatingPL: floating,
    positions: v.positions,
    history: v.history,
    copiedDecisionIds: Array.from(v.copied),
  };
}

function copyDecision(v, decision) {
  if (v.copied.has(decision.id)) return { error: 'This decision was already copied to your account.' };
  const px = engine.priceOf(decision.symbol);
  if (!px) return { error: 'No price available for ' + decision.symbol };
  const entry = decision.side === 'BUY' ? px.ask : px.bid;
  const pipVal = pipValuePerLot(decision.symbol, entry);
  if (!pipVal) return { error: 'Cannot size position for ' + decision.symbol };
  const riskUSD = v.balance * (decision.riskPct / 100);
  let lots = Math.round((riskUSD / (decision.slPips * pipVal)) * 100) / 100;
  lots = Math.max(0.01, Math.min(2, lots));
  const pip = engine.pipOf(decision.symbol);
  const pos = {
    id: 'v' + v.nextId++,
    symbol: decision.symbol,
    side: decision.side,
    lots,
    entry,
    sl: decision.side === 'BUY' ? entry - decision.slPips * pip : entry + decision.slPips * pip,
    tp: decision.side === 'BUY' ? entry + decision.tpPips * pip : entry - decision.tpPips * pip,
    openTime: Date.now(),
    current: entry,
    profit: 0,
    pips: 0,
  };
  v.positions.push(pos);
  v.copied.add(decision.id);
  return { ok: true, position: pos };
}

const engine = new Engine();
const clients = new Set();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

function handleSSE(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write(`retry: 2000\n\n`);
  res.write(`event: init\ndata: ${JSON.stringify({ snap: engine.lastSnap, candles: engine.candlesSnapshot(), news: engine.news })}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
}

function handleControl(req, res) {
  let body = '';
  req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
  req.on('end', () => {
    try {
      const { action, value } = JSON.parse(body || '{}');
      engine.control(action, value);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: false }));
    }
  });
}

function readJsonBody(req, cb) {
  let body = '';
  req.on('data', c => { body += c; if (body.length > 8192) req.destroy(); });
  req.on('end', () => {
    try { cb(null, JSON.parse(body || '{}')); }
    catch (e) { cb(e); }
  });
}

function handleCopy(req, res) {
  readJsonBody(req, (err, data) => {
    if (err) return res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'bad request' }));
    const v = viewerFor(data.viewerId);
    if (!v) return res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'missing viewer id' }));
    const decision = engine.currentDecision();
    if (!decision || decision.id !== data.decisionId) {
      return res.writeHead(409, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'This decision has expired — wait for the next one.' }));
    }
    const result = copyDecision(v, decision);
    if (result.error) return res.writeHead(409, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: result.error }));
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, portfolio: portfolioView(v) }));
  });
}

function handlePortfolio(req, res) {
  const id = new URL(req.url, 'http://x').searchParams.get('viewer');
  const v = viewerFor(id);
  if (!v) return res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'missing viewer id' }));
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(portfolioView(v)));
}

function handleClose(req, res) {
  readJsonBody(req, (err, data) => {
    if (err) return res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'bad request' }));
    const v = viewerFor(data.viewerId);
    if (!v) return res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'missing viewer id' }));
    const px = null;
    const pos = v.positions.find(p => p.id === data.positionId);
    if (!pos) return res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'position not found' }));
    const price = engine.priceOf(pos.symbol);
    if (price) pos.current = pos.side === 'BUY' ? price.bid : price.ask;
    closeVirtualPosition(v, pos.id, 'EXIT');
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, portfolio: portfolioView(v) }));
  });
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (req.method === 'GET' && url === '/stream') return handleSSE(req, res);
  if (req.method === 'GET' && url === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ snap: engine.lastSnap, candles: engine.candlesSnapshot() }));
    return;
  }
  if (req.method === 'POST' && url === '/api/control') return handleControl(req, res);
  if (req.method === 'POST' && url === '/api/copy') return handleCopy(req, res);
  if (req.method === 'POST' && url === '/api/portfolio/close') return handleClose(req, res);
  if (req.method === 'GET' && url === '/api/portfolio') return handlePortfolio(req, res);
  if (req.method === 'GET') return serveStatic(req, res);
  res.writeHead(405).end();
});

setInterval(() => {
  const snap = engine.lastSnap;
  const payload = JSON.stringify({ snap, news: engine.news });
  for (const res of clients) {
    try { res.write(`event: snap\ndata: ${payload}\n\n`); } catch { /* drop */ }
  }
}, 500);

async function main() {
  await engine.init();
  server.listen(PORT, () => {
    console.log(`NEXUS-AI trading dashboard running at http://localhost:${PORT}`);
    console.log(`Mode: ${engine.live ? 'LIVE (MetaTrader via MetaApi)' : 'SIMULATION'}`);
    console.log(`Symbols: ${PAIRS.map(p => p.symbol).join(', ')}`);
  });
}

main().catch(err => {
  console.error('Startup error:', err);
  process.exit(1);
});