// One GitHub poll per repo for every Fleet process on this machine. Teams on the same repo
// would otherwise each spend the shared API budget on the same repo-wide query; whoever
// polls first writes the result to ~/.fleet/github/<owner>__<name>.json and the rest read it.

import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fetchPrs, RateLimited } from "./github";

type Fetched = Awaited<ReturnType<typeof fetchPrs>>;
interface Cache {
  at?: number;
  result?: Fetched;
  pausedUntil?: number;
}

/** A poll lock older than this belongs to a process that died mid-fetch (gh times out at 30s, plus 15s for rate_limit). */
export const LEASE_MS = 60_000;

const fileOf = (repo: string) => join(homedir(), ".fleet", "github", `${repo.toLowerCase().replace("/", "__")}.json`);

function read(file: string): Cache {
  try {
    const c = JSON.parse(readFileSync(file, "utf8")) as Cache;
    return c && typeof c === "object" ? c : {};
  } catch {
    return {}; // missing or corrupt: poll as if nobody had
  }
}

function write(file: string, c: Cache) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(c), { mode: 0o600 });
  renameSync(tmp, file);
}

/** Take the poll lock; a stale one (its holder died) is taken over. */
function lock(path: string): boolean {
  for (let i = 0; i < 2; i++) {
    try {
      closeSync(openSync(path, "wx"));
      return true;
    } catch {
      try {
        if (Date.now() - statSync(path).mtimeMs < LEASE_MS) return false;
        unlinkSync(path); // shortcut: two processes may both clear a stale lock and both poll once; harmless
      } catch {
        /* gone already: try again */
      }
    }
  }
  return false;
}

/**
 * The repo's PRs, no older than maxAgeMs. Fetches only when the shared copy is older and no other
 * process is fetching; then everyone reads the result. A rate limit hit by any process pauses all.
 * Returns null when another process is mid-fetch and there is nothing cached yet.
 */
export async function sharedFetchPrs(repo: string, maxAgeMs: number, fetch: (repo: string) => Promise<Fetched> = fetchPrs): Promise<Fetched | null> {
  const file = fileOf(repo);
  const cached = read(file);
  if (cached.pausedUntil && Date.now() < cached.pausedUntil) throw new RateLimited(new Date(cached.pausedUntil));
  if (cached.result && cached.at && Date.now() - cached.at < maxAgeMs) return cached.result;
  mkdirSync(join(homedir(), ".fleet", "github"), { recursive: true });
  const lockFile = `${file}.lock`;
  if (!lock(lockFile)) return cached.result ?? null; // another process is polling right now
  try {
    const result = await fetch(repo);
    write(file, { at: Date.now(), result });
    return result;
  } catch (err) {
    if (err instanceof RateLimited) write(file, { ...read(file), pausedUntil: err.resetAt.getTime() });
    throw err;
  } finally {
    try {
      unlinkSync(lockFile);
    } catch {
      /* already gone */
    }
  }
}
