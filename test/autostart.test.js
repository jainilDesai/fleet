import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tempHome } from './fixtures.js';

const home = tempHome();
process.env.HOME = home; // the LaunchAgent path is resolved from the home folder at import
process.env.FLEET_PLATFORM = 'mac'; // launchd, with the fake launchctl below, on any OS
// plutil (to check the plist the way macOS reads it) only exists on macOS.
const plutil = { skip: process.platform !== 'darwin' && 'plutil is macOS-only; the plist is covered on macOS CI' };
// A fake launchctl: logs its arguments, and `print` answers with the state in $FAKE_STATE (none: not loaded).
const agents = path.join(home, 'Library', 'LaunchAgents');
const calls = path.join(home, 'launchctl.log');
const fake = path.join(home, 'launchctl');
fs.writeFileSync(fake, `#!/bin/sh\necho "$@" >> "${calls}"\nif [ "$1" = print ]; then [ -n "$FAKE_STATE" ] || exit 113; printf "\\tstate = %s\\n\\tlast exit code = %s\\n" "$FAKE_STATE" "\${FAKE_EXIT:-0}"; fi\n`, { mode: 0o755 });
process.env.FLEET_LAUNCHCTL = fake;
process.env.FLEET_LAUNCH_AGENTS = agents;
const launchctlCalls = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : []);
const { plist, staleNode, LABEL, labelFor, isFleetCommand, items, itemsFor, enable, disable, jobState, startBackground, pidsToStop, fromNpx, repoArg } = await import('../src/autostart.js');

const sample = { node: '/opt/node & co/bin/node', script: '/lib/fleet/bin/fleet.js', port: 7788, pathEnv: '/usr/bin:/bin', log: '/tmp/fleet.log' };

test('writes a valid LaunchAgent that starts Fleet without a browser tab', plutil, () => {
  const xml = plist(sample);
  const file = path.join(home, 'check.plist');
  fs.writeFileSync(file, xml);
  execFileSync('plutil', ['-lint', file]); // throws if macOS can't read it
  const json = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', file]).toString());
  assert.equal(json.Label, LABEL);
  assert.deepEqual(json.ProgramArguments, ['/opt/node & co/bin/node', '/lib/fleet/bin/fleet.js', '--no-open', '--port', '7788']);
  assert.equal(json.EnvironmentVariables.PATH, '/usr/bin:/bin');
  const withRepo = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', '-'], { input: plist({ ...sample, repo: '/code/my app' }) }).toString());
  assert.deepEqual(withRepo.ProgramArguments.slice(-2), ['--repo', '/code/my app']);
  assert.equal(json.RunAtLoad, true);
  assert.deepEqual(json.KeepAlive, { SuccessfulExit: false }, 'restart on crash only');
  assert.equal(json.StandardErrorPath, '/tmp/fleet.log');
});

test('notices when the recorded Node or Fleet script no longer exists', () => {
  const agent = path.join(home, 'stale.plist');
  const script = new URL('../bin/fleet.js', import.meta.url).pathname;
  fs.writeFileSync(agent, plist({ ...sample, node: process.execPath, script }));
  assert.equal(staleNode(agent), null);
  fs.writeFileSync(agent, plist({ ...sample, node: '/nowhere/node-v1/bin/node', script }));
  assert.equal(staleNode(agent), '/nowhere/node-v1/bin/node');
  fs.writeFileSync(agent, plist({ ...sample, node: process.execPath, script: '/gone/fleet/bin/fleet.js' }));
  assert.equal(staleNode(agent), '/gone/fleet/bin/fleet.js');
});

test('one login item per project; the older com.jainildesai.fleet item still counts as its repo\'s', plutil, () => {
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(agents, `${LABEL}.plist`), plist({ ...sample, repo: '/code/app' })); // what 0.3 wrote
  fs.writeFileSync(path.join(agents, `${labelFor('site')}.plist`), plist({ ...sample, label: labelFor('site'), port: 7790, repo: '/code/site' }));
  fs.writeFileSync(path.join(agents, 'com.other.app.plist'), plist({ ...sample, label: 'com.other.app' }));
  assert.deepEqual(items().map((i) => i.label).sort(), [LABEL, labelFor('site')]);
  assert.deepEqual(itemsFor('/code/app').map((i) => [i.label, i.port]), [[LABEL, 7788]]);
  assert.deepEqual(itemsFor('/code/site').map((i) => [i.label, i.port]), [[labelFor('site'), 7790]]);

  // Re-running --autostart in /code/app replaces the older item with com.jainildesai.fleet.app, same port.
  fs.rmSync(calls, { force: true });
  const r = enable({ port: itemsFor('/code/app')[0].port, repo: '/code/app', slug: 'app' });
  assert.equal(r.label, 'com.jainildesai.fleet.app');
  assert.ok(!fs.existsSync(path.join(agents, `${LABEL}.plist`)), 'older item removed');
  const json = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', r.plist]).toString());
  assert.equal(json.Label, 'com.jainildesai.fleet.app');
  assert.deepEqual(json.ProgramArguments.slice(2), ['--no-open', '--port', '7788', '--repo', '/code/app']);
  assert.equal(json.StandardOutPath, path.join(home, '.fleet', 'fleet-app.log'));
  assert.equal(itemsFor('/code/app')[0].log, json.StandardOutPath);
  const log = launchctlCalls();
  assert.match(log[0], new RegExp(`^bootout gui/\\d+ .*${LABEL}\\.plist$`));
  assert.match(log.at(-1), /^bootstrap gui\/\d+ .*com\.jainildesai\.fleet\.app\.plist$/);
  assert.deepEqual(itemsFor('/code/site').length, 1, 'other projects untouched');

  assert.equal(disable('/code/app'), 1);
  assert.equal(disable('/code/app'), 0);
  assert.deepEqual(items().map((i) => i.label), [labelFor('site')]);
});

test('--start checks the real state: a crash-looping job is kicked, not reported as running', () => {
  // The same item the test above leaves, written here too because that one is skipped off macOS.
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(agents, `${labelFor('site')}.plist`), plist({ ...sample, label: labelFor('site'), port: 7790, repo: '/code/site' }));
  const item = itemsFor('/code/site')[0];
  fs.rmSync(calls, { force: true });
  process.env.FAKE_STATE = 'running';
  assert.deepEqual(startBackground(item), { state: 'running' });
  process.env.FAKE_STATE = 'spawn scheduled';
  process.env.FAKE_EXIT = '1';
  assert.deepEqual(jobState(item.label), { loaded: true, running: false, lastExit: '1' });
  assert.deepEqual(startBackground(item), { state: 'started', lastExit: '1' });
  assert.match(launchctlCalls().at(-1), new RegExp(`^kickstart gui/\\d+/${item.label}$`));
  delete process.env.FAKE_STATE;
  assert.equal(startBackground(item).state, 'started');
  assert.match(launchctlCalls().at(-1), /^bootstrap /);
});

test('--autostart refuses to run from the npx cache', () => {
  assert.ok(fromNpx('/Users/a/.npm/_npx/9f2c/node_modules/@jainil_desai/fleet/bin/fleet.js'));
  assert.ok(!fromNpx('/usr/local/lib/node_modules/@jainil_desai/fleet/bin/fleet.js'));
  assert.ok(!fromNpx('/Users/a/code/my_npx_tools/fleet/bin/fleet.js'));
});

test('--stop picks only this repo\'s Fleet, unless --all', () => {
  const ps = [
    { pid: 101, cmd: '/usr/local/bin/node /usr/local/lib/node_modules/@jainil_desai/fleet/bin/fleet.js --no-open --port 7788 --repo /code/my app' },
    { pid: 102, cmd: 'node /usr/local/bin/fleet' }, // started by hand in /code/site: known from the registry
    { pid: 103, cmd: 'node /usr/local/bin/fleet --port 7795' }, // repo unknown
    { pid: 104, cmd: 'vim bin/fleet.js' },
    { pid: 105, cmd: '/usr/local/bin/node /usr/local/lib/node_modules/@jainil_desai/fleet/bin/fleet.js home --serve --port 7788' }, // the home page
    { pid: process.pid, cmd: 'node bin/fleet.js --stop' },
  ];
  const registry = [{ pid: 102, repo: '/code/site', port: 7789 }];
  assert.equal(repoArg(ps[0].cmd), '/code/my app');
  assert.deepEqual(pidsToStop(ps, registry, '/code/my app', false), { pids: [101], unknown: 1 });
  assert.deepEqual(pidsToStop(ps, registry, '/code/site', false), { pids: [102], unknown: 1 });
  assert.deepEqual(pidsToStop(ps, registry, '/code/site', true), { pids: [101, 102, 103, 105], unknown: 0 }, '--all stops the home page too');
});

test('--stop only matches Fleet servers, not other processes', () => {
  assert.ok(isFleetCommand('/Users/a/.nvm/versions/node/v22.23.0/bin/node /Users/a/.nvm/versions/node/v22.23.0/bin/fleet'));
  assert.ok(isFleetCommand('/usr/local/bin/node /usr/local/lib/node_modules/@jainil_desai/fleet/bin/fleet.js --no-open --port 7788'));
  assert.ok(isFleetCommand('node /Users/a/code/fleet/bin/fleet.js --port 7799'));
  assert.ok(isFleetCommand('node bin/fleet.js --no-open'), 'started from the repo folder');
  assert.ok(isFleetCommand('node node_modules/.bin/fleet --port 7814'), 'a local install or npx');
  assert.ok(isFleetCommand('node /Users/a/.npm/_npx/9f2c/node_modules/.bin/fleet'), 'npx cache');
  assert.ok(!isFleetCommand('node /Users/a/code/fleet/bin/statusline.js'), 'the statusline script is not the server');
  assert.ok(!isFleetCommand('node /srv/app/bin/fleet-manager.js'));
  assert.ok(!isFleetCommand('/bin/zsh -c grep bin/fleet.js notes.txt'), 'not node');
  assert.ok(!isFleetCommand('vim /Users/a/code/fleet/bin/fleet.js'));
});
