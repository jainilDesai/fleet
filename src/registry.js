// The Fleet copies running on this Mac, one per project: a file per copy in ~/.fleet/running/
// (<pid>.json: { slug, name, repo, port, pid }), so copies starting together never overwrite each
// other. Copies that died without cleaning up are dropped on read.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';

const dir = () => path.join(os.homedir(), '.fleet', 'running');

export const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // exists, owned by someone else
  }
};

export function running() {
  let files;
  try {
    files = fs.readdirSync(dir()).filter((f) => /^\d+\.json$/.test(f));
  } catch {
    return [];
  }
  return files.flatMap((f) => {
    const file = path.join(dir(), f);
    if (!alive(Number(f.slice(0, -5)))) {
      fs.rmSync(file, { force: true });
      return [];
    }
    try {
      return [JSON.parse(fs.readFileSync(file, 'utf8'))];
    } catch {
      return []; // being written
    }
  });
}

export function register(entry) {
  fs.mkdirSync(dir(), { recursive: true });
  const file = path.join(dir(), `${entry.pid}.json`);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(entry) + '\n');
  fs.renameSync(`${file}.tmp`, file);
}

export const unregister = (pid = process.pid) => fs.rmSync(path.join(dir(), `${pid}.json`), { force: true });

export const urlOf = (e) => `http://localhost:${e.port}`;

const free = (port) =>
  new Promise((resolve) => {
    const s = net.createServer().once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });

// The first port from `start` that nothing listens on and isn't in `skip`.
export async function freePort(start, skip = []) {
  for (let p = start; p < start + 100 && p <= 65535; p++) if (!skip.includes(p) && (await free(p))) return p;
  throw new Error(`No free port between ${start} and ${start + 99}. Pass --port <n>.`);
}

// One copy watches every Claude session on the Mac (banners, events.jsonl, history.json): the one
// whose pid is in ~/.fleet/watcher.pid. When it stops, the next copy to check takes over.
const lock = () => path.join(os.homedir(), '.fleet', 'watcher.pid');
const holder = () => {
  try {
    return Number(fs.readFileSync(lock(), 'utf8'));
  } catch {
    return 0;
  }
};

// 'held' (this copy is the watcher), 'took' (it just took over) or null (another copy is).
export function claimWatcher() {
  const pid = holder();
  if (pid === process.pid) return 'held';
  if (pid && alive(pid)) return null;
  try {
    fs.mkdirSync(path.dirname(lock()), { recursive: true });
    fs.rmSync(lock(), { force: true });
    fs.writeFileSync(lock(), String(process.pid), { flag: 'wx' }); // fails if another copy just took it
    return 'took';
  } catch {
    return null;
  }
}

export const releaseWatcher = () => holder() === process.pid && fs.rmSync(lock(), { force: true });
