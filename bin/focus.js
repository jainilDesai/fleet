#!/usr/bin/env node
// Brings one session's terminal window and tab forward. Clickable banners run this.
import { focus } from '../src/terminal.js';

const pid = Number(process.argv[2]);
if (pid > 0) focus(pid).catch(() => {}); // the session may have ended since the banner
