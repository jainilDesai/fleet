const TOKEN = document.querySelector('meta[name=fleet-token]').content;
const $ = (s, el = document) => el.querySelector(s);
const view = $('#view');
const drawer = $('#drawer');
const shell = $('.shell');

const state = {
  view: 'agents',
  sessions: [],
  selected: null, // sessionId open in the drawer
  collapsed: new Set(), // workflow runIds the user folded
  inventory: null,
  usage: null,
  extTab: 'plugins',
  query: '',
  summaries: new Map(), // sumKey -> { summary, at, loading, error }
};

// ---------- helpers ----------
const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n) => (n >= 100 ? `$${n.toFixed(0)}` : n >= 10 ? `$${n.toFixed(1)}` : `$${(n ?? 0).toFixed(2)}`);
const tokens = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : `${n ?? 0}`);
const ago = (t) => {
  if (!t) return '';
  const s = Math.max(0, (Date.now() - (typeof t === 'number' ? t : Date.parse(t))) / 1000);
  if (s < 45) return 'now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
};
const agoText = (t) => (ago(t) === 'now' ? 'just now' : `${ago(t)} ago`);
const clock = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
const modelName = (m) =>
  !m ? '—' : m.replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/-(\d+)$/, ' $1').replace(/^\w/, (c) => c.toUpperCase());
const chip = (family, model) => (model ? `<span class="chip m-${esc(family)}">${esc(modelName(model))}</span>` : '');
const FAMILY_COLORS = { opus: 'var(--opus)', sonnet: 'var(--sonnet)', haiku: 'var(--haiku)', fable: 'var(--fable)', mythos: 'var(--fable)' };
const famColor = (f) => FAMILY_COLORS[f] ?? 'var(--faint)';

// ---------- summaries ----------
const SPARK = '<svg viewBox="0 0 16 16"><path d="M8 2.5l1.3 3.2 3.2 1.3-3.2 1.3L8 11.5 6.7 8.3 3.5 7l3.2-1.3zM12.5 11l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z"/></svg>';
const sumKey = (sid, agentId, runId) => [sid, runId ?? '', agentId ?? ''].join('|');

function sumButton(sid, agentId, runId, status) {
  const entry = state.summaries.get(sumKey(sid, agentId, runId));
  return `<button class="icon-btn${entry?.loading ? ' spinning' : ''}" data-act="summarize" data-session="${esc(sid)}"${agentId ? ` data-agent="${esc(agentId)}"` : ''}${runId ? ` data-run="${esc(runId)}"` : ''} data-state="${esc(status)}" title="Summarize what this agent is doing">${SPARK}</button>`;
}

// lastActive: when the agent last wrote to its transcript, to flag summaries it has outgrown.
function sumBlock(sid, agentId, runId, lastActive) {
  const e = state.summaries.get(sumKey(sid, agentId, runId));
  if (!e) return '';
  if (e.loading && !e.summary) return '<div class="summary loading">Summarizing…</div>';
  if (e.error) return `<div class="summary error">${esc(e.error)}</div>`;
  const text = e.summary.replace(/\*\*|^#+\s*/gm, '').replace(/\n\s*\n+/g, '\n').trim();
  const stale = lastActive && lastActive > e.at + 2000;
  return `<div class="summary">${text.split('\n').map((l) => `<p>${esc(l)}</p>`).join('')}<small>${e.loading ? 'Updating…' : `${agoText(e.at)}${stale ? ' · agent has moved on, click ✦ to refresh' : ''}`}</small></div>`;
}

async function runSummary(el) {
  const { session, agent, run, state: status } = el.dataset;
  const key = sumKey(session, agent, run);
  const prev = state.summaries.get(key);
  if (prev?.loading) return;
  state.summaries.set(key, { ...prev, loading: true, error: null });
  render();
  try {
    const r = await post('/api/summarize', { sessionId: session, agentId: agent, runId: run, state: status });
    state.summaries.set(key, { summary: r.summary, at: r.at, loading: false });
  } catch (err) {
    state.summaries.set(key, { ...prev, loading: false, error: err.message });
  }
  render();
}

function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show${bad ? ' bad' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.className = 'toast'), 3200);
}

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-fleet-token': TOKEN },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

// ---------- routing ----------
const TITLES = { agents: 'Agents', usage: 'Usage', mcp: 'MCP servers', extensions: 'Plugins & skills' };
function route() {
  state.view = TITLES[location.hash.slice(1)] ? location.hash.slice(1) : 'agents';
  document.querySelectorAll('.nav').forEach((a) => a.classList.toggle('active', a.dataset.view === state.view));
  $('#title').textContent = TITLES[state.view];
  if (state.view !== 'agents') closeDrawer();
  if (state.view === 'usage') loadUsage();
  if (state.view === 'mcp' || state.view === 'extensions') loadInventory();
  render();
}
window.addEventListener('hashchange', route);

function render() {
  renderTopMeta();
  if (state.view === 'agents') renderAgents();
  if (state.view === 'usage') renderUsage();
  if (state.view === 'mcp') renderMcp();
  if (state.view === 'extensions') renderExtensions();
  renderDrawer();
}

// ---------- live stream ----------
function connect() {
  const es = new EventSource('/api/stream');
  es.onmessage = (e) => {
    state.sessions = JSON.parse(e.data).sessions;
    $('#nav-live').textContent = state.sessions.length || '';
    if (state.view === 'agents') render();
  };
  es.onerror = () => {
    es.close();
    setTimeout(connect, 2000);
  };
}

function allSubagents(s) {
  return [...s.subagents, ...s.workflows.flatMap((w) => w.agents)];
}

function renderTopMeta() {
  const el = $('#top-meta');
  if (state.view !== 'agents') return (el.innerHTML = '');
  const busy = state.sessions.filter((s) => s.status === 'busy').length;
  const running = state.sessions.flatMap(allSubagents).filter((a) => a.state === 'running').length;
  const cost = state.sessions.reduce((n, s) => n + s.combined.cost, 0);
  el.innerHTML = `
    <span><b>${state.sessions.length}</b> live</span>
    <span><b>${busy}</b> working</span>
    <span><b>${running}</b> subagents running</span>
    <span title="API-equivalent cost of the live sessions, including their subagents"><b>${money(cost)}</b> in live sessions</span>`;
}

// ---------- agents ----------
function renderAgents() {
  if (!state.sessions.length) {
    view.innerHTML = `<div class="empty"><b>No Claude Code sessions running</b>Start one with <em>New agent</em>, or run <code>claude</code> in any terminal. It shows up here within a couple of seconds.</div>`;
    return;
  }
  const groups = new Map();
  for (const s of state.sessions) {
    if (!groups.has(s.cwd)) groups.set(s.cwd, []);
    groups.get(s.cwd).push(s);
  }
  view.innerHTML = [...groups.entries()]
    .map(
      ([cwd, list]) => `
      <section class="group">
        <div class="group-head"><h2>${esc(list[0].project)}</h2><span>${esc(cwd.replace(/^\/Users\/[^/]+/, '~'))}</span></div>
        <div class="cards">${list.map(card).join('')}</div>
      </section>`
    )
    .join('');
}

function card(s) {
  const subs = allSubagents(s);
  const running = subs.filter((a) => a.state === 'running').length;
  const ctxClass = s.contextPct >= 85 ? 'full' : s.contextPct >= 60 ? 'hot' : '';
  const now = s.now
    ? `<span class="tool">${esc(s.now.tool)}</span><span class="detail">${esc(s.now.detail)}</span><span>· ${ago(s.now.ts)}</span>`
    : '<span>No tool calls yet</span>';
  return `
    <article class="card${state.selected === s.sessionId ? ' selected' : ''}" data-session="${esc(s.sessionId)}">
      <div class="card-title">
        <span class="dot ${esc(s.status)}" title="${esc(s.status)}"></span>
        <span class="name">${esc(s.name ?? s.sessionId.slice(0, 8))}</span>
        ${chip(s.family, s.model)}
        ${s.branch ? `<span class="chip ghost">${esc(s.branch)}</span>` : ''}
        ${subs.length ? `<span class="chip agents">${subs.length} agent${subs.length > 1 ? 's' : ''}${running ? ` · ${running} running` : ''}</span>` : ''}
        ${s.workflows.length ? `<span class="chip">${s.workflows.length} workflow${s.workflows.length > 1 ? 's' : ''}</span>` : ''}
        ${sumButton(s.sessionId, null, null, s.status)}
      </div>
      ${sumBlock(s.sessionId, null, null, Date.parse(s.lastTs))}
      <div class="card-task" title="${esc(s.lastPrompt)}">${esc(s.lastPrompt ?? s.task ?? 'Waiting for the first prompt')}</div>
      <div class="card-now">${now}</div>
      <div class="card-side">
        <div class="stat"><small>Cost</small><span class="num">${money(s.combined.cost)}</span></div>
        <div class="stat"><small>Tokens</small><span class="num">${tokens(s.combined.total)}</span></div>
        <div class="stat"><small>Context</small><span class="num">${s.contextPct}%</span><div class="ctx ${ctxClass}"><i style="width:${s.contextPct}%"></i></div></div>
      </div>
    </article>`;
}

view.addEventListener('click', (e) => {
  const sum = e.target.closest('[data-act=summarize]');
  if (sum) return runSummary(sum);
  const c = e.target.closest('.card');
  if (c) openDrawer(c.dataset.session);
});

// ---------- drawer ----------
function openDrawer(id) {
  state.selected = state.selected === id ? null : id;
  render();
}
function closeDrawer() {
  state.selected = null;
  shell.classList.remove('with-drawer');
  drawer.setAttribute('aria-hidden', 'true');
}

function renderDrawer() {
  const s = state.sessions.find((x) => x.sessionId === state.selected);
  if (!s || state.view !== 'agents') return closeDrawer();
  shell.classList.add('with-drawer');
  drawer.setAttribute('aria-hidden', 'false');
  const scroll = drawer.scrollTop;
  const t = s.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const subCost = s.combined.cost - s.cost;
  drawer.innerHTML = `
    <div class="d-head">
      <div class="d-title">
        <span class="dot ${esc(s.status)}"></span>
        <h3>${esc(s.name)}</h3>
        ${chip(s.family, s.model)}
        <button class="close" data-act="close" title="Close"><svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>
      </div>
      <div class="d-path">${esc(s.cwd)}${s.branch ? ` · ${esc(s.branch)}` : ''} · pid ${s.pid} · ${esc(s.status)} ${ago(s.statusSince)}</div>
      <div class="d-actions">
        <button class="btn small" data-act="focus" data-pid="${s.pid}"><svg viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M5 7l2 1.5L5 10M8.5 10H11"/></svg>Show terminal</button>
        <button class="btn small" data-act="summarize" data-session="${esc(s.sessionId)}" data-state="${esc(s.status)}">${SPARK}Summarize</button>
        <button class="btn small" data-act="copy" data-text="claude --resume ${esc(s.sessionId)}">Copy resume command</button>
      </div>
    </div>
    <div class="d-body">
      ${state.summaries.has(sumKey(s.sessionId)) ? `<div class="d-section"><h4>What it's doing</h4>${sumBlock(s.sessionId, null, null, Date.parse(s.lastTs))}</div>` : ''}
      <div class="d-section">
        <h4>Cost & tokens</h4>
        <div class="grid4">
          <div><small>Session</small><span class="num">${money(s.cost)}</span></div>
          <div><small>Subagents</small><span class="num">${money(subCost)}</span></div>
          <div><small>Output</small><span class="num">${tokens(t.output)}</span></div>
          <div><small>Context</small><span class="num">${tokens(s.context)} · ${s.contextPct}%</span></div>
        </div>
        <p class="note" style="margin:8px 2px 0">Input ${tokens(t.input)} · cache read ${tokens(t.cacheRead)} · cache write ${tokens(t.cacheWrite)}. Costs are API-equivalent estimates.</p>
      </div>
      ${s.lastPrompt ? `<div class="d-section"><h4>Latest prompt</h4><p class="quote">${esc(s.lastPrompt)}</p></div>` : ''}
      ${s.task && s.task !== s.lastPrompt ? `<div class="d-section"><h4>Started with</h4><p class="quote">${esc(s.task)}</p></div>` : ''}
      ${s.workflows.length ? workflowsSection(s) : ''}
      ${s.subagents.length ? subagentsSection(s) : ''}
      <div class="d-section">
        <h4>Recent activity <span>${s.activity.length}</span></h4>
        ${
          s.activity.length
            ? `<ul class="timeline">${s.activity
                .map((a) => `<li><time>${clock(a.ts)}</time><span class="tool">${esc(a.tool)}</span><span class="detail" title="${esc(a.detail)}">${esc(a.detail)}</span></li>`)
                .join('')}</ul>`
            : '<p class="note" style="margin:0">Nothing yet.</p>'
        }
      </div>
    </div>`;
  drawer.scrollTop = scroll;
}

function agentRow(a, children, sid) {
  const kids = children.get(a.id) ?? [];
  return `
    <div class="agent-row">
      <span class="dot ${esc(a.state)}" title="${esc(a.state)}"></span>
      <span class="label" title="${esc(a.description)}">${esc(a.description ?? a.id)}</span>
      <span class="right">${chip(a.family, a.model)}<span class="num">${money(a.cost)}</span>${sumButton(sid, a.id, null, a.state)}</span>
      <div class="meta">
        <span>${esc(a.type)}${a.background ? ' · background' : ''}</span>
        ${a.now ? `<span class="detail">${esc(a.now.tool)} ${esc(a.now.detail)}</span>` : ''}
      </div>
      ${sumBlock(sid, a.id, null, a.mtime)}
    </div>
    ${kids.length ? `<div class="nested">${kids.map((k) => agentRow(k, children, sid)).join('')}</div>` : ''}`;
}

function subagentsSection(s) {
  const children = new Map();
  const ids = new Set(s.subagents.map((a) => a.id));
  for (const a of s.subagents)
    if (a.parentId && ids.has(a.parentId)) {
      if (!children.has(a.parentId)) children.set(a.parentId, []);
      children.get(a.parentId).push(a);
    }
  const roots = s.subagents.filter((a) => !a.parentId || !ids.has(a.parentId)).reverse();
  const running = s.subagents.filter((a) => a.state === 'running').length;
  return `<div class="d-section">
    <h4>Subagents <span>${s.subagents.length}${running ? ` · ${running} running` : ''}</span></h4>
    ${roots.map((a) => agentRow(a, children, s.sessionId)).join('')}
  </div>`;
}

function workflowsSection(s) {
  const list = [...s.workflows].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  return `<div class="d-section">
    <h4>Workflows <span>${list.length}</span></h4>
    ${list.map((w) => workflowCard(w, s.sessionId)).join('')}
  </div>`;
}

function workflowCard(w, sid) {
  // Order columns by the script's declared phases; agents without one go in a trailing column.
  const cols = w.phases.map((p) => ({ ...p, agents: w.agents.filter((a) => a.phase === p.title) }));
  const loose = w.agents.filter((a) => !w.phases.some((p) => p.title === a.phase));
  if (loose.length) cols.push({ title: w.phases.length ? 'Other' : 'Agents', detail: '', agents: loose });
  const done = w.agents.filter((a) => a.state === 'done').length;
  const failed = w.agents.filter((a) => a.state === 'failed').length;
  const pill =
    w.status === 'completed' ? '<span class="pill off">completed</span>' : w.status === 'running' ? '<span class="pill ok">running</span>' : `<span class="pill warn">${esc(w.status)}</span>`;
  // A running workflow opens expanded; finished ones fold unless the user opened them.
  const folded = state.collapsed.has(w.runId) !== (w.status === 'completed');
  return `
    <div class="wf${folded ? ' collapsed' : ''}">
      <div class="wf-head" data-act="fold" data-run="${esc(w.runId)}">
        <span class="name">${esc(w.name)}</span>${pill}
        <span class="right"><span class="num">${done}/${w.agents.length}${failed ? ` · ${failed} failed` : ''}</span><span class="num">${money(w.cost)}</span>${w.durationMs ? `<span class="num">${Math.round(w.durationMs / 60000)}m</span>` : ''}</span>
      </div>
      ${w.summary ? `<div class="wf-summary">${esc(w.summary)}</div>` : ''}
      <div class="phases">
        ${cols
          .map((c) => {
            const d = c.agents.filter((a) => a.state === 'done').length;
            return `<div class="phase">
              <h5>${esc(c.title)}</h5>${c.detail ? `<p>${esc(c.detail)}</p>` : ''}
              <div class="phase-bar"><i style="width:${c.agents.length ? (d / c.agents.length) * 100 : 0}%"></i></div>
              ${c.agents
                .map(
                  (a) => `<div class="pa" title="${esc(a.label)}${a.now ? `\n${esc(a.now.tool)}: ${esc(a.now.detail)}` : ''}">
                    <span class="dot ${esc(a.state)}"></span><span class="label">${esc(a.label)}</span><span class="num">${money(a.cost)}</span>${sumButton(sid, a.id, w.runId, a.state)}</div>
                    ${sumBlock(sid, a.id, w.runId)}`
                )
                .join('') || '<p>No agents</p>'}
            </div>`;
          })
          .join('')}
      </div>
    </div>`;
}

drawer.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  if (act === 'close') return closeDrawer(), render();
  if (act === 'summarize') return runSummary(el);
  if (act === 'fold') {
    const id = el.dataset.run;
    state.collapsed.has(id) ? state.collapsed.delete(id) : state.collapsed.add(id);
    return renderDrawer();
  }
  if (act === 'copy') {
    await navigator.clipboard.writeText(el.dataset.text);
    return toast('Copied');
  }
  if (act === 'focus') {
    try {
      const r = await post('/api/focus', { pid: Number(el.dataset.pid) });
      toast(r.app === 'Terminal' || r.app.startsWith('iTerm') ? `Opened in ${r.app}` : `Brought ${r.app} forward`);
    } catch (err) {
      toast(err.message, true);
    }
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.selected && !$('#launch').open) closeDrawer(), render();
});

// ---------- usage ----------
async function loadUsage() {
  state.usage = await (await fetch('/api/usage')).json();
  render();
}

function renderUsage() {
  const u = state.usage;
  if (!u) return (view.innerHTML = '<p class="note">Reading transcripts…</p>');
  const fams = Object.entries(u.today.byFamily).sort((a, b) => b[1] - a[1]);
  const projects = Object.entries(u.today.byProject).sort((a, b) => b[1] - a[1]);
  const maxProject = projects[0]?.[1] || 1;
  const allCost = u.allTime.reduce((n, m) => n + m.cost, 0);
  const allFam = {};
  for (const m of u.allTime) allFam[m.family] = (allFam[m.family] ?? 0) + m.cost;
  const opusShare = u.today.cost ? Math.round(((u.today.byFamily.opus ?? 0) / u.today.cost) * 100) : 0;
  const days = u.days;
  const dayTotal = (d) => Object.values(d.byFamily).reduce((a, b) => a + b, 0);
  const maxDay = Math.max(1, ...days.map(dayTotal));
  const famOrder = ['haiku', 'sonnet', 'opus', 'fable', 'mythos'];

  view.innerHTML = `
    ${limitsPanel(u.limits)}
    <div class="kpis">
      <div class="kpi"><small>Today</small><div class="big">${money(u.today.cost)}</div><div class="sub">${tokens(u.today.total)} tokens · ${u.today.sessions} sessions</div></div>
      <div class="kpi"><small>Output today</small><div class="big">${tokens(u.today.output)}</div><div class="sub">tokens written by models</div></div>
      <div class="kpi"><small>Opus / Fable share today</small><div class="big">${u.today.cost ? Math.round((((u.today.byFamily.opus ?? 0) + (u.today.byFamily.fable ?? 0)) / u.today.cost) * 100) : 0}%</div><div class="sub">${opusShare > 80 ? 'Try Sonnet or Haiku for routine tasks' : 'of today’s spend'}</div></div>
      <div class="kpi"><small>All time</small><div class="big">${money(allCost)}</div><div class="sub">${Number(u.totals.sessions ?? 0).toLocaleString()} sessions since ${u.totals.since ? new Date(u.totals.since).toLocaleDateString([], { month: 'short', year: 'numeric' }) : '—'}</div></div>
    </div>
    <p class="note">Costs are API-equivalent estimates from token counts. A Pro or Max plan is not billed per token.</p>

    <div class="panel">
      <div class="panel-head"><h2>Today by model</h2></div>
      <div style="padding:6px 16px 14px">
        <div class="split">${fams.map(([f, c]) => `<i style="width:${(c / u.today.cost) * 100}%;background:${famColor(f)}"></i>`).join('')}</div>
        <div class="legend">${fams.map(([f, c]) => `<span><i style="background:${famColor(f)}"></i>${esc(f)} ${money(c)}</span>`).join('') || 'No usage yet today'}</div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head"><h2>Today by project</h2></div>
      ${projects.map(([p, c]) => `<div class="hbar"><span>${esc(p)}</span><span class="track"><i style="width:${(c / maxProject) * 100}%"></i></span><span class="num">${money(c)}</span></div>`).join('') || '<p class="note" style="margin:12px 16px">No usage yet today</p>'}
    </div>

    <div class="panel">
      <div class="panel-head"><h2>Last ${days.length} days</h2><span class="sub">tokens per day by model, through ${esc(u.statsThrough ?? '—')}</span></div>
      <div class="bars">
        ${days
          .map((d) => {
            const total = dayTotal(d);
            return `<div class="bar" data-tip="${esc(d.date)} · ${tokens(total)}">${famOrder
              .filter((f) => d.byFamily[f])
              .map((f) => `<i style="height:${(d.byFamily[f] / maxDay) * 100}%;background:${famColor(f)}"></i>`)
              .join('')}</div>`;
          })
          .join('')}
      </div>
      <div class="bar-axis"><span>${esc(days[0]?.date ?? '')}</span><span>${esc(days.at(-1)?.date ?? '')}</span></div>
    </div>

    <div class="panel">
      <div class="panel-head"><h2>All time by model</h2></div>
      ${u.allTime
        .map(
          (m) => `<div class="hbar"><span>${chip(m.family, m.model)}</span><span class="track"><i style="width:${(m.cost / (u.allTime[0]?.cost || 1)) * 100}%;background:${famColor(m.family)}"></i></span><span class="num">${money(m.cost)}</span></div>`
        )
        .join('')}
    </div>`;
}

const LIMIT_NAMES = {
  five_hour: 'Current session · 5 hours',
  seven_day: 'Weekly · all models',
  seven_day_opus: 'Weekly · Opus',
  seven_day_sonnet: 'Weekly · Sonnet',
  overage: 'Extra usage',
};

function resetsIn(v) {
  if (v == null) return '';
  const ms = (typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v)) - Date.now();
  if (!(ms > 0)) return 'resetting';
  const h = ms / 3.6e6;
  return h >= 24 ? `resets in ${Math.round(h / 24)}d` : h >= 1 ? `resets in ${Math.round(h)}h` : `resets in ${Math.max(1, Math.round(ms / 6e4))}m`;
}

// Plan limits, the numbers /usage shows. They only reach Fleet through the statusline script.
function limitsPanel(l) {
  if (!l) return '';
  const rows = Object.entries(l.data?.rateLimits ?? {}).filter(([, v]) => v && v.used_percentage != null);
  if (rows.length)
    return `<div class="panel">
      <div class="panel-head"><h2>Plan limits</h2><span class="sub">same numbers as /usage · updated ${agoText(l.data.at)}, after each Claude turn</span></div>
      ${rows
        .map(([k, v]) => {
          const pct = Math.round(v.used_percentage);
          const color = pct >= 90 ? 'var(--bad)' : pct >= 70 ? 'var(--warn)' : 'var(--accent)';
          return `<div class="hbar wide"><span>${esc(LIMIT_NAMES[k] ?? k.replace(/_/g, ' '))}</span><span class="track"><i style="width:${pct}%;background:${color}"></i></span><span class="num">${pct}% <small style="color:var(--faint)">${esc(resetsIn(v.resets_at))}</small></span></div>`;
        })
        .join('')}
    </div>`;
  const snippet = JSON.stringify(l.snippet, null, 2);
  return `<div class="panel">
    <div class="panel-head"><h2>Plan limits</h2><span class="sub">${l.installed ? 'waiting for the first Claude turn' : 'not connected'}</span></div>
    <div style="padding:12px 16px 16px;color:var(--muted)">
      ${
        l.installed
          ? 'The statusline is set up. Limits appear here after any Claude Code session finishes its next turn.'
          : `Claude Code only passes plan limits (the numbers <code>/usage</code> shows) to a statusline script. To show them here, replace <code>statusLine</code> in <code>~/.claude/settings.json</code> with the block below. ${
              l.otherStatusline
                ? `It wraps your current statusline (<code>${esc(l.otherStatusline)}</code>), so your terminals look exactly the same.`
                : 'Your terminals then show a short line like <code>Opus 5.5 · ctx 41% · 5h 37% · 7d 63%</code>.'
            } Takes effect on each session's next turn.`
      }
      ${l.installed ? '' : `<p class="cmd" style="margin-top:10px;white-space:pre-wrap">${esc(snippet)}</p><button class="btn small" data-act="copy-snippet" style="margin-top:8px">Copy</button>`}
    </div>
  </div>`;
}

// ---------- inventory ----------
async function loadInventory(refresh = false) {
  state.inventory = await (await fetch(`/api/inventory${refresh ? '?refresh' : ''}`)).json();
  renderAccount();
  render();
  // MCP health checks take ~20s; poll until they land.
  if (state.inventory.mcpLoading) setTimeout(() => ['mcp', 'extensions'].includes(state.view) && loadInventory(), 3000);
}

function renderAccount() {
  const a = state.inventory?.account;
  if (!a) return;
  $('#account').innerHTML = `<b title="${esc(a.email)}">${esc(a.email)}</b>${esc(a.authMethod === 'claude.ai' ? 'Claude account' : a.authMethod)}<br /><span class="plan">${esc(a.plan ?? 'API')}</span>`;
}

function renderMcp() {
  const inv = state.inventory;
  if (!inv) return (view.innerHTML = '<p class="note">Loading…</p>');
  if (!inv.mcp)
    return (view.innerHTML = `<div class="empty"><b>Checking MCP servers…</b>Claude Code connects to every server to check health. This takes about 20 seconds.</div>`);
  const groups = [
    ['claude.ai', 'Claude.ai account connectors', 'Added in claude.ai settings; follow your account to every device'],
    ['user', 'User servers', 'In ~/.claude.json; available in every project on this machine'],
    ['local', 'Local servers', 'Tied to one project directory'],
    ['project', 'Project servers', 'From a .mcp.json in the current directory'],
  ];
  const pill = (s) =>
    s.status === 'connected' ? '<span class="pill ok">Connected</span>' : s.status === 'needs-auth' ? '<span class="pill warn">Needs auth</span>' : `<span class="pill bad">${esc(s.statusText || 'Failed')}</span>`;
  const ok = inv.mcp.servers.filter((s) => s.status === 'connected').length;
  view.innerHTML = `
    <p class="note" style="margin-top:0">${ok} of ${inv.mcp.servers.length} connected · checked ${agoText(inv.mcpCheckedAt)}
      <button class="btn small" data-act="mcp-refresh" style="margin-left:8px" ${inv.mcpLoading ? 'disabled' : ''}>${inv.mcpLoading ? 'Checking…' : 'Recheck'}</button></p>
    ${groups
      .map(([scope, title, sub]) => {
        const list = inv.mcp.servers.filter((s) => s.scope === scope);
        if (!list.length) return '';
        return `<div class="panel"><div class="panel-head"><h2>${title}</h2><span class="sub">${sub}</span></div>
          ${list
            .map(
              (s) => `<div class="list-row">
                <span class="dot ${s.status === 'connected' ? 'done' : s.status === 'needs-auth' ? 'queued' : 'failed'}" style="${s.status === 'connected' ? 'background:var(--busy)' : ''}"></span>
                <span class="name">${esc(s.name)}</span>
                <span class="desc mono" title="${esc(s.target)}">${esc(s.transport)} · ${esc(s.target)}${s.localDir ? ` · ${esc(s.localDir)}` : ''}</span>
                ${pill(s)}
              </div>`
            )
            .join('')}
          ${scope === 'user' && inv.mcp.warnings.length ? `<div class="warnings">${inv.mcp.warnings.map(esc).join('<br>')}</div>` : ''}
        </div>`;
      })
      .join('')}`;
}

function renderExtensions() {
  const inv = state.inventory;
  if (!inv) return (view.innerHTML = '<p class="note">Loading…</p>');
  const q = state.query.toLowerCase();
  const match = (...f) => !q || f.some((x) => String(x ?? '').toLowerCase().includes(q));
  const tabs = [
    ['plugins', 'Plugins', inv.plugins.length],
    ['skills', 'Skills', inv.skills.length],
    ['agents', 'Agents', inv.agents.length],
    ['commands', 'Commands', inv.commands.length],
    ['hooks', 'Hooks', inv.hooks.length],
  ];
  let body = '';
  if (state.extTab === 'plugins')
    body = inv.plugins
      .filter((p) => match(p.name, p.marketplace))
      .map(
        (p) => `<div class="list-row">
          <span class="dot" style="background:${p.enabled ? 'var(--busy)' : 'var(--idle)'}"></span>
          <span class="name">${esc(p.name)}</span>
          <span class="desc">${[p.skills && `${p.skills} skills`, p.commands && `${p.commands} commands`, p.agents && `${p.agents} agents`, p.hooks && 'hooks'].filter(Boolean).join(' · ') || '—'} <span style="color:var(--faint)">· ${esc(p.marketplace)} · ${esc(p.version)}</span></span>
          <span class="pill ${p.enabled ? 'ok' : 'off'}">${p.enabled ? 'Enabled' : 'Disabled'}</span>
        </div>`
      )
      .join('');
  if (state.extTab === 'skills')
    body = inv.skills
      .filter((s) => match(s.name, s.description, s.source))
      .map(
        (s) => `<div class="list-row"><span></span><span class="name">${esc(s.name)}</span><span class="desc" title="${esc(s.description)}">${esc(s.description)}</span><span class="pill off">${esc(s.source)}</span></div>`
      )
      .join('');
  if (state.extTab === 'agents' || state.extTab === 'commands')
    body =
      inv[state.extTab]
        .filter((s) => match(s.name, s.description))
        .map((s) => `<div class="list-row"><span></span><span class="name">${esc(s.name)}</span><span class="desc">${esc(s.description)}</span>${s.model ? chip(s.model, s.model) : '<span></span>'}</div>`)
        .join('') || `<p class="note" style="margin:14px 16px">None in ~/.claude/${state.extTab}</p>`;
  if (state.extTab === 'hooks')
    body =
      inv.hooks.map((h) => `<div class="list-row"><span></span><span class="name">${esc(h.event)}</span><span class="desc">${h.count} matcher group${h.count > 1 ? 's' : ''} in ~/.claude/settings.json</span><span></span></div>`).join('') ||
      '<p class="note" style="margin:14px 16px">No user-level hooks. Plugin hooks are listed on each plugin.</p>';

  view.innerHTML = `
    <div class="tabs">
      ${tabs.map(([k, label, n]) => `<button class="tab${state.extTab === k ? ' active' : ''}" data-tab="${k}">${label}<span>${n}</span></button>`).join('')}
      <input class="search" id="ext-search" placeholder="Filter…" value="${esc(state.query)}" />
    </div>
    <div class="panel">${body || '<p class="note" style="margin:14px 16px">No matches</p>'}</div>`;
  const input = $('#ext-search');
  if (document.activeElement?.id !== 'ext-search' && state.query) input.focus(), input.setSelectionRange(99, 99);
}

view.addEventListener('click', async (e) => {
  const tab = e.target.closest('[data-tab]');
  if (tab) return (state.extTab = tab.dataset.tab), renderExtensions();
  if (e.target.closest('[data-act=copy-snippet]')) {
    await navigator.clipboard.writeText(JSON.stringify(state.usage.limits.snippet.statusLine, null, 2));
    return toast('Copied. Paste it as "statusLine" in ~/.claude/settings.json');
  }
  if (e.target.closest('[data-act=mcp-refresh]')) {
    await post('/api/mcp/refresh', {});
    loadInventory();
  }
});
view.addEventListener('input', (e) => {
  if (e.target.id !== 'ext-search') return;
  state.query = e.target.value;
  renderExtensions();
  const input = $('#ext-search');
  input.focus();
  input.setSelectionRange(state.query.length, state.query.length);
});

// ---------- launcher ----------
const dialog = $('#launch');
const form = $('#launch-form');
const PREF_KEY = 'fleet.launch';

function prefs() {
  try {
    return JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}');
  } catch {
    return {};
  }
}

$('#new-agent').addEventListener('click', async () => {
  const projects = await (await fetch('/api/projects')).json();
  $('#project-list').innerHTML = projects.map((p) => `<option value="${esc(p.path)}">${esc(p.name)}</option>`).join('');
  const p = prefs();
  const selected = state.sessions.find((s) => s.sessionId === state.selected);
  form.cwd.value = selected?.cwd ?? p.cwd ?? projects[0]?.path ?? '';
  if (p.model) form.querySelector(`input[name=model][value=${p.model}]`)?.click();
  if (p.terminal) form.terminal.value = p.terminal;
  $('#launch-error').textContent = '';
  preview();
  dialog.showModal();
  form.prompt.focus();
});

function formData() {
  const f = new FormData(form);
  return {
    cwd: f.get('cwd').trim(),
    model: f.get('model'),
    prompt: f.get('prompt'),
    name: f.get('name').trim(),
    effort: f.get('effort') || undefined,
    permissionMode: f.get('permissionMode'),
    worktree: f.get('worktree') === 'on',
    terminal: f.get('terminal'),
  };
}

function preview() {
  const d = formData();
  const parts = ['claude', '--model', d.model];
  if (d.effort) parts.push('--effort', d.effort);
  if (d.permissionMode !== 'default') parts.push('--permission-mode', d.permissionMode);
  if (d.name) parts.push('--name', JSON.stringify(d.name));
  if (d.worktree) parts.push('--worktree');
  if (d.prompt.trim()) parts.push(JSON.stringify(d.prompt.trim().length > 60 ? d.prompt.trim().slice(0, 60) + '…' : d.prompt.trim()));
  $('#cmd-preview').textContent = `cd ${d.cwd || '…'} && ${parts.join(' ')}`;
}
form.addEventListener('input', preview);
form.addEventListener('change', preview);

form.addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'go') return;
  e.preventDefault();
  const d = formData();
  const btn = $('#launch-go');
  btn.disabled = true;
  try {
    await post('/api/launch', d);
    localStorage.setItem(PREF_KEY, JSON.stringify({ cwd: d.cwd, model: d.model, terminal: d.terminal }));
    dialog.close();
    form.prompt.value = '';
    form.name.value = '';
    toast(`Launching ${d.model} in ${d.cwd.split('/').pop()}`);
  } catch (err) {
    $('#launch-error').textContent = /not allowed|1743|-1743/i.test(err.message)
      ? 'macOS blocked Fleet from controlling your terminal. Allow it in System Settings → Privacy & Security → Automation, then try again.'
      : err.message;
  } finally {
    btn.disabled = false;
  }
});

// ---------- boot ----------
route();
connect();
loadInventory();
setInterval(() => (state.view === 'agents' ? render() : state.view === 'usage' && loadUsage()), 30_000); // fresh "ago" labels, limits
