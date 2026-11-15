// Which system Fleet runs on, and the programs it uses there to open a browser or folder, a
// terminal window and notification banners. The platform choices live here.
// FLEET_PLATFORM (mac, linux, wsl, windows) overrides the detection, for tests.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

// 'mac', 'linux', 'wsl' (Linux inside Windows) or 'windows' (native Windows: not supported).
export function detect({ platform = process.platform, env = process.env, read = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  if (env.FLEET_PLATFORM) return env.FLEET_PLATFORM;
  if (platform === 'darwin') return 'mac';
  if (platform === 'win32') return 'windows';
  if (env.WSL_DISTRO_NAME) return 'wsl';
  for (const f of ['/proc/sys/kernel/osrelease', '/proc/version'])
    try {
      if (/microsoft/i.test(read(f))) return 'wsl';
    } catch {}
  return 'linux';
}

export const OS = detect();

// The full path of a program on PATH, or null.
export function which(cmd) {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const file = path.join(dir, cmd);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch {}
  }
  return null;
}

// The first [program, args] whose program is installed.
export const firstFound = (commands) => commands.find(([cmd]) => which(cmd)) ?? null;

// The commands that open a URL or folder in the desktop's app for it, best first. On WSL, the
// Windows ones take a Windows path for a folder (wslpath -w).
export function openers(target, os = OS) {
  if (os === 'mac') return [['open', [target]]];
  if (os === 'wsl') return [['wslview', [target]], ['explorer.exe', [target]], ['cmd.exe', ['/c', 'start', target]]];
  return [['xdg-open', [target]]];
}

// Opens a URL or folder. Never throws; false when there is nothing to open it with.
export function openTarget(target, os = OS) {
  let t = target;
  if (os === 'wsl' && t.startsWith('/'))
    try {
      t = execFileSync('wslpath', ['-w', t], { encoding: 'utf8' }).trim();
    } catch {}
  const c = firstFound(openers(t, os));
  if (!c) return false;
  const child = spawn(c[0], c[1], { stdio: 'ignore', detached: true });
  child.on('error', () => {});
  child.unref();
  return true;
}

// Linux terminals and how each takes a program to run: these arguments, then the program and its own.
const LINUX_TERMINALS = [
  ['x-terminal-emulator', ['-e']],
  ['gnome-terminal', ['--']],
  ['konsole', ['-e']],
  ['xfce4-terminal', ['-x']],
  ['kitty', []],
  ['alacritty', ['-e']],
  ['wezterm', ['start', '--']],
  ['xterm', ['-e']],
];

// How to open a terminal window running argv (no shell in between), best first. None on macOS,
// where AppleScript opens iTerm or Terminal. On WSL, Windows Terminal opens a tab in this distro;
// --exec runs argv without the login shell, so nothing re-parses it.
export function terminalCommands(argv, { os = OS, env = process.env } = {}) {
  const linux = LINUX_TERMINALS.map(([cmd, pre]) => [cmd, [...pre, ...argv]]);
  if (os === 'wsl') return [['wt.exe', ['-w', '0', 'new-tab', 'wsl.exe', ...(env.WSL_DISTRO_NAME ? ['-d', env.WSL_DISTRO_NAME] : []), '--exec', ...argv]], ...linux];
  if (os === 'linux') return linux;
  return [];
}

export const terminalName = (cmd) => (cmd === 'wt.exe' ? 'Windows Terminal' : cmd);

// Opens a terminal window running argv on Linux or WSL. Rejects when there is no terminal or no
// display, or when the terminal exits with an error at once (e.g. it can't reach the display).
export function openTerminal(argv, { os = OS, env = process.env, waitMs = 1500 } = {}) {
  const c = firstFound(terminalCommands(argv, { os, env }));
  if (!c) return Promise.reject(new Error('No terminal app found (for example gnome-terminal, konsole or xterm).'));
  if (c[0] !== 'wt.exe' && !env.DISPLAY && !env.WAYLAND_DISPLAY) return Promise.reject(new Error('No graphical display (DISPLAY and WAYLAND_DISPLAY are not set).'));
  return new Promise((resolve, reject) => {
    const child = spawn(c[0], c[1], { stdio: 'ignore', detached: true });
    child.unref();
    const timer = setTimeout(() => resolve(terminalName(c[0])), waitMs);
    child.on('error', (e) => (clearTimeout(timer), reject(e)));
    child.on('exit', (code) => (clearTimeout(timer), code ? reject(new Error(`${c[0]} exited with code ${code}`)) : resolve(terminalName(c[0]))));
  });
}

// The program for notification banners off macOS: notify-send on Linux, when installed. None on
// WSL: Windows doesn't show Linux notifications.
export const notifySend = (os = OS) => (os === 'linux' ? which('notify-send') : null);
