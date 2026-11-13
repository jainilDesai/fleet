// The files Fleet writes into each agent's worktree. All of them are listed in the repo's
// shared git exclude (see workspace.ts), so they are never committed.

import { agentRead, agentRemove, agentWrite } from "./lib/agentFs";
import { run } from "./lib/exec";
import type { AgentConfig, HqConfig } from "../src/data/types";

/** Team MCP config, passed with `claude --mcp-config` (so the project's own .mcp.json is untouched). */
export const MCP_CONFIG = ".claude/fleet-mcp.json";
/** Fleet's generated role file. Its own name, so a ROLE.md the project has is never overwritten. */
export const ROLE_FILE = ".fleet-role.md";
export const HQ_FILES = [ROLE_FILE, ".claude/settings.local.json", MCP_CONFIG];

/** Extra context for the generated role: the folder's own ROLE.md, and whether app variables are set. */
export interface RoleExtras {
  ownRole?: string | null;
  hasEnvFile?: boolean;
}

/** A role file Fleet generated, if one ever ends up named ROLE.md; recognised so it can be cleaned up. */
const isHqRole = (text: string) => text.includes("## Team MCP (server `hq`)") && text.includes("You are managed by Fleet.");

/**
 * The folder's own ROLE.md, if it has one (it's included in the generated role). A ROLE.md that an
 * older version generated there is removed, along with its exclude line.
 */
export async function adoptRoleFile(dir: string): Promise<string | null> {
  const text = agentRead(dir, "ROLE.md");
  if (text === null) return null;
  if (!isHqRole(text)) return text.slice(0, 20_000);
  const tracked = await run("git", ["ls-files", "--error-unmatch", "ROLE.md"], { cwd: dir });
  if (!tracked.ok) {
    agentRemove(dir, "ROLE.md");
    removeFromExclude(dir, ["ROLE.md"]);
  }
  return null;
}
export const MARK = "# fleet-hook";
/** Marks Fleet's http hook URLs (they have no comment to carry MARK). */
const URL_MARK = "src=fleet-hook";
const isOurs = (h: HookHandler) => (h.type === "http" ? h.url.includes(URL_MARK) : h.command.includes(MARK));

// PostToolUse: the moment a question or permission prompt is answered, the tool completes.
const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "Stop", "SessionEnd"] as const;

/** URL agents use to reach Fleet. */
export function hqUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export function roleMd(agent: AgentConfig, cfg: HqConfig, extras: RoleExtras = {}): string {
  const team = cfg.team.map((a) => `- ${a.name} — ${a.role}${a.isLead ? " (lead)" : ""}${a.id === agent.id ? " ← you" : ""}`).join("\n");
  const rules = agent.isLead
    ? [
        "You plan the work and assign it to the team. You never write app code.",
        "Keep tasks small: one task = one branch = one PR. Give each task the files it may edit and a clear done-when.",
        "Assign to agents that are free (check list_workers). A stopped agent starts by itself when you give it a task or a message.",
        cfg.workflow.merge.by === "lead"
          ? "You merge PRs once they pass review (`gh pr merge <number> --squash --delete-branch`), one at a time, in an order that avoids conflicts. Fleet tells you when each one passes."
          : "The user merges PRs; never merge one yourself. Decide the order they should land in, and tell the user if one blocks another.",
        "If the user changes who merges, Fleet tells you. Follow the latest message.",
      ]
    : [
        "Work only on the task you were given. When Fleet tells you to start one, call get_my_task first.",
        "If your task changes code: start from the latest main (or the branch the task names), make one branch for it, and edit only the files the task lists. Need another file? Ask the lead with send_message.",
        "If you open a PR: title it `[TASK-ID] Short title` (`gh pr create`), then call set_my_status in-review with the PR number. Otherwise call set_my_status done with a short note of what you did.",
        "set_my_status tells the lead automatically. Don't also send_message the same news.",
        "If you are blocked or need a decision, call set_my_status blocked with the reason.",
      ];
  rules.push(
    "When you need the user to do or decide something you can't (create an account, database or API key, change a setting in a dashboard, put a value in an env file, approve a deploy or a risky change), call ask_user with a short title and clear steps, then keep working on what you can. Never put secret values in it; name the variable instead.",
  );
  const tools = agent.isLead
    ? "list_workers, get_status, list_tasks, create_board, create_task, update_task, assign_task, send_message, ask_user"
    : "get_my_task, set_my_status, list_workers, get_status, list_tasks, send_message, ask_user";
  return [
    `# ${agent.name} — ${agent.role}`,
    "",
    agent.roleMd.trim(),
    "",
    "## Team",
    team,
    "",
    "## Rules",
    ...rules.map((r) => `- ${r}`),
    "",
    ...(extras.ownRole?.trim() ? ["## From ROLE.md in this folder", extras.ownRole.trim(), ""] : []),
    "## Team MCP (server `hq`)",
    `Your tools: ${tools}.`,
    "Messages that start with `[Fleet]` come from Fleet: assignments from the lead, or messages from teammates. Act on them.",
    "Teammates work in their own git worktrees and cannot see your files or terminal. Talk to them only with send_message.",
    "",
    `Project: ${cfg.project.name} (${cfg.project.repo}). You are managed by Fleet.`,
    "",
  ].join("\n");
}

type HookHandler =
  | { type: "command"; command: string; timeout?: number }
  | { type: "http"; url: string; headers?: Record<string, string>; timeout?: number };
type HookEntry = { matcher?: string; hooks: HookHandler[] };
type Settings = { hooks?: Record<string, HookEntry[]>; permissions?: { allow?: string[]; [k: string]: unknown }; [k: string]: unknown };

export function hookCommand(url: string, token: string, agentId: string, event: string): string {
  // Stop prints Fleet's reply: {"decision":"block","reason":…} hands over queued messages.
  const out = event === "Stop" ? "2>/dev/null" : ">/dev/null 2>&1";
  return `curl -sf -m 4 -X POST -H 'Authorization: Bearer ${token}' -H 'Content-Type: application/json' --data-binary @- '${url}/hook/${agentId}/${event}' ${out} || true ${MARK}`;
}

/**
 * Hooks report state to Fleet. SessionStart also prints the role file, which Claude Code
 * adds to the session's context. Existing user hooks are kept.
 */
export function writeSettings(dir: string, agent: AgentConfig, port: number, token: string) {
  const file = ".claude/settings.local.json";
  let settings: Settings = {};
  const existing = agentRead(dir, file); // a symlink reads as missing: never pull in a host file
  if (existing) {
    try {
      settings = JSON.parse(existing) as Settings;
    } catch {
      settings = {};
    }
  }
  const hooks: Record<string, HookEntry[]> = { ...(settings.hooks ?? {}) };
  const url = hqUrl(port);
  for (const event of HOOK_EVENTS) {
    const kept = (hooks[event] ?? [])
      .map((e) => ({ ...e, hooks: e.hooks.filter((h) => !isOurs(h)) }))
      .filter((e) => e.hooks.length);
    const ours: HookEntry["hooks"] = [{ type: "command", command: hookCommand(url, token, agent.id, event), timeout: 5 }];
    if (event === "SessionStart")
      ours.unshift({ type: "command", command: `cat "$CLAUDE_PROJECT_DIR/${ROLE_FILE}" 2>/dev/null || true ${MARK}` });
    hooks[event] = [...kept, event === "PreToolUse" || event === "PostToolUse" ? { matcher: "*", hooks: ours } : { hooks: ours }];
  }
  // Permission prompts go to Fleet first: you answer Allow/Deny in Action items. Fleet holds the request
  // up to ~9.5 min (Claude Code waits up to 600s); without an answer Claude Code asks in the terminal.
  const keptPermission = (hooks.PermissionRequest ?? [])
    .map((e) => ({ ...e, hooks: e.hooks.filter((h) => !isOurs(h)) }))
    .filter((e) => e.hooks.length);
  hooks.PermissionRequest = [
    ...keptPermission,
    { hooks: [{ type: "http", url: `${url}/hook/${agent.id}/PermissionRequest?${URL_MARK}`, headers: { Authorization: `Bearer ${token}` }, timeout: 600 }] },
  ];
  // Let the agent use the Team MCP without a permission prompt for every call.
  const allow = new Set([...(settings.permissions?.allow ?? []), "mcp__hq"]);
  // Owner-only: the hook commands carry the agent token.
  agentWrite(dir, file, JSON.stringify({ ...settings, hooks, permissions: { ...(settings.permissions ?? {}), allow: [...allow] } }, null, 2) + "\n", { mode: 0o600 });
}

/** Team MCP config: Fleet's URL plus this agent's identity and token. */
export function writeMcpConfig(dir: string, agent: AgentConfig, port: number, token: string) {
  const config = {
    mcpServers: {
      hq: { type: "http", url: `${hqUrl(port)}/mcp`, headers: { Authorization: `Bearer ${token}`, "X-HQ-Agent": agent.id } },
    },
  };
  agentWrite(dir, MCP_CONFIG, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

/** Claude Code's files: the role (loaded by the SessionStart hook), hooks, and the Team MCP config. */
export function writeClaudeFiles(dir: string, agent: AgentConfig, cfg: HqConfig, token: string, extras: RoleExtras = {}) {
  agentWrite(dir, ROLE_FILE, roleMd(agent, cfg, extras));
  writeSettings(dir, agent, cfg.project.hqPort, token);
  writeMcpConfig(dir, agent, cfg.project.hqPort, token);
}

/** Removes lines added to .git/info/exclude. */
export function removeFromExclude(dir: string, paths: string[]) {
  const file = ".git/info/exclude";
  const current = agentRead(dir, file);
  if (current === null) return;
  const next = current.split("\n").filter((l) => !paths.includes(l)).join("\n");
  if (next !== current) agentWrite(dir, file, next);
}

