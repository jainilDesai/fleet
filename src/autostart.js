// Start Fleet at login, one login item per repo: a per-user LaunchAgent on macOS, a systemd user
// service on Linux and WSL. It starts without a browser tab, restarts if it crashes, and writes
// its output to ~/.fleet/fleet-<project>.log.
// FLEET_LAUNCH_AGENTS and FLEET_LAUNCHCTL point it at another folder and launchctl (for tests);
// FLEET_SYSTEMD_UNITS and FLEET_SYSTEMCTL do the same for systemd.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { OS } from './platform.js';
import { freePort } from './registry.js';

const SYSTEMD = OS !== 'mac';

// The single login item older versions made, still recognised as its repo's item.
export const LABEL = 'com.jainildesai.fleet';
export const labelFor = (slug) => (SYSTEMD ? `fleet-${slug}` : `${LABEL}.${slug}`);
// The home page's own login item (com.jainildesai.fleet.home, fleet-home.service).
export const HOME_LABEL = labelFor('home');
const AGENTS = SYSTEMD
  ? process.env.FLEET_SYSTEMD_UNITS || path.join(os.homedir(), '.config', 'systemd', 'user')
  : process.env.FLEET_LAUNCH_AGENTS || path.join(os.homedir(), 'Library', 'LaunchAgents');
const EXT = SYSTEMD ? '.service' : '.plist';
const PLIST = path.join(AGENTS, `${LABEL}.plist`);
const SCRIPT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'fleet.js');

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// node: the Node binary to run Fleet with. pathEnv: the PATH Fleet needs to find `claude`;
// launchd starts agents with a bare PATH, so it is recorded at install time.
// args: what follows the script; by default a project's --no-open --port <port> [--repo <repo>].
const fleetArgs = (port, repo) => ['--no-open', '--port', String(port), ...(repo ? ['--repo', repo] : [])];

export function plist({ label = LABEL, node, script, port, repo, pathEnv, log, args: extra = fleetArgs(port, repo) }) {
  const args = [node, script, ...extra];
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

// systemd quoting: each word in double quotes, specifiers (%) doubled, and in ExecStart (which
// expands variables, unlike Environment) $ doubled too.
const unitWord = (s, dollars = true) => {
  const q = String(s).replace(/[\\"]/g, '\\$&').replace(/%/g, '%%');
  return `"${dollars ? q.replace(/\$/g, '$$$$') : q}"`;
};
const ununit = (s) => s.replace(/\$\$/g, '$').replace(/%%/g, '%').replace(/\\(.)/g, '$1');

// The same login item as a systemd user service. Restart=on-failure is launchd's
// KeepAlive SuccessfulExit=false: a copy that exits cleanly (e.g. its repo already has a Fleet) stays down.
// KillMode=process: stopping or restarting it leaves the agents' tmux sessions running, as launchd does.
export function unit({ node, script, port, repo, pathEnv, log, args: extra = fleetArgs(port, repo) }) {
  const args = [node, script, ...extra];
  return `# Written by fleet --autostart; remove it with fleet --no-autostart.
[Unit]
Description=Fleet${repo ? ` for ${repo.replace(/%/g, '%%')}` : extra[0] === 'home' ? ' home page' : ''}

[Service]
ExecStart=${args.map((a) => unitWord(a)).join(' ')}
Environment=${unitWord(`PATH=${pathEnv}`, false)}
Restart=on-failure
RestartSec=30
KillMode=process
StandardOutput=append:${log.replace(/%/g, '%%')}
StandardError=append:${log.replace(/%/g, '%%')}

[Install]
WantedBy=default.target
`;
}

// A login item Fleet wrote: its label, plist or unit file, and the node, script, port and repo it runs.
export function readItem(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    if (file.endsWith('.service')) {
      if (!text.startsWith('# Written by fleet --autostart')) return null; // someone else's fleet-*.service
      const args = [...(text.match(/^ExecStart=(.*)$/m)?.[1] ?? '').matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => ununit(m[1]));
      const flag = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : null);
      const log = text.match(/^StandardOutput=append:(.*)$/m)?.[1];
      return { label: path.basename(file, '.service'), file, node: args[0], script: args[1], port: Number(flag('--port')) || null, repo: flag('--repo'), log: log && log.replace(/%%/g, '%') };
    }
    const args = [...(text.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1] ?? '').matchAll(/<string>([^<]*)<\/string>/g)].map((m) => unxml(m[1]));
    const flag = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : null);
    const log = text.match(/<key>StandardOutPath<\/key>\s*<string>([^<]*)<\/string>/)?.[1];
    return { label: path.basename(file, '.plist'), file, node: args[0], script: args[1], port: Number(flag('--port')) || null, repo: flag('--repo'), log: log && unxml(log) };
  } catch {
    return null;
  }
}

// Every Fleet login item: the older com.jainildesai.fleet and the per-project com.jainildesai.fleet.<slug>
// on macOS; fleet-<slug>.service elsewhere.
export function items() {
  let files;
  try {
    files = fs.readdirSync(AGENTS);
  } catch {
    return [];
  }
  return files
    .filter((f) => (SYSTEMD ? f.startsWith('fleet-') && f.endsWith(EXT) : f === `${LABEL}.plist` || (f.startsWith(`${LABEL}.`) && f.endsWith('.plist'))))
    .map((f) => readItem(path.join(AGENTS, f)))
    .filter(Boolean);
}

// A repo's login items; an older com.jainildesai.fleet item without --repo counts for any repo.
export const itemsFor = (repo) => items().filter((i) => i.repo === repo || (i.label === LABEL && !i.repo));
export const homeItem = () => items().find((i) => i.label === HOME_LABEL && !i.repo) ?? null;

const domain = () => `gui/${process.getuid()}`;
const launchctl = (...args) => execFileSync(process.env.FLEET_LAUNCHCTL || 'launchctl', args, { stdio: 'pipe', encoding: 'utf8' });
const systemctl = (...args) => execFileSync(process.env.FLEET_SYSTEMCTL || 'systemctl', ['--user', ...args], { stdio: 'pipe', encoding: 'utf8' });
const unitName = (item) => path.basename(item.file);

// systemd user services need a running user manager; WSL has none unless systemd is turned on.
export function systemdReady() {
  try {
    systemctl('show-environment');
    return true;
  } catch {
    return false;
  }
}

const NO_SYSTEMD =
  OS === 'wsl'
    ? `Start at login needs systemd, which this WSL doesn't run. Turn it on: add these lines to /etc/wsl.conf

  [boot]
  systemd=true

then run "wsl --shutdown" in Windows and open your Linux terminal again. Or just run fleet in a terminal.`
    : 'Start at login needs systemd user services ("systemctl --user"), which this system does not have. Run fleet in a terminal instead.';

// Unloads (and stops) a login item.
const unload = (file) => (SYSTEMD ? systemctl('disable', '--now', path.basename(file)) : launchctl('bootout', domain(), file));

// npx runs Fleet from a cache folder npm may delete at any time; a login item can't point there.
export const fromNpx = (script = SCRIPT) => script.split(path.sep).includes('_npx');

// Writes a login item (replacing `old` ones) and starts it now.
function install({ label, log, args, old = [] }) {
  if (fromNpx()) {
    const { name } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    throw new Error(`Fleet is running from the npx cache, which npm can clear at any time. Install it first, then run this again:\n\n  npm install -g ${name}\n  fleet --autostart`);
  }
  if (SYSTEMD && !systemdReady()) throw new Error(NO_SYSTEMD);
  const file = path.join(AGENTS, `${label}${EXT}`);
  fs.mkdirSync(AGENTS, { recursive: true });
  fs.mkdirSync(path.dirname(log), { recursive: true });
  for (const o of new Map([...old, readItem(file)].filter(Boolean).map((i) => [i.file, i])).values()) {
    if (SYSTEMD && o.file === file) continue; // restarted below under the new unit, whose KillMode spares tmux
    try {
      unload(o.file);
    } catch {}
    fs.rmSync(o.file, { force: true });
  }
  const make = SYSTEMD ? unit : plist;
  fs.writeFileSync(file, make({ label, node: process.execPath, script: SCRIPT, args, pathEnv: process.env.PATH ?? '/usr/bin:/bin', log }));
  if (SYSTEMD) {
    systemctl('daemon-reload');
    systemctl('enable', path.basename(file));
    systemctl('restart', path.basename(file));
  } else launchctl('bootstrap', domain(), file);
  return { label, plist: file, log, systemd: SYSTEMD };
}

// Replaces this repo's login item (an older com.jainildesai.fleet one too) and starts it now.
export function enable({ port, repo, slug }) {
  const log = path.join(os.homedir(), '.fleet', `fleet-${slug}.log`);
  return { ...install({ label: labelFor(slug), log, args: fleetArgs(port, repo), old: itemsFor(repo) }), port, repo };
}

// The home page's login item, started now.
export const enableHome = (port) => ({ ...install({ label: HOME_LABEL, log: path.join(os.homedir(), '.fleet', 'fleet-home.log'), args: ['home', '--serve', '--port', String(port)] }), port });

// Project login items pinned to the home page's port (written before the home page had it) move to
// the next free port after it, and restart there. The agents' tmux sessions keep running.
export async function moveOff(port, slugOf) {
  const moved = [];
  for (const i of items()) {
    if (!i.repo || i.port !== port) continue;
    const to = await freePort(port + 1, items().map((x) => x.port));
    enable({ port: to, repo: i.repo, slug: slugOf(i.repo) });
    moved.push({ repo: i.repo, from: port, to });
  }
  return moved;
}

// Removes this repo's login items (or the ones given) and stops their copies. Returns how many there were.
export function disable(repo, mine = itemsFor(repo)) {
  for (const i of mine) {
    try {
      unload(i.file);
    } catch {}
    fs.rmSync(i.file);
  }
  if (SYSTEMD && mine.length)
    try {
      systemctl('daemon-reload');
    } catch {}
  return mine.length;
}

// What launchd (or systemd) says about a login item. `loaded` but not `running` is a copy that keeps exiting.
export function jobState(label) {
  if (SYSTEMD) {
    let out = '';
    try {
      out = systemctl('show', `${label}.service`, '--property=ActiveState,SubState,ExecMainStatus');
    } catch {}
    const v = (k) => out.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1];
    return { loaded: !!v('ActiveState') && v('ActiveState') !== 'inactive', running: v('SubState') === 'running', lastExit: v('ExecMainStatus') ?? null };
  }
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
  if (SYSTEMD) systemctl('restart', unitName(item));
  else if (s.loaded) launchctl('kickstart', `${domain()}/${item.label}`);
  else launchctl('bootstrap', domain(), item.file);
  return { state: 'started', lastExit: s.loaded && s.lastExit !== '0' ? s.lastExit : null };
}

// A process command line that is Fleet's server: node running bin/fleet.js, or npm's link to it
// (bin/fleet for a global install, node_modules/.bin/fleet for a local install or npx).
export const isFleetCommand = (cmd) => /(^|\/)node\s(.*[\s/])?\.?bin\/fleet(\.js)?(\s|$)/.test(cmd);

// The home page's server (fleet home --serve): stopped only with --all.
export const isHomeCommand = (cmd) => /bin\/fleet(\.js)?\s+home\s/.test(`${cmd} `);

// The --repo a Fleet command line was started with, if any.
export const repoArg = (cmd) => cmd.match(/\s--repo\s+(.+?)(?=\s--|$)/)?.[1] ?? null;

// Which running Fleets to stop: the one for `repo` (from the registry, else its --repo), or all.
// `unknown` counts the copies whose repo can't be told, left running unless `all`.
export function pidsToStop(processes, registry, repo, all) {
  const pids = [];
  let unknown = 0;
  for (const p of processes) {
    if (p.pid === process.pid || !isFleetCommand(p.cmd) || (!all && isHomeCommand(p.cmd))) continue;
    const at = registry.find((e) => e.pid === p.pid)?.repo ?? repoArg(p.cmd);
    if (all || at === repo) pids.push(p.pid);
    else if (!at) unknown++;
  }
  return { pids, unknown };
}

// -e is procps's spelling of macOS's -ax: every process.
const processes = () =>
  execFileSync('ps', SYSTEMD ? ['-eo', 'pid=,args='] : ['-axo', 'pid=,command='], { encoding: 'utf8' })
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
    if (SYSTEMD) systemctl('stop', unitName(i));
    else launchctl('bootout', domain(), i.file);
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
