// Agent folders: a Fleet-managed git worktree per agent, or a folder the user chose.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { AgentConfig } from "../src/data/types";
import { HQ_FILES } from "./agentFiles";
import { run } from "./lib/exec";
import { managedWorkspace } from "./paths";
import type { RepoInfo } from "./repo";

export function workspaceFor(agent: AgentConfig, projectSlug: string): string {
  return agent.workspacePath || managedWorkspace(projectSlug, agent.id);
}

/** The branch a managed worktree is created on. The agent makes its own task branches from there. */
export const agentBranch = (agentId: string) => `fleet/${agentId}`;

/**
 * Makes sure the agent's folder exists and is a git checkout: a worktree of the repo
 * (~/.fleet/projects/<slug>/<agent>) on its own branch, started from the default branch.
 */
export async function ensureWorkspace(agent: AgentConfig, projectSlug: string, repo: RepoInfo): Promise<string> {
  const dir = workspaceFor(agent, projectSlug);
  if (agent.workspacePath) {
    if (!existsSync(dir)) throw new Error(`Folder not found: ${dir}`);
    if (!(await run("git", ["rev-parse", "--git-dir"], { cwd: dir })).ok) throw new Error(`${dir} is not a git repository.`);
  } else if (!existsSync(dir)) {
    mkdirSync(join(dir, ".."), { recursive: true });
    await run("git", ["fetch", "--quiet", "origin"], { cwd: repo.root, timeoutMs: 60_000 }); // best effort: start from the latest
    const base = await defaultBase(repo.root);
    const branch = agentBranch(agent.id);
    // Reuse the agent's branch if an earlier worktree left it behind.
    const exists = (await run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repo.root })).ok;
    const args = exists ? ["worktree", "add", dir, branch] : ["worktree", "add", "-b", branch, dir, base];
    const add = await run("git", args, { cwd: repo.root, timeoutMs: 120_000 });
    if (!add.ok) throw new Error(`git worktree add failed: ${add.stderr.trim()}`);
  }
  await excludeFleetFiles(dir);
  return dir;
}

/** origin's default branch (e.g. origin/main), else the local HEAD. */
async function defaultBase(root: string): Promise<string> {
  const r = await run("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { cwd: root });
  if (r.ok && r.stdout.trim()) return r.stdout.trim();
  for (const b of ["origin/main", "origin/master"]) if ((await run("git", ["rev-parse", "--verify", "--quiet", b], { cwd: root })).ok) return b;
  return "HEAD";
}

/**
 * Keeps Fleet's files (role, hooks, MCP config with the agent token) out of git. A worktree's .git
 * is a file, so the exclude goes in the repo's shared git dir, where every worktree reads it.
 */
async function excludeFleetFiles(dir: string) {
  const r = await run("git", ["rev-parse", "--git-common-dir"], { cwd: dir });
  if (!r.ok) return;
  const common = r.stdout.trim();
  const file = join(isAbsolute(common) ? common : join(dir, common), "info", "exclude");
  mkdirSync(join(file, ".."), { recursive: true });
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  const missing = HQ_FILES.filter((p) => !current.split("\n").includes(p));
  if (missing.length) appendFileSync(file, (current && !current.endsWith("\n") ? "\n" : "") + "# Fleet\n" + missing.join("\n") + "\n");
}

/** Removes a managed worktree (and prunes git's record of it). */
export async function removeWorktree(repo: RepoInfo, dir: string) {
  const r = await run("git", ["worktree", "remove", "--force", dir], { cwd: repo.root, timeoutMs: 60_000 });
  if (!r.ok) await run("git", ["worktree", "prune"], { cwd: repo.root });
  return r.ok;
}
