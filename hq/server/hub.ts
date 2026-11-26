// The server's single source of truth. Every mutation emits the matching
// OfficeEvent to all connected browsers, and config/plan changes are saved in the project's home.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OfficeEvent } from "../src/data/source";
import type { ActivityType, AgentConfig, AgentStatus, HqConfig, OfficeSnapshot, SessionInfo, SetupState } from "../src/data/types";
import { writePlanExport } from "./planExport";
import { saveConfig, savePlan, type PlanFile } from "./store";
import type { RepoInfo } from "./repo";
import { MESSAGES_KEPT } from "./planner";
import { keepMessages } from "../src/data/messages";
import { alertUser } from "../../src/events.js";

/** Activity lines kept in history. */
const ACTIVITY_KEPT = 300;

type Listener = (e: OfficeEvent) => void;

const now = () => new Date().toISOString();

export class Hub {
  snap: OfficeSnapshot;
  private listeners = new Set<Listener>();
  private seq = 0;
  /** When this Fleet started: the idle clock of an agent with no saved last activity. */
  readonly startedAt = Date.now();
  /** Each agent's last state change or activity line (ISO). Saved in history.json, so it survives a restart. */
  lastActive: Record<string, string>;

  constructor(readonly repo: RepoInfo, readonly slug: string, readonly home: string, config: HqConfig, plan: PlanFile, setup: SetupState) {
    const { lastActive, ...history } = Hub.loadHistory(home);
    this.lastActive = lastActive;
    this.snap = {
      setup,
      sbx: { basePolicy: "unknown", proxy: null, globalKeys: [], agents: {}, checkedAt: now() },
      config,
      agents: config.team.map((a) => Hub.freshStatus(a.id)),
      boards: plan.boards,
      tasks: plan.tasks,
      pullRequests: [],
      environments: [],
      ...history,
    };
  }

  // Messages, the activity feed and each agent's last activity survive a Fleet restart: kept in the project's home (history.json).
  private static loadHistory(home: string): Pick<OfficeSnapshot, "messages" | "activity"> & { lastActive: Record<string, string> } {
    const file = join(home, "history.json");
    try {
      const h = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Partial<OfficeSnapshot> & { lastActive?: Record<string, string> }) : {};
      return {
        messages: Array.isArray(h.messages) ? keepMessages(h.messages, MESSAGES_KEPT, MESSAGES_KEPT) : [],
        activity: Array.isArray(h.activity) ? h.activity.slice(0, ACTIVITY_KEPT) : [],
        lastActive: h.lastActive && typeof h.lastActive === "object" ? h.lastActive : {},
      };
    } catch {
      return { messages: [], activity: [], lastActive: {} };
    }
  }

  private historyTimer: NodeJS.Timeout | null = null;

  /** Saves messages and activity a moment after they change (activity can come in bursts). */
  historyChanged() {
    if (this.historyTimer) return;
    this.historyTimer = setTimeout(() => {
      this.historyTimer = null;
      const file = join(this.home, "history.json");
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ messages: this.snap.messages, activity: this.snap.activity, lastActive: this.lastActive }) + "\n", { mode: 0o600 });
      renameSync(tmp, file);
    }, 1000);
  }

  static freshStatus(agentId: string): AgentStatus {
    return {
      agentId, state: "idle", currentTaskId: null, stateSince: now(), note: "Not started",
      session: { state: "stopped", detail: null, workspace: null, sandbox: null },
    };
  }

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(e: OfficeEvent) {
    for (const fn of this.listeners) fn(e);
  }

  // ------------------------------------------------------------ lookups

  cfg(id: string): AgentConfig | undefined {
    return this.snap.config.team.find((a) => a.id === id);
  }

  status(id: string): AgentStatus | undefined {
    return this.snap.agents.find((a) => a.agentId === id);
  }

  name(id: string | null) {
    if (id === "you") return "You";
    if (id === "hq") return "Fleet";
    return (id && this.cfg(id)?.name) || "Someone";
  }

  /** A banner for you (macOS; Fleet's banner setting applies): clicking it opens this team's page. */
  alert(fromId: string, text: string) {
    const p = this.snap.config.project;
    alertUser(this.name(fromId), text.replace(/\s+/g, " "), p.name, `http://localhost:${p.hqPort}`);
  }

  // ------------------------------------------------------------ mutations

  setStatus(id: string, patch: Partial<Omit<AgentStatus, "agentId" | "session">>) {
    const s = this.status(id);
    if (!s) return;
    if (patch.state !== undefined && patch.state !== s.state) {
      s.stateSince = now();
      this.lastActive[id] = s.stateSince;
      this.historyChanged();
    }
    Object.assign(s, patch);
    this.emit({ type: "agent.updated", agent: structuredClone(s) });
  }

  setSession(id: string, patch: Partial<SessionInfo>) {
    const s = this.status(id);
    if (!s) return;
    s.session = { ...s.session, ...patch };
    this.emit({ type: "agent.updated", agent: structuredClone(s) });
  }

  setSetup(setup: SetupState) {
    this.snap.setup = setup;
    this.emit({ type: "setup.updated", setup });
  }

  activity(type: ActivityType, agentId: string | null, text: string) {
    this.seq += 1;
    // Time-based ids: ones loaded from history.json must never clash with new ones.
    const event = { id: `a${Date.now().toString(36)}${this.seq}`, at: now(), type, agentId, text };
    this.snap.activity = [event, ...this.snap.activity].slice(0, ACTIVITY_KEPT);
    if (agentId) this.lastActive[agentId] = event.at;
    this.historyChanged();
    this.emit({ type: "activity", event });
  }

  configChanged() {
    saveConfig(this.home, this.snap.config);
    this.emit({ type: "config.updated", config: structuredClone(this.snap.config) });
  }

  planChanged() {
    const plan = { boards: this.snap.boards, tasks: this.snap.tasks };
    savePlan(this.home, plan);
    if (this.snap.config.project.exportPlan) writePlanExport(this.repo.root, this.snap.config, plan);
  }
}
