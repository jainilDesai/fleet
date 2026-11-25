import { test } from 'node:test';
import assert from 'node:assert/strict';

const { Sessions, trustSelected } = await import('../dist/hq.mjs');

// Claude Code 2.1.x's folder-trust prompt on a new Fleet worktree, as captured from tmux.
const screen = (yes) => [
  ' Accessing workspace:',
  ' /Users/x/.fleet/projects/pricing-by-country-react/cto',
  " Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this",
  ' folder first.',
  " Claude Code'll be able to read, edit, and execute files here.",
  ' ⚠ This folder pre-approves 1 tool permission in .claude/settings.local.json:',
  '   mcp__fleet',
  ' These will apply without asking. Only proceed if you trust this configuration.',
  ' Trusting this folder loads .claude/settings.local.json.',
  ' Security guide',
  yes ? '   No, exit' : ' ❯ No, exit',
  yes ? ' ❯ Yes, I trust this folder' : '   Yes, I trust this folder',
  ' Enter to confirm · Esc to cancel',
].join('\n');
const tail = (s, n) => s.split('\n').slice(-n).join('\n'); // like tmux tailText

// Just the parts of Hub and the tmux backend that the trust prompt touches.
function fakeAgent({ workspacePath = null } = {}) {
  const st = { agentId: 'cto', state: 'idle', note: 'Running', session: { state: 'running' } };
  const calls = { alerts: [], activity: [], keys: [] };
  let yes = false;
  const hub = {
    slug: 'p',
    snap: { config: { team: [] }, agents: [st] },
    cfg: () => ({ id: 'cto', name: 'CTO', workspacePath }),
    status: () => st,
    name: () => 'CTO',
    setStatus: (_id, patch) => Object.assign(st, patch),
    activity: (_type, _id, text) => calls.activity.push(text),
    alert: (_id, text) => calls.alerts.push(text),
  };
  const s = new Sessions(hub, 'token');
  s.backend = {
    screenText: async (_name, n) => tail(screen(yes), n),
    key: async (_name, k) => { calls.keys.push(k); if (k === 'Down') yes = true; return true; },
    enter: async () => { calls.keys.push('Enter'); return true; },
  };
  return { s, st, calls };
}

test('trustSelected reads the 2.1.x prompt: No is the default, Yes after Down', () => {
  assert.equal(trustSelected(screen(false)), false);
  assert.equal(trustSelected(screen(true)), true);
});

test('the trust prompt makes the agent need you, with one banner', async () => {
  const { s, st, calls } = fakeAgent();
  await s.reconcileFromScreen('cto', 'fleet-p-cto');
  await s.reconcileFromScreen('cto', 'fleet-p-cto'); // the next poll: still waiting, no second banner
  assert.equal(st.state, 'needs-input'); // counted in Action items / "needs you"
  assert.match(st.note, /trust this new worktree/);
  assert.equal(calls.alerts.length, 1);
  assert.equal(calls.activity.length, 1);
});

test('Trust folder moves off "No, exit" to Yes before pressing Enter', async () => {
  const { s, calls } = fakeAgent();
  assert.equal(await s.trustFolder('cto'), true);
  assert.deepEqual(calls.keys, ['Down', 'Enter']);
});

test('Trust folder never answers in a folder Fleet did not make', async () => {
  const { s, calls } = fakeAgent({ workspacePath: '/Users/x/code/app' });
  assert.equal(await s.trustFolder('cto'), false);
  assert.deepEqual(calls.keys, []);
});
