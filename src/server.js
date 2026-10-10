import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { liveSessions } from './sessions.js';
import { inventory, usage, recentProjects, refreshMcp, limits } from './inventory.js';
import { launch, focus } from './terminal.js';
import { summarize } from './summarize.js';
import { observe, recentEvents, config, setConfig, setDashboardUrl } from './events.js';
import { scan, history, summarizeSession } from './history.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };

// POSTs start processes on this machine. Only the page this server rendered may send them:
// it carries a per-run token, and the Host check stops DNS-rebinding pages from reaching us.
const TOKEN = crypto.randomBytes(24).toString('hex');

export function start({ port = 7788, host = '127.0.0.1' } = {}) {
  const clients = new Set();
  let last = '';

  const snapshot = () => ({ at: Date.now(), sessions: liveSessions(), events: recentEvents(), config: config() });

  // Runs even with no browser open: attention events and banners must not depend on a tab.
  setInterval(() => {
    let body;
    try {
      const snap = snapshot();
      if (observe(snap.sessions).length) snap.events = recentEvents();
      body = JSON.stringify(snap);
    } catch (e) {
      console.error('snapshot failed:', e);
      return;
    }
    if (!clients.size || body === last) return;
    last = body;
    for (const res of clients) res.write(`data: ${body}\n\n`);
  }, 1500);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const allowedHost = [`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host);
    if (!allowedHost) return send(res, 403, { error: 'bad host' });

    try {
      if (req.method === 'GET' && url.pathname === '/api/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        last = JSON.stringify(snapshot());
        res.write(`data: ${last}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/inventory')
        return send(res, 200, await inventory(url.searchParams.has('refresh')));
      if (req.method === 'GET' && url.pathname === '/api/usage') return send(res, 200, { ...usage(), limits: limits() });
      if (req.method === 'GET' && url.pathname === '/api/history') return send(res, 200, history());
      if (req.method === 'GET' && url.pathname === '/api/projects') return send(res, 200, recentProjects(liveSessions()));

      if (req.method === 'POST') {
        if (req.headers['x-fleet-token'] !== TOKEN) return send(res, 403, { error: 'bad token' });
        const body = JSON.parse((await readBody(req)) || '{}');
        if (url.pathname === '/api/launch') return send(res, 200, await launch(body));
        if (url.pathname === '/api/focus') {
          if (!liveSessions().some((s) => s.pid === Number(body.pid))) return send(res, 404, { error: 'no such session' });
          return send(res, 200, await focus(body.pid));
        }
        if (url.pathname === '/api/summarize') {
          const session = liveSessions().find((s) => s.sessionId === body.sessionId);
          if (!session) return send(res, 404, { error: 'no such session' });
          return send(res, 200, await summarize({ ...body, project: session.project }));
        }
        if (url.pathname === '/api/history/summarize') {
          const live = liveSessions().find((s) => s.sessionId === body.sessionId);
          return send(res, 200, await summarizeSession(String(body.sessionId), live?.status ?? 'done'));
        }
        if (url.pathname === '/api/config') return send(res, 200, setConfig(body));
        if (url.pathname === '/api/mcp/refresh') {
          refreshMcp();
          return send(res, 200, { ok: true });
        }
      }

      if (req.method === 'GET') return serveStatic(url.pathname, res);
      send(res, 404, { error: 'not found' });
    } catch (e) {
      send(res, 500, { error: e.message });
    }
  });

  server.listen(port, host);
  setDashboardUrl(`http://localhost:${port}`);
  refreshMcp(); // warm the slow MCP health check
  scan();
  setInterval(scan, 60_000);
  return server;
}

// Loaded once at startup, like the server code, so the page always matches the API it talks to.
// (Reading from disk per request let a git pull serve a new UI to an old server.)
const STATIC = new Map(
  fs.readdirSync(PUBLIC).map((f) => {
    let body = fs.readFileSync(path.join(PUBLIC, f));
    if (f === 'index.html') body = Buffer.from(body.toString().replace('__FLEET_TOKEN__', TOKEN));
    return [f, body];
  })
);

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const body = STATIC.get(rel);
  if (!body) return send(res, 404, { error: 'not found' });
  res.writeHead(200, { 'content-type': TYPES[path.extname(rel)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(body);
}

function send(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
