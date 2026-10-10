// Attention events: an agent asked something, finished a turn, or a subagent/workflow ended.
// Derived by diffing consecutive snapshots of live sessions - no hooks. Kept in
// ~/.fleet/events.jsonl and optionally raised as macOS notification banners.
// With terminal-notifier installed, clicking a banner opens that session's terminal tab;
// osascript banners can't run anything on click, so macOS opens an unrelated app instead.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';

const DIR = path.join(os.homedir(), '.fleet');
const LOG = path.join(DIR, 'events.jsonl');
const CONFIG = path.join(DIR, 'config.json');
const KEEP = 200;
const FOCUS = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'focus.js');
const NOTIFIER = ['/opt/homebrew/bin', '/usr/local/bin', ...(process.env.PATH ?? '').split(':')]
  .map((d) => path.join(d, 'terminal-notifier'))
  .find((p) => fs.existsSync(p));
let dashboardUrl = null;

export function setDashboardUrl(url) {
  dashboardUrl = url;
}
const MIN_BUSY_MS = 20_000; // shorter turns are back-and-forth chat, not "finished a task"

const events = load();
let prev = null; // last snapshot, as maps keyed by id
let seq = events.at(-1)?.id ?? 0;

function load() {
  try {
    return fs
      .readFileSync(LOG, 'utf8')
      .trim()
      .split('\n')
      .slice(-KEEP)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

export function config() {
  try {
    return { banners: true, ...JSON.parse(fs.readFileSync(CONFIG, 'utf8')), clickable: !!NOTIFIER };
  } catch {
    return { banners: true, clickable: !!NOTIFIER };
  }
}

export function setConfig(patch) {
  const next = { banners: !!patch.banners };
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(next, null, 2));
  return config();
}

export function recentEvents() {
  return events.slice(-50).reverse();
}

function index(sessions) {
  const s = new Map();
  const agents = new Map(); // `${sessionId}|${agentId}` -> state
  const runs = new Map(); // `${sessionId}|${runId}` -> status
  for (const x of sessions) {
    s.set(x.sessionId, x);
    for (const a of x.subagents) agents.set(`${x.sessionId}|${a.id}`, a.state);
    for (const w of x.workflows) {
      runs.set(`${x.sessionId}|${w.runId}`, w.status);
      for (const a of w.agents) agents.set(`${x.sessionId}|${w.runId}|${a.id}`, a.state);
    }
  }
  return { s, agents, runs };
}

// Returns the events this snapshot produced (possibly none).
export function observe(sessions) {
  const now = index(sessions);
  const out = [];
  if (prev) {
    for (const x of sessions) {
      const before = prev.s.get(x.sessionId);
      if (!before) continue; // new session: nothing happened to it yet
      const base = { sessionId: x.sessionId, name: x.name, project: x.project, pid: x.pid };

      if (x.status === 'waiting' && before.status !== 'waiting')
        out.push({ ...base, kind: 'needs-input', title: `${x.name} needs you`, detail: askText(x) });

      if (before.status === 'busy' && x.status === 'idle') {
        const busyFor = Date.now() - (before.statusSince ?? Date.now());
        if (busyFor >= MIN_BUSY_MS)
          out.push({ ...base, kind: 'finished', title: `${x.name} finished`, detail: x.lastPrompt ?? '', busyMs: busyFor });
      }

      for (const a of x.subagents) {
        const was = prev.agents.get(`${x.sessionId}|${a.id}`);
        if (was && was !== 'done' && a.state === 'done')
          out.push({ ...base, kind: 'subagent-done', agentId: a.id, title: `Subagent done in ${x.name}`, detail: a.description ?? '' });
      }

      for (const w of x.workflows) {
        const was = prev.runs.get(`${x.sessionId}|${w.runId}`);
        if (was && was !== w.status && w.status !== 'running') {
          const failed = w.agents.filter((a) => a.state === 'failed').length;
          out.push({
            ...base,
            kind: failed ? 'workflow-failed' : 'workflow-done',
            runId: w.runId,
            title: `Workflow ${w.name} ${w.status}`,
            detail: `${w.agents.length} agents${failed ? `, ${failed} failed` : ''}`,
          });
        }
        for (const a of w.agents) {
          const wasA = prev.agents.get(`${x.sessionId}|${w.runId}|${a.id}`);
          if (wasA && wasA !== 'failed' && a.state === 'failed')
            out.push({ ...base, kind: 'workflow-failed', runId: w.runId, agentId: a.id, title: `${a.label} failed`, detail: `in workflow ${w.name}` });
        }
      }
    }
  }
  prev = now;
  if (out.length) record(out);
  return out;
}

// What the agent is waiting on: its last question, or the tool it wants permission for.
function askText(x) {
  const n = x.now;
  if (!n) return 'Waiting for your input';
  if (n.tool === 'AskUserQuestion') return n.detail || 'Asked you a question';
  if (n.tool === 'ExitPlanMode') return 'Plan ready for your review';
  return `Wants to run ${n.tool}${n.detail ? `: ${n.detail}` : ''}`;
}

function record(list) {
  fs.mkdirSync(DIR, { recursive: true });
  const lines = [];
  for (const e of list) {
    const ev = { id: ++seq, at: Date.now(), ...e, detail: String(e.detail).slice(0, 300) };
    events.push(ev);
    lines.push(JSON.stringify(ev));
  }
  fs.appendFileSync(LOG, lines.join('\n') + '\n');
  if (events.length > KEEP) events.splice(0, events.length - KEEP);
  trimLog();

  if (!config().banners) return;
  // Subagent completions are too frequent for banners; they stay in the inbox.
  const loud = list.filter((e) => e.kind !== 'subagent-done');
  if (loud.length > 3) banner(`${loud.length} agents need attention`, 'Open Fleet to see them', '', 'Glass', null);
  else for (const e of loud) banner(e.title, e.detail, e.project, e.kind === 'needs-input' ? 'Glass' : 'Tink', e);
}

// Keep the log file from growing forever: rewrite it once it is well past KEEP lines.
function trimLog() {
  try {
    if (fs.statSync(LOG).size < 512_000) return;
    fs.writeFileSync(LOG, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  } catch {}
}

const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// event: the session the banner is about (its terminal opens on click), or null for the dashboard.
function banner(title, message, subtitle, sound, event) {
  if (NOTIFIER) {
    const click = event?.pid
      ? `${sh(process.execPath)} ${sh(FOCUS)} ${Number(event.pid)}`
      : dashboardUrl && `open ${sh(dashboardUrl)}`;
    // A leading "-" or "[" would be read as an option; a zero-width space keeps it text.
    const text = (v, n) => String(v || ' ').slice(0, n).replace(/^[-[]/, '\u200b$&');
    execFile(NOTIFIER, [
      '-title', text(title, 120),
      '-message', text(message, 240),
      ...(subtitle ? ['-subtitle', text(subtitle, 120)] : []),
      '-sound', sound,
      '-group', `fleet-${event?.sessionId ?? 'all'}`, // a session's newer banner replaces its older one
      ...(click ? ['-execute', click] : []),
    ], () => {});
    return;
  }
  // Arguments go through argv, never spliced into the AppleScript source.
  execFile('osascript', [
    '-e', 'on run argv',
    '-e', 'display notification (item 2 of argv) with title (item 1 of argv) subtitle (item 3 of argv) sound name (item 4 of argv)',
    '-e', 'end run',
    String(title).slice(0, 120),
    String(message || ' ').slice(0, 240),
    String(subtitle || ''),
    sound,
  ], () => {});
}
