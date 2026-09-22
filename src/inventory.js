// What is installed and configured at user level: account, MCP servers, plugins, skills,
// agents, commands, plus usage totals. Slow CLI calls are cached and refreshed in background.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { readTranscript } from './transcript.js';
import { costOfTotals, modelFamily } from './pricing.js';

const HOME = os.homedir();
const CLAUDE = path.join(HOME, '.claude');

function run(args, timeout = 60_000) {
  return new Promise((resolve) => {
    execFile('claude', args, { cwd: HOME, timeout, maxBuffer: 8 << 20 }, (err, stdout) =>
      resolve(err && !stdout ? null : stdout)
    );
  });
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function frontmatter(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const m = text.match(/^---\n([\s\S]*?)\n---/);
    const out = {};
    if (m)
      for (const line of m[1].split('\n')) {
        const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
        if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
      }
    return out;
  } catch {
    return {};
  }
}

const cache = { mcp: null, mcpAt: 0, mcpLoading: null, plugins: null, account: null };

// `claude mcp list` health-checks every server, so it takes ~20s. Never block a request on it.
export function refreshMcp() {
  cache.mcpLoading ??= run(['mcp', 'list'], 90_000).then((out) => {
    cache.mcpLoading = null;
    if (out == null) return;
    cache.mcp = parseMcp(out);
    cache.mcpAt = Date.now();
  });
  return cache.mcpLoading;
}

function parseMcp(out) {
  const config = readJson(path.join(HOME, '.claude.json')) ?? {};
  const userScope = new Set(Object.keys(config.mcpServers ?? {}));
  const localScope = new Map();
  for (const [dir, p] of Object.entries(config.projects ?? {}))
    for (const name of Object.keys(p.mcpServers ?? {})) localScope.set(name, dir);

  const servers = [];
  let warnings = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^(.+?): (.+) - (✔|✗|!|⚠)\s*(.*)$/);
    if (m) {
      const [, name, target, mark, text] = m;
      const account = name.startsWith('claude.ai ');
      servers.push({
        name: account ? name.slice('claude.ai '.length) : name,
        target: target.replace(/\s+\((HTTP|SSE|stdio)\)$/, ''),
        transport: target.match(/\((HTTP|SSE|stdio)\)$/)?.[1] ?? (target.startsWith('http') ? 'HTTP' : 'stdio'),
        status: mark === '✔' ? 'connected' : /auth/i.test(text) ? 'needs-auth' : 'failed',
        statusText: text.trim(),
        scope: account ? 'claude.ai' : userScope.has(name) ? 'user' : localScope.has(name) ? 'local' : 'project',
        localDir: localScope.get(name) ?? null,
      });
    } else if (/^[├└]/.test(line.trim())) warnings.push(line.trim().replace(/^[├└]\s*/, ''));
  }
  return { servers, warnings };
}

async function plugins() {
  const out = await run(['plugin', 'list', '--json']);
  let list = [];
  try {
    list = JSON.parse(out ?? '[]');
  } catch {}
  return list.map((p) => {
    const count = (sub) => {
      try {
        return fs.readdirSync(path.join(p.installPath, sub)).filter((f) => !f.startsWith('.')).length;
      } catch {
        return 0;
      }
    };
    const [name, marketplace] = p.id.split('@');
    return {
      id: p.id,
      name,
      marketplace,
      version: p.version,
      scope: p.scope,
      enabled: p.enabled,
      skills: count('skills'),
      commands: count('commands'),
      agents: count('agents'),
      hooks: fs.existsSync(path.join(p.installPath, 'hooks')),
      installPath: p.installPath,
      updatedAt: p.lastUpdated,
    };
  });
}

function skills(pluginList) {
  const out = [];
  const scan = (dir, source) => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      const fm = frontmatter(file);
      out.push({ name: fm.name ?? name, description: fm.description ?? '', source, path: file });
    }
  };
  scan(path.join(CLAUDE, 'skills'), 'user');
  for (const p of pluginList ?? []) if (p.enabled) scan(path.join(p.installPath, 'skills'), p.name);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function mdEntries(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const fm = frontmatter(path.join(dir, f));
      return { name: fm.name ?? f.replace(/\.md$/, ''), description: fm.description ?? '', model: fm.model ?? null };
    });
}

export async function inventory(force = false) {
  if (force || !cache.plugins) {
    const [p, a] = await Promise.all([plugins(), run(['auth', 'status'])]);
    cache.plugins = p;
    try {
      cache.account = JSON.parse(a ?? 'null');
    } catch {}
  }
  if (force || !cache.mcp) refreshMcp();
  const settings = readJson(path.join(CLAUDE, 'settings.json')) ?? {};
  return {
    account: cache.account && {
      email: cache.account.email,
      plan: cache.account.subscriptionType,
      org: cache.account.orgName,
      authMethod: cache.account.authMethod,
    },
    mcp: cache.mcp,
    mcpLoading: !!cache.mcpLoading,
    mcpCheckedAt: cache.mcpAt || null,
    plugins: cache.plugins,
    skills: skills(cache.plugins),
    agents: mdEntries(path.join(CLAUDE, 'agents')),
    commands: mdEntries(path.join(CLAUDE, 'commands')),
    hooks: Object.entries(settings.hooks ?? {}).map(([event, list]) => ({ event, count: list.length })),
    defaultModel: settings.model ?? null,
  };
}

// Today's usage comes from every transcript written today (sessions + subagents);
// earlier days come from Claude Code's own stats-cache.json, which lags by a day.
export function usage() {
  const stats = readJson(path.join(CLAUDE, 'stats-cache.json')) ?? {};
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const today = { cost: 0, total: 0, output: 0, byFamily: {}, byProject: {}, sessions: 0 };

  const walk = (dir, depth) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) {
        if (depth < 4) walk(p, depth + 1);
        continue;
      }
      if (!f.name.endsWith('.jsonl')) continue;
      let st;
      try {
        st = fs.statSync(p);
      } catch {
        continue;
      }
      if (st.mtimeMs < midnight.getTime()) continue;
      const t = readTranscript(p, midnight.getTime());
      if (!t) continue;
      if (depth === 0) today.sessions++;
      // Subagent transcripts carry the parent's cwd, so every file resolves to a real project.
      const project = projectOf(t.cwd);
      for (const [model, c] of Object.entries(t.byModelToday ?? {})) {
        const fam = modelFamily(model);
        today.byFamily[fam] = (today.byFamily[fam] ?? 0) + c.cost;
        today.byProject[project] = (today.byProject[project] ?? 0) + c.cost;
        today.cost += c.cost;
        today.total += c.total;
        today.output += c.output;
      }
    }
  };
  const root = path.join(CLAUDE, 'projects');
  for (const dir of fs.readdirSync(root)) {
    const full = path.join(root, dir);
    if (fs.statSync(full).isDirectory()) walk(full, 0);
  }

  const days = (stats.dailyModelTokens ?? []).slice(-30).map((d) => {
    const byFamily = {};
    for (const [m, n] of Object.entries(d.tokensByModel)) byFamily[modelFamily(m)] = (byFamily[modelFamily(m)] ?? 0) + n;
    return { date: d.date, byFamily };
  });
  const allTime = Object.entries(stats.modelUsage ?? {}).map(([model, t]) => ({
    model,
    family: modelFamily(model),
    tokens: t.inputTokens + t.outputTokens + t.cacheReadInputTokens + t.cacheCreationInputTokens,
    cost: costOfTotals(model, t),
  }));
  return {
    today,
    days,
    allTime: allTime.sort((a, b) => b.cost - a.cost),
    totals: { sessions: stats.totalSessions, messages: stats.totalMessages, since: stats.firstSessionDate },
    statsThrough: stats.lastComputedDate ?? null,
  };
}

export function projectOf(cwd) {
  if (!cwd) return 'unknown';
  return path.basename(cwd.split('/.claude/worktrees/')[0]);
}

// Recent project dirs for the launcher: live sessions first, then history.jsonl.
export function recentProjects(live) {
  const seen = new Map();
  for (const s of live) seen.set(s.cwd, Date.now());
  try {
    const lines = fs.readFileSync(path.join(CLAUDE, 'history.jsonl'), 'utf8').trim().split('\n').slice(-3000);
    for (const line of lines.reverse()) {
      try {
        const d = JSON.parse(line);
        if (d.project && !seen.has(d.project) && fs.existsSync(d.project)) seen.set(d.project, d.timestamp);
      } catch {}
    }
  } catch {}
  return [...seen.keys()]
    .filter((p) => !p.includes('/.claude/worktrees/') && !p.startsWith('/private/') && !p.startsWith('/tmp'))
    .slice(0, 40)
    .map((p) => ({ path: p, name: path.basename(p) }));
}

// Plan limits (what /usage shows) arrive only through the statusline hook; see bin/statusline.js.
// Fleet never edits settings.json itself: the UI shows the line for the user to add.
const STATUSLINE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'statusline.js');

export function limits() {
  const settings = readJson(path.join(CLAUDE, 'settings.json')) ?? {};
  const command = settings.statusLine?.command ?? '';
  const other = command && !command.includes(STATUSLINE) ? command : null;
  return {
    installed: command.includes(STATUSLINE),
    otherStatusline: other,
    // An existing statusline is wrapped, not replaced: it still renders exactly as before.
    snippet: { statusLine: { ...settings.statusLine, type: 'command', command: `${process.execPath} ${STATUSLINE}${other ? ` ${other}` : ''}` } },
    data: readJson(path.join(HOME, '.fleet', 'limits.json')),
  };
}
