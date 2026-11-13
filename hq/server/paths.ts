import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "") || "project";

/** ~/.fleet/projects/<project>/ — the team's home: config, plan, action items, token, worktrees. Never in the repo. */
export function projectHome(projectSlug: string): string {
  const dir = join(homedir(), ".fleet", "projects", projectSlug);
  // Owner-only: it holds the agent token and every agent's worktree (whose settings carry the token).
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

export function managedWorkspace(projectSlug: string, agentId: string): string {
  return join(projectHome(projectSlug), agentId);
}

/** tmux session names. */
export const sessionName = (projectSlug: string, agentId: string) => `fleet-${projectSlug}-${agentId}`;

/**
 * Agent token: what hooks and the Team MCP send. Stable per project so agent
 * sessions that outlive a Fleet restart keep working. Stored 0600 in the project's home.
 */
export function agentToken(projectSlug: string): string {
  const file = join(projectHome(projectSlug), "agent-token");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const tok = randomBytes(24).toString("hex");
  writeFileSync(file, tok, { mode: 0o600 });
  return tok;
}

