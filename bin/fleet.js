#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { enable, disable, staleNode, isSetUp, startBackground, stopAll } from '../src/autostart.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const has = (name) => process.argv.includes(name);
const port = Number(arg('--port', process.env.FLEET_PORT ?? 7788));

if (has('--help') || has('-h')) {
  console.log(`Usage: fleet [options]

  --port <n>        Serve on another port (default 7788, or FLEET_PORT)
  --no-open         Don't open a browser tab
  --autostart       Start Fleet at login, in the background, and start it now
  --no-autostart    Stop starting Fleet at login, and stop the background copy
  --stop            Stop Fleet now; with auto-start it comes back at the next login
  --start           Start the background copy now (needs --autostart)
  -h, --help        Show this help`);
  process.exit(0);
}

if (has('--autostart')) {
  try {
    const r = enable(port);
    console.log(`Fleet now starts at login on http://localhost:${r.port}, and is starting now.
Log: ${r.log}
Turn it off with: fleet --no-autostart`);
  } catch (e) {
    console.error(`Could not set up auto-start: ${e.stderr?.toString().trim() || e.message}`);
    process.exit(1);
  }
  process.exit(0);
}

if (has('--no-autostart')) {
  console.log(disable() ? 'Fleet no longer starts at login, and the background copy is stopped.' : 'Auto-start was not set up.');
  process.exit(0);
}

if (has('--stop')) {
  const { background, manual } = stopAll();
  if (!background && !manual) console.log('Fleet is not running.');
  else console.log(`Fleet stopped.${background ? ' Auto-start is still on, so it starts again at the next login (or run "fleet --start").' : ''}`);
  process.exit(0);
}

if (has('--start')) {
  if (!isSetUp()) {
    console.log('Auto-start is not set up. Run "fleet" to start Fleet here, or "fleet --autostart" to run it in the background from login.');
    process.exit(1);
  }
  try {
    const state = startBackground();
    console.log(state === 'running' ? 'Fleet is already running in the background.' : `Fleet is starting in the background on its usual port.`);
  } catch (e) {
    console.error(`Could not start Fleet: ${e.stderr?.toString().trim() || e.message}`);
    process.exit(1);
  }
  process.exit(0);
}

const stale = staleNode();
if (stale) console.warn(`Auto-start points at ${stale}, which no longer exists (Node was updated or removed).
Run "fleet --autostart" again to fix it.`);

const { start } = await import('../src/server.js');
const server = start({ port });
server.on('listening', () => {
  const url = `http://localhost:${port}`;
  console.log(`Fleet running at ${url}`);
  if (!has('--no-open')) execFile('open', [url]);
});
server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${port} is in use. Try --port <n>.` : e.message);
  process.exit(1);
});
