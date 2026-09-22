// On-demand "what is this agent doing" summaries. Reads the tail of an agent's transcript,
// condenses it to a plain-text activity log, and asks Haiku (through the user's own `claude`
// login) for a two or three line status. Results are cached until the transcript grows.
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { transcriptFor, hiddenPids } from './sessions.js';

const TAIL_BYTES = 400_000;
const LOG_CHARS = 14_000;
const cache = new Map(); // file -> { size, summary, at }
const inflight = new Map(); // file -> Promise

const SYSTEM = `You write status summaries of AI coding agents for a dashboard. The owner glances at it to know what each agent is doing without opening its terminal.
Reply in plain English sentences, no markdown, no headings, at most 60 words, in this shape:
Line 1: the goal it is working on.
Line 2: where it is now: what it just did or is doing.
Line 3, only if true: it is waiting for the user, blocked, hitting errors, or going in circles. Say which.
You are also given the agent's status as the dashboard sees it. Trust it over the log: if the status is "done", the agent has finished, so say what it accomplished and never that it is waiting.`;

const STATES = new Set(['busy', 'idle', 'waiting', 'running', 'done', 'failed', 'queued']);

export async function summarize(target) {
  const file = transcriptFor(target);
  if (!file || !fs.existsSync(file)) throw new Error('No transcript for this agent yet');
  const size = fs.statSync(file).size;
  // A finished agent's transcript stops growing, but its status can still flip to done.
  const hit = cache.get(file);
  if (hit && hit.size === size && hit.state === target.state) return hit;
  if (inflight.has(file)) return inflight.get(file);

  const job = (async () => {
    const log = activityLog(file, size);
    if (!log.trim()) throw new Error('Nothing to summarize yet');
    const status = STATES.has(target.state) ? target.state : 'unknown';
    const prompt = `Project: ${target.project ?? 'unknown'}\nStatus: ${status}\n\nActivity log, oldest first:\n\n${log}`;
    const summary = await haiku(prompt);
    const result = { size, state: target.state, summary, at: Date.now() };
    cache.set(file, result);
    return result;
  })();
  inflight.set(file, job);
  try {
    return await job;
  } finally {
    inflight.delete(file);
  }
}

// Condense transcript lines into "USER: / CLAUDE: / TOOL:" entries, newest kept when trimming.
function activityLog(file, size) {
  const start = Math.max(0, size - TAIL_BYTES);
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(size - start);
  fs.readSync(fd, buf, 0, buf.length, start);
  fs.closeSync(fd);
  const lines = buf.toString('utf8').split('\n');
  if (start > 0) lines.shift(); // first line is probably cut mid-way

  const entries = [];
  const firstTask = start > 0 ? firstPrompt(file) : null;
  if (firstTask) entries.push(`TASK (from the start of the session): ${firstTask}`);

  for (const line of lines) {
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const content = d.message?.content;
    if (d.type === 'user') {
      if (typeof content === 'string') pushPrompt(entries, content, d);
      else
        for (const b of content ?? []) {
          if (b.type === 'text') pushPrompt(entries, b.text, d);
          if (b.type === 'tool_result' && b.is_error) entries.push(`TOOL ERROR: ${flat(b.content).slice(0, 240)}`);
        }
    }
    if (d.type === 'assistant')
      for (const b of Array.isArray(content) ? content : []) {
        if (b.type === 'text' && b.text.trim()) entries.push(`CLAUDE: ${b.text.trim().slice(0, 600)}`);
        if (b.type === 'tool_use') entries.push(`TOOL ${b.name}: ${describe(b.input)}`);
      }
  }

  const out = [];
  let used = 0;
  for (let i = entries.length - 1; i >= 0 && used < LOG_CHARS; i--) {
    out.unshift(entries[i]);
    used += entries[i].length + 1;
  }
  if (firstTask && out[0] !== entries[0]) out.unshift(entries[0]);
  return out.join('\n');
}

function pushPrompt(entries, text, d) {
  if (d.isMeta) return;
  const clean = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  const note = clean.match(/<task-notification>[\s\S]*?<summary>([^<]*)<\/summary>/);
  if (note) return entries.push(`EVENT: ${note[1]}`);
  if (!clean || clean.startsWith('<')) return;
  entries.push(`USER: ${clean.slice(0, 800)}`);
}

function firstPrompt(file) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(200_000);
  const n = fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  for (const line of buf.toString('utf8', 0, n).split('\n')) {
    try {
      const d = JSON.parse(line);
      if (d.type !== 'user' || d.isMeta) continue;
      const c = d.message?.content;
      const t = typeof c === 'string' ? c : c?.find?.((b) => b.type === 'text')?.text;
      const clean = t?.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
      if (clean && !clean.startsWith('<')) return clean.slice(0, 800);
    } catch {}
  }
  return null;
}

const flat = (c) => (typeof c === 'string' ? c : JSON.stringify(c ?? ''));
function describe(input = {}) {
  const v = input.description ?? input.file_path ?? input.command ?? input.pattern ?? input.url ?? input.query ?? input.prompt ?? '';
  return String(v).split('\n')[0].slice(0, 200);
}

// Haiku through the user's own Claude login. No tools, no MCP, no settings files (so no hooks
// or plugins restyle the answer), nothing saved to disk, and hidden from Fleet's own board.
function haiku(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'claude',
      [
        '-p',
        '--model', 'haiku',
        '--setting-sources', '',
        '--no-session-persistence',
        '--tools', '',
        '--strict-mcp-config',
        '--disable-slash-commands',
        '--system-prompt', SYSTEM,
        '--output-format', 'json',
      ],
      // A status line needs no reasoning; thinking tripled the latency in testing.
      { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, MAX_THINKING_TOKENS: '0' } }
    );
    hiddenPids.add(child.pid);
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill(), 90_000);
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      setTimeout(() => hiddenPids.delete(child.pid), 5000);
      let d = null;
      try {
        d = JSON.parse(out);
      } catch {}
      if (process.env.FLEET_DEBUG) console.error('haiku', d?.duration_ms, d?.duration_api_ms, d?.usage?.output_tokens);
      if (code === 0 && d?.result?.trim()) resolve(d.result.trim());
      else reject(new Error((err || out).trim().split('\n').pop() || `claude exited with ${code}`));
    });
    child.stdin.end(prompt);
  });
}
