// Start Fleet at login with a per-user LaunchAgent, one per repo. launchd starts it without a
// browser tab, restarts it if it crashes, and writes its output to ~/.fleet/fleet-<project>.log.
// FLEET_LAUNCH_AGENTS and FLEET_LAUNCHCTL point it at another folder and launchctl (for tests).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

// The single login item older versions made, still recognised as its repo's item.
export const LABEL = 'com.jainildesai.fleet';
export const labelFor = (slug) => `${LABEL}.${slug}`;
const AGENTS = process.env.FLEET_LAUNCH_AGENTS || path.join(os.homedir(), 'Library', 'LaunchAgents');
const PLIST = path.join(AGENTS, `${LABEL}.plist`);
const SCRIPT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'fleet.js');

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// node: the Node binary to run Fleet with. pathEnv: the PATH Fleet needs to find `claude`;
// launchd starts agents with a bare PATH, so it is recorded at install time.
export function plist({ label = LABEL, node, script, port, repo, pathEnv, log }) {
  const args = [node, script, '--no-open', '--port', String(port), ...(repo ? ['--repo', repo] : [])];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(pathEnv)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
}

// A login item Fleet wrote: its label, plist file, and the node, script, port and repo it runs.
export function readItem(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const args = [...(text.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1] ?? '').matchAll(/<string>([^<]*)<\/string>/g)].map((m) => unxml(m[1]));
    const flag = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : null);
    const log = text.match(/<key>StandardOutPath<\/key>\s*<string>([^<]*)<\/string>/)?.[1];
    return { label: path.basename(file, '.plist'), file, node: args[0], script: args[1], port: Number(flag('--port')) || null, repo: flag('--repo'), log: log && unxml(log) };
  } catch {
    return null;
  }
}

// Every Fleet login item: the older com.jainildesai.fleet and the per-project com.jainildesai.fleet.<slug>.
export function items() {
  let files;
  try {
    files = fs.readdirSync(AGENTS);
  } catch {
    return [];
  }
  return files
    .filter((f) => f === `${LABEL}.plist` || (f.startsWith(`${LABEL}.`) && f.endsWith('.plist')))
    .map((f) => readItem(path.join(AGENTS, f)))
    .filter(Boolean);
}

// A repo's login items; an older com.jainildesai.fleet item without --repo counts for any repo.
export const itemsFor = (repo) => items().filter((i) => i.repo === repo || (i.label === LABEL && !i.repo));

const domain = () => `gui/${process.getuid()}`;
const launchctl = (...args) => execFileSync(process.env.FLEET_LAUNCHCTL || 'launchctl', args, { stdio: 'pipe', encoding: 'utf8' });

// npx runs Fleet from a cache folder npm may delete at any time; a login item can't point there.
export const fromNpx = (script = SCRIPT) => script.split(path.sep).includes('_npx');

// Replaces this repo's login item (an older com.jainildesai.fleet one too) and starts it now.
export function enable({ port, repo, slug }) {
  if (fromNpx()) {
    const { name } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    throw new Error(`Fleet is running from the npx cache, which npm can clear at any time. Install it first, then run this again:\n\n  npm install -g ${name}\n  fleet --autostart`);
  }
  const label = labelFor(slug);
  const file = path.join(AGENTS, `${label}.plist`);
  const log = path.join(os.homedir(), '.fleet', `fleet-${slug}.log`);
  fs.mkdirSync(AGENTS, { recursive: true });
  fs.mkdirSync(path.dirname(log), { recursive: true });
  for (const old of [...itemsFor(repo), readItem(file)].filter(Boolean)) {
    try {
      launchctl('bootout', domain(), old.file);
    } catch {}
    fs.rmSync(old.file, { force: true });
  }
  fs.writeFileSync(file, plist({ label, node: process.execPath, script: SCRIPT, port, repo, pathEnv: process.env.PATH ?? '/usr/bin:/bin', log }));
  launchctl('bootstrap', domain(), file);
  return { label, plist: file, log, port, repo };
}

// Removes this repo's login items and stops their copies. Returns how many there were.
export function disable(repo) {
  const mine = itemsFor(repo);
  for (const i of mine) {
    try {
      launchctl('bootout', domain(), i.file);
    } catch {}
    fs.rmSync(i.file);
  }
  return mine.length;
}

// What launchd says about a login item. `loaded` but not `running` is a copy that keeps exiting.
export function jobState(label) {
  let out;
  try {
    out = launchctl('print', `${domain()}/${label}`);
  } catch {
    return { loaded: false, running: false, lastExit: null };
  }
  return { loaded: true, running: /^\s*state = running\s*$/m.test(out), lastExit: out.match(/last exit code = (-?\d+)/)?.[1] ?? null };
}

// Starts a login item's copy now; it starts at login anyway. 'running', or 'started' with the
// exit code of its last run when it had stopped.
export function startBackground(item) {
  const s = jobState(item.label);
  if (s.running) return { state: 'running' };
  if (s.loaded) launchctl('kickstart', `${domain()}/${item.label}`);
  else launchctl('bootstrap', domain(), item.file);
  return { state: 'started', lastExit: s.loaded && s.lastExit !== '0' ? s.lastExit : null };
}

// A process command line that is Fleet's server: node running bin/fleet.js, or npm's link to it
// (bin/fleet for a global install, node_modules/.bin/fleet for a local install or npx).
export const isFleetCommand = (cmd) => /(^|\/)node\s(.*[\s/])?\.?bin\/fleet(\.js)?(\s|$)/.test(cmd);

// The --repo a Fleet command line was started with, if any.
export const repoArg = (cmd) => cmd.match(/\s--repo\s+(.+?)(?=\s--|$)/)?.[1] ?? null;

// Which running Fleets to stop: the one for `repo` (from the registry, else its --repo), or all.
// `unknown` counts the copies whose repo can't be told, left running unless `all`.
export function pidsToStop(processes, registry, repo, all) {
  const pids = [];
  let unknown = 0;
  for (const p of processes) {
    if (p.pid === process.pid || !isFleetCommand(p.cmd)) continue;
    const at = registry.find((e) => e.pid === p.pid)?.repo ?? repoArg(p.cmd);
    if (all || at === repo) pids.push(p.pid);
    else if (!at) unknown++;
  }
  return { pids, unknown };
}

const processes = () =>
  execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), cmd: m[2] }));

// Stops the Fleet for `repo` (or every Fleet). Background copies are unloaded rather than killed,
// because launchd restarts a killed one; they come back at the next login. Copies started by hand
// get SIGTERM.
export function stop({ repo, all = false, registry = [] }) {
  let background = 0;
  for (const i of all ? items() : itemsFor(repo)) {
    if (!jobState(i.label).loaded) continue;
    launchctl('bootout', domain(), i.file);
    background++;
  }
  const { pids, unknown } = pidsToStop(processes(), registry, repo, all);
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  }
  return { background, manual: pids.length, unknown };
}

// The Node or Fleet path a login item recorded, when it no longer exists (e.g. nvm removed that
// Node, or Fleet was reinstalled elsewhere). launchd then can't start Fleet, so this is checked on
// a manual start.
export function staleNode(file = PLIST) {
  const i = readItem(file);
  return [i?.node, i?.script].find((p) => p && !fs.existsSync(p)) ?? null;
}
