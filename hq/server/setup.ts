// The setup checks: what this machine has, and how to fix what's missing.

import { existsSync } from "node:fs";
import { cpus, platform, totalmem } from "node:os";
import type { SetupCheck, SetupFix, SetupState } from "../src/data/types";
import { has, run } from "./lib/exec";
import type { RepoInfo } from "./repo";
import { OS, firstFound, terminalCommands, terminalName } from "../../src/platform.js";

const os = platform();

type Check = Omit<SetupCheck, "fix"> & { fix: SetupFix | null };

const fix = (command: string, runnable: boolean, docs: string | null): SetupFix => ({ command, runnable, docs });

async function checkTmux(brew: boolean): Promise<Check> {
  const base = { id: "tmux" as const, label: "tmux (keeps agents running if Fleet closes)", neededFor: "all" as const };
  const v = await run("tmux", ["-V"], { timeoutMs: 5000 });
  if (v.ok) return { ...base, status: "ok", detail: v.stdout.trim(), fix: null };
  return {
    ...base,
    status: "missing",
    detail: "Not installed.",
    fix: os === "darwin" ? fix("brew install tmux", brew, "https://github.com/tmux/tmux/wiki/Installing") : fix("sudo apt install tmux", false, "https://github.com/tmux/tmux/wiki/Installing"),
  };
}

async function checkClaude(): Promise<Check> {
  const base = { id: "claude" as const, label: "Claude Code", neededFor: "all" as const };
  const v = await run("claude", ["--version"], { timeoutMs: 8000 });
  if (v.ok) return { ...base, status: "ok", detail: v.stdout.trim(), fix: null };
  return {
    ...base,
    status: "missing",
    detail: "Not installed, or not on your PATH.",
    fix: fix("curl -fsSL https://claude.ai/install.sh | bash", false, "https://docs.claude.com/en/docs/claude-code/setup"),
  };
}

/**
 * Signed in to Claude Code? `claude auth status --json` answers from Claude Code's own store (Keychain on
 * macOS, or an API key). Only `loggedIn` is read; nothing else from it is shown or kept.
 */
async function checkClaudeLogin(): Promise<Check> {
  const base = { id: "claude-login" as const, label: "Claude Code sign-in", neededFor: "all" as const };
  const r = await run("claude", ["auth", "status", "--json"], { timeoutMs: 8000 });
  let loggedIn: unknown;
  try {
    loggedIn = JSON.parse(r.stdout).loggedIn;
  } catch {}
  // An older Claude Code without `auth status` isn't flagged; the agent's screen still shows a login prompt.
  if (loggedIn !== false) return { ...base, status: "ok", detail: loggedIn ? "Signed in" : "Couldn't tell (older Claude Code)", fix: null };
  return { ...base, status: "missing", detail: "Not signed in. Run `claude` once in a terminal and log in.", fix: fix("claude", false, "https://docs.claude.com/en/docs/claude-code/setup") };
}

/** iTerm is used for "Open in terminal" when it's installed; Terminal.app otherwise. */
export const hasIterm = () => existsSync("/Applications/iTerm.app");

function checkTerminal(): Check {
  const base = { id: "terminal" as const, label: "Terminal for Open in terminal", neededFor: "local" as const, fix: null };
  if (OS === "mac") return { ...base, status: "ok", detail: hasIterm() ? "iTerm" : "Terminal.app (iTerm optional)" };
  const found = firstFound(terminalCommands([]));
  if (found) return { ...base, status: "ok", detail: terminalName(found[0]) };
  return { ...base, status: "warning", detail: "None found. Open in terminal shows the tmux command to run yourself.", fix: OS === "wsl" ? fix("winget install Microsoft.WindowsTerminal", false, "https://aka.ms/terminal") : fix("sudo apt install xterm", false, null) };
}

async function checkGh(brew: boolean): Promise<Check> {
  const base = { id: "gh" as const, label: "GitHub CLI (reads PRs and reviews)", neededFor: "github" as const };
  if (!(await has("gh")))
    return {
      ...base,
      status: "missing",
      detail: "Not installed.",
      fix: fix(
        os === "darwin" ? "brew install gh" : os === "win32" ? "winget install --id GitHub.cli" : "sudo apt install gh",
        os === "darwin" ? brew : os === "win32",
        // Linux: the page covers apt, dnf, pacman and the rest.
        os === "darwin" || os === "win32" ? "https://cli.github.com" : "https://github.com/cli/cli/blob/trunk/docs/install_linux.md",
      ),
    };
  const r = await run("gh", ["auth", "status"], { timeoutMs: 10_000 });
  const out = r.stdout + r.stderr;
  if (r.ok) return { ...base, status: "ok", detail: `Signed in as ${out.match(/account (\S+)/)?.[1] ?? "you"}`, fix: null };
  return { ...base, status: "missing", detail: "Not signed in.", fix: fix("gh auth login", true, "https://cli.github.com/manual/gh_auth_login") };
}

function checkRemote(repo: RepoInfo): Check {
  const base = { id: "gh-remote" as const, label: "GitHub remote", neededFor: "github" as const };
  if (repo.github) return { ...base, status: "ok", detail: repo.github, fix: null };
  return {
    ...base,
    status: "warning",
    detail: repo.originUrl ? `origin is ${repo.originUrl} (not GitHub)` : "No origin remote. Agents can't push or open PRs.",
    fix: fix("gh repo create --source . --private --push", false, "https://cli.github.com/manual/gh_repo_create"),
  };
}

export async function runSetupChecks(repo: RepoInfo): Promise<SetupState> {
  const brew = os === "darwin" && (await has("brew"));
  const [tmux, claude, gh] = await Promise.all([checkTmux(brew), checkClaude(), checkGh(brew)]);
  const checks: SetupCheck[] = [tmux, claude];
  if (claude.status === "ok") checks.push(await checkClaudeLogin());
  checks.push(gh, checkRemote(repo), checkTerminal());
  const ok = (c: SetupCheck) => c.status === "ok";
  return {
    machine: { cpus: cpus().length, memoryGb: Math.round(totalmem() / 1024 ** 3), persistentAgents: true },
    checks,
    sandboxReady: false,
    localReady: ok(tmux) && ok(claude),
    checkedAt: new Date().toISOString(),
  };
}
