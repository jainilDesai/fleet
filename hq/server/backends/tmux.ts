// Each agent runs in a tmux session, so it keeps running when Fleet or the browser closes.
// You watch or answer it by attaching iTerm to the session (Fleet's "Open in iTerm").

import { run, shq } from "../lib/exec";
import * as tmux from "./tmuxCli";
import type { LaunchSpec, SessionBackend } from "./types";

/** Quotes for a POSIX shell only when needed, so simple commands stay readable. */
const q = (s: string) => (/^[A-Za-z0-9_\-.,:/=@%+]+$/.test(s) ? s : shq(s));

/**
 * Shell code that exports each KEY=value line of an env file literally, like `sbx --env-file`
 * (no $-expansion, spaces kept; comments and blank lines skipped). HQ itself never reads the file.
 */
export const loadEnvFile = (quotedPath: string) =>
  // CRLF files: drop the \r. Lines whose key isn't a valid name are skipped (export would stop the shell).
  // Scratch names are unlikely to clash with app variables and are unset afterwards; the CR is
  // computed per line, so nothing in the file can change it.
  `while IFS= read -r __jsmhq_l || [ -n "$__jsmhq_l" ]; do __jsmhq_l=\${__jsmhq_l%"$(printf '\\r')"}; __jsmhq_k=\${__jsmhq_l%%=*}; ` +
  `case "$__jsmhq_l" in *=*) case "$__jsmhq_k" in ""|[!A-Za-z_]*|*[!A-Za-z0-9_]*) ;; *) export "$__jsmhq_l";; esac;; esac; done < ${quotedPath}; ` +
  `unset __jsmhq_l __jsmhq_k`;

/** The shell line tmux runs. Local mode loads the env file into that shell. */
export function shellCommand(spec: LaunchSpec): string {
  const load = spec.envFile ? `${loadEnvFile(shq(spec.envFile))} && ` : "";
  return load + [spec.file, ...spec.args].map(q).join(" ");
}

export const tmuxBackend: SessionBackend = {
  kind: "tmux",
  persistent: true,

  exists: (name) => tmux.hasSession(name),

  async create(name, cwd, spec) {
    // The session's shell gets Fleet's PATH (fixed up from your login shell at startup), so it finds claude.
    await tmux.newSession(name, cwd, shellCommand(spec), { PATH: process.env.PATH ?? "" });
  },

  kill: (name) => tmux.killSession(name),

  async type(name, text) {
    if (!(await tmux.hasSession(name))) return false;
    return (await run("tmux", ["send-keys", "-t", `=${name}:`, "-l", text], { timeoutMs: 5000 })).ok;
  },

  async enter(name) {
    return (await run("tmux", ["send-keys", "-t", `=${name}:`, "Enter"], { timeoutMs: 5000 })).ok;
  },

  exitInfo: (name) => tmux.paneInfo(name),

  screenText: (name, lines) => tmux.tailText(name, lines),

  promptDraft: (name) => tmux.promptDraft(name),

  shutdown() {
    // Nothing to do: tmux keeps the agents running.
  },
};
