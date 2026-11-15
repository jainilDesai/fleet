#!/usr/bin/env node
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enable, disable, staleNode, isSetUp, startBackground, stopAll } from '../src/autostart.js';

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
const FLAGS = ['--no-open', '--autostart', '--no-autostart', '--stop', '--start', '--version', '-h', '--help'];
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

const portText = String(arg('--port', process.env.FLEET_PORT ?? 7788));
const port = Number(portText);
if (!/^\d+$/.test(portText) || port < 1 || port > 65535) fail(`Port must be a number from 1 to 65535, not "${portText}".`);
// The repo the agent team works on: --repo, else FLEET_REPO, else the current folder.
const repo = path.resolve(arg('--repo', process.env.FLEET_REPO ?? process.cwd()));

if (has('--help') || has('-h')) {
  console.log(`Usage: fleet [options]

  --repo <path>     The git repo the agent team works on (default: this folder, or FLEET_REPO)
  --port <n>        Serve on another port (default 7788, or FLEET_PORT)
  --no-open         Don't open a browser tab
  --autostart       Start Fleet at login for this repo, in the background, and start it now
  --no-autostart    Stop starting Fleet at login, and stop the background copy
  --stop            Stop Fleet now; with auto-start it comes back at the next login
  --start           Start the background copy now (needs --autostart)
  --version         Print Fleet's version
  -h, --help        Show this help`);
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

if (has('--autostart')) {
  try {
    const r = enable(port, repoRoot());
    console.log(`Fleet now starts at login on http://localhost:${r.port} for ${r.repo}, and is starting now.
Log: ${r.log}
Turn it off with: fleet --no-autostart`);
  } catch (e) {
    console.error(`Could not set up auto-start: ${e.stderr?.toString().trim() || e.message}`);
    process.exit(1);
  }
  process.exit(0);
}

if (has('--no-autostart')) {
  console.log(disable() ? 'Fleet no longer starts at login, and the background copy is stopped.' : 'Auto-start was not set up.');
  process.exit(0);
}

if (has('--stop')) {
  const { background, manual } = stopAll();
  if (!background && !manual) console.log('Fleet is not running.');
  else console.log(`Fleet stopped.${background ? ' Auto-start is still on, so it starts again at the next login (or run "fleet --start").' : ''}`);
  process.exit(0);
}

if (has('--start')) {
  if (!isSetUp()) {
    console.log('Auto-start is not set up. Run "fleet" to start Fleet here, or "fleet --autostart" to run it in the background from login.');
    process.exit(1);
  }
  try {
    const state = startBackground();
    console.log(state === 'running' ? 'Fleet is already running in the background.' : `Fleet is starting in the background on its usual port.`);
  } catch (e) {
    console.error(`Could not start Fleet: ${e.stderr?.toString().trim() || e.message}`);
    process.exit(1);
  }
  process.exit(0);
}

const stale = staleNode();
if (stale) console.warn(`Auto-start points at ${stale}, which no longer exists (Node was updated or removed).
Run "fleet --autostart" again to fix it.`);

// The office UI (public/) and the agent-team server (dist/hq.mjs) are built from hq/.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!fs.existsSync(path.join(root, 'public', 'index.html')) || !fs.existsSync(path.join(root, 'dist', 'hq.mjs'))) {
  console.error(`Fleet isn't built yet. Run this first, in ${root}:\n\n  npm install && npm run build\n`);
  process.exit(1);
}

const { start } = await import('../src/server.js');
const server = start({ port, repo: repoRoot() });
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
