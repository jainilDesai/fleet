import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tempHome } from './fixtures.js';

const { makeCommands } = await import('../dist/hq.mjs');
const { freePort } = await import('../src/registry.js');

// Just the parts of Hub and Sessions that stopTeam / quitFleet touch.
function fakeTeam(states, failing = []) {
  const activity = [];
  const stopped = [];
  const hub = {
    snap: { config: { team: [] }, agents: Object.entries(states).map(([agentId, state]) => ({ agentId, session: { state } })) },
    name: (id) => id,
    activity: (_type, agentId, text) => activity.push({ agentId, text }),
  };
  const sessions = {
    stop: async (id) => {
      if (failing.includes(id)) throw new Error('tmux said no');
      stopped.push(id);
    },
  };
  return { hub, sessions, activity, stopped };
}

test('stopTeam stops every running agent and reports the one that failed', async () => {
  const t = fakeTeam({ lead: 'running', dev: 'running', qa: 'stopped', ops: 'failed', ux: 'running' }, ['dev']);
  await makeCommands(t.hub, t.sessions, {}, {}).stopTeam();
  assert.deepEqual(t.stopped.sort(), ['lead', 'ux']);
  assert.deepEqual(t.activity, [{ agentId: 'dev', text: "Couldn't stop dev: tmux said no" }]);
});

test('quitFleet stops the agents, then exits 0 after replying', async () => {
  const t = fakeTeam({ lead: 'running' });
  let code = null;
  await makeCommands(t.hub, t.sessions, {}, {}, (c) => (code = c)).quitFleet();
  assert.deepEqual(t.stopped, ['lead']);
  assert.equal(code, null, 'not before the reply');
  await new Promise((r) => setTimeout(r, 1700));
  assert.equal(code, 0);
});

test('quitFleet from the page: Fleet exits 0 and leaves no registry entry or watcher lock', async () => {
  const home = tempHome();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-quit-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'first'], { cwd: repo });
  const port = await freePort(7830);
  const bin = new URL('../bin/fleet.js', import.meta.url).pathname;
  const child = spawn(process.execPath, [bin, '--repo', repo, '--port', String(port), '--no-open'], { env: { ...process.env, HOME: home }, stdio: 'ignore' });
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  try {
    const entry = path.join(home, '.fleet', 'running', `${child.pid}.json`);
    for (let i = 0; i < 100 && !fs.existsSync(entry); i++) await new Promise((r) => setTimeout(r, 200));
    assert.ok(fs.existsSync(entry), 'registered while running');
    assert.equal(fs.readFileSync(path.join(home, '.fleet', 'watcher.pid'), 'utf8'), String(child.pid), 'holds the watcher lock');
    const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    const token = page.match(/__FLEET_PAGE_TOKEN__ = "([0-9a-f]+)"/)[1];
    const r = await fetch(`http://127.0.0.1:${port}/api/hq/cmd`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fleet-token': token },
      body: JSON.stringify({ cmd: 'quitFleet', args: [] }),
    });
    assert.equal(r.status, 200, 'the browser gets its answer');
    assert.equal(await exited, 0);
    assert.ok(!fs.existsSync(entry), 'registry entry removed');
    assert.ok(!fs.existsSync(path.join(home, '.fleet', 'watcher.pid')), 'watcher lock released');
  } finally {
    child.kill();
  }
});
