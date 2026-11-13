import { agentPalette } from "../../theme/tokens";
import type { OfficeDataSource, OfficeEvent, SimSpeed } from "../source";
import { AgentConfig, AgentPatch, Board, NewAgentInput, ProjectConfig, WorkflowPatch } from "../types";
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

    stopAgent(id) {
      const st = world.status(id);
      if (!st) return;
      sim.stopAgent(id);
      world.setStatus(id, { state: "idle", currentTaskId: null, note: "Stopped", session: { ...st.session, state: "stopped", detail: null } });
      world.activity("session", id, `${world.name(id)}'s session stopped`);
    },

    openWorkspace() {
      // Demo: nothing opens.
    },

    openInIterm() {
      // Demo: there is no tmux session to attach to.
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
      world.message("you", item.fromId, decision === "done" ? `Done: ${item.title}${item.note ? ` (${item.note})` : ""}` : `Dismissed: ${item.title}${item.note ? ` (${item.note})` : ""}`);
    },

    updateWorkflow(patch: WorkflowPatch) {
      const wf = world.snap.config.workflow;
      Object.assign(wf.review, patch.review);
      Object.assign(wf.merge, patch.merge);
      Object.assign(wf.deploy, patch.deploy);
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
      world.emit({ type: "board.updated", board: { ...board } });
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
