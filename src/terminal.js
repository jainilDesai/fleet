// Real terminal windows, no terminal emulation in the browser.
// launch: writes a small script and asks Terminal.app / iTerm to run it in a new window.
// focus:  finds the app hosting a session's pid and brings that exact tab forward.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, execFileSync } from 'node:child_process';

const LAUNCH_DIR = path.join(os.homedir(), '.fleet', 'launch');
const MODELS = new Set(['haiku', 'sonnet', 'opus', 'fable', 'default']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const MODES = new Set(['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions']);

const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const osa = (script) =>
  new Promise((resolve, reject) =>
    execFile('osascript', ['-e', script], (err, out, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(out.trim())))
  );

export async function launch(opts) {
  const cwd = path.resolve(String(opts.cwd ?? ''));
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`Not a directory: ${cwd}`);
  const args = [];
  if (opts.model && opts.model !== 'default') {
    if (!MODELS.has(opts.model)) throw new Error('Unknown model');
    args.push('--model', opts.model);
  }
  if (opts.effort) {
    if (!EFFORTS.has(opts.effort)) throw new Error('Unknown effort');
    args.push('--effort', opts.effort);
  }
  if (opts.permissionMode && opts.permissionMode !== 'default') {
    if (!MODES.has(opts.permissionMode)) throw new Error('Unknown permission mode');
    args.push('--permission-mode', opts.permissionMode);
  }
  if (opts.name) args.push('--name', String(opts.name).slice(0, 60));
  if (opts.worktree) args.push('--worktree', ...(opts.worktreeName ? [String(opts.worktreeName)] : []));
  if (opts.prompt?.trim()) args.push('--', opts.prompt.trim());

  fs.mkdirSync(LAUNCH_DIR, { recursive: true });
  const file = path.join(LAUNCH_DIR, `${Date.now()}.sh`);
  // The script deletes itself; the prompt never goes through AppleScript string quoting.
  fs.writeFileSync(
    file,
    `#!/bin/zsh -l\nrm -f ${sh(file)}\ncd ${sh(cwd)} || exit 1\nprintf '\\e]0;%s\\a' ${sh(opts.name || path.basename(cwd))}\nexec claude ${args.map(sh).join(' ')}\n`,
    { mode: 0o700 }
  );
  const command = `zsh ${sh(file)}`;
  const q = JSON.stringify(command); // AppleScript string literal: same escaping rules as JSON for our input
  if (opts.terminal === 'iterm')
    await osa(`tell application "iTerm"
  activate
  create window with default profile command ${q}
end tell`);
  else
    await osa(`tell application "Terminal"
  activate
  do script ${q}
end tell`);
  return { cwd, args };
}

// Walk up the process tree to the .app that owns this session's terminal.
function hostApp(pid) {
  let p = pid;
  for (let i = 0; i < 12 && p > 1; i++) {
    const line = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(p)], { encoding: 'utf8' }).trim();
    const m = line.match(/^(\d+)\s+(.*)$/);
    if (!m) break;
    const app = m[2].match(/^(.*?\.app)\/Contents\/MacOS\//);
    if (app) return app[1];
    p = Number(m[1]);
  }
  return null;
}

export async function focus(pid) {
  pid = Number(pid);
  const tty = execFileSync('ps', ['-o', 'tty=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  const app = hostApp(pid);
  if (!app) throw new Error('Could not find the app hosting this session');
  const name = path.basename(app, '.app');
  const dev = `/dev/${tty}`;
  if (name === 'Terminal')
    await osa(`tell application "Terminal"
  activate
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is "${dev}" then
        set selected of t to true
        set index of w to 1
        return
      end if
    end repeat
  end repeat
end tell`);
  else if (name === 'iTerm' || name === 'iTerm2')
    await osa(`tell application "iTerm"
  activate
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if tty of s is "${dev}" then
          select w
          select t
          select s
          return
        end if
      end repeat
    end repeat
  end repeat
end tell`);
  // Editors (Zed, VS Code, Cursor...) expose no tab API; bringing the app forward is the best we can do.
  else execFileSync('open', ['-a', app]);
  return { app: name, tty };
}
