// The agent team behind Fleet's pixel office, for one git repo. Fleet's server (src/server.js)
// calls startHq() and hands every request to the returned handler first.

import { resolve } from "node:path";
import { userInfo } from "node:os";
import { ActionItems } from "./actionItems";
import { makeCommands } from "./commands";
import { GitHubSync } from "./githubSync";
import { makeHandler, type HqHandler } from "./http";
import { Hub } from "./hub";
import { Inbox } from "./inbox";
import { run } from "./lib/exec";
import { log } from "./lib/log";
import { agentToken, projectHome, slugify } from "./paths";
import { Planner } from "./planner";
import { detectRepo } from "./repo";
import { Sessions } from "./sessions";
import { runSetupChecks } from "./setup";
import { loadConfig, loadPlan } from "./store";

export interface HqOptions {
  /** Any folder inside the repo the team works on. */
  repo: string;
  /** Fleet's port: agents' hooks and Team MCP call back to it. */
  port: number;
  /** Fleet's per-run page token: commands from the page must carry it. */
  pageToken: string;
}

export interface Hq {
  handle: HqHandler;
  repoRoot: string;
  stop(): void;
}

/**
 * Started at login by launchd, Fleet gets a bare PATH (no Homebrew, no ~/.local/bin), so tmux,
 * claude, git and gh wouldn't be found. Take the PATH your login shell sets up, once.
 */
async function adoptLoginPath() {
  const shell = process.env.SHELL || userInfo().shell || "/bin/zsh";
  const r = await run(shell, ["-ilc", 'printf "__FLEET_PATH__%s__FLEET_PATH__" "$PATH"'], { timeoutMs: 15_000 });
  const path = r.stdout.match(/__FLEET_PATH__(.*?)__FLEET_PATH__/)?.[1];
  if (path) process.env.PATH = path;
  else log.warn("Couldn't read PATH from your login shell; using Fleet's own.");
}

export async function startHq(o: HqOptions): Promise<Hq> {
  await adoptLoginPath();
  const repo = await detectRepo(resolve(o.repo));
  const slug = slugify(repo.name);
  const home = projectHome(slug);
  const { config, isNew } = loadConfig(home, repo, o.port);
  config.project.id = slug;
  config.project.path = repo.root;
  config.project.hqPort = o.port;
  const token = agentToken(slug);

  log.info(`repo   ${repo.root}${repo.github ? `  (github.com/${repo.github})` : ""}`);
  log.info(`team   ${home}`);
  const setup = await runSetupChecks(repo);
  for (const c of setup.checks) log.info(`  ${c.status === "ok" ? "✓" : c.status === "warning" ? "!" : "✗"} ${c.label}: ${c.detail}`);

  const hub = new Hub(repo, slug, home, config, loadPlan(home), setup);
  hub.snap.welcome = isNew;
  const sessions = new Sessions(hub, token);
  const inbox = new Inbox(hub, { type: (id, text) => sessions.typeInto(id, text), enter: (id) => sessions.pressEnter(id) });
  sessions.onSessionDown = (id) => inbox.sessionDown(id);
  sessions.onSessionReattached = (id) => inbox.sessionReattached(id);
  sessions.lastHookAt = (id) => inbox.lastHookAt(id);
  // A task or message for an agent that isn't running starts it; the message waits for its prompt.
  inbox.onNeedsSession = (id) => void sessions.start(id);
  const planner = new Planner(hub, inbox);
  planner.actions = new ActionItems(hub, planner);

  const handle = makeHandler({ hub, inbox, planner, pageToken: o.pageToken, agentToken: token, commands: makeCommands(hub, sessions, planner, inbox) });
  sessions.startPolling();
  const github = new GitHubSync(hub, planner, repo.github);
  github.start();

  return {
    handle,
    repoRoot: repo.root,
    stop() {
      // tmux keeps the agents running.
      sessions.shutdown();
      github.stop();
    },
  };
}

// For Fleet's tests (test/hq.test.js).
export { describePermission, lastAssistantText } from "./hooks";
export { draftFromPromptLine } from "./backends/tmuxCli";
export { branchAgent } from "./github";
export { passedNotice } from "./githubSync";
export { rolePreset } from "./roles";
export { isApproval, resolutionMessage } from "./actionItems";
export { skillText, writeSkills } from "./agentFiles";
