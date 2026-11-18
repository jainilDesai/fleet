// Refresh: an agent's Claude Code session is replaced by a fresh one that carries a handoff, so a long
// context never builds up. Same agent (id, name, worktree, branch, tasks); only the session is new.
// The handoff is built from Fleet's own records, so it is the same shape every time and needs no AI turn.
// Saved in the project's home (handoffs/<agent>/<time>.md); the new session gets it at SessionStart.

import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import type { Handoff } from "../src/data/types";
import type { Hub } from "./hub";
import { lastAssistantText } from "./hooks";
import { run } from "./lib/exec";
import { log } from "./lib/log";
import { workspaceFor } from "./workspace";

const KEEP = 20;
/** After a turn ends, how long to wait before refreshing (the agent may be handed a message first). */
const SETTLE_MS = 3000;

/** Tokens in the agent's context at its last turn, from the transcript's usage. Null if unknown. */
export function contextUse(transcriptPath: string): { tokens: number; model: string } | null {
  let text: string;
  try {
    const size = statSync(transcriptPath).size;
    const len = Math.min(size, 1024 * 1024);
    const buf = Buffer.alloc(len);
    const fd = openSync(transcriptPath, "r");
    try {
      readSync(fd, buf, 0, len, size - len);
    } finally {
      closeSync(fd);
    }
    text = buf.toString("utf8");
  } catch {
    return null;
  }
  for (const line of text.split("\n").reverse()) {
    if (!line.includes('"usage"')) continue;
    try {
      const e = JSON.parse(line) as { type?: string; message?: { model?: string; usage?: Record<string, number> } };
      const u = e.message?.usage;
      if (e.type !== "assistant" || !u) continue;
      return { tokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), model: e.message?.model ?? "" };
    } catch {
      continue; // the first line of the window may be cut
    }
  }
  return null;
}

/**
 * The context window for a model id. shortcut: Claude Code doesn't write the window into the transcript;
 * Claude 5 models (Haiku included) and "[1m]" ids run with 1M, older ones with 200k. Update when that changes.
 */
export function contextWindow(model: string): number {
  if (/\[1m\]/i.test(model)) return 1_000_000;
  return /claude-(opus|sonnet|fable|haiku)-[5-9]/i.test(model) ? 1_000_000 : 200_000;
}

export interface GitState {
  branch: string;
  changed: string[];
  commits: string[];
}

/** A hook's transcript_path is read only if it is a Claude Code transcript: a .jsonl under ~/.claude/projects. */
export function isTranscript(path: string): boolean {
  try {
    const real = realpathSync(path);
    return real.endsWith(".jsonl") && real.startsWith(realpathSync(join(homedir(), ".claude", "projects")) + sep);
  } catch {
    return false;
  }
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** The handoff text: who, why, its tasks, its folder's git state, recent messages, its last reply. */
export function buildHandoff(hub: Hub, agentId: string, reason: string, git: GitState | null, lastReply: string | null, at = new Date()): string {
  const snap = hub.snap;
  const agent = hub.cfg(agentId);
  const board = (id: string) => snap.boards.find((b) => b.id === id)?.title ?? id;
  const mine = snap.tasks.filter((t) => t.ownerId === agentId);
  const open = mine.filter((t) => t.status !== "done");
  const lines = [
    `# Handoff: ${agent?.name ?? agentId} (${agent?.role ?? ""})`,
    "",
    `Written by Fleet ${at.toISOString()}: ${reason}. If this starts your session, you are the same agent continuing in a fresh session: carry on from here.`,
    "",
    "## Your tasks",
    ...(open.length
      ? open.map((t) => `- ${t.id} [${t.status}] ${t.title} (board "${board(t.boardId)}")${t.prNumber ? ` · PR #${t.prNumber}` : ""}${t.note ? ` · ${clip(t.note, 200)}` : ""}`)
      : ["- None open."]),
  ];
  const done = mine.filter((t) => t.status === "done").slice(-5);
  if (done.length) lines.push("", "## Recently done", ...done.map((t) => `- ${t.id} ${t.title}${t.prNumber ? ` · PR #${t.prNumber}` : ""}`));
  if (git) {
    lines.push("", "## Your folder", `- Branch: ${git.branch || "(unknown)"}`);
    lines.push(git.changed.length ? `- Uncommitted: ${git.changed.length} file(s): ${git.changed.slice(0, 20).join(", ")}` : "- No uncommitted changes.");
    if (git.commits.length) lines.push("- Last commits:", ...git.commits.map((c) => `  - ${c}`));
  }
  const msgs = snap.messages.filter((m) => m.fromId === agentId || m.toId === agentId).slice(0, 8).reverse();
  if (msgs.length) lines.push("", "## Recent messages (oldest first)", ...msgs.map((m) => `- ${hub.name(m.fromId)} → ${hub.name(m.toId)}: ${clip(m.text.replace(/\s+/g, " "), 300)}`));
  const asks = (snap.actionItems ?? []).filter((i) => i.fromId === agentId && i.status === "open" && !i.kind);
  if (asks.length) lines.push("", "## Waiting on the user", ...asks.map((i) => `- ${clip(i.title, 150)}`));
  if (lastReply?.trim()) lines.push("", "## Your last reply before the refresh", clip(lastReply.trim(), 2500));
  return lines.join("\n") + "\n";
}

interface SessionsLike {
  stop(id: string): Promise<void>;
  start(id: string): Promise<void>;
  hasDraft(id: string): Promise<boolean>;
}
interface InboxLike {
  pending(id: string): number;
}
interface PlannerLike {
  notify(agentId: string, text: string): void;
  currentTask(agentId: string): { id: string; status: string } | undefined;
}

export class Refresher {
  /** Each agent's transcript (from its hooks): the last reply and context use are read from it. */
  private transcripts = new Map<string, string>();
  /** Handoffs waiting for the new session's SessionStart. */
  private pending = new Map<string, string>();
  /** Refresh at the agent's next quiet moment (it was busy when asked). */
  private wanted = new Map<string, string>();
  private running = new Set<string>();

  constructor(
    private hub: Hub,
    private sessions: SessionsLike,
    private inbox: InboxLike,
    private planner: PlannerLike,
  ) {}

  private dir(agentId: string) {
    return join(this.hub.home, "handoffs", agentId);
  }

  /** Every hook passes through: remembers the transcript; after a turn, checks context use. */
  noteHook(agentId: string, event: string, transcriptPath?: string) {
    if (transcriptPath && isTranscript(transcriptPath)) this.transcripts.set(agentId, transcriptPath);
    else transcriptPath = undefined;
    if (event === "SessionStart") return this.hub.setStatus(agentId, { contextPct: null });
    if (event !== "Stop") return;
    // Claude Code may still be writing the turn to the transcript when Stop fires: read it after a moment.
    setTimeout(() => {
      const use = transcriptPath ? contextUse(transcriptPath) : null;
      if (use) {
        const pct = Math.round((use.tokens / contextWindow(use.model)) * 100);
        this.hub.setStatus(agentId, { contextPct: pct });
        const at = this.hub.snap.config.workflow.refreshAtPercent;
        if (at && pct >= at && !this.wanted.has(agentId)) this.wanted.set(agentId, `refreshed automatically, context at ${pct}%`);
      }
      void this.tryWanted(agentId);
    }, SETTLE_MS);
  }

  private async tryWanted(agentId: string) {
    const reason = this.wanted.get(agentId);
    if (!reason) return;
    const r = await this.refresh(agentId, reason);
    if (r !== "busy") this.wanted.delete(agentId);
  }

  /** The ⟳ button: now if the agent is quiet, else at the end of its turn. */
  async request(agentId: string) {
    const agent = this.hub.cfg(agentId);
    if (!agent) return;
    const r = await this.refresh(agentId, "refreshed by the user");
    if (r === "busy") {
      this.wanted.set(agentId, "refreshed by the user");
      this.hub.activity("session", agentId, `${agent.name} is mid-turn: it refreshes when the turn ends`);
    } else if (r === "draft") this.hub.activity("session", agentId, `${agent.name} has unsent text at its prompt: send or clear it, then refresh`);
    else if (r === "stopped") this.hub.activity("session", agentId, `${agent.name} isn't running: its next start is a fresh session anyway`);
  }

  /** Writes the handoff and saves it, without touching the session. Used by Refresh and by Done boards. */
  async writeHandoff(agentId: string, reason: string): Promise<string> {
    const agent = this.hub.cfg(agentId);
    const st = this.hub.status(agentId);
    const ws = st?.session.workspace ?? (agent ? workspaceFor(agent, this.hub.slug) : null);
    const git = ws ? await gitState(ws) : null;
    const transcript = this.transcripts.get(agentId);
    const at = new Date();
    const text = buildHandoff(this.hub, agentId, reason, git, transcript ? lastAssistantText(transcript) : null, at);
    try {
      const dir = this.dir(agentId);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, `${at.toISOString().replace(/[:.]/g, "-")}.md`), text, { mode: 0o600 });
      const old = readdirSync(dir).filter((f) => f.endsWith(".md")).sort().slice(0, -KEEP);
      for (const f of old) rmSync(join(dir, f), { force: true });
    } catch (err) {
      log.warn("handoff not saved:", err instanceof Error ? err.message : err);
    }
    return text;
  }

  /** Replaces the agent's session with a fresh one carrying a handoff. Only when the agent is quiet. */
  async refresh(agentId: string, reason: string): Promise<"done" | "busy" | "draft" | "stopped"> {
    const st = this.hub.status(agentId);
    const agent = this.hub.cfg(agentId);
    if (!st || !agent || st.session.state !== "running") return "stopped";
    if (this.running.has(agentId) || st.state !== "idle" || this.inbox.pending(agentId)) return "busy";
    this.running.add(agentId);
    try {
      if (await this.sessions.hasDraft(agentId)) return "draft";
      const handoff = await this.writeHandoff(agentId, reason);
      await this.sessions.stop(agentId);
      this.pending.set(agentId, handoff);
      await this.sessions.start(agentId);
      this.hub.activity("session", agentId, `${agent.name}: fresh session with a handoff (${reason})`);
      // A worker mid-task carries on by itself; the lead waits for its next message.
      const task = agent.isLead ? undefined : this.planner.currentTask(agentId);
      if (task?.status === "in-progress")
        this.planner.notify(agentId, `Your session was refreshed (${reason}). Read the handoff in your context, then carry on with ${task.id} (get_my_task has the details).`);
      return "done";
    } finally {
      this.running.delete(agentId);
    }
  }

  /** The handoff for this session start, once. */
  takeHandoff(agentId: string): string | null {
    const h = this.pending.get(agentId) ?? null;
    this.pending.delete(agentId);
    return h;
  }

  /** Saved handoffs, newest first. */
  list(agentId: string): Handoff[] {
    const dir = this.dir(agentId);
    try {
      return readdirSync(dir)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .reverse()
        .map((f) => ({ at: f.replace(/\.md$/, ""), text: readFileSync(join(dir, f), "utf8") }));
    } catch {
      return [];
    }
  }
}

async function gitState(dir: string): Promise<GitState | null> {
  const branch = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir });
  if (!branch.ok) return null;
  const status = await run("git", ["status", "--porcelain"], { cwd: dir });
  const logR = await run("git", ["log", "--oneline", "-5"], { cwd: dir });
  return {
    branch: branch.stdout.trim(),
    changed: status.stdout.split("\n").filter(Boolean).map((l) => l.slice(3)),
    commits: logR.stdout.split("\n").filter(Boolean),
  };
}
