import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempHome } from './fixtures.js';

process.env.HOME = tempHome();
const { running, register, unregister, freePort, claimWatcher, releaseWatcher } = await import('../src/registry.js');
const deadPid = spawnSync('true').pid; // exited already
const dir = path.join(process.env.HOME, '.fleet', 'running');

test('lists running copies and drops the ones that died', () => {
  register({ slug: 'app', repo: '/code/app', port: 7788, pid: process.pid });
  register({ slug: 'old', repo: '/code/old', port: 7789, pid: deadPid });
  assert.deepEqual(running().map((e) => e.slug), ['app']);
  assert.deepEqual(fs.readdirSync(dir), [`${process.pid}.json`], 'dead entry removed');
  register({ slug: 'app', repo: '/code/app', port: 7790, pid: process.pid });
  assert.deepEqual(running().map((e) => e.port), [7790], 'one entry per copy');
  unregister();
  assert.deepEqual(running(), []);
});

test('picks the next free port when one is taken', async () => {
  const busy = net.createServer();
  await new Promise((r) => busy.listen(0, '127.0.0.1', r));
  const port = busy.address().port;
  try {
    assert.equal(await freePort(port), port + 1);
    assert.equal(await freePort(port, [port + 1]), port + 2, 'skips ports other login items use');
  } finally {
    busy.close();
  }
});

test('one copy watches; another takes over when it dies', () => {
  const lock = path.join(process.env.HOME, '.fleet', 'watcher.pid');
  fs.writeFileSync(lock, String(process.ppid)); // a live process holds it
  assert.equal(claimWatcher(), null);
  fs.writeFileSync(lock, String(deadPid));
  assert.equal(claimWatcher(), 'took');
  assert.equal(claimWatcher(), 'held');
  releaseWatcher();
  assert.ok(!fs.existsSync(lock));
});
