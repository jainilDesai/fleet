import { test } from 'node:test';
import assert from 'node:assert/strict';

const { keepMessages } = await import('../dist/hq.mjs');

test("a busy team never pushes your conversation out of the kept messages", () => {
  const at = (i) => new Date(Date.UTC(2026, 10, 26, 0, 0, i)).toISOString();
  // Newest first: 300 agent-to-agent messages, then (older) one reply to you and one message from you.
  const team = Array.from({ length: 300 }, (_, i) => ({ id: `t${i}`, at: at(1000 - i), fromId: 'planner', toId: 'cto', text: 'report' }));
  const yours = [
    { id: 'r', at: at(5), fromId: 'cto', toId: 'you', text: 'Planning is done', cause: 'team' },
    { id: 'q', at: at(4), fromId: 'you', toId: 'cto', text: 'status?' },
  ];
  const kept = keepMessages([...team, ...yours], 100, 300);
  assert.equal(kept.filter((m) => m.toId === 'cto' && m.fromId === 'planner').length, 100, 'team traffic capped');
  assert.deepEqual(kept.slice(-2).map((m) => m.id), ['r', 'q'], 'yours kept, a lead update included, order kept');
  assert.equal(keepMessages(yours, 100, 1).length, 1, 'yours have their own cap');
});
