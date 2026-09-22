#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { start } from '../src/server.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const port = Number(arg('--port', process.env.FLEET_PORT ?? 7788));
const server = start({ port });
server.on('listening', () => {
  const url = `http://localhost:${port}`;
  console.log(`Fleet running at ${url}`);
  if (!process.argv.includes('--no-open')) execFile('open', [url]);
});
server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${port} is in use. Try --port <n>.` : e.message);
  process.exit(1);
});
