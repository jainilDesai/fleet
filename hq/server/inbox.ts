// Delivery to agents. If the agent is idle at its prompt, Fleet types the message
// into its terminal. If it's busy, the message waits and is handed over by the
// agent's Stop hook when its turn ends (Claude Code then continues with it).
// If it isn't running, Fleet starts it and types the message once its prompt is up.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hub } from "./hub";
import { log } from "./lib/log";

export interface InboxItem {
  fromId: string; // agent id or "you"
  text: string;
  kind: "message" | "assign" | "notice"; // notice = from HQ itself (e.g. review results)
  /** A notice about something you did (an approval, a closed action item): the answer is for you. */
  byUser?: boolean;
}

export interface Keyboard {
  type(agentId: string, text: string): Promise<boolean>;
  enter(agentId: string): Promise<boolean>;
  /** Unsent text at the agent's prompt ("" if none). */
  draft(agentId: string): Promise<string>;
}

const QUIET_MS = 1000; // no hooks for this long = the prompt has settled
const SUBMIT_CHECK_MS = 3000; // typed text should produce UserPromptSubmit by then

export class Inbox {
  private queues = new Map<string, InboxItem[]>();
  private sessionUp = new Set<string>(); // SessionStart seen: Claude Code's prompt exists
  private lastHook = new Map<string, number>();
  private lastSubmit = new Map<string, number>();
  private typing = new Set<string>();
  /** Agents Fleet couldn't type into: warned once until typing works again. */
  private warned = new Set<string>();
  /** Agents handed a message from you in their current turn: their answer goes back to you. */
  private awaitingReply = new Set<string>();
  private timer: NodeJS.Timeout;
  /** Starts an agent whose session isn't running (set by index.ts). */
  onNeedsSession: (agentId: string) => void = () => {};

  constructor(private hub: Hub, private keys: Keyboard) {
    this.load();
    // Safety net: retry anything queued for agents that have gone idle.
    this.timer = setInterval(() => {
      for (const id of this.queues.keys()) void this.tryType(id);
    }, 2000);
  }

  stop() {
    clearInterval(this.timer);
  }

  // Queued messages survive a Fleet restart: kept in the project's home (inbox.json).
  private get file() {
    return join(this.hub.home, "inbox.json");
  }

  private load() {
    if (!existsSync(this.file)) return;
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, InboxItem[]>;
      for (const [id, items] of Object.entries(saved)) if (this.hub.cfg(id) && Array.isArray(items) && items.length) this.queues.set(id, items);
    } catch {
      log.warn("inbox.json is unreadable; starting with an empty inbox");
    }
  }

  private save() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries([...this.queues].filter(([, q]) => q.length)), null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  push(agentId: string, item: InboxItem) {
    const q = this.queues.get(agentId) ?? [];
    q.push(item);
    this.queues.set(agentId, q);
    this.save();
    const session = this.hub.status(agentId)?.session.state;
    if (session === "stopped" || session === "failed") this.onNeedsSession(agentId);
    void this.tryType(agentId);
  }

  /** When the agent's last hook arrived (0 if never). */
  lastHookAt(agentId: string): number {
    return this.lastHook.get(agentId) ?? 0;
  }

  pending(agentId: string) {
    return this.queues.get(agentId)?.length ?? 0;
  }

  /** Every hook event goes through here (before the state change it causes). */
  noteHook(agentId: string, event: string) {
    this.lastHook.set(agentId, Date.now());
    if (event === "SessionStart") this.sessionUp.add(agentId);
    if (event === "SessionEnd") this.sessionUp.delete(agentId);
    if (event === "UserPromptSubmit") this.lastSubmit.set(agentId, Date.now());
    if (event === "Stop" || event === "SessionStart" || event === "Notification") setTimeout(() => void this.tryType(agentId), QUIET_MS + 100);
  }

  /** An already-running session was reattached: its prompt exists even though HQ missed SessionStart. */
  sessionReattached(agentId: string) {
    this.sessionUp.add(agentId);
  }

  /** The session stopped or restarted: Claude Code's prompt is gone until the next SessionStart. */
  sessionDown(agentId: string) {
    this.sessionUp.delete(agentId);
  }

  forget(agentId: string) {
    this.queues.delete(agentId);
    this.save();
    this.sessionUp.delete(agentId);
    this.awaitingReply.delete(agentId);
  }

  /** You asked it something outside Fleet's inbox (in its terminal): its answer goes to Messages too. */
  expectReply(agentId: string) {
    this.awaitingReply.add(agentId);
  }

  /** True once per turn that included a message from you; the caller posts the agent's answer back. */
  takeAwaitingReply(agentId: string): boolean {
    return this.awaitingReply.delete(agentId);
  }

  private noteFromYou(agentId: string, items: InboxItem[]) {
    if (items.some((i) => i.fromId === "you" || i.byUser)) this.awaitingReply.add(agentId);
  }

  /** Called from the Stop hook: everything queued, as the reason Claude continues with. */
  takeForStop(agentId: string): string | null {
    const q = this.queues.get(agentId);
    if (!q?.length) return null;
    this.queues.set(agentId, []);
    this.save();
    this.noteFromYou(agentId, q);
    return this.format(q);
  }

  private canType(agentId: string): boolean {
    const st = this.hub.status(agentId);
    return (
      !!st &&
      this.sessionUp.has(agentId) &&
      st.session.state === "running" &&
      st.state === "idle" &&
      !this.typing.has(agentId) &&
      Date.now() - (this.lastHook.get(agentId) ?? 0) >= QUIET_MS
    );
  }

  private whyNot(agentId: string): string {
    const st = this.hub.status(agentId);
    return JSON.stringify({ up: this.sessionUp.has(agentId), session: st?.session.state, state: st?.state, note: st?.note, typing: this.typing.has(agentId), quietMs: Date.now() - (this.lastHook.get(agentId) ?? 0) });
  }

  /** Types queued items into an idle agent. Safe to call any time. */
  async tryType(agentId: string) {
    const q = this.queues.get(agentId);
    if (!q?.length) return;
    if (!this.canType(agentId)) {
      if (process.env.HQ_DEBUG) log.info(`inbox ${agentId}: holding ${q.length} — ${this.whyNot(agentId)}`);
      return;
    }
    const items = q.splice(0);
    this.typing.add(agentId);
    const typedAt = Date.now();
    try {
      if (!(await this.keys.type(agentId, this.format(items)))) {
        if (!this.warned.has(agentId)) log.warn(`could not type into ${agentId}; keeping ${items.length} message(s) queued`);
        this.warned.add(agentId);
        this.queues.set(agentId, [...items, ...(this.queues.get(agentId) ?? [])]);
        return;
      }
      this.warned.delete(agentId);
      this.save();
      this.noteFromYou(agentId, items);
      // If the prompt didn't submit (Enter swallowed), press it once more. The hook alone can't tell: Claude Code
      // holds a submitted prompt while slow SessionStart hooks run, and UserPromptSubmit can land seconds late.
      // So only while our text is still at the prompt (it starts "[Fleet]"; a long paste shows as "[Pasted text #1 …]").
      await new Promise((r) => setTimeout(r, SUBMIT_CHECK_MS));
      if (
        (this.lastSubmit.get(agentId) ?? 0) < typedAt &&
        this.hub.status(agentId)?.state === "idle" &&
        /^\[(Fleet\]|Pasted text)/.test(await this.keys.draft(agentId))
      ) {
        log.warn(`${agentId}: no prompt submit after typing; pressing Enter again`);
        await this.keys.enter(agentId);
      }
    } finally {
      this.typing.delete(agentId);
    }
  }

  private format(items: InboxItem[]): string {
    const lines = items.map((i) =>
      i.kind === "message" ? `[Fleet] Message from ${this.hub.name(i.fromId)}: ${i.text}` : `[Fleet] ${i.text}`,
    );
    const fromAgent = items.some((i) => i.kind === "message" && i.fromId !== "you");
    // Delivered as one paste (see the tmux backend), so line breaks are kept.
    return lines.join("\n\n") + (fromAgent ? "\n\n(Reply with the hq send_message tool only if a reply is needed.)" : "");
  }
}
