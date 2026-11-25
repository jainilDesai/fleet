import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { Planner, ActionItems, newAgent } = await import('../dist/hq.mjs');

// A Hub with just what Planner and ActionItems use (as in hq.test.js); HOME is a temp folder.
function setup() {
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-boarddone-'));
  const hub = {
    slug: 'bd-test',
    snap: { config: { team: [newAgent('cto', 'CTO', 'Lead', '#000', true), newAgent('qa', 'QA', 'QA', '#111', false)], workflow: {} }, agents: [], boards: [], tasks: [], messages: [], actionItems: [] },
    emit() {},
    activity() {},
    planChanged() {},
    historyChanged() {},
    setStatus() {},
    alert() {},
    name: (id) => id,
    cfg: (id) => hub.snap.config.team.find((a) => a.id === id),
    status: () => undefined,
  };
  fs.mkdirSync(path.join(process.env.HOME, '.fleet', 'projects', hub.slug), { recursive: true });
  const planner = new Planner(hub, { push() {} });
  planner.actions = new ActionItems(hub, planner);
  const marked = [];
  planner.actions.onMarkDone = (id) => (marked.push(id), planner.updateBoard(id, { status: 'done' }));
  return { hub, planner, marked };
}

const asks = (hub) => hub.snap.actionItems.filter((i) => i.status === 'open' && i.markDone);

function inTempHome(fn) {
  const home = process.env.HOME;
  try {
    fn();
  } finally {
    process.env.HOME = home;
  }
}

test('a board whose tasks are all done: Fleet asks once to mark it done; Approve marks it', () =>
  inTempHome(() => {
    const { hub, planner, marked } = setup();
    const board = planner.createBoard('Checkout', 'active');
    planner.suggestDone(board.id);
    assert.equal(asks(hub).length, 0, 'no tasks: nothing to ask');
    const t1 = planner.createTask({ boardId: board.id, title: 'One' }, 'cto');
    const t2 = planner.createTask({ boardId: board.id, title: 'Two' }, 'cto');
    planner.assign(t1.id, 'qa', 'cto');
    planner.setStatus('qa', 'done', undefined, undefined, t1.id);
    assert.equal(asks(hub).length, 0, 'a task still open');
    planner.updateTask(t2.id, { status: 'done' });
    const [item] = asks(hub);
    assert.equal(item.markDone, board.id);
    assert.equal(item.approval, true);
    assert.equal(item.fromId, 'cto');

    planner.suggestDone(board.id);
    planner.updateTask(t2.id, { status: 'done' });
    assert.equal(hub.snap.actionItems.length, 1, 'asked once');

    planner.actions.resolve(item.id, 'dismissed');
    planner.updateTask(t2.id, { status: 'done' });
    assert.equal(asks(hub).length, 0, 'rejected: not asked again for the same tasks');
    assert.equal(board.status, 'active');

    const t3 = planner.createTask({ boardId: board.id, title: 'Three' }, 'cto');
    planner.updateTask(t3.id, { status: 'done' });
    const [again] = asks(hub);
    assert.ok(again, 'a new task, all done again: asked again');
    planner.actions.resolve(again.id, 'done');
    assert.deepEqual(marked, [board.id]);
    assert.equal(board.status, 'done');
  }));

test('a board marked done on the board closes its open "mark it done?" item', () =>
  inTempHome(() => {
    const { hub, planner, marked } = setup();
    const board = planner.createBoard('Docs', 'active');
    const t = planner.createTask({ boardId: board.id, title: 'Write' }, 'cto');
    planner.updateTask(t.id, { status: 'done' });
    assert.equal(asks(hub).length, 1);
    planner.updateBoard(board.id, { status: 'done' });
    assert.equal(asks(hub).length, 0);
    assert.deepEqual(marked, [], 'already done: not marked twice');
  }));
