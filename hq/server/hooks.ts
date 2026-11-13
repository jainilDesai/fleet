// Claude Code hooks → agent state. Each agent's hooks POST to
// /hook/<agentId>/<Event> with the hook's JSON payload.

import { closeSync, openSync, readSync, statSync } from "node:fs";
import type { Hub } from "./hub";
import type { Inbox } from "./inbox";

export interface HookPayload {
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  message?: string;
  notification_type?: string;
  transcript_path?: string;
}

/** What a permission request is for, in words: a title and the details you decide on. */
export function describePermission(tool: string, input: Record<string, unknown> = {}): { title: string; details: string } {
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  if (tool === "Bash") {
    const cmd = s(input.command);
    const details = [cmd, s(input.description)].filter(Boolean).join("\n\n");
    // Same match as the upsell repo's deploy-prod-guard.sh: never let a production deploy look routine.
    if (/gh +workflow +run.*(Deploy +To +Production|deploy-prod\.ya?ml|166193513)/i.test(cmd)) {
      const branch = cmd.match(/-f +branch=(\S+)/)?.[1] ?? "(no branch given)";
      return { title: `⚠ PRODUCTION deploy: ${branch}`, details: `This reloads production for every live merchant.\n\n${details}` };
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
    return null;
  }
  const lines = text.split("\n").filter(Boolean).reverse();
  for (const line of lines) {
    let entry: { type?: string; message?: { content?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // the first line of the window may be cut
    }
    // A real prompt (string content) means we've gone back past the last turn.
    if (entry.type === "user" && typeof entry.message?.content === "string") return null;
    if (entry.type !== "assistant" || !Array.isArray(entry.message?.content)) continue;
    const parts = (entry.message.content as { type?: string; text?: string }[]).filter((c) => c.type === "text" && c.text?.trim()).map((c) => c.text!.trim());
    if (parts.length) return parts.join("\n\n");
  }
  return null;
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
}

export function handleHook(hub: Hub, inbox: Inbox, agentId: string, event: string, body: HookPayload): HookResult {
  const st = hub.status(agentId);
  const name = hub.name(agentId);
  if (!st) return { ok: false };
  inbox.noteHook(agentId, event);

  switch (event) {
    case "SessionStart":
      turnOpen.set(agentId, false);
      hub.setStatus(agentId, { state: "idle", note: "Ready" });
      break;
    case "UserPromptSubmit":
      turnOpen.set(agentId, true);
      hub.setStatus(agentId, { state: "working", note: body.prompt ? clip(body.prompt.replace(/\s+/g, " ")) : null });
      if (st.state !== "working") hub.activity("task.started", agentId, `${name} is working`);
      break;
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
      const queued = inbox.takeForStop(agentId);
      if (queued) {
        turnOpen.set(agentId, true); // Claude continues: same turn
        hub.setStatus(agentId, { state: "working", note: "Reading new messages" });
        return { ok: true, response: { decision: "block", reason: queued } };
      }
      turnOpen.set(agentId, false);
      hub.setStatus(agentId, { state: "idle", note: "Finished — ready for the next instruction" });
      hub.activity("agent.answered", agentId, `${name} finished a turn`);
      // The turn answered you, or it's the lead (you talk only to the lead, so its answers are for you):
      // its final text goes to the Messages tab too. Claude Code may still be writing it to the
      // transcript when Stop fires, so the caller reads it a moment later.
      const forYou = inbox.takeAwaitingReply(agentId) || !!hub.cfg(agentId)?.isLead;
      if (forYou && body.transcript_path) return { ok: true, replyTranscript: body.transcript_path };
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
