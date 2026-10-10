// Builds fake Claude Code transcripts in a temp home folder, shaped like the real ones.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-test-'));
  fs.mkdirSync(path.join(home, '.fleet'), { recursive: true });
  fs.writeFileSync(path.join(home, '.fleet', 'config.json'), JSON.stringify({ banners: false }));
  return home;
}

let ts = Date.parse('2026-10-01T10:00:00Z');
const at = () => new Date((ts += 1000)).toISOString();

export const user = (content, extra = {}) =>
  JSON.stringify({ type: 'user', timestamp: at(), cwd: '/work/shop', gitBranch: 'main', message: { role: 'user', content }, ...extra });

export const assistant = (id, content, usage = { input_tokens: 100, output_tokens: 50 }, extra = {}) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: at(),
    message: { id, model: 'claude-sonnet-5', role: 'assistant', content, usage, stop_reason: 'end_turn' },
    ...extra,
  });

export const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
export const toolResult = (id, content) => ({ type: 'tool_result', tool_use_id: id, content });

export function write(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + '\n');
}
