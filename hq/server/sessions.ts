// Agent sessions: Claude Code in a tmux session per agent, in its own git worktree.
// Fleet types messages into a session and reads its screen; you watch or answer it by
// attaching a terminal (iTerm, else Terminal.app) to the session ("Open in terminal").

import { existsSync } from "node:fs";
import { TRUST_NOTE, type WorkspaceInfo } from "../src/data/types";
import { launchArgs, writeAgentFiles } from "./adapters";
import type { Hub } from "./hub";
import { tmuxBackend } from "./backends/tmux";
import { run } from "./lib/exec";
import { openTarget } from "../../src/platform.js";
import { log } from "./lib/log";
import { sessionName } from "./paths";
import { runSetupChecks } from "./setup";
import { ensureWorkspace, removeWorktree, workspaceFor } from "./workspace";

// What Claude Code's screen shows.
const BUSY = /esc to interrupt/i; // the footer while a turn runs
const DIALOG = /Enter to select|↑\/↓ to navigate|Do you want to (proceed|make this edit|create)|Would you like to|^\s*[❯›]\s*1\.\s/im;
const PROMPT_READY = /⏵⏵|\? for shortcuts/; // the input prompt is up
// First start in a new worktree: Claude Code asks you to trust the folder. Fleet answers only when you press Trust folder.
const TRUST = /Yes, I trust this folder/;
// Not signed in: Claude Code's first-run screens (theme, then login method).
const LOGIN = /Select login method|Let's get started\.|Syntax theme:/;
const LOGIN_NOTE = "Asking: sign in to Claude Code. Open it in the terminal and log in (or run `claude` once and log in).";
const SCREEN_QUIET_MS = 4000; // only second-guess hooks after this much silence
const STALE_WORKING_MS = 15_000; // "working" with an idle screen this long = a missed Stop

export class Sessions {
  readonly backend = tmuxBackend;
  /** Called whenever an agent's Claude Code session goes away (stop, restart, crash). */
  onSessionDown: (agentId: string) => void = () => {};
  /** Called when Fleet finds a session that was already running (e.g. after a Fleet restart). */
  onSessionReattached: (agentId: string) => void = () => {};
  /** When the agent's last hook arrived (from the inbox). */
  lastHookAt: (agentId: string) => number = () => 0;
  private polling: NodeJS.Timeout | null = null;
  /** Consecutive polls that saw a "working" agent's screen sitting idle. */
  private idleScreens = new Map<string, number>();
  /** Agents whose prompt holds your unsent text (from the terminal): Fleet has said so once and is waiting. */
  private drafts = new Set<string>();

  constructor(private hub: Hub, private agentToken: string) {}

  name(agentId: string) {
    return sessionName(this.hub.slug, agentId);
  }

  // ------------------------------------------------------------ lifecycle

  async start(id: string) {
    const hub = this.hub;
    const agent = hub.cfg(id);
    const st = hub.status(id);
    if (!agent || !st || st.session.state === "running" || st.session.state === "starting") return;
    const fail = (detail: string) => {
      hub.setSession(id, { state: "failed", detail });
      hub.setStatus(id, { state: "idle", note: "Could not start" });
      hub.activity("session", id, `${agent.name} could not start: ${detail.split("\n")[0]}`);
    };
    const check = (cid: string) => hub.snap.setup.checks.find((c) => c.id === cid)?.status;
    if (check("tmux") !== "ok") return fail("tmux is not installed. Run: brew install tmux");
    if (check("claude") !== "ok") return fail("Claude Code isn't installed or isn't on your PATH.");

    const name = this.name(id);
    this.onSessionDown(id);
    try {
      hub.setSession(id, { state: "starting", detail: "Preparing worktree…", workspace: workspaceFor(agent, hub.slug) });
      const dir = await ensureWorkspace(agent, hub.slug, hub.repo);
      await writeAgentFiles(dir, agent, hub.snap.config, this.agentToken, { noGitHub: !hub.repo.github || check("gh") !== "ok" });
      if (!(await this.backend.exists(name))) {
        hub.setSession(id, { detail: "Starting Claude Code…" });
        await this.backend.create(name, dir, { file: "claude", args: launchArgs(agent), envFile: null }, { cols: 200, rows: 50 });
      }
      hub.setSession(id, { state: "running", detail: null, workspace: dir });
      hub.setStatus(id, { state: "idle", note: "Running" });
      hub.activity("session", id, `${agent.name} started`);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  }

  async stop(id: string) {
    const hub = this.hub;
    const agent = hub.cfg(id);
    if (!agent) return;
    this.onSessionDown(id);
    await this.backend.kill(this.name(id));
    hub.setSession(id, { state: "stopped", detail: null });
    hub.setStatus(id, { state: "idle", currentTaskId: null, note: "Stopped" });
    hub.activity("session", id, `${agent.name} stopped`);
  }

  /** What removing this agent would delete: the worktree's uncommitted and unpushed work. */
  async inspectWorkspace(id: string): Promise<WorkspaceInfo | null> {
    const agent = this.hub.cfg(id);
    if (!agent) return null;
    const dir = workspaceFor(agent, this.hub.slug);
    const exists = existsSync(dir);
    let changedFiles = 0;
    let unpushedCommits = 0;
    if (exists) {
      const status = await run("git", ["status", "--porcelain"], { cwd: dir });
      changedFiles = status.stdout.split("\n").filter(Boolean).length;
      // Commits on the worktree's branch that no remote-tracking ref has.
      const log = await run("git", ["log", "--oneline", "HEAD", "--not", "--remotes"], { cwd: dir });
      unpushedCommits = log.stdout.split("\n").filter(Boolean).length;
    }
    return { agentId: id, path: dir, managed: !agent.workspacePath, exists, changedFiles, unpushedCommits, sandboxName: null, sandboxExists: false };
  }

  /** Stops the agent and, if asked, removes its Fleet-made worktree. Your own folders are never deleted. */
  async removeResources(id: string, opts: { deleteFolder: boolean }): Promise<string[]> {
    const agent = this.hub.cfg(id);
    if (!agent) return [];
    this.onSessionDown(id);
    await this.backend.kill(this.name(id));
    if (opts.deleteFolder && !agent.workspacePath) {
      const dir = workspaceFor(agent, this.hub.slug);
      if (existsSync(dir) && (await removeWorktree(this.hub.repo, dir))) return ["folder"];
    }
    return [];
  }

  /**
   * Types a line into an agent's prompt and submits it. Not if you've typed something there yourself
   * (in the terminal) and not sent it: the message would land on top of yours. It stays queued instead.
   */
  async typeInto(agentId: string, text: string): Promise<boolean> {
    const draft = await this.backend.promptDraft(this.name(agentId));
    if (draft) {
      if (!this.drafts.has(agentId)) {
        this.drafts.add(agentId);
        const quote = draft.length > 50 ? `${draft.slice(0, 49)}…` : draft;
        this.hub.setStatus(agentId, { note: `Holding a message for you to see first: send or clear what you typed in its terminal ("${quote}")` });
        this.hub.activity("agent.needs-input", agentId, `Fleet is holding a message for ${this.hub.name(agentId)}: there's unsent text at its prompt in its terminal`);
      }
      return false;
    }
    this.drafts.delete(agentId);
    if (!(await this.backend.type(this.name(agentId), text))) return false;
    await new Promise((r) => setTimeout(r, 200));
    return this.backend.enter(this.name(agentId));
  }

  async pressEnter(agentId: string): Promise<boolean> {
    return this.backend.enter(this.name(agentId));
  }

  /**
   * Answers Claude Code's folder-trust prompt with "Yes, I trust this folder", only in a worktree Fleet made.
   * The highlighted default is "No, exit", so Enter is pressed only once the screen shows Yes selected.
   */
  async trustFolder(id: string): Promise<boolean> {
    const agent = this.hub.cfg(id);
    if (!agent || agent.workspacePath || this.hub.status(id)?.session.state !== "running") return false;
    const name = this.name(id);
    const screen = await this.backend.screenText(name, 12);
    if (!TRUST.test(screen)) return false;
    if (!trustSelected(screen)) {
      await this.backend.key(name, "Down");
      await new Promise((r) => setTimeout(r, 400));
    }
    if (!trustSelected(await this.backend.screenText(name, 12))) return false;
    const ok = await this.backend.enter(name);
    if (ok) this.hub.activity("session", id, `Trusted ${agent.name}'s new worktree`);
    return ok;
  }

  async openWorkspace(id: string) {
    const st = this.hub.status(id);
    const agent = this.hub.cfg(id);
    const dir = st?.session.workspace ?? (agent ? workspaceFor(agent, this.hub.slug) : null);
    if (dir) openTarget(dir);
  }

  // ------------------------------------------------------------ health

  /** Keeps session state honest: picks up sessions from before a restart, notices crashes. */
  startPolling() {
    const tick = async () => {
      if (this.hub.snap.setup.checks.find((c) => c.id === "tmux")?.status !== "ok") return;
      for (const agent of this.hub.snap.config.team) {
        const st = this.hub.status(agent.id);
        if (!st || st.session.state === "starting") continue;
        const name = this.name(agent.id);
        if (await this.backend.exists(name)) {
          const pane = await this.backend.exitInfo(name);
          if (pane?.dead) {
            const detail = (await this.backend.screenText(name, 6)) || `Exited with code ${pane.exitStatus}`;
            await this.backend.kill(name);
            this.onSessionDown(agent.id);
            this.hub.setSession(agent.id, { state: "failed", detail });
            this.hub.setStatus(agent.id, { state: "idle", note: "Session ended" });
            this.hub.activity("session", agent.id, `${agent.name}'s session ended`);
            continue;
          }
          if (st.session.state !== "running") {
            this.hub.setSession(agent.id, { state: "running", detail: null, workspace: workspaceFor(agent, this.hub.slug) });
            this.hub.setStatus(agent.id, { note: "Reattached" });
            this.onSessionReattached(agent.id);
          }
          await this.reconcileFromScreen(agent.id, name);
        } else if (st.session.state === "running") {
          this.onSessionDown(agent.id);
          this.hub.setSession(agent.id, { state: "stopped", detail: null });
          this.hub.setStatus(agent.id, { state: "idle", note: "Stopped" });
        }
      }
    };
    void tick();
    this.polling = setInterval(() => void tick().catch((e) => log.warn("poll:", e)), 3000);
  }

  /**
   * Hooks are the main signal, but one can be missed or arrive late. When hooks have been
   * quiet for a while, the screen says what the agent is really doing, and a wrong state
   * would otherwise hold back queued messages.
   */
  private async reconcileFromScreen(agentId: string, name: string) {
    const st = this.hub.status(agentId);
    if (!st || st.session.state !== "running") return;
    const quietMs = Date.now() - this.lastHookAt(agentId);
    if (quietMs < SCREEN_QUIET_MS) return;
    const screen = await this.backend.screenText(name, 10);
    if (!screen) return;
    const busy = BUSY.test(screen);
    const dialog = DIALOG.test(screen);
    const set = (state: "idle" | "working" | "needs-input", note: string) => this.hub.setStatus(agentId, { state, note });

    if (LOGIN.test(screen)) {
      if (st.note !== LOGIN_NOTE) {
        set("needs-input", LOGIN_NOTE);
        this.hub.activity("agent.needs-input", agentId, `${this.hub.name(agentId)} needs you: Claude Code isn't signed in. Log in in its terminal`);
      }
      return;
    }
    if (TRUST.test(screen)) {
      if (st.note !== TRUST_NOTE) {
        set("needs-input", TRUST_NOTE);
        this.hub.activity("agent.needs-input", agentId, `${this.hub.name(agentId)} needs you: trust its new worktree (Trust folder, or in its terminal)`);
      }
      return;
    }
    if (st.state === "needs-input") {
      if (dialog) return; // still waiting
      this.idleScreens.delete(agentId);
      if (busy) return set("working", "Continuing after your answer");
      // Idle only on a positive sign: Claude Code's input footer is back, so queued messages aren't typed into a dialog.
      if (PROMPT_READY.test(screen)) set("idle", "Waiting for you");
      return;
    }
    if (dialog) return set("needs-input", "Asking: answer it in the terminal");
    // A missed UserPromptSubmit: the agent is busy, so don't type into it.
    if (st.state === "idle" && busy) return set("working", "Working");
    if (st.state === "working" && !busy) {
      // Twice in a row, so a gap between two steps isn't mistaken for the end of the turn.
      const n = (this.idleScreens.get(agentId) ?? 0) + 1;
      this.idleScreens.set(agentId, n);
      if (n >= 2 && quietMs >= STALE_WORKING_MS) {
        this.idleScreens.delete(agentId);
        set("idle", "Finished — ready for the next instruction");
      }
      return;
    }
    this.idleScreens.delete(agentId);
    // An idle agent's prompt is on screen, so typed messages will land (e.g. Fleet missed SessionStart).
    if (st.state === "idle" && !busy && PROMPT_READY.test(screen)) this.onSessionReattached(agentId);
  }

  async recheckSetup() {
    this.hub.setSetup(await runSetupChecks(this.hub.repo));
  }

  shutdown() {
    // tmux keeps the agents running.
    if (this.polling) clearInterval(this.polling);
  }
}

/** The folder-trust prompt with "Yes, I trust this folder" highlighted (❯), so Enter answers yes. */
export const trustSelected = (screen: string) => /^\s*❯\s*Yes, I trust this folder/m.test(screen);
