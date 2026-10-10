// Live Claude Code sessions on this machine, from Claude Code's own registry
// (~/.claude/sessions/<pid>.json), enriched with transcript stats, subagents and workflows.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readTranscript, firstLine } from './transcript.js';
import { contextWindow, modelFamily } from './pricing.js';

const CLAUDE = path.join(os.homedir(), '.claude');
const PROJECTS = path.join(CLAUDE, 'projects');
const transcriptPath = new Map(); // sessionId -> jsonl path

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// Claude Code names the project dir after the cwd with every non-alphanumeric char as '-'.
// A session that changed cwd keeps its original dir, so fall back to a scan.
function findTranscript(sessionId, cwd) {
  const known = transcriptPath.get(sessionId);
  if (known && fs.existsSync(known)) return known;
  const guess = path.join(PROJECTS, cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
  let found = fs.existsSync(guess) ? guess : null;
  if (!found) {
    for (const dir of fs.readdirSync(PROJECTS)) {
      const p = path.join(PROJECTS, dir, `${sessionId}.jsonl`);
      if (fs.existsSync(p)) {
        found = p;
        break;
      }
    }
  }
  if (found) transcriptPath.set(sessionId, found);
  return found;
}

// Transcript for a session, a subagent, or a workflow agent. Used by the summarizer.
export function transcriptFor({ sessionId, agentId, runId }) {
  const main = transcriptPath.get(sessionId);
  if (!main) return null;
  if (!agentId) return main;
  const dir = main.replace(/\.jsonl$/, '');
  const safe = (v) => /^[\w-]+$/.test(v); // ids come from the browser; keep them out of path tricks
  if (!safe(agentId) || (runId && !safe(runId))) return null;
  return runId
    ? path.join(dir, 'subagents', 'workflows', runId, `agent-${agentId}.jsonl`)
    : path.join(dir, 'subagents', `agent-${agentId}.jsonl`);
}

// Sessions Fleet itself spawned (the summarizer) are hidden from the board.
export const hiddenPids = new Set();
const lastRegistry = new Map(); // registry file name -> last parsed contents

export function liveSessions() {
  const dir = path.join(CLAUDE, 'sessions');
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    // Claude Code rewrites these files in place; a read can land mid-write. Keep the last good copy.
    const reg = readJson(path.join(dir, f)) ?? lastRegistry.get(f);
    if (reg) lastRegistry.set(f, reg);
    if (!reg?.pid || hiddenPids.has(reg.pid) || !alive(reg.pid)) continue;
    out.push(buildSession(reg));
  }
  return out.sort((a, b) => a.project.localeCompare(b.project) || b.startedAt - a.startedAt);
}

function buildSession(reg) {
  const file = findTranscript(reg.sessionId, reg.cwd);
  const t = file ? readTranscript(file) : null;
  const sessionDir = file ? file.replace(/\.jsonl$/, '') : null;
  const subagents = sessionDir ? readSubagents(sessionDir, t) : [];
  const workflows = sessionDir ? readWorkflows(sessionDir) : [];
  const subTotals = [...subagents, ...workflows.flatMap((w) => w.agents)].reduce(
    (acc, a) => ({ cost: acc.cost + a.cost, total: acc.total + a.total }),
    { cost: 0, total: 0 }
  );
  const model = t?.model ?? null;
  return {
    pid: reg.pid,
    sessionId: reg.sessionId,
    name: reg.name,
    cwd: reg.cwd,
    project: path.basename(reg.cwd),
    kind: reg.kind,
    entrypoint: reg.entrypoint,
    status: reg.status ?? 'unknown',
    statusSince: reg.statusUpdatedAt ?? reg.updatedAt,
    startedAt: reg.startedAt,
    version: reg.version,
    model,
    family: modelFamily(model ?? ''),
    branch: t?.branch ?? null,
    task: t?.firstPrompt ?? null,
    lastPrompt: t?.lastPrompt ?? null,
    lastTs: t?.lastTs ?? null,
    now: t?.activity.at(-1) ?? null,
    activity: t?.activity.slice(-15).reverse() ?? [],
    tokens: t?.tokens ?? null,
    total: t?.total ?? 0,
    cost: t?.cost ?? 0,
    context: t?.context ?? 0,
    contextPct: t ? Math.min(100, Math.round((t.context / contextWindow(model ?? '')) * 100)) : 0,
    subagents,
    workflows,
    combined: { cost: (t?.cost ?? 0) + subTotals.cost, total: (t?.total ?? 0) + subTotals.total },
  };
}

function agentState(done, mtime) {
  if (done) return 'done';
  return Date.now() - mtime < 90_000 ? 'running' : 'idle';
}

function readSubagents(sessionDir, parent) {
  const dir = path.join(sessionDir, 'subagents');
  if (!fs.existsSync(dir)) return [];
  const agents = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.startsWith('agent-') || !f.endsWith('.jsonl')) continue;
    const id = f.slice('agent-'.length, -'.jsonl'.length);
    const meta = readJson(path.join(dir, `agent-${id}.meta.json`)) ?? {};
    const t = readTranscript(path.join(dir, f));
    if (!t) continue;
    const done = meta.toolUseId ? parent?.finishedToolUses.has(meta.toolUseId) : false;
    // Nested agents report to their parent agent's transcript, not the session's.
    agents.push({
      id,
      type: meta.agentType ?? 'agent',
      description: meta.description ?? firstLine(path.join(dir, f)),
      parentId: meta.parentAgentId ?? null,
      depth: meta.spawnDepth ?? 1,
      toolUseId: meta.toolUseId,
      background: meta.requestShape === 'background',
      model: t.model,
      family: modelFamily(t.model ?? ''),
      state: done ? 'done' : agentState(t.lastStop === 'end_turn' && Date.now() - t.mtime > 5000, t.mtime),
      now: t.activity.at(-1) ?? null,
      cost: t.cost,
      total: t.total,
      startedAt: t.activity[0]?.ts ?? null,
      mtime: t.mtime,
    });
  }
  return agents.sort((a, b) => (a.mtime ?? 0) - (b.mtime ?? 0));
}

function readWorkflows(sessionDir) {
  const runs = new Map();
  const jsonDir = path.join(sessionDir, 'workflows');
  if (fs.existsSync(jsonDir))
    for (const f of fs.readdirSync(jsonDir))
      if (f.endsWith('.json')) {
        const d = readJson(path.join(jsonDir, f));
        if (d?.runId) runs.set(d.runId, d);
      }
  // A running workflow may only have its agents' transcripts on disk so far.
  const agentsRoot = path.join(sessionDir, 'subagents', 'workflows');
  if (fs.existsSync(agentsRoot))
    for (const runId of fs.readdirSync(agentsRoot)) if (!runs.has(runId)) runs.set(runId, { runId });

  return [...runs.values()].map((d) => {
    const agentDir = path.join(agentsRoot, d.runId);
    const progress = (d.workflowProgress ?? []).filter((p) => p.type === 'workflow_agent');
    const phases = (d.phases ?? []).map((p, i) => ({ index: i + 1, title: p.title, detail: p.detail }));
    const seen = new Set();
    const agents = progress.map((p) => {
      seen.add(p.agentId);
      const t = readTranscript(path.join(agentDir, `agent-${p.agentId}.jsonl`));
      return {
        id: p.agentId,
        label: p.label,
        phase: p.phaseTitle ?? null,
        phaseIndex: p.phaseIndex ?? null,
        state: p.state === 'done' ? 'done' : p.state === 'error' || p.state === 'failed' ? 'failed' : p.state ?? 'queued',
        model: p.model ?? t?.model,
        family: modelFamily(p.model ?? t?.model ?? ''),
        now: p.lastToolName ? { tool: p.lastToolName, detail: p.lastToolSummary ?? '' } : t?.activity.at(-1),
        cost: t?.cost ?? 0,
        total: t?.total ?? 0,
      };
    });
    // Retried or resumed agents can be on disk without a progress entry. Their spend is real.
    const finished = d.status && d.status !== 'running';
    if (fs.existsSync(agentDir))
      for (const f of fs.readdirSync(agentDir)) {
        if (!f.startsWith('agent-') || !f.endsWith('.jsonl')) continue; // not journal.jsonl
        const id = f.slice('agent-'.length, -'.jsonl'.length);
        if (seen.has(id)) continue;
        const t = readTranscript(path.join(agentDir, f));
        if (!t) continue;
        agents.push({
          id,
          label: firstLine(path.join(agentDir, f)) ?? id,
          phase: progress.length ? 'Other' : null,
          phaseIndex: null,
          state: finished ? 'done' : agentState(false, t.mtime),
          model: t.model,
          family: modelFamily(t.model ?? ''),
          now: t.activity.at(-1) ?? null,
          cost: t.cost,
          total: t.total,
        });
      }
    const running = agents.some((a) => a.state === 'running');
    return {
      runId: d.runId,
      name: d.workflowName ?? d.runId,
      summary: d.summary ?? null,
      status: d.status ?? (running ? 'running' : 'unknown'),
      phases,
      agents,
      startedAt: d.startTime ?? null,
      durationMs: d.durationMs ?? null,
      cost: agents.reduce((n, a) => n + a.cost, 0),
      total: d.totalTokens ?? agents.reduce((n, a) => n + a.total, 0),
    };
  });
}
