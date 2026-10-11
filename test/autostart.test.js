import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tempHome } from './fixtures.js';

const home = tempHome();
process.env.HOME = home; // the LaunchAgent path is resolved from the home folder at import
const { plist, staleNode, LABEL } = await import('../src/autostart.js');

const sample = { node: '/opt/node & co/bin/node', script: '/lib/fleet/bin/fleet.js', port: 7788, pathEnv: '/usr/bin:/bin', log: '/tmp/fleet.log' };

test('writes a valid LaunchAgent that starts Fleet without a browser tab', () => {
  const xml = plist(sample);
  const file = path.join(home, 'check.plist');
  fs.writeFileSync(file, xml);
  execFileSync('plutil', ['-lint', file]); // throws if macOS can't read it
  const json = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', file]).toString());
  assert.equal(json.Label, LABEL);
  assert.deepEqual(json.ProgramArguments, ['/opt/node & co/bin/node', '/lib/fleet/bin/fleet.js', '--no-open', '--port', '7788']);
  assert.equal(json.EnvironmentVariables.PATH, '/usr/bin:/bin');
  assert.equal(json.RunAtLoad, true);
  assert.deepEqual(json.KeepAlive, { SuccessfulExit: false }, 'restart on crash only');
  assert.equal(json.StandardErrorPath, '/tmp/fleet.log');
});

test('notices when the recorded Node no longer exists', () => {
  const agent = path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  fs.mkdirSync(path.dirname(agent), { recursive: true });
  fs.writeFileSync(agent, plist({ ...sample, node: process.execPath }));
  assert.equal(staleNode(), null);
  fs.writeFileSync(agent, plist({ ...sample, node: '/nowhere/node-v1/bin/node' }));
  assert.equal(staleNode(), '/nowhere/node-v1/bin/node');
});
