import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { Hub, newAgent, stopIdleAgents, makeCommands } = await import('../dist/hq.mjs');

const DAY = 86_400_000;
const IDS = ['lead', 'dev', 'qa', 'ops', 'ux', 'pm'];

// A real Hub in a temp project home, with every agent's session running and idle.
function team(days = 3) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-idle-'));
  const config = {
    project: { id: 'p', name: 'P', repo: 'p', path: home, hqPort: 0 },
    team: IDS.map((id, i) => newAgent(id, id, i ? 'Developer' : 'Lead', '#fff', i === 0)),
    workflow: { review: { enabled: false, tool: 'human', command: '' }, merge: { by: 'human' }, deploy: { enabled: false, tool: 'custom', command: '', perAgentEnvironments: false }, stopIdleAfterDays: days },
  };
  const hub = new Hub({ root: home }, 'p', home, config, { boards: [], tasks: [] }, { checks: [] });
  for (const a of hub.snap.agents) a.session.state = 'running';
  const stopped = [];
  const deps = { drafts: [], queued: [] };
  deps.stop = async (id) => void stopped.push(id);
  deps.hasDraft = async (id) => deps.drafts.includes(id);
  deps.pending = (id) => (deps.queued.includes(id) ? 1 : 0);
  return { hub, home, stopped, deps };
}

test('stops only running idle agents past the threshold; skips working, needs-input, action items, drafts, queued messages', async () => {
  const t = team(3);
  const now = t.hub.startedAt + 4 * DAY;
  t.hub.snap.agents.find((a) => a.agentId === 'dev').state = 'working';
  t.hub.snap.agents.find((a) => a.agentId === 'qa').state = 'needs-input';
  t.hub.snap.actionItems = [{ id: 'A1', fromId: 'ops', status: 'open' }, { id: 'A2', fromId: 'lead', status: 'done' }];
  t.deps.drafts.push('ux');
  t.deps.queued.push('pm');
  const stopped = await stopIdleAgents(t.hub, t.deps, now);
  assert.deepEqual(stopped, ['lead']);
  assert.deepEqual(t.stopped, ['lead']);
  assert.equal(t.hub.snap.activity[0].text, 'Stopped lead after 4 days idle. Start team or a new task brings it back.');
});

test('recent activity keeps an agent running; stopped sessions are left alone', async () => {
  const t = team(1);
  const now = t.hub.startedAt + 2 * DAY;
  t.hub.lastActive.dev = new Date(now - DAY / 2).toISOString();
  t.hub.snap.agents.find((a) => a.agentId === 'qa').session.state = 'stopped';
  const stopped = await stopIdleAgents(t.hub, t.deps, now);
  assert.deepEqual(stopped.sort(), ['lead', 'ops', 'pm', 'ux']);
});

test('Never (0) stops nobody', async () => {
  const t = team(0);
  assert.deepEqual(await stopIdleAgents(t.hub, t.deps, t.hub.startedAt + 100 * DAY), []);
});

test('last activity is saved in history.json and survives a restart', async () => {
  const t = team(3);
  t.hub.activity('task.started', 'dev', 'dev is working');
  const at = t.hub.lastActive.dev;
  await new Promise((r) => setTimeout(r, 1200)); // history.json is saved 1 s after a change
  const again = new Hub({ root: t.home }, 'p', t.home, t.hub.snap.config, { boards: [], tasks: [] }, { checks: [] });
  assert.equal(again.lastActive.dev, at);
});

test('the setting is saved; anything but 1, 3, 7 or 0 is ignored', () => {
  const t = team(3);
  let saved = 0;
  t.hub.configChanged = () => saved++;
  const cmd = makeCommands(t.hub, {}, {}, {});
  cmd.updateWorkflow({ stopIdleAfterDays: 7 });
  assert.equal(t.hub.snap.config.workflow.stopIdleAfterDays, 7);
  cmd.updateWorkflow({ stopIdleAfterDays: 0 });
  assert.equal(t.hub.snap.config.workflow.stopIdleAfterDays, 0);
  cmd.updateWorkflow({ stopIdleAfterDays: 2 });
  cmd.updateWorkflow({ stopIdleAfterDays: '3' });
  assert.equal(t.hub.snap.config.workflow.stopIdleAfterDays, 0);
  assert.equal(saved, 4);
});
