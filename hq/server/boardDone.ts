// A board marked Done: its agents hand off and stop, their worktrees go, and the board moves to History.
// Which agents: the ones New work added for the board (removed from the team), plus core agents who
// worked on it and have nothing open on another active board (stopped; they stay on the team).
// A worktree with uncommitted changes is never deleted silently: the lead asks you in Action items.

import type { ActionItem, Board, BoardDoneCheck, CleanupRequest, OfficeSnapshot } from "../src/data/types";
import type { Hub } from "./hub";

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** The board's agents: `crew` (added for it) and `core` (team members free once it's done). */
export function boardAgents(snap: OfficeSnapshot, board: Board): { crew: string[]; core: string[] } {
  const team = snap.config.team;
  const lead = team.find((a) => a.isLead);
  const crew = (board.crewIds ?? []).filter((id) => team.some((a) => a.id === id && !a.isLead));
  const active = (id: string) => id !== board.id && snap.boards.find((b) => b.id === id)?.status === "active";
  const busyElsewhere = (id: string) =>
    id === lead?.id ? snap.boards.some((b) => active(b.id)) : snap.tasks.some((t) => t.ownerId === id && t.status !== "done" && active(t.boardId));
  const worked = new Set(snap.tasks.filter((t) => t.boardId === board.id && t.ownerId).map((t) => t.ownerId!));
  if (lead) worked.add(lead.id);
  const core = [...worked].filter((id) => team.some((a) => a.id === id) && !crew.includes(id) && !busyElsewhere(id));
  return { crew, core };
}

/** What the board was and what came of it, kept on the board for History and Reopen. */
export function boardSummary(hub: Hub, board: Board, handoffs: Record<string, string>, at: string): string {
  const tasks = hub.snap.tasks.filter((t) => t.boardId === board.id);
  const lines = [`Board ${board.id} "${board.title}" marked done ${at}.`];
  if (board.brief) lines.push("", `Request: ${clip(board.brief.prompt.replace(/\s+/g, " "), 600)}`);
  lines.push("", "Tasks:", ...(tasks.length ? tasks.map((t) => `- ${t.id} [${t.status}] ${t.title}${t.ownerId ? ` · ${hub.name(t.ownerId)}` : ""}${t.prNumber ? ` · PR #${t.prNumber}` : ""}`) : ["- None."]));
  for (const [id, text] of Object.entries(handoffs)) lines.push("", `--- ${hub.name(id)} ---`, clip(text.replace(/^# .*\n+/, ""), 1500));
  return clip(lines.join("\n"), 15_000);
}

/** What marking the board done would cut short: its agents mid-turn, and worktrees with uncommitted work. */
export async function doneBlockers(hub: Hub, board: Board, inspect: Deps["inspect"]): Promise<BoardDoneCheck> {
  const { crew, core } = boardAgents(hub.snap, board);
  const ids = [...crew, ...core];
  const running = ids.filter((id) => {
    const st = hub.status(id);
    return st?.session.state === "running" && st.state !== "idle";
  });
  const dirty: BoardDoneCheck["dirty"] = [];
  for (const id of ids) {
    const ws = await inspect(id);
    if (ws?.exists && ws.managed && ws.changedFiles) dirty.push({ name: hub.name(id), files: ws.changedFiles });
  }
  return { boardId: board.id, title: board.title, running: running.map((id) => hub.name(id)), dirty };
}

interface Deps {
  writeHandoff(id: string, reason: string): Promise<string>;
  stop(id: string): Promise<void>;
  inspect(id: string): Promise<{ path: string; managed: boolean; exists: boolean; changedFiles: number } | null>;
  /** Kills the session and deletes the agent's Fleet-made worktree. */
  deleteWorktree(id: string): Promise<void>;
  /** Removes the agent from the team, deleting its worktree. */
  removeAgent(id: string): Promise<void>;
  ask(fromId: string, title: string, details: string, cleanup: CleanupRequest): ActionItem;
  notify(id: string, text: string): void;
}

export class BoardCloser {
  constructor(
    private hub: Hub,
    private deps: Deps,
  ) {}

  async finish(boardId: string) {
    const hub = this.hub;
    const board = hub.snap.boards.find((b) => b.id === boardId);
    if (!board || board.status !== "done") return;
    const at = new Date().toISOString();
    const { crew, core } = boardAgents(hub.snap, board);
    const ids = [...crew, ...core];
    const names = (list: string[]) => list.map((id) => named[id] ?? id).join(", ");
    const named = Object.fromEntries(ids.map((id) => [id, hub.name(id)])); // crew are removed below
    const handoffs: Record<string, string> = {};
    for (const id of ids) handoffs[id] = await this.deps.writeHandoff(id, `its board "${board.title}" was marked done`);
    board.doneAt = at;
    board.summary = boardSummary(hub, board, handoffs, at);
    hub.emit({ type: "board.updated", board: structuredClone(board) });
    hub.planChanged();

    for (const id of ids) if (hub.status(id)?.session.state !== "stopped") await this.deps.stop(id);
    const dirty: { id: string; path: string; files: number }[] = [];
    let deleted = 0;
    for (const id of ids) {
      const ws = await this.deps.inspect(id);
      if (ws?.exists && ws.managed && ws.changedFiles) {
        dirty.push({ id, path: ws.path, files: ws.changedFiles });
        continue;
      }
      if (crew.includes(id)) await this.deps.removeAgent(id);
      else if (ws?.exists && ws.managed) await this.deps.deleteWorktree(id);
      if (ws?.exists && ws.managed) deleted++;
    }
    const lead = hub.snap.config.team.find((a) => a.isLead);
    if (dirty.length && lead)
      this.deps.ask(
        lead.id,
        `Board "${board.title}" is done: delete ${dirty.length} folder${dirty.length > 1 ? "s" : ""} with uncommitted work?`,
        [
          "These agents' folders have changes that were never committed:",
          ...dirty.map((d) => `- ${hub.name(d.id)}: ${d.files} file(s) in ${d.path}`),
          "",
          "Approve: delete them; the uncommitted changes are lost (commits stay on their branches).",
          `Reject: keep them for now; ${lead.name} asks you what to do with them.`,
        ].join("\n"),
        { boardId: board.id, agentIds: dirty.map((d) => d.id) },
      );
    hub.activity(
      "config",
      null,
      `Board "${board.title}" done: ${ids.length ? `stopped ${names(ids)} (handoffs saved)` : "no agents to stop"}; ${deleted} worktree(s) deleted${dirty.length ? `, ${dirty.length} waiting for you in Action items` : ""}.`,
    );
  }

  /** Your answer on uncommitted work: approve = delete those folders, reject = keep them (the lead follows up). */
  async cleanup(req: CleanupRequest, approved: boolean, fromId: string) {
    const board = this.hub.snap.boards.find((b) => b.id === req.boardId);
    const crew = board?.crewIds ?? [];
    const names = req.agentIds.map((id) => this.hub.name(id)).join(", ");
    if (approved) {
      for (const id of req.agentIds) {
        if (!this.hub.cfg(id)) continue;
        if (crew.includes(id)) await this.deps.removeAgent(id);
        else await this.deps.deleteWorktree(id);
      }
      this.hub.activity("config", null, `Deleted the folders of ${names}, uncommitted changes included.`);
      return;
    }
    this.deps.notify(
      fromId,
      `The user kept the folders of ${names} (board "${board?.title ?? req.boardId}" is done, but they have uncommitted changes). Ask the user what to do with that work: commit it on a branch, move it to another task, or delete it. Each folder's handoff is in that agent's History.`,
    );
  }
}
