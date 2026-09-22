#!/usr/bin/env node
// Claude Code statusline command. Claude Code pipes session JSON to stdin after each turn;
// it is the only place plan limits (the numbers /usage shows) are exposed. We save them for
// Fleet, then print a compact status line - or, when given one, run the user's own statusline
// command with the same input and print its output instead:
//   node statusline.js ~/.claude/scripts/my-bar.sh
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const DIR = path.join(os.homedir(), '.fleet');

let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  let d = {};
  try {
    d = JSON.parse(input);
  } catch {}

  if (d.rate_limits) {
    try {
      fs.mkdirSync(DIR, { recursive: true });
      const tmp = path.join(DIR, `limits.${process.pid}.json`);
      fs.writeFileSync(tmp, JSON.stringify({ at: Date.now(), sessionId: d.session_id, rateLimits: d.rate_limits }));
      fs.renameSync(tmp, path.join(DIR, 'limits.json')); // atomic: Fleet never reads a half-written file
    } catch {}
  }

  const wrapped = process.argv.slice(2).join(' ');
  if (wrapped) {
    const r = spawnSync('/bin/sh', ['-c', wrapped], { input, encoding: 'utf8', timeout: 5000 });
    return process.stdout.write(r.stdout ?? '');
  }

  const parts = [];
  if (d.model?.display_name) parts.push(d.model.display_name);
  const ctx = d.context_window?.used_percentage;
  if (ctx != null) parts.push(`ctx ${Math.round(ctx)}%`);
  const five = d.rate_limits?.five_hour?.used_percentage;
  const week = d.rate_limits?.seven_day?.used_percentage;
  if (five != null) parts.push(`5h ${Math.round(five)}%`);
  if (week != null) parts.push(`7d ${Math.round(week)}%`);
  process.stdout.write(parts.join(' · '));
});
