// Incremental reader for Claude Code transcripts (~/.claude/projects/<slug>/<session>.jsonl).
// Each file is read from the last byte offset seen, so polling a 50MB transcript costs only
// the bytes appended since the previous poll.
import fs from 'node:fs';
import { costOf } from './pricing.js';

const cache = new Map(); // path -> { offset, state }

function emptyState() {
  return {
    usageById: new Map(), // message.id -> { model, usage }; one API message spans many lines
    model: null,
    firstPrompt: null,
    lastPrompt: null,
    lastTs: null,
    lastUsage: null,
    branch: null,
    activity: [], // recent tool calls, newest last
    finishedToolUses: new Set(), // tool_use ids whose (sub)agent has returned
    agentLaunches: new Map(), // tool_use id -> { name, input } for Agent / Workflow calls
    lastStop: null,
    cwd: null,
  };
}

export function readTranscript(file, since = null) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  let entry = cache.get(file);
  if (!entry || stat.size < entry.offset) entry = { offset: 0, state: emptyState(), mtime: 0 };
  if (stat.size > entry.offset) {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(stat.size - entry.offset);
    fs.readSync(fd, buf, 0, buf.length, entry.offset);
    fs.closeSync(fd);
    const text = buf.toString('utf8');
    const end = text.lastIndexOf('\n');
    if (end >= 0) {
      for (const line of text.slice(0, end).split('\n')) if (line) apply(entry.state, line);
      entry.offset += Buffer.byteLength(text.slice(0, end + 1));
    }
  }
  entry.mtime = stat.mtimeMs;
  cache.set(file, entry);
  return summarize(entry.state, stat.mtimeMs, since);
}

function apply(s, line) {
  let d;
  try {
    d = JSON.parse(line);
  } catch {
    return;
  }
  if (d.timestamp) s.lastTs = d.timestamp;
  if (d.gitBranch) s.branch = d.gitBranch;
  if (d.cwd && !s.cwd) s.cwd = d.cwd;
  const msg = d.message;
  if (!msg) return;

  if (d.type === 'assistant') {
    if (msg.model && msg.model !== '<synthetic>') s.model = msg.model;
    if (msg.usage && msg.id) {
      s.usageById.set(msg.id, { model: msg.model, usage: msg.usage, ts: Date.parse(d.timestamp) || 0 });
      s.lastUsage = msg.usage;
    }
    if (msg.stop_reason) s.lastStop = msg.stop_reason;
    for (const b of Array.isArray(msg.content) ? msg.content : []) {
      if (b.type !== 'tool_use') continue;
      s.activity.push({ tool: b.name, detail: describe(b.name, b.input), ts: d.timestamp });
      if (s.activity.length > 40) s.activity.shift();
      if (b.name === 'Agent' || b.name === 'Task' || b.name === 'Workflow')
        s.agentLaunches.set(b.id, { name: b.name, input: b.input ?? {} });
    }
    return;
  }

  if (d.type === 'user') {
    const content = msg.content;
    if (typeof content === 'string') return notePrompt(s, content, d);
    for (const b of Array.isArray(content) ? content : []) {
      if (b.type === 'text') notePrompt(s, b.text, d);
      if (b.type === 'tool_result') {
        const t = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
        // A background agent's first tool_result only says it launched; it finishes later.
        if (!/launched successfully|running in the background|Workflow started/i.test(t))
          s.finishedToolUses.add(b.tool_use_id);
      }
    }
  }
}

function notePrompt(s, text, d) {
  if (!text) return;
  // Background agents report back as a <task-notification> naming the tool_use that spawned them.
  for (const m of text.matchAll(/<tool-use-id>([^<]+)<\/tool-use-id>[\s\S]*?<status>(\w+)<\/status>/g))
    if (m[2] !== 'running') s.finishedToolUses.add(m[1]);
  if (d.isMeta || d.isSidechain) return;
  const clean = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, '')
    .trim();
  if (!clean || clean.startsWith('<') || clean.startsWith('Caveat:')) return;
  const cmd = clean.match(/^<command-name>(.*?)<\/command-name>/);
  const prompt = cmd ? cmd[1] : clean;
  s.firstPrompt ??= prompt.slice(0, 400);
  s.lastPrompt = prompt.slice(0, 400);
}

function describe(tool, input = {}) {
  const v =
    input.description ??
    input.file_path ??
    input.command ??
    input.pattern ??
    input.url ??
    input.query ??
    input.prompt ??
    input.skill ??
    '';
  return String(v).split('\n')[0].slice(0, 160);
}

function summarize(s, mtime, since) {
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const byModel = {};
  const byModelToday = {};
  let cost = 0;
  for (const { model, usage: u, ts } of s.usageById.values()) {
    tokens.input += u.input_tokens ?? 0;
    tokens.output += u.output_tokens ?? 0;
    tokens.cacheRead += u.cache_read_input_tokens ?? 0;
    tokens.cacheWrite += u.cache_creation_input_tokens ?? 0;
    const c = costOf(model, u);
    cost += c;
    byModel[model] = (byModel[model] ?? 0) + c;
    if (since != null && ts >= since) {
      const m = (byModelToday[model] ??= { cost: 0, total: 0, output: 0 });
      m.cost += c;
      m.output += u.output_tokens ?? 0;
      m.total +=
        (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    }
  }
  const u = s.lastUsage;
  const context = u
    ? (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
    : 0;
  return {
    model: s.model,
    branch: s.branch,
    firstPrompt: s.firstPrompt,
    lastPrompt: s.lastPrompt,
    lastTs: s.lastTs,
    mtime,
    tokens,
    total: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
    cost,
    byModel,
    byModelToday,
    cwd: s.cwd,
    context,
    lastStop: s.lastStop,
    activity: s.activity,
    finishedToolUses: s.finishedToolUses,
    agentLaunches: s.agentLaunches,
  };
}

// First user message of a transcript: used as a label for workflow agents with no name.
export function firstLine(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const d = JSON.parse(buf.toString('utf8', 0, n).split('\n')[0]);
    const c = d.message?.content;
    const t = typeof c === 'string' ? c : c?.find?.((b) => b.type === 'text')?.text;
    return t?.trim().split('\n')[0].slice(0, 120) ?? null;
  } catch {
    return null;
  }
}
