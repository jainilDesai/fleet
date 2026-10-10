// Session history: one record per Claude Code session, kept in ~/.fleet/history.json.
// Claude Code deletes transcripts after cleanupPeriodDays (30 by default); these records outlive them.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readTranscriptOnce } from './transcript.js';
import { modelFamily } from './pricing.js';
import { projectOf } from './inventory.js';
import { summarize } from './summarize.js';

const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const DIR = path.join(os.homedir(), '.fleet');
const FILE = path.join(DIR, 'history.json');
const VERSION = 2; // bump when build() changes: records whose transcript still exists are rebuilt

const records = load(); // sessionId -> record
const skipped = new Map(); // sessionId -> size, for transcripts with no user prompt
let scanning = false;

function load() {
  try {
    return new Map(Object.entries(JSON.parse(fs.readFileSync(FILE, 'utf8'))));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('history.json unreadable, starting a new one:', e.message);
    return new Map();
  }
}

// Write-then-rename: a crash mid-write must never truncate months of history.
function save() {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(Object.fromEntries(records)));
  fs.renameSync(`${FILE}.tmp`, FILE);
}

// Re-reads only transcripts whose size changed since the last scan.
export async function scan() {
  if (scanning) return;
  scanning = true;
  let changed = 0;
  try {
    for (const dir of fs.readdirSync(PROJECTS)) {
      const full = path.join(PROJECTS, dir);
      if (!fs.statSync(full).isDirectory()) continue;
      for (const f of fs.readdirSync(full)) {
        if (!f.endsWith('.jsonl')) continue;
        const sessionId = f.slice(0, -'.jsonl'.length);
        const file = path.join(full, f);
        let size;
        try {
          size = fs.statSync(file).size;
        } catch {
          continue;
        }
        const old = records.get(sessionId);
        if ((old?.size === size && old.v === VERSION) || skipped.get(sessionId) === size) continue;
        const rec = build(sessionId, file, size, records.get(sessionId));
        if (rec) records.set(sessionId, rec);
        else skipped.set(sessionId, size);
        if (rec && ++changed % 50 === 0) save(); // the first scan is long; keep progress
        await new Promise((r) => setImmediate(r)); // let HTTP and the live stream run between files
      }
    }
  } catch (e) {
    console.error('history scan failed:', e);
  } finally {
    scanning = false;
  }
  if (changed) save();
}

function build(sessionId, file, size, old) {
  const t = readTranscriptOnce(file);
  if (!t?.firstPrompt) return null;
  let agents = 0;
  let agentCost = 0;
  let agentTotal = 0;
  for (const f of jsonlFiles(file.replace(/\.jsonl$/, ''))) {
    const a = readTranscriptOnce(f);
    if (!a) continue;
    agents++;
    agentCost += a.cost;
    agentTotal += a.total;
  }
  return {
    v: VERSION,
    sessionId,
    file,
    title: t.title,
    project: projectOf(t.cwd),
    cwd: t.cwd,
    branch: t.branch,
    model: t.model,
    family: modelFamily(t.model ?? ''),
    startedAt: Date.parse(t.firstTs) || null,
    endedAt: Date.parse(t.lastTs) || null,
    firstPrompt: t.firstPrompt,
    lastPrompt: t.lastPrompt,
    edited: t.edited,
    agents,
    cost: t.cost + agentCost,
    total: t.total + agentTotal,
    size,
    summary: old?.summary ?? null,
    summaryAt: old?.summaryAt ?? null,
    summarySize: old?.summarySize ?? null,
  };
}

// Subagent and workflow-agent transcripts under <session>/subagents, at any depth.
function jsonlFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return jsonlFiles(p);
    return e.name.startsWith('agent-') && e.name.endsWith('.jsonl') ? [p] : [];
  });
}

export function history() {
  const list = [...records.values()]
    .map(({ file, ...r }) => ({ ...r, gone: !fs.existsSync(file) }))
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  return { scanning, records: list };
}

// state: the live status if the session is still running, else 'done'.
export async function summarizeSession(sessionId, state) {
  const r = records.get(sessionId);
  if (!r) throw new Error('No such session');
  if (!fs.existsSync(r.file)) throw new Error('Claude Code already deleted this transcript, so there is nothing left to summarize');
  const { summary, at } = await summarize({ file: r.file, state, project: r.project });
  Object.assign(r, { summary, summaryAt: at, summarySize: fs.statSync(r.file).size });
  save();
  const { file, ...out } = r;
  return { ...out, gone: false };
}
