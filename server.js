'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Engine, PAIRS } = require('./engine');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

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

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (req.method === 'GET' && url === '/stream') return handleSSE(req, res);
  if (req.method === 'GET' && url === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ snap: engine.lastSnap, candles: engine.candlesSnapshot() }));
    return;
  }
  if (req.method === 'POST' && url === '/api/control') return handleControl(req, res);
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

server.listen(PORT, () => {
  console.log(`NEXUS-AI demo trading dashboard running at http://localhost:${PORT}`);
  console.log(`Symbols: ${PAIRS.map(p => p.symbol).join(', ')}`);
});