#!/usr/bin/env node
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enable, disable, staleNode, items, itemsFor, startBackground, stop } from '../src/autostart.js';
import { running, urlOf, freePort } from '../src/registry.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const has = (name) => process.argv.includes(name);
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

// Unknown flags and missing values stop here, before anything starts.
const VALUE_FLAGS = ['--repo', '--port'];
const FLAGS = ['--no-open', '--autostart', '--no-autostart', '--stop', '--start', '--all', '--list', '--version', '-h', '--help'];
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (VALUE_FLAGS.includes(a)) {
    const v = process.argv[++i];
    if (v === undefined || v.startsWith('-')) fail(`${a} needs a value. Run "fleet --help" for usage.`);
  } else if (!FLAGS.includes(a)) fail(`Unknown option: ${a}. Run "fleet --help" for the options.`);
}

if (has('--version')) {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  console.log(pkg.version);
  process.exit(0);
}

// No --port or FLEET_PORT: 7788, or the next free port when another Fleet (or anything) has it.
const portGiven = has('--port') || process.env.FLEET_PORT !== undefined;
const portText = String(arg('--port', process.env.FLEET_PORT ?? 7788));
let port = Number(portText);
if (!/^\d+$/.test(portText) || port < 1 || port > 65535) fail(`Port must be a number from 1 to 65535, not "${portText}".`);
// The repo the agent team works on: --repo, else FLEET_REPO, else the current folder.
const repo = path.resolve(arg('--repo', process.env.FLEET_REPO ?? process.cwd()));

if (has('--help') || has('-h')) {
  console.log(`Usage: fleet [options]

Run fleet in each repo you want a team on; each copy gets its own port.

  --repo <path>     The git repo the agent team works on (default: this folder, or FLEET_REPO)
  --port <n>        Serve on this port (default 7788, or the next free one; or FLEET_PORT)
  --no-open         Don't open a browser tab
  --list            List the Fleet copies running on this Mac, with their URLs
  --autostart       Start Fleet at login for this repo, in the background, and start it now
  --no-autostart    Stop starting Fleet at login for this repo, and stop its background copy
  --stop            Stop Fleet for this repo now; with auto-start it comes back at the next login
  --start           Start this repo's background copy now (needs --autostart)
  --all             With --stop, --start or --no-autostart: every repo, not just this one
  --version         Print Fleet's version
  -h, --help        Show this help`);
  process.exit(0);
}

if (has('--list')) {
  const list = running();
  if (!list.length) console.log('No Fleet is running.');
  for (const e of list) console.log(`${urlOf(e).padEnd(23)} ${e.slug.padEnd(24)} ${e.repo}`);
  process.exit(0);
}

// The agent team needs a git repo. Check it up front: the background copy must not restart forever on a bad folder.
const repoRoot = () => {
  let root;
  try {
    root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: repo, stdio: 'pipe' }).toString().trim();
  } catch {
    fail(`${repo} is not inside a git repository. Run fleet from your project folder, or pass --repo <path>.`);
  }
  // Agents' worktrees start from a commit, so an empty repo would fail later with "invalid reference: HEAD".
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: root, stdio: 'pipe' });
  } catch {
    fail('This repo has no commits yet. Make a first commit, then run fleet.');
  }
  return root;
};

// The office UI (public/) and the agent-team server (dist/hq.mjs) are built from hq/.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const built = () => {
  if (fs.existsSync(path.join(root, 'public', 'index.html')) && fs.existsSync(path.join(root, 'dist', 'hq.mjs'))) return;
  console.error(`Fleet isn't built yet. Run this first, in ${root}:\n\n  npm install && npm run build\n`);
  process.exit(1);
};

if (has('--autostart')) {
  built();
  const r = repoRoot();
  const { projectSlug } = await import('../dist/hq.mjs');
  // The port this repo's login item already had, else a free one no other login item uses.
  const p = portGiven ? port : itemsFor(r).find((i) => i.port)?.port ?? (await freePort(7788, items().map((i) => i.port)));
  try {
    const out = enable({ port: p, repo: r, slug: projectSlug(r) });
    console.log(`Fleet now starts at login on http://localhost:${out.port} for ${out.repo}, and is starting now.
Log: ${out.log}
Turn it off with: fleet --no-autostart`);
  } catch (e) {
    console.error(`Could not set up auto-start: ${e.stderr?.toString().trim() || e.message}`);
    process.exit(1);
  }
  process.exit(0);
}

// --stop, --start and --no-autostart act on this repo's Fleet; --all on every one.
const all = has('--all');
const target = () => (all ? null : repoRoot());

if (has('--no-autostart')) {
  const repos = all ? [...new Set(items().map((i) => i.repo))] : [target()];
  const n = repos.reduce((sum, r) => sum + disable(r), 0);
  console.log(n ? 'Fleet no longer starts at login, and the background copy is stopped.' : 'Auto-start was not set up.');
  process.exit(0);
}

if (has('--stop')) {
  const { background, manual, unknown } = stop({ repo: target(), all, registry: running() });
  if (!background && !manual) console.log('Fleet is not running.');
  else console.log(`Fleet stopped.${background ? ' Auto-start is still on, so it starts again at the next login (or run "fleet --start").' : ''}`);
  if (unknown) console.log(`${unknown} other Fleet ${unknown === 1 ? 'copy is' : 'copies are'} running for a repo Fleet can't tell; "fleet --stop --all" stops every Fleet.`);
  process.exit(0);
}

if (has('--start')) {
  const list = all ? items() : itemsFor(target());
  if (!list.length) {
    console.log('Auto-start is not set up. Run "fleet" to start Fleet here, or "fleet --autostart" to run it in the background from login.');
    process.exit(1);
  }
  for (const i of list) {
    try {
      const { state, lastExit } = startBackground(i);
      const where = `http://localhost:${i.port} (${i.repo ?? 'no repo'})`;
      console.log(state === 'running' ? `Fleet is already running in the background on ${where}.` : `Fleet is starting in the background on ${where}.`);
      if (lastExit) console.log(`  Its last run exited with code ${lastExit}; if it keeps stopping, see ${i.log ?? 'its log'}.`);
    } catch (e) {
      console.error(`Could not start Fleet: ${e.stderr?.toString().trim() || e.message}`);
      process.exit(1);
    }
  }
  process.exit(0);
}

built();
const r = repoRoot();
for (const i of itemsFor(r)) {
  const stale = staleNode(i.file);
  if (stale) console.warn(`Auto-start points at ${stale}, which no longer exists (Node or Fleet was updated or removed).
Run "fleet --autostart" again to fix it.`);
}

// One Fleet per repo: a second one would run the same team twice. Exit 0, so launchd doesn't retry.
const already = running().find((e) => e.repo === r);
if (already) {
  console.log(`Fleet is already running for this repo at ${urlOf(already)}.`);
  if (!has('--no-open')) execFileSync('open', [urlOf(already)]);
  process.exit(0);
}
if (!portGiven) {
  try {
    port = await freePort(port);
  } catch (e) {
    fail(e.message);
  }
  if (port !== 7788) console.log(`Port 7788 is in use, so Fleet uses ${port}.`);
}

const { start } = await import('../src/server.js');
const server = start({ port, repo: r });
server.hqReady.catch((e) => {
  console.error(`Could not start the agent team: ${e.message}`);
  process.exit(1);
});
server.on('listening', () => {
  const url = `http://localhost:${port}`;
  console.log(`Fleet running at ${url}`);
  if (!has('--no-open')) execFile('open', [url]);
});
server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${port} is in use. Try --port <n>.` : e.message);
  process.exit(1);
});
