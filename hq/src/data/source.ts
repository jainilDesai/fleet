import type {
  ActionItem,
  ActivityEvent,
  AgentMessage,
  AgentPatch,
  AgentStatus,
  Board,
  Environment,
  HqConfig,
  NewAgentInput,
  NewWorkInput,
  OfficeSnapshot,
  RemoveAgentOptions,
  RoleInfo, Handoff,
  SaveRoleInput,
  SetupState,
  WelcomeInput,
  WorkspaceInfo,
  ProjectConfig,
  PullRequest,
  Task,
  WorkflowPatch,
} from "./types";

export type OfficeEvent =
  | { type: "snapshot"; snapshot: OfficeSnapshot }
  | { type: "setup.updated"; setup: SetupState }
  | { type: "workspace.info"; info: WorkspaceInfo }
  | { type: "roles"; roles: RoleInfo[] }
  | { type: "handoffs"; agentId: string; handoffs: Handoff[] }
  | { type: "config.updated"; config: HqConfig }
  | { type: "agent.updated"; agent: AgentStatus }
  | { type: "agent.removed"; agentId: string }
  | { type: "board.updated"; board: Board }
  | { type: "task.updated"; task: Task }
  | { type: "task.removed"; taskId: string }
  | { type: "pr.updated"; pr: PullRequest }
  | { type: "env.updated"; env: Environment }
  | { type: "env.removed"; name: string }
  | { type: "message"; message: AgentMessage }
  | { type: "activity"; event: ActivityEvent }
  | { type: "action.updated"; item: ActionItem };

export type SimSpeed = 1 | 2 | 4;

export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "unauthorized";

export interface DataPreset {
  id: string;
  label: string;
}

/** Controls that only exist on the mock source. The UI hides them when absent. */
export interface DevControls {
  presets: DataPreset[];
  loadPreset(id: string): void;
  setSpeed(multiplier: SimSpeed): void;
}

export interface OfficeDataSource {
  connect(onEvent: (e: OfficeEvent) => void, onStatus?: (s: ConnectionStatus) => void): () => void; // returns disconnect

  assignTask(taskId: string, agentId: string): void;
  /** You → an agent, delivered like any Team MCP message. */
  sendMessage(toId: string, text: string): void;

  // agent sessions
  startAgent(id: string): void;
  stopAgent(id: string): void;
  /** Replace the agent's session with a fresh one that carries a handoff. */
  refreshAgent(id: string): void;
  /** Ask for the agent's saved handoffs (answered with a "handoffs" event). */
  listHandoffs(id: string): void;
  /** Stops every running agent session. */
  stopTeam(): void;
  /** Stops every running agent session, then Fleet itself. */
  quitFleet(): void;
  openWorkspace(id: string): void; // opens the agent's folder on the host
  /** Opens a terminal (iTerm, else Terminal.app) attached to the agent's tmux session. */
  openInIterm(id: string): void;
  /** Answers Claude Code's folder-trust prompt with "Yes" (worktrees Fleet made only). */
  trustFolder(id: string): void;
  /** Runs the setup checks again (tmux, Claude Code, gh, …). */
  recheckSetup(): void;

  addAgent(input: NewAgentInput): void;
  updateAgent(id: string, patch: AgentPatch): void;
  /** Stops the agent and removes it from the team; optionally deletes its worktree. Ignored for the lead. */
  removeAgent(id: string, opts?: RemoveAgentOptions): void;
  /** Asks what removing would delete; answered with a `workspace.info` event. */
  inspectWorkspace(id: string): void;
  /** Asks for the role picker's list; answered with a `roles` event (also sent after a save or delete). */
  listRoles(): void;
  /** Saves a role's ROLE.md and skills as your own, in ~/.fleet/roles, for every project. */
  saveRole(input: SaveRoleInput): void;
  /** Deletes your saved version of a role (its ~/.fleet/roles files only). */
  deleteRole(key: string): void;
  /** Closes an action item; the agent is told (done: with your note; dismissed: continue without it). */
  resolveActionItem(id: string, decision: "done" | "dismissed", note?: string): void;

  updateWorkflow(patch: WorkflowPatch): void;
  updateProject(patch: Partial<ProjectConfig>): void;
  createBoard(title: string): void;
  updateBoard(id: string, patch: Partial<Pick<Board, "title" | "status">>): void;
  /** New work: a board for it, the extra agents, and the prompt to the lead (now, or saved for later). */
  newWork(input: NewWorkInput): void;
  /** Starts New work that was saved for later. */
  startWork(boardId: string): void;
  /** Boards → History → Reopen: the board is active again and the lead gets its summary. */
  reopenBoard(boardId: string): void;

  /** Finishes first-run setup: saves the project's team and review tool. */
  completeWelcome(input: WelcomeInput): void;

  dev?: DevControls;
}
