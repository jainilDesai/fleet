#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { enable, enableHome, disable, staleNode, items, itemsFor, homeItem, startBackground, stop } from '../src/autostart.js';
import { running, urlOf, freePort, HOME_PORT, homeUrl } from '../src/registry.js';
import { OS, openTarget } from '../src/platform.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const has = (name) => process.argv.includes(name);
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

// `fleet home` and `fleet open`: the home page. Everything else is a project's Fleet.
const sub = ['home', 'open'].includes(process.argv[2]) ? process.argv[2] : null;

// Unknown flags and missing values stop here, before anything starts.
const VALUE_FLAGS = ['--repo', '--port', '--project'];
const FLAGS = sub ? ['--no-open', '--autostart', '--no-autostart', '--serve', '-h', '--help'] : ['--no-open', '--autostart', '--no-autostart', '--stop', '--start', '--all', '--list', '--version', '-h', '--help'];
for (let i = sub ? 3 : 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (VALUE_FLAGS.includes(a)) {
    const v = process.argv[++i];
    if (v === undefined || v.startsWith('-')) fail(`${a} needs a value. Run "fleet --help" for usage.`);
  } else if (!FLAGS.includes(a)) fail(`Unknown option: ${a}. Run "fleet --help" for the options.`);
}

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
if (has('--version')) {
  console.log(pkg.version);
  process.exit(0);
}

// No --port or FLEET_PORT: the port after the home page's (7789), or the next free one.
const portGiven = has('--port') || process.env.FLEET_PORT !== undefined;
const portText = String(arg('--port', process.env.FLEET_PORT ?? HOME_PORT + 1));
let port = Number(portText);
if (!/^\d+$/.test(portText) || port < 1 || port > 65535) fail(`Port must be a number from 1 to 65535, not "${portText}".`);
// The repo the agent team works on: --repo, else FLEET_REPO, else the current folder.
const repoGiven = has('--repo') || !!process.env.FLEET_REPO;
const repo = path.resolve(arg('--repo', process.env.FLEET_REPO ?? process.cwd()));

if (has('--help') || has('-h')) {
  console.log(`Usage: fleet [options]
       fleet home | fleet open

Run fleet in each repo you want a team on; each copy gets its own port. Outside a repo, fleet
opens the home page at http://localhost:${HOME_PORT}: every project, what runs, what needs you, cost.

  fleet home        Start the home page in the background if needed, and open it
  fleet open        The same: open the home page
  fleet home --autostart     Start the home page at login (on by itself once any repo has --autostart)
  fleet home --no-autostart  Stop starting it at login, and stop it

  --repo <path>     The git repo the agent team works on (default: this folder, or FLEET_REPO)
  --port <n>        Serve on this port (default ${HOME_PORT + 1}, or the next free one; or FLEET_PORT)
  --project <name>  A separate team on this repo (New work makes these): its own CTO, port and page
  --no-open         Don't open a browser tab
  --list            List the Fleet copies running on this computer, with their URLs
  --autostart       Start Fleet at login for this repo, in the background, and start it now
  --no-autostart    Stop starting Fleet at login for this repo, and stop its background copy
  --stop            Stop Fleet for this repo now; with auto-start it comes back at the next login
  --start           Start this repo's background copy now (needs --autostart)
  --all             With --stop, --start or --no-autostart: every repo, not just this one
  --version         Print Fleet's version
  -h, --help        Show this help`);
  process.exit(0);
}

// Agents run in tmux, which native Windows doesn't have; Fleet runs inside WSL there.
if (OS === 'windows')
  fail(`Fleet doesn't run on Windows itself: it needs WSL (Linux inside Windows).

  1. In PowerShell: wsl --install, then restart and open Ubuntu.
  2. Inside Ubuntu: install Node 20 or newer, tmux (sudo apt install tmux) and Claude Code.
  3. Inside Ubuntu: npm install -g ${pkg.name}, then run fleet in your repo there.

Step by step: ${pkg.homepage}/docs.html#install-wsl`);

const openBrowser = (url) => openTarget(url) || console.log(`Open ${url} in your browser.`);

// The home page's UI is in public/ too.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const built = () => {
  if (fs.existsSync(path.join(root, 'public', 'index.html')) && fs.existsSync(path.join(root, 'dist', 'hq.mjs'))) return;
  console.error(`Fleet isn't built yet. Run this first, in ${root}:\n\n  npm install && npm run build\n`);
  process.exit(1);
};

const home = await import('../src/home.js');
const printMoved = (moved) => {
  for (const m of moved) console.log(`Fleet for ${m.repo} moved from port ${m.from} to ${m.to}, to make room for the home page (its agents keep running).`);
};

// The home page: started in the background (or served here with --serve), then opened.
const runHome = async () => {
  built();
  if (has('--serve')) return home.serve().then(() => new Promise(() => {})); // serves until stopped; never falls through
  if (has('--no-autostart')) {
    const item = homeItem();
    disable(null, item ? [item] : []);
    console.log(item ? 'The home page no longer starts at login, and is stopped.' : 'The home page was not set to start at login.');
    process.exit(0);
  }
  if (has('--autostart')) {
    try {
      printMoved(await home.migrate());
      if (!homeItem()) enableHome(HOME_PORT);
    } catch (e) {
      fail(`Could not set up auto-start: ${e.stderr?.toString().trim() || e.message}`);
    }
    console.log(`The home page now starts at login on ${homeUrl()}.`);
  } else printMoved(await home.ensureHome());
  if (!(await home.waitForHome())) fail(`The home page didn't start. See ${path.join(os.homedir(), '.fleet', 'fleet-home.log')}.`);
  console.log(`Fleet home at ${homeUrl()}`);
  if (!has('--no-open')) openBrowser(homeUrl());
  process.exit(0);
};
if (sub) await runHome();

if (has('--project') && ['--autostart', '--no-autostart', '--stop', '--start', '--all'].some(has))
  fail('--project is only for starting a separate team. Stop it from the home page.');

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
    fail(`${repo} is not inside a git repository. Run fleet from your project folder, pass --repo <path>, or run "fleet home" for the home page.`);
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
  built();
  const r = repoRoot();
  const { projectSlug } = await import('../dist/hq.mjs');
  // The port this repo's login item already had (not the home page's), else a free one no other login item uses.
  const p = portGiven ? port : itemsFor(r).find((i) => i.port && i.port !== HOME_PORT)?.port ?? (await freePort(HOME_PORT + 1, items().map((i) => i.port)));
  try {
    const out = enable({ port: p, repo: r, slug: projectSlug(r) });
    console.log(`Fleet now starts at login on http://localhost:${out.port} for ${out.repo}, and is starting now.
Log: ${out.log}
Turn it off with: fleet --no-autostart`);
    if (out.systemd) console.log('It runs as a systemd user service. To start it at boot, before you log in: loginctl enable-linger "$USER"');
    // The home page starts at login too, the first time any repo does.
    if (!homeItem()) {
      printMoved(await home.migrate());
      enableHome(HOME_PORT);
      console.log(`The home page starts at login too, on ${homeUrl()} (turn it off with: fleet home --no-autostart).`);
    }
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
// Outside a repo (and no --repo): the home page.
if (!repoGiven) {
  try {
    execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: repo, stdio: 'pipe' });
  } catch {
    await runHome();
  }
}
const r = repoRoot();

// The home page runs alongside, in the background; it never stops this repo's Fleet from starting.
// A login item still pinned to the home's port is this copy itself: the home moves it, not us.
const pinnedHere = portGiven && port === HOME_PORT && itemsFor(r).some((i) => i.port === HOME_PORT);
try {
  const moved = await home.ensureHome({ move: !pinnedHere });
  printMoved(moved);
  // This repo's own background copy just restarted on its new port: wait for it, don't start a second one.
  if (moved.some((m) => m.repo === r)) for (let i = 0; i < 100 && !running().some((e) => e.repo === r); i++) await new Promise((res) => setTimeout(res, 300));
} catch (e) {
  console.warn(`The home page could not start: ${e.message}`);
}
for (const i of itemsFor(r)) {
  const stale = staleNode(i.file);
  if (stale) console.warn(`Auto-start points at ${stale}, which no longer exists (Node or Fleet was updated or removed).
Run "fleet --autostart" again to fix it.`);
}

// One Fleet per project: a second one would run the same team twice. Exit 0, so launchd (or systemd) doesn't retry.
// A repo's main project and the separate teams New work made on it (--project) are different projects.
const project = arg('--project');
const already = running().find((e) => (project ? e.slug === project : e.repo === r && !e.team));
if (already) {
  console.log(`Fleet is already running for this repo at ${urlOf(already)}.`);
  if (!has('--no-open')) openBrowser(urlOf(already));
  process.exit(0);
}
if (!portGiven) {
  try {
    port = await freePort(port);
  } catch (e) {
    fail(e.message);
  }
  if (port !== HOME_PORT + 1) console.log(`Port ${HOME_PORT + 1} is in use, so Fleet uses ${port}.`);
}
if (port === HOME_PORT && !pinnedHere) console.warn(`Port ${HOME_PORT} is the home page's; it can't start while this Fleet uses it.`);

const { start } = await import('../src/server.js');
const server = start({ port, repo: r, project });
server.hqReady.catch((e) => {
  console.error(`Could not start the agent team: ${e.message}`);
  process.exit(1);
});
server.on('listening', () => {
  const url = `http://localhost:${port}`;
  console.log(`Fleet running at ${url}`);
  if (!has('--no-open')) openBrowser(url);
});
server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${port} is in use. Try --port <n>.` : e.message);
  process.exit(1);
});
