import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { liveSessions } from './sessions.js';
import { inventory, usage, recentProjects, refreshMcp, limits } from './inventory.js';
import { launch, focus } from './terminal.js';
import { summarize } from './summarize.js';
import { observe, recentEvents, reloadEvents, config, setConfig, setDashboardUrl } from './events.js';
import { scan, history, summarizeSession, reloadHistory } from './history.js';
import { running, register, unregister, urlOf, homeUrl, claimWatcher, releaseWatcher, freePort } from './registry.js';
import { agentTarget, proxy } from './home.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const HQ_BUNDLE = path.join(ROOT, 'dist', 'hq.mjs');
const TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

// POSTs start processes on this machine. Only the page this server rendered may send them:
// it carries a per-run token, and the Host check stops DNS-rebinding pages from reaching us.
const TOKEN = crypto.randomBytes(24).toString('hex');

// `nextFree`: if the port is taken by the time it listens (two Fleets starting at once), take the next free one.
export function start({ port = 7788, host = '127.0.0.1', repo = process.cwd(), project, nextFree = false } = {}) {
  const clients = new Set();
  let last = '';
  // The agent team for `repo` (built into dist/hq.mjs). Its routes are tried before Fleet's own.
  // It starts once the port is ours: its agents' hooks and Team MCP are written with that port.
  let listening;
  const hqReady = new Promise((r) => (listening = r)).then(() => import(HQ_BUNDLE).then((m) => m.startHq({ repo, port, pageToken: TOKEN, project })));

  const snapshot = () => ({ at: Date.now(), sessions: liveSessions(), events: recentEvents(), config: config() });

  // Every copy sees every Claude session on the Mac, so only one (the watcher) raises banners and
  // writes events.jsonl and history.json. Returns whether this copy is it.
  const watching = () => {
    const w = claimWatcher();
    if (w === 'took') {
      reloadEvents();
      reloadHistory();
    }
    return !!w;
  };

  // Runs even with no browser open: attention events and banners must not depend on a tab.
  setInterval(() => {
    let body;
    try {
      const snap = snapshot();
      if (watching() && observe(snap.sessions).length) snap.events = recentEvents();
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
      const hq = await hqReady;
      // Agents still running from when another project had this port: hand them to their own Fleet.
      if ((url.pathname.startsWith('/hook/') || url.pathname === '/mcp') && req.headers.authorization !== `Bearer ${hq.agentToken}`) {
        const { project: p, copy } = agentTarget(req);
        if (p && p.slug !== hq.slug && copy && copy.port !== port) return proxy(req, res, copy.port);
      }
      // Agents' hooks and Team MCP authenticate with their own token, so they come before Fleet's POST check.
      if (await hq.handle(req, res, url)) return;
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
      // For the home page: this project's agents, what needs you, open PRs.
      if (req.method === 'GET' && url.pathname === '/api/summary') return send(res, 200, { ...(await hqReady).summary(), port });
      // The Fleet copies running on this Mac, for the project switcher.
      if (req.method === 'GET' && url.pathname === '/api/fleets')
        return send(res, 200, running().map((e) => ({ slug: e.slug, name: e.name, repo: e.repo, url: urlOf(e), current: e.pid === process.pid })));

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

  server.hqReady = hqReady;
  server.once('listening', () => listening());
  let tries = 0;
  server.on('error', async (e) => {
    if (!nextFree || e.code !== 'EADDRINUSE') return;
    if (++tries > 20) return server.emit('error', new Error('Ports keep being taken while Fleet starts. Pass --port <n>.'));
    try {
      port = await freePort(port + 1);
      server.listen(port, host);
    } catch (err) {
      server.emit('error', err);
    }
  });
  server.listen(port, host);
  // In ~/.fleet/running/ while it serves (fleet --list, the switcher); out again when it exits.
  Promise.all([hqReady, new Promise((r) => server.once('listening', r))])
    .then(([hq]) => register({ slug: hq.slug, name: hq.team ? hq.name() : path.basename(hq.repoRoot), repo: hq.repoRoot, port, pid: process.pid, ...(hq.team && { team: true }) }))
    .catch(() => {});
  process.on('exit', () => {
    unregister();
    releaseWatcher();
  });
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => process.exit(0));
  setDashboardUrl(`http://localhost:${port}`);
  refreshMcp(); // warm the slow MCP health check
  if (watching()) scan();
  setInterval(() => watching() && scan(), 60_000);
  return server;
}

// Loaded once at startup, like the server code, so the page always matches the API it talks to.
// (Reading from disk per request let a git pull serve a new UI to an old server.)
// Keys are paths relative to public/, with forward slashes (e.g. "assets/index-x.js").
const STATIC = new Map(
  fs.existsSync(PUBLIC)
    ? fs
        .readdirSync(PUBLIC, { recursive: true })
        .map(String)
        .filter((f) => fs.statSync(path.join(PUBLIC, f)).isFile())
        .map((f) => {
          let body = fs.readFileSync(path.join(PUBLIC, f));
          if (f === 'index.html') body = Buffer.from(body.toString().replace('__FLEET_TOKEN__', TOKEN).replace('__FLEET_HOME_URL__', homeUrl()));
          return [f.split(path.sep).join('/'), body];
        })
    : []
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
