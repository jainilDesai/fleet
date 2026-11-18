// Shared dependencies: an agent's worktree gets your checkout's installed node_modules as a copy-on-write
// clone (APFS on macOS, reflink on Linux). A clone shares disk blocks with yours until either side changes
// a file, so it costs next to no disk, and an install in the agent's folder never touches your checkout.
// Only where the package files match yours; otherwise the agent installs for its branch as usual.

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { agentPath, agentWrite } from "./lib/agentFs";
import { run } from "./lib/exec";

/** The files that decide what's installed. All must match for node_modules to be shared. */
const PACKAGE_FILES = ["package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb"];

/** Folders under `root` ("" is root itself) with an installed node_modules, up to `depth` levels down. */
export function dependencyDirs(root: string, depth = 3): string[] {
  const found: string[] = [];
  const walk = (rel: string, level: number) => {
    let entries;
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.name === "node_modules" && e.isDirectory())) found.push(rel);
    if (level < depth) for (const e of entries) if (e.isDirectory() && e.name !== "node_modules" && !e.name.startsWith(".")) walk(join(rel, e.name), level + 1);
  };
  walk("", 0);
  return found;
}

const read = (p: string) => {
  try {
    return readFileSync(p);
  } catch {
    return null;
  }
};
const sameFile = (a: string, b: string) => {
  const x = read(a);
  const y = read(b);
  return x === null ? y === null : y !== null && x.equals(y);
};

/** The worktree has the same package files as `root` in `rel` (and at the top, for workspaces). */
export function packagesMatch(root: string, dir: string, rel: string): boolean {
  if (!existsSync(join(dir, rel, "package.json"))) return false;
  return [...new Set([rel, ""])].every((d) => PACKAGE_FILES.every((f) => sameFile(join(root, d, f), join(dir, d, f))));
}

/** A copy-on-write clone only: never a full copy, which would cost the disk this is meant to save. */
async function cloneDir(src: string, dest: string) {
  const args = process.platform === "darwin" ? ["-cR", src, dest] : ["-R", "--reflink=always", src, dest];
  return (await run("cp", args, { timeoutMs: 10 * 60_000 })).ok;
}

const busy = new Set<string>();

/**
 * Gives worktree `dir` each node_modules it lacks from `root`, where the package files match. Each clone
 * is made in `tmp` (same disk, outside the worktree) and moved in when complete, so the agent never sees
 * half a node_modules; if it installed its own meanwhile, that one stays. Returns the folders filled.
 */
export async function shareDependencies(root: string, dir: string, tmp: string): Promise<string[]> {
  if (busy.has(dir)) return [];
  busy.add(dir);
  const filled: string[] = [];
  try {
    for (const rel of dependencyDirs(root)) {
      let target: string;
      try {
        target = agentPath(dir, join(rel, "node_modules")); // never into a folder the agent swapped for a symlink
      } catch {
        continue;
      }
      if (existsSync(target) || !packagesMatch(root, dir, rel)) continue;
      mkdirSync(tmp, { recursive: true });
      const staging = join(tmp, `${basename(dir)}-${Date.now()}`);
      try {
        if ((await cloneDir(join(root, rel, "node_modules"), staging)) && !lstat(target)) {
          agentPath(dir, join(rel, "node_modules")); // and still not, after the clone
          renameSync(staging, target);
          filled.push(rel || ".");
        }
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    }
  } finally {
    busy.delete(dir);
  }
  return filled;
}

/** Env files: `.env`, `.env.local`, `.env.test`… */
const ENV_FILE = /^\.env(\..+)?$/;

/**
 * Copies each env file of your checkout that git ignores into worktree `dir` (mode 600), so agents can
 * run the app and its tests. Never a tracked file like `.env.example`. A copy, not a link: an agent's edit
 * stays in its folder. Copied again when yours is newer than the agent's copy, so your edits reach agents
 * on their next start. Writes go through agentWrite: a folder the agent swapped for a symlink is refused.
 * Returns the files copied.
 */
export async function copyEnvFiles(root: string, dir: string, depth = 3): Promise<string[]> {
  const found: string[] = [];
  const walk = (rel: string, level: number) => {
    let entries;
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isFile() && ENV_FILE.test(e.name)) found.push(join(rel, e.name));
      else if (level < depth && e.isDirectory() && e.name !== "node_modules" && !e.name.startsWith(".")) walk(join(rel, e.name), level + 1);
    }
  };
  walk("", 0);
  const copied: string[] = [];
  for (const rel of found) {
    try {
      const target = agentPath(dir, rel);
      if (!existsSync(dirname(target))) continue; // that folder isn't on the agent's branch
      const mine = lstat(target);
      const src = statSync(join(root, rel));
      // An agent's own file (or link) stays, unless it's older than yours or the link an older Fleet made.
      const oldLink = mine?.isSymbolicLink() && readlinkSync(target) === join(root, rel);
      if (mine && !oldLink && !(mine.isFile() && src.mtimeMs > mine.mtimeMs)) continue;
      if (!(await run("git", ["check-ignore", "-q", rel], { cwd: root })).ok) continue; // tracked or not ignored
      agentWrite(dir, rel, readFileSync(join(root, rel), "utf8"), { mode: 0o600 });
      copied.push(rel);
    } catch {
      /* a symlinked folder on the way, or a file that vanished: skip */
    }
  }
  return copied;
}

const lstat = (p: string) => {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
};
