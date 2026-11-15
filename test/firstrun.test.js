// A fresh machine and a fresh repo: what `fleet` does before anything else is set up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const bin = new URL('../bin/fleet.js', import.meta.url).pathname;
const fleet = (...args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env: { ...process.env, FLEET_PORT: '' } });

test('bad --port values are rejected before anything starts', () => {
  for (const args of [['--port', 'abc'], ['--port', '0'], ['--port', '70000'], ['--port']]) {
    const r = fleet(...args);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, /Port must be a number|needs a value/);
  }
});

test('unknown flags point at --help', () => {
  const r = fleet('--bogus');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Unknown option: --bogus.*--help/);
});

test('--version prints the package version', () => {
  const r = fleet('--version');
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
});

test('a repo with no commits stops with a clear message', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-empty-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const r = fleet('--repo', dir, '--port', '7899', '--no-open');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no commits yet/);
});

test('no ~/.claude yet reads as no sessions, with nothing logged', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-nohome-'));
  process.env.HOME = home; // before importing: both resolve ~/.claude at load
  const { liveSessions } = await import('../src/sessions.js');
  const { scan } = await import('../src/history.js');
  const logged = [];
  const error = console.error;
  console.error = (...a) => logged.push(a);
  try {
    assert.deepEqual(liveSessions(), []);
    await scan();
  } finally {
    console.error = error;
  }
  assert.deepEqual(logged, []);
});
