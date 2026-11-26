// Claude Code hooks → agent state. Each agent's hooks POST to
// /hook/<agentId>/<Event> with the hook's JSON payload.

import { closeSync, openSync, readSync, statSync } from "node:fs";
import type { Hub } from "./hub";
import type { Inbox } from "./inbox";

/** SessionStart context Fleet adds, at most (Claude Code's limit is 10,000 characters). */
const CONTEXT_MAX = 9500;
const clipTo = (s: string, n: number) => (s.length > n ? s.slice(0, Math.max(0, n - 1)) + "…" : s);

export interface HookPayload {
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  message?: string;
  notification_type?: string;
  transcript_path?: string;
  /** SessionStart: startup, resume, clear or compact. */
  source?: string;
}

/** What a permission request is for, in words: a title and the details you decide on. */
export function describePermission(tool: string, input: Record<string, unknown> = {}): { title: string; details: string } {
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  if (tool === "Bash") {
    const cmd = s(input.command);
    const details = [cmd, s(input.description)].filter(Boolean).join("\n\n");
    // A workflow run that names production (e.g. "Deploy To Production", deploy-prod.yml): never let it look routine.
    if (/gh +workflow +run\b.*\bprod(uction)?\b/i.test(cmd)) {
      const branch = cmd.match(/-f +branch=(\S+)/)?.[1] ?? "(no branch given)";
      return { title: `⚠ PRODUCTION deploy: ${branch}`, details: `This deploys to production.\n\n${details}` };
    }
    return { title: `Run a command: ${cmd.split("\n")[0].slice(0, 100)}`, details };
  }
  if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) {
    const file = s(input.file_path) || s(input.notebook_path);
    return { title: `${tool === "Write" ? "Write" : "Edit"} ${file.split("/").slice(-2).join("/") || "a file"}`, details: file };
  }
  if (tool === "WebFetch") return { title: `Fetch ${s(input.url).slice(0, 100)}`, details: s(input.url) };
  return { title: `Use ${tool}`, details: JSON.stringify(input, null, 2).slice(0, 3000) };
}

/** The agent's final text in its last turn, from the end of its transcript (JSONL). Null if none. */
export function lastAssistantText(transcriptPath: string): string | null {
  return turnTexts(transcriptPath).at(-1) ?? null;
}

/**
 * What the agent said to you in its last turn, oldest first: its final text, plus earlier texts of
 * at least `min` characters (a report written before more tool calls).
 * shortcut: length tells a report from narration like "Let me check."; a short earlier answer is dropped.
 */
export function turnReplies(transcriptPath: string, min = 300, before?: string): string[] {
  const texts = turnTexts(transcriptPath, before);
  return texts.filter((t, i) => i === texts.length - 1 || t.length >= min);
}

/**
 * Every assistant text of the last turn, oldest first. `before`: the turn went on with messages Fleet
 * handed over at its Stop; take the part written before them (once they're in the transcript, skip past).
 */
function turnTexts(transcriptPath: string, before?: string): string[] {
  let text: string;
  try {
    const size = statSync(transcriptPath).size;
    const len = Math.min(size, 512 * 1024);
    const buf = Buffer.alloc(len);
    const fd = openSync(transcriptPath, "r");
    try {
      readSync(fd, buf, 0, len, size - len);
    } finally {
      closeSync(fd);
    }
    text = buf.toString("utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n").filter(Boolean).reverse();
  const marker = before?.slice(0, 120);
  const skipTo = marker && lines.some((l) => l.includes(JSON.stringify(marker).slice(1, -1))) ? marker : undefined;
  let skipping = !!skipTo;
  const found: string[] = [];
  for (const line of lines) {
    let entry: { type?: string; message?: { content?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // the first line of the window may be cut
    }
    // A real prompt (string content) means we've gone back past the last turn.
    if (entry.type === "user" && typeof entry.message?.content === "string") {
      if (skipping && entry.message.content.includes(skipTo!)) skipping = false;
      else if (!skipping) break;
      continue;
    }
    if (skipping || entry.type !== "assistant" || !Array.isArray(entry.message?.content)) continue;
    const parts = (entry.message.content as { type?: string; text?: string }[]).filter((c) => c.type === "text" && c.text?.trim()).map((c) => c.text!.trim());
    if (parts.length) found.push(parts.join("\n\n"));
  }
  return found.reverse();
}

/** The plan as Fleet has it, for the lead at session start: open boards, their unfinished tasks, the team, open action items. */
export function leadBriefing(hub: Hub, source = "startup"): string {
  const snap = hub.snap;
  const why = source === "compact" ? "Your context was just compacted, so details of earlier conversation may be gone or wrong" : "This is a new session";
  const lines = [`[Fleet] ${why}. Fleet's state below is the truth; trust it over memory, and call get_status / list_tasks for live updates.`];
  for (const b of snap.boards.filter((b) => b.status !== "done")) {
    const ts = snap.tasks.filter((t) => t.boardId === b.id);
    lines.push("", `Board ${b.id} "${b.title}" (${b.status}, ${ts.filter((t) => t.status === "done").length}/${ts.length} tasks done)`);
    if (b.brief?.startedAt) lines.push(`  Request: ${clip(b.brief.prompt.replace(/\s+/g, " "), 300)}`);
    for (const t of ts.filter((t) => t.status !== "done"))
      lines.push(`  - ${t.id} [${t.status}] ${t.title} · ${t.ownerId ? hub.name(t.ownerId) : "unassigned"}${t.prNumber ? ` · PR #${t.prNumber}` : ""}${t.note ? ` · ${clip(t.note, 100)}` : ""}`);
  }
  lines.push("", "Team:", ...snap.agents.map((a) => `- ${hub.name(a.agentId)} (${a.agentId}): ${a.session.state === "running" ? a.state : a.session.state}${a.currentTaskId ? `, on ${a.currentTaskId}` : ""}`));
  const open = (snap.actionItems ?? []).filter((i) => i.status === "open" && !i.kind);
  if (open.length) lines.push("", "Waiting on the user (Action items):", ...open.map((i) => `- ${clip(i.title, 120)} (from ${hub.name(i.fromId)})`));
  return lines.join("\n").slice(0, 8000);
}

const clip = (s: string, n = 80) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/**
 * Whether the agent is inside a turn (prompt submitted, no Stop yet). Hooks can
 * arrive late or out of order (e.g. a PreToolUse after Stop), so only a new prompt
 * may turn an idle agent back to "working".
 */
const turnOpen = new Map<string, boolean>();

export interface HookResult {
  ok: boolean;
  /** JSON printed by the hook command; Claude Code acts on it (Stop: block = continue). */
  response?: Record<string, unknown>;
  /** The turn answered a message from you: its transcript, to read the answer from (after a moment). */
  replyTranscript?: string;
  /** "team": the turn answered teammates or Fleet, not you. */
  replyCause?: "team";
  /** The turn goes on with these messages: post the part written before them. */
  replyBefore?: string;
  /** You typed this in the agent's terminal: it goes into the agent's chat in Fleet. */
  typedPrompt?: string;
}

export function handleHook(hub: Hub, inbox: Inbox, agentId: string, event: string, body: HookPayload, takeHandoff: (id: string) => string | null = () => null): HookResult {
  const st = hub.status(agentId);
  const name = hub.name(agentId);
  if (!st) return { ok: false };
  inbox.noteHook(agentId, event);

  switch (event) {
    case "SessionStart": {
      turnOpen.set(agentId, false);
      hub.setStatus(agentId, { state: "idle", note: "Ready" });
      // The lead's memory of the plan is lost on a fresh start and blurred by compaction: hand it Fleet's.
      // A refreshed session also gets its handoff: what the session it replaces had done.
      // Claude Code moves context over 10,000 characters into a file and shows a preview: stay under it.
      const handoff = clipTo(takeHandoff(agentId) ?? "", 5500);
      const briefing = hub.cfg(agentId)?.isLead ? clipTo(leadBriefing(hub, body.source), CONTEXT_MAX - handoff.length - 2) : "";
      const context = [briefing, handoff].filter(Boolean).join("\n\n");
      if (context) return { ok: true, response: { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } } };
      break;
    }
    case "UserPromptSubmit": {
      turnOpen.set(agentId, true);
      // You typed it in the agent's terminal (not a message Fleet delivered, not a /command): it shows in
      // the agent's chat in Fleet, and so does the answer. Claude Code also submits its own notices as a
      // prompt, one tag block like <task-notification>…</task-notification> or <agent-message …>…: not yours.
      const p = body.prompt?.trim() ?? "";
      const notice = /^<([a-z][a-z-]*)[\s>][\s\S]*<\/\1>$/.test(p);
      let typedPrompt = "";
      if (p && !notice && !p.startsWith("/") && !/\[Fleet\]/.test(p.slice(0, 400))) {
        inbox.expectReply(agentId);
        typedPrompt = p;
      }
      hub.setStatus(agentId, { state: "working", note: body.prompt ? clip(body.prompt.replace(/\s+/g, " ")) : null });
      if (st.state !== "working") hub.activity("task.started", agentId, `${name} is working`);
      if (typedPrompt) return { ok: true, typedPrompt };
      break;
    }
    case "PreToolUse":
      // Stale: the turn already ended. (Unknown, e.g. after an HQ restart, is allowed.)
      if (turnOpen.get(agentId) === false) break;
      // Also clears "needs input" once a permission prompt is answered.
      if (st.state !== "working" || st.note?.startsWith("Asking")) hub.setStatus(agentId, { state: "working", note: body.tool_name ? `Using ${body.tool_name}` : null });
      break;
    case "PostToolUse":
      // A tool finished: if it was waiting on the user (a question or a permission), they answered.
      if (turnOpen.get(agentId) === false) break;
      if (st.state === "needs-input") hub.setStatus(agentId, { state: "working", note: "Continuing after your answer" });
      break;
    case "Notification": {
      const msg = body.message ?? "Needs your attention";
      // "Waiting for your input" fires after a finished turn sits idle — not urgent.
      if (/waiting for your input/i.test(msg) || body.notification_type === "idle_prompt") {
        hub.setStatus(agentId, { state: "idle", note: "Waiting for you" });
        break;
      }
      // A permission prompt Fleet already holds (PermissionRequest came first): keep its specific note.
      if (body.notification_type === "permission_prompt" && (hub.snap.actionItems ?? []).some((i) => i.kind === "permission" && i.status === "open" && i.fromId === agentId))
        break;
      hub.setStatus(agentId, { state: "needs-input", note: `Asking: ${clip(msg)}` });
      hub.activity("agent.needs-input", agentId, `${name} needs you: ${clip(msg, 60)}`);
      break;
    }
    case "Stop": {
      // Messages that arrived while the agent was busy: hand them over now,
      // and Claude Code continues with them instead of stopping.
      const lead = !!hub.cfg(agentId)?.isLead;
      const answeredYou = inbox.takeAwaitingReply(agentId); // before the new batch can set it again
      const queued = inbox.takeForStop(agentId);
      if (queued) {
        turnOpen.set(agentId, true); // Claude continues: same turn
        hub.setStatus(agentId, { state: "working", note: "Reading new messages" });
        // What it wrote so far (an answer to you, say) would be cut off by the messages it continues with: post it now.
        const post = (answeredYou || lead) && body.transcript_path;
        return {
          ok: true,
          response: { decision: "block", reason: queued },
          ...(post && { replyTranscript: body.transcript_path, replyBefore: queued, ...(!answeredYou && { replyCause: "team" as const }) }),
        };
      }
      turnOpen.set(agentId, false);
      hub.setStatus(agentId, { state: "idle", note: "Finished — ready for the next instruction" });
      hub.activity("agent.answered", agentId, `${name} finished a turn`);
      // The turn answered you, or it's the lead (you talk only to the lead, so its answers are for you):
      // its final text goes to the Messages tab too. Claude Code may still be writing it to the
      // transcript when Stop fires, so the caller reads it a moment later.
      if ((answeredYou || lead) && body.transcript_path)
        return { ok: true, replyTranscript: body.transcript_path, ...(!answeredYou && { replyCause: "team" as const }) };
      break;
    }
    case "SessionEnd":
      turnOpen.set(agentId, false);
      hub.setStatus(agentId, { state: "idle", note: "Session ended" });
      break;
    default:
      return { ok: false };
  }
  return { ok: true };
}
