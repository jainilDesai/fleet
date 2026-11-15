// Start at login on Linux and WSL: systemd user services, driven through a fake systemctl.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { tempHome } from './fixtures.js';

const home = tempHome();
process.env.HOME = home;
process.env.FLEET_PLATFORM = 'linux';
const units = path.join(home, '.config', 'systemd', 'user');
const calls = path.join(home, 'systemctl.log');
const fake = path.join(home, 'systemctl');
// Logs its arguments; `show-environment` fails with $FAKE_NO_SYSTEMD; `show` reports $FAKE_ACTIVE/$FAKE_SUB.
fs.writeFileSync(
  fake,
  `#!/bin/sh
echo "$@" >> "${calls}"
[ "$2" = show-environment ] && [ -n "$FAKE_NO_SYSTEMD" ] && { echo "Failed to connect to bus" >&2; exit 1; }
[ "$2" = show ] && printf "ActiveState=%s\\nSubState=%s\\nExecMainStatus=%s\\n" "\${FAKE_ACTIVE:-inactive}" "\${FAKE_SUB:-dead}" "\${FAKE_EXIT:-0}"
exit 0
`,
  { mode: 0o755 },
);
process.env.FLEET_SYSTEMCTL = fake;
process.env.FLEET_SYSTEMD_UNITS = units;
const systemctlCalls = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : []);
const { unit, readItem, items, itemsFor, labelFor, enable, disable, jobState, startBackground, stop, moveOff, enableHome, homeItem, HOME_LABEL } = await import('../src/autostart.js');

const sample = { node: '/opt/node 22/bin/node', script: '/lib/fleet/bin/fleet.js', port: 7788, pathEnv: '/usr/bin:/home/a/.local/bin', log: '/home/a/.fleet/fleet-app.log' };

test('writes a user service that runs what launchd runs, restarting on failure only', () => {
  const text = unit({ ...sample, repo: '/code/my "app" 100% $HOME' });
  assert.match(text, /^Restart=on-failure$/m);
  assert.match(text, /^Environment="PATH=\/usr\/bin:\/home\/a\/\.local\/bin"$/m);
  assert.match(text, /^StandardOutput=append:\/home\/a\/\.fleet\/fleet-app\.log$/m);
  assert.match(text, /^StandardError=append:\/home\/a\/\.fleet\/fleet-app\.log$/m);
  assert.match(text, /^WantedBy=default\.target$/m);
  assert.match(text, /^ExecStart="\/opt\/node 22\/bin\/node" "\/lib\/fleet\/bin\/fleet\.js" "--no-open" "--port" "7788" "--repo" "\/code\/my \\"app\\" 100%% \$\$HOME"$/m);
  const file = path.join(home, 'check.service');
  fs.writeFileSync(file, text);
  assert.deepEqual(readItem(file), { label: 'check', file, node: sample.node, script: sample.script, port: 7788, repo: '/code/my "app" 100% $HOME', log: sample.log });
});

test('one service per project: --autostart replaces this repo\'s, --no-autostart removes only this repo\'s', () => {
  fs.mkdirSync(units, { recursive: true });
  fs.writeFileSync(path.join(units, 'fleet-site.service'), unit({ ...sample, port: 7790, repo: '/code/site' }));
  fs.writeFileSync(path.join(units, 'fleet-app-old.service'), unit({ ...sample, repo: '/code/app' }));
  fs.writeFileSync(path.join(units, 'fleet-other.service'), '[Service]\nExecStart=/usr/bin/fleetctl\n'); // not Fleet's
  assert.deepEqual(items().map((i) => i.label).sort(), ['fleet-app-old', 'fleet-site']);
  assert.equal(labelFor('app'), 'fleet-app');

  fs.rmSync(calls, { force: true });
  const r = enable({ port: 7788, repo: '/code/app', slug: 'app' });
  assert.equal(r.systemd, true);
  assert.equal(r.plist, path.join(units, 'fleet-app.service'));
  assert.equal(r.log, path.join(home, '.fleet', 'fleet-app.log'));
  assert.ok(!fs.existsSync(path.join(units, 'fleet-app-old.service')), 'older item for this repo removed');
  const item = itemsFor('/code/app')[0];
  assert.deepEqual([item.label, item.port, item.node, item.script.endsWith(path.join('bin', 'fleet.js')), item.log], ['fleet-app', 7788, process.execPath, true, r.log]);
  assert.deepEqual(systemctlCalls(), ['--user show-environment', '--user disable --now fleet-app-old.service', '--user daemon-reload', '--user enable fleet-app.service', '--user restart fleet-app.service']);
  assert.equal(itemsFor('/code/site').length, 1, 'other projects untouched');

  fs.rmSync(calls, { force: true });
  assert.equal(disable('/code/app'), 1);
  assert.equal(disable('/code/app'), 0);
  assert.deepEqual(systemctlCalls(), ['--user disable --now fleet-app.service', '--user daemon-reload']);
  assert.deepEqual(items().map((i) => i.label), ['fleet-site']);
  assert.ok(fs.existsSync(path.join(units, 'fleet-other.service')), "someone else's unit is left alone");
});

test('--start and --stop read the real state: a restarting service is restarted, a stopped one is not stopped again', () => {
  const site = itemsFor('/code/site')[0];
  fs.rmSync(calls, { force: true });
  process.env.FAKE_ACTIVE = 'active';
  process.env.FAKE_SUB = 'running';
  assert.deepEqual(jobState(site.label), { loaded: true, running: true, lastExit: '0' });
  assert.deepEqual(startBackground(site), { state: 'running' });
  process.env.FAKE_ACTIVE = 'activating';
  process.env.FAKE_SUB = 'auto-restart';
  process.env.FAKE_EXIT = '1';
  assert.deepEqual(startBackground(site), { state: 'started', lastExit: '1' });
  assert.equal(systemctlCalls().at(-1), '--user restart fleet-site.service');

  // `unknown` counts any Fleet the other test files are running at the same moment, so it isn't checked.
  assert.deepEqual({ ...stop({ repo: '/code/site' }), unknown: 0 }, { background: 1, manual: 0, unknown: 0 });
  assert.equal(systemctlCalls().at(-1), '--user stop fleet-site.service');
  process.env.FAKE_ACTIVE = 'inactive';
  fs.rmSync(calls, { force: true });
  assert.equal(stop({ repo: '/code/site' }).background, 0);
  assert.ok(!systemctlCalls().some((c) => c.includes(' stop ')));
  delete process.env.FAKE_ACTIVE;
  delete process.env.FAKE_SUB;
  delete process.env.FAKE_EXIT;
});

test('--autostart without systemd says how to turn it on (WSL) and writes nothing', () => {
  const repo = path.join(home, 'toy');
  fs.mkdirSync(repo);
  const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' });
  git('init', '-q');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'first');
  const cli = new URL('../bin/fleet.js', import.meta.url).pathname;
  const before = fs.readdirSync(units);
  for (const [platform, message] of [['wsl', /\/etc\/wsl\.conf[\s\S]*systemd=true/], ['linux', /systemctl --user/]]) {
    const r = spawnSync(process.execPath, [cli, '--autostart', '--repo', repo, '--port', '7829'], { env: { ...process.env, FLEET_PLATFORM: platform, FAKE_NO_SYSTEMD: '1' }, encoding: 'utf8' });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, message);
  }
  assert.deepEqual(fs.readdirSync(units), before);
});

test('upgrading: a service pinned to the home port is rewritten to a free port and restarted in place, keeping tmux', async () => {
  fs.mkdirSync(units, { recursive: true });
  const free = 7880;
  fs.writeFileSync(path.join(units, 'fleet-shop.service'), unit({ ...sample, port: free, repo: '/code/shop' }));
  fs.rmSync(calls, { force: true });
  const moved = await moveOff(free, () => 'shop');
  assert.deepEqual(moved, [{ repo: '/code/shop', from: free, to: free + 1 }]);
  const text = fs.readFileSync(path.join(units, 'fleet-shop.service'), 'utf8');
  assert.match(text, new RegExp(`"--port" "${free + 1}" "--repo" "/code/shop"`));
  assert.match(text, /^KillMode=process$/m, 'stopping Fleet leaves the agents\' tmux sessions running');
  // Not stopped under the old unit (whose default KillMode would kill tmux): reloaded, then restarted.
  assert.deepEqual(systemctlCalls(), ['--user show-environment', '--user daemon-reload', '--user enable fleet-shop.service', '--user restart fleet-shop.service']);

  enableHome(free);
  assert.equal(HOME_LABEL, 'fleet-home');
  assert.deepEqual([homeItem().port, homeItem().repo], [free, null]);
  assert.match(fs.readFileSync(path.join(units, 'fleet-home.service'), 'utf8'), /^Description=Fleet home page$/m);
  assert.equal(disable(null, [homeItem()]), 1);
  assert.equal(homeItem(), null);
  assert.equal(itemsFor('/code/shop').length, 1, 'the project keeps its service');
});
