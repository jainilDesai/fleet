import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempHome } from './fixtures.js';

process.env.HOME = tempHome(); // banners are off in this home, and the event log stays in it
const { observe, recentEvents } = await import('../src/events.js');

const session = (status, extra = {}) => ({
  sessionId: 's1', name: 'cart', project: 'shop', pid: 42, status, statusSince: Date.now(),
  now: null, lastPrompt: 'make the cart faster', subagents: [], workflows: [], ...extra,
});

test('reports a session that starts waiting, with the question it asked', () => {
  observe([session('busy')]);
  const [e] = observe([session('waiting', { now: { tool: 'AskUserQuestion', detail: 'Which color?' } })]);
  assert.equal(e.kind, 'needs-input');
  assert.equal(e.detail, 'Which color?');
});

test('a long turn ending is reported; a quick reply is not', () => {
  observe([session('busy', { statusSince: Date.now() - 5000 })]);
  assert.deepEqual(observe([session('idle')]), []);
  observe([session('busy', { statusSince: Date.now() - 60_000 })]);
  assert.equal(observe([session('idle')])[0].kind, 'finished');
});

test('reports finished subagents and failed workflow agents once', () => {
  const sub = (state) => [{ id: 'a1', state, description: 'scan repo' }];
  const wf = (state) => [{ runId: 'w1', name: 'build', status: 'running', agents: [{ id: 'x', label: 'tests', state }] }];
  observe([session('busy', { subagents: sub('running'), workflows: wf('running') })]);
  const out = observe([session('busy', { subagents: sub('done'), workflows: wf('failed') })]);
  assert.deepEqual(out.map((e) => e.kind).sort(), ['subagent-done', 'workflow-failed']);
  assert.deepEqual(observe([session('busy', { subagents: sub('done'), workflows: wf('failed') })]), []);
  assert.ok(recentEvents().length >= 4);
});
