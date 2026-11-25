import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { Hub, Inbox, newAgent } = await import('../dist/hq.mjs');

// An idle, running agent and an Inbox typing into it through fake keys; `draft` is what its prompt shows after typing.
function setup(t, draft) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-inbox-'));
  const config = {
    project: { id: 'p', name: 'P', repo: 'p', path: home, hqPort: 0 },
    team: [newAgent('dev', 'Dev', 'Developer', '#fff', false)],
    workflow: { review: { enabled: false, tool: 'human', command: '' }, merge: { by: 'human' }, deploy: { enabled: false, tool: 'custom', command: '', perAgentEnvironments: false } },
  };
  const hub = new Hub({ root: home }, 'p', home, config, { boards: [], tasks: [] }, { checks: [] });
  Object.assign(hub.status('dev'), { state: 'idle' });
  hub.status('dev').session.state = 'running';
  const keys = { enters: 0, type: async () => true, enter: async () => ++keys.enters, draft: async () => draft };
  const inbox = new Inbox(hub, keys);
  t.after(() => inbox.stop());
  inbox.sessionReattached('dev');
  return { inbox, keys };
}

const flush = () => new Promise((r) => setImmediate(r));

// Deliver one message, optionally fire UserPromptSubmit before the submit check, then let the check run.
async function deliver(t, draft, hookFires = false) {
  const { inbox, keys } = setup(t, draft);
  inbox.push('dev', { fromId: 'you', text: 'hi', kind: 'message' });
  await flush();
  if (hookFires) inbox.noteHook('dev', 'UserPromptSubmit');
  t.mock.timers.tick(3000);
  await flush();
  return keys.enters;
}

test('submit check: Enter again only while Fleet\'s text is still unsent at the prompt', async (t) => {
  await t.test('submitted, hook late (prompt empty): no second Enter', async (t) => assert.equal(await deliver(t, ''), 0));
  await t.test('Enter swallowed (text still there): Enter again', async (t) => assert.equal(await deliver(t, '[Fleet] Message from You: hi'), 1));
  await t.test('Enter swallowed on a long paste: Enter again', async (t) => assert.equal(await deliver(t, '[Pasted text #1 +12 lines]'), 1));
  await t.test('your own draft at the prompt: never submitted', async (t) => assert.equal(await deliver(t, 'my half-typed note'), 0));
  await t.test('hook arrived in time: no second Enter', async (t) => assert.equal(await deliver(t, '[Fleet] Message from You: hi', true), 0));
});
