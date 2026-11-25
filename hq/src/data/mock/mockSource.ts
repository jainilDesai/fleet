import { agentPalette } from "../../theme/tokens";
import type { OfficeDataSource, OfficeEvent, SimSpeed } from "../source";
import { BUILT_IN_ROLES, roleKey } from "../names";
import { AgentConfig, AgentPatch, Board, NewAgentInput, ProjectConfig, RoleInfo, WorkflowPatch } from "../types";
import { defaultPresetId, presets, type Preset } from "./presets";
import { Simulation } from "./simulation";
import * as T from "./terminalScripts";
import { mockSession, World } from "./world";

const TICK_MS = 50;

export function createMockSource(): OfficeDataSource {
  let presetId = defaultPresetId;
  let world = new World(findPreset(presetId));
  let sim = new Simulation(world);
  let listener: ((e: OfficeEvent) => void) | null = null;
  let timers: number[] = [];
  let last = 0;
  // Demo: roles you "save" live in memory only; nothing is written.
  let saved: RoleInfo[] = [];

  function findPreset(id: string): Preset {
    return presets.find((p) => p.id === id) ?? presets[0];
  }

  /** Fresh world for the current preset (keeps the speed). */
  function reset() {
    const speed = world.speed;
    world.clearTimers();
    world.setEmitter(null);
    world = new World(findPreset(presetId));
    world.speed = speed;
    sim = new Simulation(world);
  }

  function boot() {
    world.setEmitter((e) => listener?.(e));
    listener?.({ type: "snapshot", snapshot: structuredClone(world.snap) });
    sim.start();
  }

  function loop() {
    const t = performance.now();
    const dt = Math.min(0.25, (t - last) / 1000) * world.speed;
    last = t;
    world.advance(dt);
    sim.tick(dt);
  }

  const source: OfficeDataSource = {
    connect(onEvent, onStatus) {
      listener = onEvent;
      onStatus?.("open");
      last = performance.now();
      reset();
      boot();
      timers = [window.setInterval(loop, TICK_MS)];
      return () => {
        timers.forEach((id) => window.clearInterval(id));
        timers = [];
        world.clearTimers();
        world.setEmitter(null);
        listener = null;
      };
    },

    sendMessage(toId, text) {
      if (!world.cfg(toId) || !text.trim()) return;
      world.message("you", toId, text.trim());
    },

    startAgent(id) {
      const st = world.status(id);
      if (!st || st.session.state === "running") return;
      world.setStatus(id, { session: { ...st.session, state: "running", detail: null } });
      world.activity("session", id, `${world.name(id)}'s session started`);
      if (!world.cfg(id)?.isLead) sim.startWorker(id, 1.5);
    },

    refreshAgent(id) {
      world.activity("session", id, `${world.name(id)} refreshed: a fresh session with a handoff (demo)`);
    },

    listHandoffs(id) {
      world.emit({ type: "handoffs", agentId: id, handoffs: [] });
    },

    // The demo has no server: a pasted image gets a made-up path (the chat shows it as a broken image).
    async uploadImage(image) {
      return `/demo/uploads/${Date.now().toString(16).padStart(16, "0")}.${image.type.split("/")[1] ?? "png"}`;
    },

    listHistory() {
      const own = world.snap.boards.filter((b) => b.status === "done").map((board) => ({ team: "askwell", teamName: world.snap.config.project.name, board, own: true, url: null }));
      const other = {
        team: "askwell-pricing",
        teamName: `${world.snap.config.project.name} · Pricing page`,
        board: { id: "PP", title: "Pricing page", status: "done" as const, order: 0, doneAt: new Date(Date.now() - 86_400_000).toISOString(), summary: "Pricing page shipped in PR #41 (demo).", brief: { prompt: "Build the pricing page with three plans", investigate: false, crew: [], startedAt: null, freshLead: false } },
        own: false,
        url: null,
      };
      world.emit({ type: "history", boards: [other, ...own] });
    },

    stopAgent(id) {
      const st = world.status(id);
      if (!st) return;
      sim.stopAgent(id);
      world.setStatus(id, { state: "idle", currentTaskId: null, note: "Stopped", session: { ...st.session, state: "stopped", detail: null } });
      world.activity("session", id, `${world.name(id)}'s session stopped`);
    },

    stopTeam() {
      for (const a of world.snap.agents) if (a.session.state === "running") source.stopAgent(a.agentId);
    },

    quitFleet() {
      source.stopTeam();
      world.activity("session", null, "Demo: there is no Fleet to quit, so only the agents stopped.");
    },

    openWorkspace() {
      // Demo: nothing opens.
    },

    openInIterm() {
      // Demo: there is no tmux session to attach to.
    },

    trustFolder() {
      // Demo: there is no trust prompt.
    },

    recheckSetup() {
      // Demo: the checks are fixed.
    },

    assignTask(taskId, agentId) {
      const task = world.task(taskId);
      const agent = world.cfg(agentId);
      if (!task || !agent || agent.isLead || task.status !== "todo") return;
      world.patchTask(taskId, { ownerId: agentId });
      world.activity("task.assigned", null, `You assigned ${taskId} ${task.title} to ${agent.name}`);
      if (!sim.hasJob(agentId) && world.status(agentId)?.state === "idle") {
        world.message(world.lead().id, agentId, `Pull main, start ${taskId}.`);
        world.after(1, () => sim.begin(agentId, taskId), agentId);
      }
    },

    addAgent(input: NewAgentInput) {
      const team = world.snap.config.team;
      const base = T.slug(input.name) || "agent";
      let id = base;
      for (let i = 2; team.some((a) => a.id === id); i++) id = `${base}-${i}`;
      const used = new Set(team.map((a) => a.color));
      const color = agentPalette.find((c) => !used.has(c)) ?? agentPalette[team.length % agentPalette.length];
      const lead = world.lead();
      const agent: AgentConfig = {
        id, name: input.name.trim() || "Agent", role: input.role.trim() || "Developer", isLead: false, cli: "claude",
        model: input.model ?? "", mode: "local", color, skills: [],
        roleMd: `# ${input.name} — ${input.role}\n\nYou build the tasks assigned to you.`,
        sandbox: structuredClone(lead.sandbox),
        workspacePath: null,
      };
      team.push(agent);
      world.snap.agents.push({
        agentId: id, state: "idle", currentTaskId: null, stateSince: new Date().toISOString(), note: null,
        session: mockSession(world.snap.config.project.name, id),
      });
      world.configChanged();
      world.emit({ type: "agent.updated", agent: { ...world.snap.agents[world.snap.agents.length - 1] } });
      world.syncEnvironments();
      world.activity("config", null, `Added ${agent.name} (${agent.role})`);
      sim.startWorker(id, 2);
    },

    updateAgent(id, patch: AgentPatch) {
      const agent = world.cfg(id);
      if (!agent) return;
      Object.assign(agent, patch);
      world.configChanged();
    },

    inspectWorkspace(id) {
      const st = world.status(id);
      if (!st) return;
      listener?.({
        type: "workspace.info",
        info: { agentId: id, path: st.session.workspace ?? "", managed: true, exists: true, changedFiles: 1, unpushedCommits: 2, sandboxName: null, sandboxExists: false },
      });
    },

    listRoles() {
      const builtIn = [{ name: "Lead", key: "cto", lead: true }, ...BUILT_IN_ROLES.map((name) => ({ name, key: roleKey(name), lead: false }))].map(
        ({ name, key, lead }): RoleInfo => saved.find((r) => r.key === key) ?? { key, name, builtIn: true, ...(lead ? { lead } : {}), saved: false, roleMd: null, builtInMd: null, skillFiles: [] },
      );
      listener?.({ type: "roles", roles: [...builtIn, ...saved.filter((r) => !r.builtIn)] });
    },

    saveRole(input) {
      const name = input.lead ? "Lead" : input.name.trim();
      const key = roleKey(name, input.lead);
      if (!key || !input.roleMd.trim()) return;
      const builtIn = input.lead || BUILT_IN_ROLES.some((r) => roleKey(r) === key);
      const role: RoleInfo = { key, name, builtIn, ...(input.lead ? { lead: true } : {}), saved: true, roleMd: input.roleMd.trim(), ...(builtIn ? { builtInMd: null } : {}), skillFiles: input.skillFiles ?? [] };
      saved = [...saved.filter((r) => r.key !== key), role];
      world.activity("config", null, `Demo: saved ${name} as your role (in this page only).`);
      source.listRoles();
    },

    deleteRole(key) {
      saved = saved.filter((r) => r.key !== key);
      source.listRoles();
    },

    removeAgent(id) {
      const agent = world.cfg(id);
      if (!agent || agent.isLead) return;
      sim.stopAgent(id);
      world.snap.config.team = world.snap.config.team.filter((a) => a.id !== id);
      world.snap.agents = world.snap.agents.filter((a) => a.agentId !== id);
      for (const t of world.snap.tasks)
        if (t.ownerId === id && t.status !== "done") world.patchTask(t.id, { ownerId: null, status: t.status === "in-progress" ? "todo" : t.status });
      world.emit({ type: "agent.removed", agentId: id });
      world.configChanged();
      world.syncEnvironments();
      world.activity("config", null, `Removed ${agent.name}`);
    },

    resolveActionItem(id, decision, note) {
      const item = world.snap.actionItems?.find((i) => i.id === id);
      if (!item || item.status !== "open") return;
      item.status = decision;
      item.note = note?.trim() || null;
      item.closedAt = new Date().toISOString();
      world.emit({ type: "action.updated", item: { ...item } });
      world.message("you", item.fromId, decision === "done" ? `${item.approval ? "Approved" : "Done"}: ${item.title}${item.note ? ` (${item.note})` : ""}` : `${item.approval ? "Rejected" : "Dismissed"}: ${item.title}${item.note ? ` (${item.note})` : ""}`);
    },

    answerQuestion(id, answers) {
      const item = world.snap.actionItems?.find((i) => i.id === id);
      if (!item || item.status !== "open") return;
      Object.assign(item, { status: "done", answers, closedAt: new Date().toISOString() });
      world.emit({ type: "action.updated", item: { ...item } });
    },

    updateWorkflow(patch: WorkflowPatch) {
      const wf = world.snap.config.workflow;
      Object.assign(wf.review, patch.review);
      Object.assign(wf.merge, patch.merge);
      Object.assign(wf.deploy, patch.deploy);
      if (patch.stopIdleAfterDays !== undefined) wf.stopIdleAfterDays = patch.stopIdleAfterDays;
      if (patch.refreshAtPercent !== undefined) wf.refreshAtPercent = patch.refreshAtPercent;
      world.configChanged();
      world.syncEnvironments();
      sim.workflowChanged();
      world.activity("config", null, "Workflow updated");
    },

    updateProject(patch: Partial<ProjectConfig>) {
      Object.assign(world.snap.config.project, patch);
      world.configChanged();
      world.syncEnvironments();
    },

    createBoard(title) {
      const clean = title.trim();
      if (!clean) return;
      const base = clean.split(/\s+/).map((w) => w[0]).join("").toUpperCase().slice(0, 3) || "B";
      let id = base;
      for (let i = 2; world.snap.boards.some((b) => b.id === id); i++) id = `${base}${i}`;
      const board: Board = { id, title: clean, status: "planned", order: world.snap.boards.length };
      world.snap.boards.push(board);
      world.emit({ type: "board.updated", board: { ...board } });
      world.activity("config", null, `Created board ${clean}`);
    },

    updateBoard(id, patch) {
      const board = world.snap.boards.find((b) => b.id === id);
      if (!board) return;
      Object.assign(board, patch);
      if (patch.status === "done") board.doneAt ??= new Date().toISOString();
      world.emit({ type: "board.updated", board: { ...board } });
    },

    reopenBoard(boardId) {
      this.updateBoard(boardId, { status: "active" });
    },

    newWork(input) {
      const title = input.title?.trim() || input.prompt.trim().split("\n")[0].slice(0, 60) || "New work";
      const base = title.split(/\s+/).map((w) => w[0]).join("").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3) || "B";
      let id = base;
      for (let i = 2; world.snap.boards.some((b) => b.id === id); i++) id = `${base}${i}`;
      const board: Board = { id, title, status: input.startNow ? "active" : "planned", order: world.snap.boards.length, brief: { prompt: input.prompt, investigate: input.investigate, crew: input.crew, startedAt: null } };
      world.snap.boards.push(board);
      world.emit({ type: "board.updated", board: { ...board } });
      if (input.startNow) this.startWork(id);
    },

    startWork(boardId) {
      const board = world.snap.boards.find((b) => b.id === boardId);
      if (!board?.brief || board.brief.startedAt) return;
      board.brief.startedAt = new Date().toISOString();
      board.status = "active";
      world.emit({ type: "board.updated", board: { ...board } });
      world.message("you", world.lead().id, board.brief.prompt);
    },

    completeWelcome() {
      // The demo never shows the welcome screen.
    },

    dev: {
      presets: presets.map((p) => ({ id: p.id, label: p.label })),
      loadPreset(id) {
        presetId = id;
        reset();
        boot();
      },
      setSpeed(multiplier: SimSpeed) {
        world.speed = multiplier;
      },
    },
  };

  return source;
}
