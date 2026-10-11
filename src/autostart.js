// Start Fleet at login with a per-user LaunchAgent. launchd starts it without a browser tab,
// restarts it if it crashes, and writes its output to ~/.fleet/fleet.log.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

export const LABEL = 'com.jainildesai.fleet';
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LOG = path.join(os.homedir(), '.fleet', 'fleet.log');
const SCRIPT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'fleet.js');

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// node: the Node binary to run Fleet with. pathEnv: the PATH Fleet needs to find `claude`;
// launchd starts agents with a bare PATH, so it is recorded at install time.
export function plist({ node, script, port, pathEnv, log }) {
  const args = [node, script, '--no-open', '--port', String(port)];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
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

const domain = () => `gui/${process.getuid()}`;
const launchctl = (...args) => execFileSync('launchctl', args, { stdio: 'pipe' });

export function enable(port) {
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  try {
    launchctl('bootout', domain(), PLIST); // replace an older registration
  } catch {}
  fs.writeFileSync(PLIST, plist({ node: process.execPath, script: SCRIPT, port, pathEnv: process.env.PATH ?? '/usr/bin:/bin', log: LOG }));
  launchctl('bootstrap', domain(), PLIST);
  return { plist: PLIST, log: LOG, port };
}

export function disable() {
  if (!fs.existsSync(PLIST)) return false;
  try {
    launchctl('bootout', domain(), PLIST);
  } catch {}
  fs.rmSync(PLIST);
  return true;
}

// The Node path recorded at install time, when it no longer exists (e.g. nvm removed that
// version). launchd then can't start Fleet at all, so this is checked on a manual start.
export function staleNode() {
  try {
    const node = fs.readFileSync(PLIST, 'utf8').match(/<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]+)<\/string>/)?.[1];
    return node && !fs.existsSync(node.replace(/&amp;/g, '&')) ? node : null;
  } catch {
    return null;
  }
}
