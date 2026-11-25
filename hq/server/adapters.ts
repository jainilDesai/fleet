// How an agent is launched and which files Fleet writes into its folder. Claude Code only.

import type { AgentConfig, HqConfig, PermissionMode } from "../src/data/types";
import { adoptRoleFile, type RoleExtras, MCP_CONFIG, writeClaudeFiles } from "./agentFiles";

/** Writes Fleet's files into the agent's folder (all git-excluded). */
export async function writeAgentFiles(dir: string, agent: AgentConfig, cfg: HqConfig, token: string, extras: RoleExtras = {}) {
  const ownRole = await adoptRoleFile(dir);
  writeClaudeFiles(dir, agent, cfg, token, { ...extras, ownRole });
}

/** The `claude` arguments for this agent (not shell-quoted). */
export function launchArgs(agent: AgentConfig, projectMode?: PermissionMode): string[] {
  // "Opus" / "Sonnet" / "Haiku" → Claude Code's aliases; anything else is passed as a full model id.
  const m = agent.model.trim();
  const model = !m || /^default$/i.test(m) ? null : /^(opus|sonnet|haiku|fable)$/i.test(m) ? m.toLowerCase() : m;
  // Relative to the agent's folder, where it starts.
  const perm = agent.permissionMode ?? projectMode; // the agent's own mode, else the project's
  const mode = perm ? ["--permission-mode", perm] : [];
  return ["--mcp-config", MCP_CONFIG, ...(model ? ["--model", model] : []), ...mode];
}
