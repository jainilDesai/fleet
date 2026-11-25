import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { Hub, Sessions, newAgent, makeCommands } = await import('../dist/hq.mjs');

test('a settings change mid-run marks the running agent "Restart to apply" until its session matches again', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-restart-'));
  const dir = path.join(home, 'work');
  fs.mkdirSync(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const dev = { ...newAgent('dev', 'Dev', 'Developer', '#fff', false), workspacePath: dir };
  const config = { project: { id: 'p', name: 'P', repo: 'p', path: home, hqPort: 0 }, team: [dev], workflow: {} };
  const hub = new Hub({ root: home }, 'p', home, config, { boards: [], tasks: [] }, { checks: [{ id: 'tmux', status: 'ok' }, { id: 'claude', status: 'ok' }] });
  const sessions = new Sessions(hub, 'token');
  // No tmux: a fake backend records the launch args.
  const launched = [];
  let alive = false;
  sessions.backend = { exists: async () => alive, create: async (_n, _d, cmd) => { launched.push(cmd.args); alive = true; }, kill: async () => { alive = false; } };
  const cmd = makeCommands(hub, sessions, {}, {});
  const flag = () => hub.status('dev').session.restartToApply;

  await sessions.start('dev');
  assert.equal(hub.status('dev').session.state, 'running');
  assert.equal(flag(), false);

  cmd.updateProject({ permissionMode: 'bypassPermissions' });
  assert.equal(flag(), true, 'the project-wide mode differs from what it started with');
  cmd.updateProject({ permissionMode: null });
  assert.equal(flag(), false, 'back to what it started with');

  cmd.updateAgent('dev', { model: 'Opus' });
  assert.equal(flag(), true, 'its own model changed');

  await sessions.stop('dev');
  await sessions.start('dev');
  assert.ok(launched.at(-1).includes('opus'), 'the new session got the new model');
  assert.equal(flag(), false);
});
