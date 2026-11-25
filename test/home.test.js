// The home page: project discovery, cost by project, moving login items off its port, and the
// home server and a project copy running side by side (fake launchctl; temp home folder).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { tempHome } from './fixtures.js';

const home = tempHome();
process.env.HOME = home;
process.env.FLEET_PLATFORM = 'mac'; // launchd, with the fake launchctl below, on any OS
process.env.FLEET_HOME_PORT = '7861';
const PORT = 7861;
const agents = path.join(home, 'Library', 'LaunchAgents');
const calls = path.join(home, 'launchctl.log');
const fake = path.join(home, 'launchctl');
fs.writeFileSync(fake, `#!/bin/sh\necho "$@" >> "${calls}"\n[ "$1" = print ] && exit 113\nexit 0\n`, { mode: 0o755 });
process.env.FLEET_LAUNCHCTL = fake;
process.env.FLEET_LAUNCH_AGENTS = agents;
const launchctlCalls = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : []);

const { projects, costs, ensureHome, createProject, state } = await import('../src/home.js');
const { plist, items, readItem, HOME_LABEL, labelFor } = await import('../src/autostart.js');

const projectsDir = path.join(home, '.fleet', 'projects');
const project = (slug, files) => {
  fs.mkdirSync(path.join(projectsDir, slug), { recursive: true });
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(projectsDir, slug, f), text);
};
const gitRepo = (name) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'first'], { cwd: dir });
  return dir;
};

test('finds every project with a repo-root (or an older config.json), and marks the ones whose repo is gone', () => {
  const repo = gitRepo('fleet-app');
  project('app', { 'repo-root': `${repo}\n` });
  project('old', { 'config.json': JSON.stringify({ project: { name: 'Old one', path: repo } }) });
  project('gone', { 'repo-root': '/nowhere/gone\n' });
  project('empty', {}); // not a project: no repo recorded
  project('app-reviews', { 'repo-root': `${repo}\n`, 'config.json': JSON.stringify({ project: { name: 'app · Reviews', parent: 'app' } }) });
  const list = projects().sort((a, b) => a.slug.localeCompare(b.slug));
  assert.deepEqual(
    list.map((p) => [p.slug, p.name, p.repo, p.missing, p.parent]),
    [
      ['app', path.basename(repo), repo, false, null],
      ['app-reviews', 'app · Reviews', repo, false, 'app'],
      ['gone', 'gone', '/nowhere/gone', true, null],
      ['old', 'Old one', repo, false, null],
    ],
  );
  fs.rmSync(projectsDir, { recursive: true });
});

test("a team shows on the home page only while it runs; its project always does", async () => {
  const repo = gitRepo('fleet-app');
  project('app', { 'repo-root': `${repo}\n` });
  project('app-reviews', { 'repo-root': `${repo}\n`, 'config.json': JSON.stringify({ project: { name: 'app · Reviews', parent: 'app' } }) });
  assert.deepEqual((await state()).projects.map((p) => p.slug), ['app'], 'a stopped team is in its project\'s History instead');
  fs.rmSync(projectsDir, { recursive: true });
});

test('cost: sessions whose cwd is in a project folder, for today, 7 days and all time', () => {
  const now = new Date('2026-11-15T15:00:00').getTime();
  const day = 86_400_000;
  const list = [
    { slug: 'app', dir: '/h/.fleet/projects/app' },
    { slug: 'site', dir: '/h/.fleet/projects/site' },
  ];
  const records = [
    { cwd: '/h/.fleet/projects/app/cto', cost: 2, endedAt: now - 3600_000 }, // today
    { cwd: '/h/.fleet/projects/app/qa', cost: 1, endedAt: new Date('2026-11-14T23:00:00').getTime() }, // yesterday: 7 days, not today
    { cwd: '/h/.fleet/projects/app/dev', cost: 4, endedAt: now - 10 * day }, // all time only
    { cwd: '/h/.fleet/projects/site/cto', cost: 0.5, startedAt: now - 1000 }, // no endedAt: its start
    { cwd: '/h/.fleet/projects/app-2/cto', cost: 100, endedAt: now }, // a different project folder
    { cwd: '/code/app', cost: 100, endedAt: now }, // not an agent's session
    { cost: 100, endedAt: now }, // no cwd
  ];
  const { by, total } = costs(list, records, now);
  assert.deepEqual(by.app, { today: 2, week: 3, all: 7 });
  assert.deepEqual(by.site, { today: 0.5, week: 0.5, all: 0.5 });
  assert.deepEqual(total, { today: 2.5, week: 3.5, all: 7.5 });
});

test('upgrading: a project login item pinned to the home port moves to the next free port and restarts; the home gets its own', async () => {
  fs.mkdirSync(agents, { recursive: true });
  const sample = { node: process.execPath, script: '/lib/fleet/bin/fleet.js', pathEnv: '/usr/bin:/bin', log: '/tmp/fleet.log' };
  // What 0.5 wrote: the first project on 7788 (here the home's port), a second one on the next.
  fs.writeFileSync(path.join(agents, `${labelFor('app')}.plist`), plist({ ...sample, label: labelFor('app'), port: PORT, repo: '/code/app' }));
  fs.writeFileSync(path.join(agents, `${labelFor('site')}.plist`), plist({ ...sample, label: labelFor('site'), port: PORT + 1, repo: '/code/site' }));
  fs.rmSync(calls, { force: true });

  const moved = await ensureHome();
  assert.deepEqual(moved, [{ repo: '/code/app', from: PORT, to: PORT + 2 }]);
  const byLabel = Object.fromEntries(items().map((i) => [i.label, i]));
  assert.equal(byLabel[labelFor('app')].port, PORT + 2, 'rewritten with its new port');
  assert.equal(byLabel[labelFor('app')].repo, '/code/app');
  assert.equal(byLabel[labelFor('site')].port, PORT + 1, 'other projects untouched');
  const homeItem = readItem(path.join(agents, `${HOME_LABEL}.plist`));
  assert.equal(HOME_LABEL, 'com.jainildesai.fleet.home');
  assert.deepEqual([homeItem.port, homeItem.repo], [PORT, null]);
  assert.match(fs.readFileSync(homeItem.file, 'utf8'), /<string>home<\/string>\s*<string>--serve<\/string>/);
  // Restarted cleanly (launchd stops the old copy, tmux keeps its agents), then the home starts.
  const log = launchctlCalls();
  assert.match(log[0], /^bootout gui\/\d+ .*fleet\.app\.plist$/);
  assert.match(log[1], /^bootstrap gui\/\d+ .*fleet\.app\.plist$/);
  assert.match(log.at(-1), /^bootstrap gui\/\d+ .*fleet\.home\.plist$/);

  fs.rmSync(calls, { force: true });
  assert.deepEqual(await ensureHome(), [], 'nothing left to move');
  fs.rmSync(agents, { recursive: true });
});

const bin = new URL('../bin/fleet.js', import.meta.url).pathname;
const get = async (port, p, init) => fetch(`http://127.0.0.1:${port}${p}`, init);
const waitFor = async (fn, ms = 30_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 200))) if (await fn().catch(() => false)) return true;
  return false;
};

test('fleet outside a repo starts the home page; a project copy takes the next port and reports to it', async () => {
  // Children get their own empty LaunchAgents folder: no login items, so the home runs as a plain background process.
  const env = { ...process.env, FLEET_LAUNCH_AGENTS: path.join(home, 'no-agents'), FLEET_PORT: '' };
  delete env.FLEET_PORT;
  delete env.FLEET_PLATFORM; // the real platform: these are real processes
  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-norepo-'));
  const repo = gitRepo('fleet-toy');
  let child;
  try {
    const out = execFileSync(process.execPath, [bin, '--no-open'], { cwd: notRepo, env, encoding: 'utf8' });
    assert.match(out, new RegExp(`Fleet home at http://localhost:${PORT}`));

    // The page, the manifest and its icons.
    const page = await (await get(PORT, '/')).text();
    assert.match(page, /<link rel="manifest" href="\/manifest\.webmanifest"/);
    assert.match(page, /apple-touch-icon/);
    const res = await get(PORT, '/manifest.webmanifest');
    assert.equal(res.headers.get('content-type'), 'application/manifest+json');
    const manifest = await res.json();
    assert.deepEqual([manifest.name, manifest.short_name, manifest.start_url, manifest.scope, manifest.display], ['Fleet', 'Fleet', '/', '/', 'standalone']);
    assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'));
    for (const { src, sizes } of [...manifest.icons, { src: '/apple-touch-icon.png', sizes: '180x180' }]) {
      const r = await get(PORT, src);
      assert.equal(r.headers.get('content-type'), 'image/png', src);
      const png = Buffer.from(await r.arrayBuffer());
      assert.equal(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, sizes, src); // IHDR width x height
    }
    const badHost = await new Promise((resolve) => http.get({ host: '127.0.0.1', port: PORT, path: '/api/home', headers: { host: 'evil.example' } }, (r) => (r.resume(), resolve(r.statusCode))));
    assert.equal(badHost, 403, 'Host check');
    assert.equal((await get(PORT, '/api/home/stop', { method: 'POST', body: '{"slug":"x"}' })).status, 403, 'POSTs need the page token');

    // A project copy: the port after the home's, a summary for the home, and a Home link to it.
    child = spawn(process.execPath, [bin, '--repo', repo, '--no-open'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));
    assert.ok(await waitFor(async () => /Fleet running at/.test(log) && (await get(PORT + 1, '/api/summary')).ok), log);
    assert.match(log, new RegExp(`Fleet running at http://localhost:${PORT + 1}`));
    const summary = await (await get(PORT + 1, '/api/summary')).json();
    assert.deepEqual(Object.keys(summary).sort(), ['agents', 'agentsRunning', 'name', 'needsYou', 'openPrs', 'port', 'repo', 'slug']);
    assert.deepEqual([summary.repo, summary.port, summary.agentsRunning, summary.needsYou, summary.openPrs], [fs.realpathSync(repo), PORT + 1, 0, 0, 0]);
    assert.match(await (await get(PORT + 1, '/')).text(), new RegExp(`window.__FLEET_HOME__ = "http://localhost:${PORT}"`));

    assert.ok(await waitFor(async () => (await (await get(PORT, '/api/home')).json()).projects.some((p) => p.running && p.summary)));
    const state = await (await get(PORT, '/api/home')).json();
    const me = state.projects.find((p) => p.slug === summary.slug);
    assert.deepEqual([me.url, me.missing, me.summary.slug], [`http://localhost:${PORT + 1}`, false, summary.slug]);

    // Agents whose hooks still name the home's port reach their project, by their token only.
    const token = fs.readFileSync(path.join(projectsDir, summary.slug, 'agent-token'), 'utf8').trim();
    const hook = (auth) => get(PORT, '/hook/nobody/Stop', { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: '{}' });
    assert.equal((await hook('Bearer wrong')).status, 401);
    // Same string length as the real header but more bytes once re-encoded: raw 0xE9 bytes arrive as
    // 'é', one character each, two bytes in UTF-8. A 401, and the home keeps answering.
    const odd = await new Promise((resolve) => {
      const sock = net.connect(PORT, '127.0.0.1', () =>
        sock.end(Buffer.concat([Buffer.from(`POST /hook/nobody/Stop HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nContent-Length: 2\r\nAuthorization: Bearer `), Buffer.alloc(token.length, 0xe9), Buffer.from('\r\nConnection: close\r\n\r\n{}')])),
      );
      let data = '';
      sock.on('data', (d) => (data += d));
      sock.on('close', () => resolve(Number(data.match(/^HTTP\/1\.1 (\d+)/)?.[1])));
      sock.on('error', () => resolve('error'));
    });
    assert.equal(odd, 401);
    const badJson = await new Promise((resolve) => {
      const r = http.request({ host: '127.0.0.1', port: PORT, path: '/api/home/start', method: 'POST', headers: { 'x-fleet-token': page.match(/__FLEET_PAGE_TOKEN__ = "([0-9a-f]+)"/)[1] } }, (x) => (x.resume(), resolve(x.statusCode)));
      r.end('{not json');
    });
    assert.equal(badJson, 400);
    assert.equal((await get(PORT, '/api/home')).status, 200, 'still answering');
    assert.equal((await hook(`Bearer ${token}`)).status, 404, "forwarded: the project doesn't know agent 'nobody'");
  } finally {
    child?.kill();
    const pid = Number(fs.readFileSync(path.join(home, '.fleet', 'home.pid'), 'utf8'));
    if (pid) process.kill(pid);
  }
});

test('New project: checks the folder, sets up git only when asked, and starts Fleet on the repo root', async () => {
  // A commit needs a name and email; CI machines may have none.
  Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' });
  const started = [];
  const opts = { waitMs: 0, start: (root) => started.push(root) };
  assert.match((await createProject({ folder: 'relative/path' }, opts)).error, /full path/);
  assert.match((await createProject({ folder: path.join(home, 'nope') }, opts)).error, /no folder/);

  const plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plain-')));
  fs.writeFileSync(path.join(plain, 'a.txt'), 'hi');
  const r = await createProject({ folder: plain }, opts);
  assert.equal(r.needsInit, 'repo');
  assert.ok(!fs.existsSync(path.join(plain, '.git')), 'nothing changes without your OK');
  assert.equal(started.length, 0);

  await createProject({ folder: plain, init: true }, opts);
  assert.equal(execFileSync('git', ['log', '--format=%s'], { cwd: plain }).toString().trim(), 'Initial commit');
  assert.equal(execFileSync('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: plain }).toString().trim(), 'a.txt');
  assert.deepEqual(started, [plain]);

  const repo = fs.realpathSync(gitRepo('sub'));
  fs.mkdirSync(path.join(repo, 'src'));
  const sub = await createProject({ folder: path.join(repo, 'src') }, opts);
  assert.deepEqual(started.at(-1), repo, 'a subfolder starts Fleet on the repo root');
  assert.match(sub.error, /didn't start/, 'no copy registered within the wait');
});
