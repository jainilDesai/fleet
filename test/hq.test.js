import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The agent-team server is built into dist/ (npm run build).
const { lastAssistantText, draftFromPromptLine, describePermission } = await import('../dist/hq.mjs');

const write = (lines) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-hq-')), 't.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
};
const user = (content) => ({ type: 'user', message: { content } });
const assistant = (...blocks) => ({ type: 'assistant', message: { content: blocks } });
const text = (t) => ({ type: 'text', text: t });
const toolUse = { type: 'tool_use', name: 'mcp__hq__list_workers', input: {} };
const toolResult = user([{ type: 'tool_result', content: 'ok' }]);

test("returns the turn's final text, after tool calls", () => {
  const file = write([user('who are you?'), assistant(text('Let me check.'), toolUse), toolResult, assistant(text('I have 5 teammates.'))]);
  assert.equal(lastAssistantText(file), 'I have 5 teammates.');
});

test('never reaches back into an earlier turn', () => {
  const file = write([user('first'), assistant(text('old answer')), user('second'), assistant(toolUse), toolResult]);
  assert.equal(lastAssistantText(file), null);
});

test('missing file reads as null', () => {
  assert.equal(lastAssistantText('/nonexistent/t.jsonl'), null);
});

test("Claude Code's dim prompt suggestion is not a draft; typed text is", () => {
  assert.equal(draftFromPromptLine('\x1b[39m❯\u00a0\x1b[2massign B1-T02 to implementer\x1b[0m'), '');
  assert.equal(draftFromPromptLine('\x1b[39m❯\u00a0'), '');
  assert.equal(draftFromPromptLine('\x1b[39m❯\u00a0hello typed'), 'hello typed');
});

test('a permission request reads as what you are allowing', () => {
  const bash = describePermission('Bash', { command: 'rm -rf build\necho done', description: 'Clean build' });
  assert.equal(bash.title, 'Run a command: rm -rf build');
  assert.equal(bash.details, 'rm -rf build\necho done\n\nClean build');
  assert.equal(describePermission('Write', { file_path: '/repo/src/app.ts' }).title, 'Write src/app.ts');
  assert.equal(describePermission('mcp__x__y', { a: 1 }).title, 'Use mcp__x__y');
});

test('a production deploy is never labelled like a routine command', () => {
  const d = describePermission('Bash', { command: 'gh workflow run "Deploy To Production" -f branch=main' });
  assert.equal(d.title, '⚠ PRODUCTION deploy: main');
  assert.match(d.details, /every live merchant/);
  assert.match(describePermission('Bash', { command: 'gh workflow run "Deploy To Staging" -f branch=x' }).title, /^Run a command/);
});
