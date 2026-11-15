import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const { detect, openers, terminalCommands, firstFound, openTerminal, notifySend } = await import('../src/platform.js');

// A folder of fake programs, used as the whole PATH.
const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-bin-'));
const fake = (name, body = 'exit 0') => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
const withPath = async (fn) => {
  const saved = process.env.PATH;
  process.env.PATH = bin;
  try {
    return await fn();
  } finally {
    process.env.PATH = saved;
  }
};

test('detects macOS, Linux, WSL and native Windows', () => {
  const none = () => {
    throw new Error('ENOENT');
  };
  assert.equal(detect({ platform: 'darwin', env: {}, read: none }), 'mac');
  assert.equal(detect({ platform: 'win32', env: {}, read: none }), 'windows');
  assert.equal(detect({ platform: 'linux', env: {}, read: () => '6.8.0-45-generic' }), 'linux');
  assert.equal(detect({ platform: 'linux', env: {}, read: none }), 'linux');
  assert.equal(detect({ platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu' }, read: none }), 'wsl');
  assert.equal(detect({ platform: 'linux', env: {}, read: () => '5.15.153.1-microsoft-standard-WSL2' }), 'wsl');
  assert.equal(detect({ platform: 'linux', env: {}, read: (f) => (f === '/proc/version' ? 'Linux version 4.4.0-19041-Microsoft' : 'x') }), 'wsl', 'WSL 1');
  assert.equal(detect({ platform: 'darwin', env: { FLEET_PLATFORM: 'linux' }, read: none }), 'linux', 'override for tests');
});

test('opens the browser with open, xdg-open, or wslview then explorer.exe', () => {
  const url = 'http://localhost:7788';
  assert.deepEqual(openers(url, 'mac'), [['open', [url]]]);
  assert.deepEqual(openers(url, 'linux'), [['xdg-open', [url]]]);
  assert.deepEqual(openers(url, 'wsl').map(([c]) => c), ['wslview', 'explorer.exe', 'cmd.exe']);
  assert.deepEqual(openers(url, 'wsl')[2], ['cmd.exe', ['/c', 'start', url]]);
});

test('Open in terminal: each Linux terminal gets the tmux command its own way; Windows Terminal first on WSL', () => {
  const argv = ['/usr/bin/tmux', 'attach', '-t', '=fleet-app-lead'];
  assert.deepEqual(terminalCommands(argv, { os: 'mac' }), [], 'AppleScript on macOS');
  const linux = terminalCommands(argv, { os: 'linux' });
  assert.deepEqual(
    linux.map(([c, a]) => [c, a.slice(0, a.length - argv.length)]),
    [['x-terminal-emulator', ['-e']], ['gnome-terminal', ['--']], ['konsole', ['-e']], ['xfce4-terminal', ['-x']], ['kitty', []], ['alacritty', ['-e']], ['wezterm', ['start', '--']], ['xterm', ['-e']]],
  );
  for (const [, a] of linux) assert.deepEqual(a.slice(-argv.length), argv);
  const wsl = terminalCommands(argv, { os: 'wsl', env: { WSL_DISTRO_NAME: 'Ubuntu-24.04' } });
  assert.deepEqual(wsl[0], ['wt.exe', ['-w', '0', 'new-tab', 'wsl.exe', '-d', 'Ubuntu-24.04', '--exec', ...argv]]);
  assert.deepEqual(terminalCommands(argv, { os: 'wsl', env: {} })[0][1].slice(0, 5), ['-w', '0', 'new-tab', 'wsl.exe', '--exec'], 'default distro');
  assert.deepEqual(wsl.slice(1), linux, 'then the Linux terminals');
});

test('picks the first installed terminal; fails clearly with none, no display, or a terminal that exits with an error', async () => {
  const argv = ['tmux', 'attach', '-t', '=s'];
  const display = { DISPLAY: ':0' };
  await withPath(async () => {
    await assert.rejects(openTerminal(argv, { os: 'linux', env: display }), /No terminal app found/);
    fake('xterm', 'exec /bin/sleep 2');
    fake('konsole', 'exit 1');
    assert.equal(firstFound(terminalCommands(argv, { os: 'linux' }))[0], 'konsole');
    await assert.rejects(openTerminal(argv, { os: 'linux', env: {} }), /No graphical display/);
    await assert.rejects(openTerminal(argv, { os: 'linux', env: display, waitMs: 3000 }), /konsole exited with code 1/);
    fs.rmSync(path.join(bin, 'konsole'));
    assert.equal(await openTerminal(argv, { os: 'linux', env: display, waitMs: 200 }), 'xterm', 'still running: opened');
    fake('wt.exe');
    assert.equal(await openTerminal(argv, { os: 'wsl', env: {}, waitMs: 3000 }), 'Windows Terminal', 'exits 0 at once: opened, no display needed');
    fs.rmSync(path.join(bin, 'wt.exe'));
  });
});

test('banners: notify-send on Linux when installed, none on WSL', async () => {
  await withPath(() => {
    assert.equal(notifySend('linux'), null, 'not installed: skipped');
    fake('notify-send');
    assert.equal(notifySend('linux'), path.join(bin, 'notify-send'));
    assert.equal(notifySend('wsl'), null);
    assert.equal(notifySend('mac'), null, 'macOS keeps terminal-notifier / osascript');
  });
});

test('native Windows: --version and --help work, everything else points to WSL', () => {
  const cli = new URL('../bin/fleet.js', import.meta.url).pathname;
  const env = { ...process.env, FLEET_PLATFORM: 'windows' };
  assert.match(execFileSync(process.execPath, [cli, '--version'], { env, encoding: 'utf8' }), /^\d+\.\d+\.\d+/);
  assert.match(execFileSync(process.execPath, [cli, '--help'], { env, encoding: 'utf8' }), /Usage: fleet/);
  for (const args of [[], ['--list'], ['--autostart']]) {
    const r = spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /needs WSL[\s\S]*wsl --install[\s\S]*tmux[\s\S]*Claude Code[\s\S]*docs\.html#install-wsl/);
  }
});
