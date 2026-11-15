// Fleet's home page: one light server on a fixed port (7788, or FLEET_HOME_PORT) that lists every
// project in ~/.fleet/projects/, which ones run, what needs you and what they cost, and starts or
// stops them. No repo, no agents, no tmux. Run by `fleet home`, `fleet open`, and `fleet` outside a repo.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { running, urlOf, alive, HOME_PORT } from './registry.js';
import { items, itemsFor, homeItem, enableHome, moveOff, startBackground, stop, fromNpx } from './autostart.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'bin', 'fleet.js');
const fleetDir = () => path.join(os.homedir(), '.fleet');
const projectsDir = () => path.join(fleetDir(), 'projects');
const lockFile = () => path.join(fleetDir(), 'home.pid');
const TOKEN = crypto.randomBytes(24).toString('hex');
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

const read = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

// Every project Fleet has a home for: a folder with repo-root (or an older config.json with project.path).
export function projects() {
  let dirs;
  try {
    dirs = fs.readdirSync(projectsDir(), { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return [];
  }
  return dirs.flatMap(({ name: slug }) => {
    const dir = path.join(projectsDir(), slug);
    let config = null;
    try {
      config = JSON.parse(read(path.join(dir, 'config.json')));
    } catch {}
    const repo = read(path.join(dir, 'repo-root'))?.trim() || config?.project?.path;
    if (!repo) return [];
    return [{ slug, dir, repo, name: config?.project?.name ?? path.basename(repo), missing: !fs.existsSync(repo) }];
  });
}

// API-equivalent cost of the sessions whose cwd is inside each project's folder (its agents'
// worktrees; subagents are already in their parent's cost), for today, the last 7 days and all time.
// shortcut: a session counts in full on the day it last ran; per-day splits would need its transcript.
export function costs(list, records, now = Date.now()) {
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  const zero = () => ({ today: 0, week: 0, all: 0 });
  const by = Object.fromEntries(list.map((p) => [p.slug, zero()]));
  const total = zero();
  for (const r of records) {
    const p = r.cwd && list.find((x) => r.cwd === x.dir || r.cwd.startsWith(x.dir + path.sep));
    if (!p || !r.cost) continue;
    const at = r.endedAt ?? r.startedAt ?? 0;
    for (const c of [by[p.slug], total]) {
      c.all += r.cost;
      if (at >= now - 7 * 86_400_000) c.week += r.cost;
      if (at >= midnight) c.today += r.cost;
    }
  }
  return { by, total };
}

// ~/.fleet/history.json (written by the copy that watches sessions), re-read only when it changes.
let cache = { mtime: 0, records: [] };
function records() {
  const file = path.join(fleetDir(), 'history.json');
  try {
    const { mtimeMs } = fs.statSync(file);
    if (mtimeMs !== cache.mtime) cache = { mtime: mtimeMs, records: Object.values(JSON.parse(fs.readFileSync(file, 'utf8'))) };
  } catch {}
  return cache.records;
}

// A running project's GET /api/summary, or null.
const summary = (port) =>
  new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/summary', timeout: 1500 }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve(res.statusCode === 200 ? JSON.parse(data) : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });

export async function state() {
  const list = projects();
  const live = running();
  const { by, total } = costs(list, records());
  const out = await Promise.all(
    list.map(async (p) => {
      const copy = live.find((e) => e.slug === p.slug);
      return {
        slug: p.slug,
        name: p.name,
        repo: p.repo,
        missing: p.missing,
        running: !!copy,
        url: copy ? urlOf(copy) : null,
        autostart: itemsFor(p.repo).length > 0,
        summary: copy ? await summary(copy.port) : null,
        cost: by[p.slug],
      };
    }),
  );
  out.sort((a, b) => b.running - a.running || a.missing - b.missing || a.name.localeCompare(b.name));
  return { port: HOME_PORT, projects: out, total };
}

// Starts a command of Fleet's in the background, detached from this process, logging to ~/.fleet/<log>.
function spawnFleet(args, log) {
  fs.mkdirSync(fleetDir(), { recursive: true });
  const fd = fs.openSync(path.join(fleetDir(), log), 'a');
  const child = spawn(process.execPath, [SCRIPT, ...args], { detached: true, stdio: ['ignore', fd, fd], env: process.env });
  child.unref();
  fs.closeSync(fd);
}

// Start: the project's login item if it has one, else a background `fleet --repo <repo> --no-open`.
export function startProject(p) {
  const item = itemsFor(p.repo)[0];
  if (item) startBackground(item);
  else spawnFleet(['--repo', p.repo, '--no-open'], `fleet-${p.slug}.log`);
}

// Byte lengths, not string lengths: timingSafeEqual throws on buffers of different sizes.
const safeEqual = (a, b) => {
  const A = Buffer.from(a);
  const B = Buffer.from(b);
  return A.length === B.length && crypto.timingSafeEqual(A, B);
};

// Agents' hooks and Team MCP still pointing at this port (their project moved off it while they
// ran) reach their project here: the agent token says which one.
function forward(req, res) {
  const auth = String(req.headers.authorization ?? '');
  const p = projects().find((x) => {
    const t = read(path.join(x.dir, 'agent-token'))?.trim();
    return t && safeEqual(auth, `Bearer ${t}`);
  });
  const copy = p && running().find((e) => e.slug === p.slug && e.port !== HOME_PORT);
  if (!copy) return send(res, p ? 503 : 401, { error: p ? 'project not running' : 'unauthorized' });
  const up = http.request({ host: '127.0.0.1', port: copy.port, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${copy.port}` } }, (r) => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  up.on('error', () => (res.headersSent ? res.end() : send(res, 502, { error: 'project unreachable' })));
  res.on('close', () => up.destroy()); // the agent stopped waiting (a held permission request)
  req.pipe(up);
}

// public/ files the home page needs: its page, assets, manifest, icons and service worker.
const STATIC = new Map();
function loadStatic() {
  const pub = path.join(ROOT, 'public');
  if (!fs.existsSync(pub)) return;
  for (const f of fs.readdirSync(pub, { recursive: true }).map(String)) {
    const file = path.join(pub, f);
    if (!fs.statSync(file).isFile() || f === 'index.html') continue;
    let body = fs.readFileSync(file);
    if (f === 'home.html') body = Buffer.from(body.toString().replace('__FLEET_TOKEN__', TOKEN));
    STATIC.set(f.split(path.sep).join('/'), body);
  }
}

function send(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e5) req.destroy();
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });

export function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  if (![`127.0.0.1:${HOME_PORT}`, `localhost:${HOME_PORT}`].includes(req.headers.host)) return send(res, 403, { error: 'bad host' });
  (async () => {
    if (url.pathname.startsWith('/hook/') || url.pathname === '/mcp') return forward(req, res);
    if (req.method === 'GET' && url.pathname === '/api/home') return send(res, 200, await state());
    if (req.method === 'POST') {
      if (req.headers['x-fleet-token'] !== TOKEN) return send(res, 403, { error: 'bad token' });
      let slug;
      try {
        ({ slug } = JSON.parse((await readBody(req)) || '{}'));
      } catch {
        return send(res, 400, { error: 'bad request' });
      }
      const p = projects().find((x) => x.slug === slug);
      if (!p) return send(res, 404, { error: 'no such project' });
      if (url.pathname === '/api/home/start') {
        if (p.missing) return send(res, 400, { error: 'repo folder is gone' });
        if (!running().some((e) => e.slug === p.slug)) startProject(p);
        return send(res, 200, { ok: true });
      }
      if (url.pathname === '/api/home/stop') return send(res, 200, stop({ repo: p.repo, registry: running() }));
      // Forget removes only Fleet's folder for a project whose repo is gone; never the repo.
      if (url.pathname === '/api/home/forget') {
        if (!p.missing) return send(res, 400, { error: 'repo still exists' });
        fs.rmSync(p.dir, { recursive: true, force: true });
        return send(res, 200, { ok: true });
      }
    }
    if (req.method !== 'GET') return send(res, 404, { error: 'not found' });
    const rel = url.pathname === '/' ? 'home.html' : url.pathname.slice(1);
    const body = STATIC.get(rel);
    if (!body) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': TYPES[path.extname(rel)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  })().catch((e) => (res.headersSent ? res.end() : send(res, 500, { error: e.message })));
}

// The home's pid in ~/.fleet/home.pid while it runs (or is starting): one home per computer.
export const homeRunning = () => {
  const pid = Number(read(lockFile()));
  return pid > 0 && alive(pid);
};
function claim() {
  if (homeRunning() && Number(read(lockFile())) !== process.pid) return false;
  fs.mkdirSync(fleetDir(), { recursive: true });
  fs.rmSync(lockFile(), { force: true });
  try {
    fs.writeFileSync(lockFile(), String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

// Moves project login items pinned to the home's port (see moveOff). The bundle is loaded only then.
export const migrate = async () => (items().some((i) => i.repo && i.port === HOME_PORT) ? moveOff(HOME_PORT, (await import('../dist/hq.mjs')).projectSlug) : []);

// Makes sure the home runs, in the background: its login item if it has one; one is made when any
// project starts at login; else a detached process. `move`: first move project login items off
// the home's port (not from inside the copy being moved). Returns what moved.
export async function ensureHome({ move = true } = {}) {
  if (homeRunning()) return [];
  const moved = move ? await migrate() : [];
  const item = homeItem();
  try {
    if (item) startBackground(item);
    else if (items().some((i) => i.repo) && !fromNpx()) enableHome(HOME_PORT);
    else spawnFleet(['home', '--serve'], 'fleet-home.log');
  } catch {
    spawnFleet(['home', '--serve'], 'fleet-home.log');
  }
  return moved;
}

// Resolves once the home answers (true), or false after `ms`.
export async function waitForHome(ms = 30_000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 300))) {
    const ok = await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: HOME_PORT, path: '/manifest.webmanifest', timeout: 1000 }, (res) => (res.resume(), resolve(res.statusCode === 200)));
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve(false));
    });
    if (ok) return true;
  }
  return false;
}

// `fleet home --serve`: moves pinned project login items off the port, then serves. Retries the
// port for a few seconds while a moved copy lets go of it.
export async function serve() {
  if (!claim()) {
    console.log('Fleet home is already running.');
    process.exit(0);
  }
  process.on('exit', () => Number(read(lockFile())) === process.pid && fs.rmSync(lockFile(), { force: true }));
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => process.exit(0));
  try {
    for (const m of await migrate()) console.log(`Moved Fleet for ${m.repo} from port ${m.from} to ${m.to}.`);
  } catch (e) {
    console.error(`Could not move a project off port ${HOME_PORT}: ${e.message}`);
  }
  loadStatic();
  const server = http.createServer(handler);
  for (let tries = 0; ; tries++) {
    const err = await new Promise((resolve) => {
      server.once('error', resolve);
      server.listen(HOME_PORT, '127.0.0.1', () => resolve(null));
    });
    if (!err) break;
    if (err.code !== 'EADDRINUSE' || tries >= 20) {
      console.error(err.code === 'EADDRINUSE' ? `Port ${HOME_PORT} is in use, so Fleet's home page can't start. Stop what uses it, or set FLEET_HOME_PORT.` : err.message);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(`Fleet home running at http://localhost:${HOME_PORT}`);
  return server;
}
