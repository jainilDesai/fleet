// Shared dependencies: an agent's worktree gets your checkout's installed node_modules as a copy-on-write
// clone (APFS on macOS, reflink on Linux). A clone shares disk blocks with yours until either side changes
// a file, so it costs next to no disk, and an install in the agent's folder never touches your checkout.
// Only where the package files match yours; otherwise the agent installs for its branch as usual.

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { basename, join } from "node:path";
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
      const target = join(dir, rel, "node_modules");
      if (existsSync(target) || !packagesMatch(root, dir, rel)) continue;
      mkdirSync(tmp, { recursive: true });
      const staging = join(tmp, `${basename(dir)}-${Date.now()}`);
      try {
        if ((await cloneDir(join(root, rel, "node_modules"), staging)) && !existsSync(target)) {
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
 * Links each env file of your checkout that git ignores (and the worktree lacks) into worktree `dir`,
 * so agents can run the app and its tests. A link, not a copy: your edits reach them. Never a tracked
 * file like `.env.example`. Returns the files linked.
 */
export async function linkEnvFiles(root: string, dir: string, depth = 3): Promise<string[]> {
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
  const linked: string[] = [];
  for (const rel of found) {
    const target = join(dir, rel);
    if (exists(target) || !existsSync(join(dir, rel, ".."))) continue;
    if (!(await run("git", ["check-ignore", "-q", rel], { cwd: root })).ok) continue; // tracked or not ignored
    try {
      symlinkSync(join(root, rel), target);
      linked.push(rel);
    } catch {
      /* a race with the agent, or a filesystem without links: skip */
    }
  }
  return linked;
}

/** True for anything at `p`, a dangling link included. */
const exists = (p: string) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};
