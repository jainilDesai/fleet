import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempHome, user, assistant, toolUse, write } from './fixtures.js';

const home = tempHome();
process.env.HOME = home; // before importing: history.js resolves ~/.claude and ~/.fleet at load
const { scan, history } = await import('../src/history.js');

const project = path.join(home, '.claude', 'projects', '-work-shop');
const main = path.join(project, 'sess-1.jsonl');
write(main, [
  user('make the cart faster'),
  JSON.stringify({ type: 'ai-title', aiTitle: 'Faster cart' }),
  assistant('m1', [toolUse('e1', 'Edit', { file_path: '/work/shop/cart.js' })]),
]);
write(path.join(project, 'sess-1', 'subagents', 'agent-a1.jsonl'), [user('look around'), assistant('s1', [{ type: 'text', text: 'ok' }])]);
write(path.join(project, 'sess-1', 'subagents', 'workflows', 'wf_1', 'journal.jsonl'), [JSON.stringify({ event: 'start' })]);
write(path.join(project, 'empty.jsonl'), [JSON.stringify({ type: 'summary' })]);

test('records a session with its title, edits, subagents and their cost', async () => {
  await scan();
  const { records } = history();
  assert.equal(records.length, 1, 'a transcript without a prompt is not a session');
  const r = records[0];
  assert.equal(r.title, 'Faster cart');
  assert.equal(r.project, 'shop');
  assert.deepEqual(r.edited, ['/work/shop/cart.js']);
  assert.equal(r.agents, 1, 'journal.jsonl is not an agent');
  assert.ok(r.cost > 0);
  assert.equal(r.gone, false);
  assert.equal('file' in r, false, 'the transcript path stays on the server');
});

test('keeps the record after Claude Code deletes the transcript', async () => {
  fs.rmSync(main);
  fs.rmSync(path.join(project, 'sess-1'), { recursive: true });
  await scan();
  const r = history().records[0];
  assert.equal(r.title, 'Faster cart');
  assert.equal(r.gone, true);
  const saved = JSON.parse(fs.readFileSync(path.join(home, '.fleet', 'history.json'), 'utf8'));
  assert.ok(saved['sess-1']);
});
