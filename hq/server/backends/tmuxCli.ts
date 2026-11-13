// Agent sessions live in tmux so they survive HQ restarts.

import { run } from "../lib/exec";

export async function hasSession(name: string): Promise<boolean> {
  return (await run("tmux", ["has-session", "-t", `=${name}`], { timeoutMs: 5000 })).ok;
}

/** Starts a detached session running `command` (via the user's shell) in `cwd`. */
export async function newSession(name: string, cwd: string, command: string, env: Record<string, string> = {}) {
  const args = ["new-session", "-d", "-s", name, "-x", "200", "-y", "50", "-c", cwd];
  for (const [k, v] of Object.entries(env)) args.push("-e", `${k}=${v}`);
  args.push(command);
  const r = await run("tmux", args, { timeoutMs: 10_000 });
  if (!r.ok) throw new Error(`tmux: ${r.stderr.trim()}`);
  // Keep the pane after the command exits, so we can show why it ended.
  await run("tmux", ["set-option", "-t", name, "remain-on-exit", "on"], { timeoutMs: 5000 });
  // Agents use colours and the mouse wheel for scrollback; HQ shows its own status.
  await run("tmux", ["set-option", "-t", name, "mouse", "on"], { timeoutMs: 5000 });
  await run("tmux", ["set-option", "-t", name, "status", "off"], { timeoutMs: 5000 });
  await run("tmux", ["set-option", "-t", name, "focus-events", "on"], { timeoutMs: 5000 });
}

export async function killSession(name: string) {
  await run("tmux", ["kill-session", "-t", `=${name}`], { timeoutMs: 5000 });
}

export interface PaneInfo {
  dead: boolean;
  exitStatus: number | null;
}

export async function paneInfo(name: string): Promise<PaneInfo | null> {
  const r = await run("tmux", ["display-message", "-p", "-t", `=${name}:`, "#{pane_dead} #{pane_dead_status}"], { timeoutMs: 5000 });
  if (!r.ok) return null;
  const [dead, status] = r.stdout.trim().split(" ");
  return { dead: dead === "1", exitStatus: status ? Number(status) : null };
}

/** The visible screen plus some scrollback, with colours, as terminal text. */
export async function capturePane(name: string, lines = 300): Promise<string> {
  const r = await run("tmux", ["capture-pane", "-p", "-e", "-J", "-S", `-${lines}`, "-t", `=${name}:`], { timeoutMs: 5000 });
  return r.ok ? r.stdout.replace(/\n/g, "\r\n") : "";
}

/**
 * What you've typed at Claude Code's prompt and not sent, or "" if nothing. The grey suggestion
 * Claude Code shows on an empty prompt is drawn dim (SGR 2), so it counts as nothing.
 */
export async function promptDraft(name: string): Promise<string> {
  const r = await run("tmux", ["capture-pane", "-e", "-p", "-t", `=${name}:`], { timeoutMs: 5000 });
  const line = r.stdout.split("\n").reverse().find((l) => l.includes("❯"));
  return line ? draftFromPromptLine(line) : "";
}

/** The unsent text on one styled prompt line (see promptDraft). */
export function draftFromPromptLine(line: string): string {
  // eslint-disable-next-line no-control-regex
  const after = line.slice(line.indexOf("❯") + 1).replace(/^[\s\u00a0]+/, "");
  // eslint-disable-next-line no-control-regex
  const leadingCodes = after.match(/^(\x1b\[[0-9;]*m)*/)?.[0] ?? "";
  // eslint-disable-next-line no-control-regex
  const text = after.replace(/\x1b\[[0-9;]*m/g, "").trim();
  if (!text) return "";
  // A suggestion: the text starts dim. (Your own typing is drawn in the normal colour.)
  return /\x1b\[([0-9;]*;)?2(;[0-9;]*)?m/.test(leadingCodes) ? "" : text;
}

/** Last non-empty lines of the pane, plain text (for error messages). */
export async function tailText(name: string, n = 6): Promise<string> {
  const r = await run("tmux", ["capture-pane", "-p", "-t", `=${name}:`], { timeoutMs: 5000 });
  return r.stdout.split("\n").map((l) => l.trimEnd()).filter(Boolean).slice(-n).join("\n");
}
