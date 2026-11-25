// Action items: things an agent needs the user to do outside its own reach
// (create a database, put a key in an env file, change a dashboard setting).
// Agents add them with the Team MCP tool `ask_user`; the user closes them in Fleet,
// and Fleet tells the agent so it can continue. Kept on this Mac, never committed.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ActionItem, AddAgentRequest, AskQuestion, CleanupRequest, AgentConfig } from "../src/data/types";
import type { Hub } from "./hub";
import { parseCliJson } from "./lib/json";
import { projectHome } from "./paths";
import type { Planner } from "./planner";

const KEEP_CLOSED = 500;

/** An approval request: the agent said so, or (older agents) the title starts with "Approve". */
export function isApproval(title: string, flag?: boolean): boolean {
  return flag ?? /^approve\b/i.test(title.trim());
}

/** What Fleet tells the agent when the user closes its action item. */
export function resolutionMessage(item: Pick<ActionItem, "title" | "note" | "approval">, decision: "done" | "dismissed"): string {
  const n = item.note ? ` Note from the user: ${item.note}` : "";
  if (item.approval)
    return decision === "done"
      ? `The user approved "${item.title}".${n} Go ahead.`
      : `The user rejected "${item.title}".${n} Do not do it, and do not try another way to do it. Stop that work and tell the lead, or wait for the user.`;
  return decision === "done"
    ? `The user did your action item "${item.title}".${n} Continue with it.`
    : `The user dismissed your action item "${item.title}".${n} Continue without it, or find another way.`;
}

export type PermissionAnswer = { behavior: "allow" } | { behavior: "deny"; message: string } | null;
/** Answers to an AskUserQuestion: question text → chosen label (several joined with ", "). */
export type QuestionAnswer = Record<string, string> | null;

/** The questions of an AskUserQuestion call, or null when its input isn't what we expect. */
export function parseQuestions(input: unknown): AskQuestion[] | null {
  const qs = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(qs) || !qs.length) return null;
  const out: AskQuestion[] = [];
  for (const q of qs.slice(0, 4) as { question?: unknown; header?: unknown; options?: unknown; multiSelect?: unknown }[]) {
    if (typeof q?.question !== "string" || !Array.isArray(q.options)) return null;
    const options = (q.options as { label?: unknown; description?: unknown }[])
      .filter((o) => typeof o?.label === "string")
      .map((o) => ({ label: String(o.label).slice(0, 200), ...(typeof o.description === "string" && { description: o.description.slice(0, 500) }) }));
    out.push({ question: q.question.slice(0, 1000), ...(typeof q.header === "string" && { header: q.header.slice(0, 60) }), options, multiSelect: q.multiSelect === true });
  }
  return out;
}

export class ActionItems {
  private file: string;
  private seq = 0;
  /** Permission items whose agent is waiting on an open hook request: answering one replies to it. */
  private waiters = new Map<string, (answer: PermissionAnswer | QuestionAnswer) => void>();
  /** Open permission items: which agent and tool each is for. */
  private pendingTools = new Map<string, { agentId: string; tool: string }>();
  /** Set by main: adds an agent the lead asked for (add_agent), once you approve. */
  onAddAgent: ((req: AddAgentRequest) => AgentConfig) | null = null;
  /** Set by index.ts: deletes (approved) or keeps the folders a finished board left behind. */
  onCleanup: ((req: CleanupRequest, approved: boolean, fromId: string) => Promise<void>) | null = null;

  constructor(private hub: Hub, private planner: Planner) {
    this.file = join(projectHome(hub.slug), "action-items.json");
    const saved = existsSync(this.file) ? parseCliJson<ActionItem[]>(readFileSync(this.file, "utf8")) : null;
    hub.snap.actionItems = Array.isArray(saved) ? saved : [];
    // A permission left open by an earlier run has no request waiting on it any more.
    let stale = false;
    for (const i of this.items)
      if ((i.kind === "permission" || i.kind === "question") && i.status === "open") {
        Object.assign(i, { status: "dismissed", note: "Fleet restarted; the agent asked in its terminal instead.", closedAt: new Date().toISOString() });
        stale = true;
      }
    if (stale) this.save();
  }

  private get items(): ActionItem[] {
    return (this.hub.snap.actionItems ??= []);
  }

  private save() {
    const open = this.items.filter((i) => i.status === "open");
    const closed = this.items.filter((i) => i.status !== "open").slice(0, KEEP_CLOSED);
    this.hub.snap.actionItems = [...open, ...closed].sort((a, b) => b.at.localeCompare(a.at));
    // Write a temp file and rename it over, so a crash mid-save can't leave a half-written list.
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.hub.snap.actionItems, null, 2));
    renameSync(tmp, this.file);
  }

  add(fromId: string, title: string, details: string, waiting: boolean, approval?: boolean, addAgent?: AddAgentRequest, cleanup?: CleanupRequest): ActionItem {
    const clean = title.trim().replace(/\s+/g, " ").slice(0, 160);
    if (!clean) throw new Error("Give the action item a short title.");
    const item: ActionItem = {
      id: `ai${Date.now().toString(36)}${++this.seq}`,
      fromId,
      taskId: this.planner.currentTask(fromId)?.id ?? null,
      title: clean,
      details: details.trim().slice(0, 4000),
      waiting,
      status: "open",
      ...((addAgent || cleanup || isApproval(clean, approval)) && { approval: true }),
      ...(addAgent && { addAgent }),
      ...(cleanup && { cleanup }),
      note: null,
      at: new Date().toISOString(),
      closedAt: null,
    };
    this.items.unshift(item);
    this.save();
    this.hub.emit({ type: "action.updated", item: { ...item } });
    this.hub.activity("agent.needs-input", fromId, `${this.hub.name(fromId)} added an action item${waiting ? " (waiting)" : ""}: ${clean}`);
    this.hub.alert(fromId, `${item.approval ? "Approve: " : ""}${clean}`);
    return item;
  }

  /**
   * Claude Code is about to ask this agent's user to allow a tool. Adds an Allow/Deny item and
   * resolves with your answer, or null when the request goes away first (the agent then asks in its terminal).
   */
  askPermission(fromId: string, tool: string, title: string, details: string): { item: ActionItem; answer: Promise<PermissionAnswer> } {
    const item: ActionItem = {
      id: `pr${Date.now().toString(36)}${++this.seq}`,
      fromId,
      taskId: this.planner.currentTask(fromId)?.id ?? null,
      title: title.slice(0, 160),
      details: details.slice(0, 4000),
      waiting: true,
      status: "open",
      kind: "permission",
      note: null,
      at: new Date().toISOString(),
      closedAt: null,
    };
    this.items.unshift(item);
    this.save();
    this.hub.emit({ type: "action.updated", item: { ...item } });
    this.hub.activity("agent.needs-input", fromId, `${this.hub.name(fromId)} asks: ${item.title}`);
    this.hub.alert(fromId, tool === "AskUserQuestion" ? `Asks: ${item.title}` : `Wants to: ${item.title}`);
    const answer = new Promise<PermissionAnswer>((done) => this.waiters.set(item.id, done as (a: PermissionAnswer | QuestionAnswer) => void));
    this.pendingTools.set(item.id, { agentId: fromId, tool });
    return { item, answer };
  }

  /**
   * The agent asks you multiple-choice questions (AskUserQuestion). Adds a question item and resolves
   * with your answers, or null when it goes away first (the agent then asks in its terminal).
   */
  askQuestions(fromId: string, questions: AskQuestion[]): { item: ActionItem; answer: Promise<QuestionAnswer> } {
    const title = questions.length === 1 ? questions[0].question : `${questions.length} questions: ${questions.map((q) => q.header ?? q.question).join(", ")}`;
    const { item, answer } = this.askPermission(fromId, "AskUserQuestion", title, "");
    item.kind = "question";
    item.questions = questions;
    this.save();
    this.hub.emit({ type: "action.updated", item: { ...item } });
    return { item, answer: answer as unknown as Promise<QuestionAnswer> };
  }

  /** Your answers to a question item: they go straight back to the agent's AskUserQuestion. */
  answerQuestions(id: string, answers: Record<string, string>) {
    const item = this.items.find((i) => i.id === id);
    if (!item || item.kind !== "question" || item.status !== "open") return;
    const asked = new Set((item.questions ?? []).map((q) => q.question));
    const clean = Object.fromEntries(Object.entries(answers).filter(([q, a]) => asked.has(q) && typeof a === "string" && a.trim()).map(([q, a]) => [q, a.trim().slice(0, 1000)]));
    if (!Object.keys(clean).length) return;
    Object.assign(item, { status: "done", answers: clean, closedAt: new Date().toISOString() });
    this.save();
    this.hub.emit({ type: "action.updated", item: { ...item } });
    const waiter = this.waiters.get(id);
    this.waiters.delete(id);
    this.pendingTools.delete(id);
    waiter?.(clean);
    this.hub.activity("agent.answered", item.fromId, `You answered ${this.hub.name(item.fromId)}: ${Object.values(clean).join("; ").slice(0, 120)}`);
  }

  /**
   * You answered in the agent's terminal instead: Claude Code doesn't drop the held hook request then,
   * so its next hooks tell us. `tool` given: only that tool's prompt (it ran); none: every prompt of the agent.
   */
  answeredInTerminal(agentId: string, tool?: string) {
    for (const [id, p] of this.pendingTools)
      if (p.agentId === agentId && (!tool || p.tool === tool)) this.expirePermission(id, "Answered in the agent's terminal.");
  }

  /** The hook request ended without an answer from you (timeout, or the agent went away). */
  expirePermission(id: string, why: string) {
    const item = this.items.find((i) => i.id === id);
    this.waiters.get(id)?.(null);
    this.waiters.delete(id);
    this.pendingTools.delete(id);
    if (!item || item.status !== "open") return;
    Object.assign(item, { status: "dismissed", note: why, closedAt: new Date().toISOString() });
    this.save();
    this.hub.emit({ type: "action.updated", item: { ...item } });
  }

  resolve(id: string, decision: "done" | "dismissed", note?: string) {
    const item = this.items.find((i) => i.id === id);
    if (!item || item.status !== "open") return;
    item.status = decision;
    item.note = note?.trim().slice(0, 1000) || null;
    item.closedAt = new Date().toISOString();
    this.save();
    this.hub.emit({ type: "action.updated", item: { ...item } });
    if (item.kind === "question") {
      // Closed without answers: the agent asks in its terminal instead.
      const waiter = this.waiters.get(id);
      this.waiters.delete(id);
      this.pendingTools.delete(id);
      waiter?.(null);
      return;
    }
    if (item.kind === "permission") {
      // Done = Allow, dismissed = Deny. The answer goes back to Claude Code, not as a message.
      const waiter = this.waiters.get(id);
      this.waiters.delete(id);
      this.pendingTools.delete(id);
      waiter?.(decision === "done" ? { behavior: "allow" } : { behavior: "deny", message: item.note ? `The user denied this: ${item.note}` : "The user denied this." });
      this.hub.activity("config", item.fromId, `You ${decision === "done" ? "allowed" : "denied"}: ${item.title}`);
      // Claude Code's allow carries no text, so a note you wrote with Allow goes as a message.
      if (decision === "done" && item.note && this.hub.cfg(item.fromId)) this.planner.message("you", item.fromId, `About "${item.title}" (allowed): ${item.note}`);
      return;
    }
    if (item.cleanup && this.onCleanup) return void this.onCleanup(item.cleanup, decision === "done", item.fromId);
    if (item.addAgent && decision === "done" && this.onAddAgent) {
      const a = this.onAddAgent(item.addAgent);
      const n = item.note ? ` Note from the user: ${item.note}` : "";
      return this.planner.notify(item.fromId, `The user approved adding ${a.name}. Fleet added them: id ${a.id}, role ${a.role}, in their own new worktree.${n} Give them a task with assign_task; they start on it.`, true);
    }
    this.planner.notify(item.fromId, resolutionMessage(item, decision), true);
  }
}
