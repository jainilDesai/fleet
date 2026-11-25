// One GitHub poll per repo, shared by every Fleet process on the machine (hq/server/prCache.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { sharedFetchPrs, LEASE_MS, RateLimited } = await import('../dist/hq.mjs');

/** Runs async fn with HOME at a fresh temp folder, kept until fn settles; passes the repo's cache file. */
async function inTempHome(fn) {
  const home = process.env.HOME;
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-prcache-'));
  try {
    return await fn(path.join(process.env.HOME, '.fleet', 'github', 'acme__app.json'));
  } finally {
    process.env.HOME = home;
  }
}

const RESULT = { open: [], merged: [], closed: [7], rate: { cost: 1, remaining: 4000, resetAt: '' } };

/** A stand-in for fetchPrs that counts its calls. */
function counter(delayMs = 0) {
  const f = async () => {
    f.calls++;
    await new Promise((r) => setTimeout(r, delayMs));
    return RESULT;
  };
  f.calls = 0;
  return f;
}

test('two syncs on one repo: one fetch per interval, the other reads it', () =>
  inTempHome(async () => {
    const fetch = counter(50);
    const [a, b] = await Promise.all([sharedFetchPrs('acme/app', 20_000, fetch), sharedFetchPrs('acme/app', 20_000, fetch)]);
    assert.deepEqual(a, RESULT);
    assert.equal(b, null, 'nothing cached yet while the other polls');
    assert.equal(fetch.calls, 1);
    assert.deepEqual(await sharedFetchPrs('Acme/App', 20_000, fetch), RESULT, 'repo names match case-insensitively');
    assert.equal(fetch.calls, 1, 'fresh enough: no second fetch');
    await sharedFetchPrs('acme/app', 0, fetch);
    assert.equal(fetch.calls, 2, 'older than this caller allows: fetched again');
  }));

test('a lock left by a dead process is taken over once its lease expires', () =>
  inTempHome(async (file) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.lock`, '');
    const fetch = counter();
    assert.equal(await sharedFetchPrs('acme/app', 20_000, fetch), null, 'a live lock is respected');
    assert.equal(fetch.calls, 0);
    const old = (Date.now() - LEASE_MS - 1000) / 1000;
    fs.utimesSync(`${file}.lock`, old, old);
    assert.deepEqual(await sharedFetchPrs('acme/app', 20_000, fetch), RESULT);
    assert.equal(fetch.calls, 1);
    assert.equal(fs.existsSync(`${file}.lock`), false, 'released after the fetch');
  }));

test('a corrupt cache file is ignored and replaced', () =>
  inTempHome(async (file) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"at": 1, "res');
    const fetch = counter();
    assert.deepEqual(await sharedFetchPrs('acme/app', 20_000, fetch), RESULT);
    assert.equal(fetch.calls, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).result, RESULT);
  }));

test('a rate limit hit by one process pauses the others until it resets, without fetching', () =>
  inTempHome(async (file) => {
    const resetAt = new Date(Date.now() + 60_000);
    const limited = async () => {
      throw new RateLimited(resetAt);
    };
    await assert.rejects(sharedFetchPrs('acme/app', 20_000, limited), RateLimited);
    const fetch = counter();
    await assert.rejects(sharedFetchPrs('acme/app', 20_000, fetch), (e) => e instanceof RateLimited && e.resetAt.getTime() === resetAt.getTime());
    assert.equal(fetch.calls, 0);
    // Once the reset time passes, polling resumes.
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...c, pausedUntil: Date.now() - 1 }));
    assert.deepEqual(await sharedFetchPrs('acme/app', 20_000, fetch), RESULT);
    assert.equal(fetch.calls, 1);
  }));
