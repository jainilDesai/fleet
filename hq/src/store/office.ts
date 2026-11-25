// The office store: the only place that talks to the data source.
// Components and the PixiJS scene read from here.

import { create } from "zustand";
import { createMockSource } from "../data/mock/mockSource";
import type { ConnectionStatus, DataPreset, OfficeDataSource, OfficeEvent, SimSpeed } from "../data/source";
import { createSseSource } from "../data/sse/sseSource";
import type { AgentConfig, AgentStatus, BoardDoneCheck, Handoff, OfficeSnapshot, PastBoard, RemoveAgentOptions, RoleInfo, SaveRoleInput, WelcomeInput, WorkspaceInfo } from "../data/types";

export interface LoggedEvent {
  n: number;
  at: number;
  event: OfficeEvent;
}

interface OfficeState {
  snap: OfficeSnapshot | null;
  epoch: number; // bumps on every full snapshot (e.g. a preset reload)
  events: LoggedEvent[]; // last 20
  speed: SimSpeed;
  presets: DataPreset[] | null;
  live: boolean; // connected to Fleet's server (vs. the demo mock)
  workspaceInfo: Record<string, WorkspaceInfo>; // answers to inspectWorkspace
  roles: RoleInfo[] | null; // answer to listRoles
  handoffs: Record<string, Handoff[]>; // answers to listHandoffs, by agent
  history: PastBoard[] | null; // answer to listHistory: the project's boards across its teams
  doneCheck: BoardDoneCheck | null; // a Done waiting for your confirmation
  teamStarted: { title: string; url: string } | null; // New work's separate team is up: a link to it
  connection: ConnectionStatus;
  quit: boolean; // you quit Fleet from this page
  source: OfficeDataSource;
}

/**
 * Fleet's server writes its per-run token into the page it serves. With a token we talk to
 * the real server; without one (`npm run dev` straight from Vite) the UI runs on the mock.
 */
function fleetToken(): string | null {
  const t = (window as { __FLEET_PAGE_TOKEN__?: string }).__FLEET_PAGE_TOKEN__;
  return t && !t.startsWith("__") ? t : null;
}

const token = fleetToken();
const source: OfficeDataSource = token ? createSseSource(token) : createMockSource();

export const useOffice = create<OfficeState>(() => ({
  snap: null,
  epoch: 0,
  events: [],
  speed: 1,
  presets: source.dev?.presets ?? null,
  live: token !== null,
  workspaceInfo: {},
  roles: null,
  handoffs: {},
  history: null,
  doneCheck: null,
  teamStarted: null,
  connection: "connecting",
  quit: false,
  source,
}));

let eventN = 0;

function upsert<T>(list: T[], item: T, same: (a: T) => boolean): T[] {
  const i = list.findIndex(same);
  if (i === -1) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

function reduce(snap: OfficeSnapshot, e: OfficeEvent): OfficeSnapshot {
  switch (e.type) {
    case "snapshot":
      return e.snapshot;
    case "workspace.info":
    case "roles":
    case "handoffs":
    case "history":
    case "board.doneCheck":
    case "team.started":
      return snap;
    case "setup.updated":
      return { ...snap, setup: e.setup };
    case "config.updated":
      return { ...snap, config: e.config };
    case "agent.updated":
      return { ...snap, agents: upsert(snap.agents, e.agent, (a) => a.agentId === e.agent.agentId) };
    case "agent.removed":
      return { ...snap, agents: snap.agents.filter((a) => a.agentId !== e.agentId) };
    case "board.updated":
      return { ...snap, boards: upsert(snap.boards, e.board, (b) => b.id === e.board.id) };
    case "task.updated":
      return { ...snap, tasks: upsert(snap.tasks, e.task, (t) => t.id === e.task.id) };
    case "task.removed":
      return { ...snap, tasks: snap.tasks.filter((t) => t.id !== e.taskId) };
    case "pr.updated":
      return { ...snap, pullRequests: upsert(snap.pullRequests, e.pr, (p) => p.number === e.pr.number) };
    case "env.updated":
      return { ...snap, environments: upsert(snap.environments, e.env, (x) => x.name === e.env.name) };
    case "env.removed":
      return { ...snap, environments: snap.environments.filter((x) => x.name !== e.name) };
    case "message":
      return { ...snap, messages: [e.message, ...snap.messages].slice(0, 100) };
    case "activity":
      return { ...snap, activity: [e.event, ...snap.activity].slice(0, 50) };
    case "action.updated":
      return { ...snap, actionItems: upsert(snap.actionItems ?? [], e.item, (i) => i.id === e.item.id) };
  }
}

function handle(e: OfficeEvent) {
  if (e.type === "workspace.info") {
    useOffice.setState((s) => ({ workspaceInfo: { ...s.workspaceInfo, [e.info.agentId]: e.info } }));
    return;
  }
  if (e.type === "roles") return void useOffice.setState({ roles: e.roles });
  if (e.type === "handoffs") return void useOffice.setState((s) => ({ handoffs: { ...s.handoffs, [e.agentId]: e.handoffs } }));
  if (e.type === "history") return void useOffice.setState({ history: e.boards });
  if (e.type === "board.doneCheck") return void useOffice.setState({ doneCheck: e.check });
  if (e.type === "team.started") return void useOffice.setState({ teamStarted: { title: e.title, url: e.url } });
  useOffice.setState((s) => {
    const base = s.snap ?? (e.type === "snapshot" ? e.snapshot : null);
    if (!base) return {};
    eventN += 1;
    return {
      snap: reduce(base, e),
      epoch: e.type === "snapshot" ? s.epoch + 1 : s.epoch,
      events: [{ n: eventN, at: Date.now(), event: e }, ...s.events].slice(0, 20),
    };
  });
}

let disconnect: (() => void) | null = null;

export function connectOffice() {
  if (disconnect) return disconnect;
  disconnect = source.connect(handle, (connection) => useOffice.setState({ connection }));
  return () => {
    disconnect?.();
    disconnect = null;
  };
}

// ---------------------------------------------------------------- actions

export const officeActions = {
  startAgent: (id: string) => source.startAgent(id),
  stopAgent: (id: string) => source.stopAgent(id),
  refreshAgent: (id: string) => source.refreshAgent(id),
  listHandoffs: (id: string) => source.listHandoffs(id),
  listHistory: () => source.listHistory(),
  uploadImage: (image: Blob) => source.uploadImage(image),
  stopTeam: () => source.stopTeam(),
  quitFleet() {
    if (useOffice.getState().live) useOffice.setState({ quit: true });
    source.quitFleet();
  },
  openWorkspace: (id: string) => source.openWorkspace(id),
  openInIterm: (id: string) => source.openInIterm(id),
  trustFolder: (id: string) => source.trustFolder(id),
  recheckSetup: () => source.recheckSetup(),
  assignTask: (taskId: string, agentId: string) => source.assignTask(taskId, agentId),
  sendMessage: (toId: string, text: string) => source.sendMessage(toId, text),
  addAgent: source.addAgent.bind(source),
  updateAgent: source.updateAgent.bind(source),
  removeAgent: (id: string, opts?: RemoveAgentOptions) => source.removeAgent(id, opts),
  inspectWorkspace: (id: string) => source.inspectWorkspace(id),
  listRoles: () => source.listRoles(),
  saveRole: (input: SaveRoleInput) => source.saveRole(input),
  deleteRole: (key: string) => source.deleteRole(key),
  updateWorkflow: source.updateWorkflow.bind(source),
  updateProject: source.updateProject.bind(source),
  createBoard: source.createBoard.bind(source),
  updateBoard: source.updateBoard.bind(source),
  /** Your answer to a held-back Done. */
  answerDone(confirmed: boolean) {
    const check = useOffice.getState().doneCheck;
    useOffice.setState({ doneCheck: null });
    if (check && confirmed) source.updateBoard(check.boardId, { status: "done" }, { confirmed: true });
  },
  newWork: source.newWork.bind(source),
  startWork: source.startWork.bind(source),
  reopenBoard: source.reopenBoard.bind(source),
  completeWelcome: (input: WelcomeInput) => source.completeWelcome(input),
  resolveActionItem: (id: string, decision: "done" | "dismissed", note?: string) => source.resolveActionItem(id, decision, note),
  answerQuestion: (id: string, answers: Record<string, string>) => source.answerQuestion(id, answers),
  setSpeed(speed: SimSpeed) {
    source.dev?.setSpeed(speed);
    useOffice.setState({ speed });
  },
  loadPreset(id: string) {
    source.dev?.loadPreset(id);
  },
};

// ---------------------------------------------------------------- selectors

export interface AgentView {
  config: AgentConfig;
  status: AgentStatus;
}

/** Team in config order, joined with live status. */
export function selectTeam(snap: OfficeSnapshot | null): AgentView[] {
  if (!snap) return [];
  return snap.config.team.flatMap((config) => {
    const status = snap.agents.find((a) => a.agentId === config.id);
    return status ? [{ config, status }] : [];
  });
}

export const reviewToolLabel = {
  coderabbit: "CodeRabbit",
  greptile: "Greptile",
  copilot: "Copilot",
  human: "Human review",
  custom: "Custom check",
} as const;

export const deployToolLabel = { instacloud: "InstaCloud", vercel: "Vercel", custom: "Custom deploy" } as const;

export { selectAttention } from "../data/attention";
