import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

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

/** The repo root in a project's config.json, from before the repo-root file. */
function configRoot(dir: string): string | null {
  try {
    return JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).project?.path ?? null;
  } catch {
    return null;
  }
}

/** Claims a project folder for `root` (atomically: copies can start together at login), or says whose it is. */
function claim(slug: string, root: string): boolean {
  const dir = projectHome(slug);
  const file = join(dir, "repo-root");
  const old = configRoot(dir);
  if (old && old !== root && !existsSync(file)) return false;
  try {
    writeFileSync(file, root + "\n", { flag: "wx" });
    return true;
  } catch {
    return readFileSync(file, "utf8").trim() === root;
  }
}

/**
 * The project's slug, from the repo folder's name. Another repo with the same folder name already owns
 * that slug, or is it "home"? Then <name>-<short hash of the root>, so two repos never share a team.
 */
export function projectSlug(root: string): string {
  const base = slugify(basename(root));
  const hashed = `${base}-${createHash("sha256").update(root).digest("hex").slice(0, 6)}`;
  // "home" is reserved: its login item would be the home page's (com.jainildesai.fleet.home, fleet-home.service).
  return base !== "home" && claim(base, root) ? base : (claim(hashed, root), hashed);
}

/** A slug a project can be given (`fleet --project`): lowercase letters, digits, dashes. */
export const validSlug = (s: string) => /^[a-z0-9][a-z0-9-]{0,59}$/.test(s) && s !== "home";

/**
 * The slug of a project named on the command line (`fleet --project <slug>`): a second team on the same
 * repo, made by New work. Refused when the slug belongs to another repo.
 */
export function namedSlug(root: string, wanted: string): string {
  if (!validSlug(wanted)) throw new Error(`"${wanted}" isn't a valid project name: use lowercase letters, digits and dashes.`);
  if (!claim(wanted, root)) throw new Error(`The project "${wanted}" belongs to another repo.`);
  return wanted;
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

