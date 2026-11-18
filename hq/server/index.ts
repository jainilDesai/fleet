// The agent team behind Fleet's pixel office, for one git repo. Fleet's server (src/server.js)
// calls startHq() and hands every request to the returned handler first.

import { resolve } from "node:path";
import { userInfo } from "node:os";
import { selectAttention } from "../src/data/attention";
import { ActionItems } from "./actionItems";
import { addTeamAgent, makeCommands } from "./commands";
import { GitHubSync } from "./githubSync";
import { makeHandler, type HqHandler } from "./http";
import { Hub } from "./hub";
import { IDLE_CHECK_MS, stopIdleAgents } from "./idleStop";
import { Refresher } from "./refresh";
import { BoardCloser } from "./boardDone";
import { Inbox } from "./inbox";
import { run } from "./lib/exec";
import { log } from "./lib/log";
import { agentToken, projectHome, projectSlug } from "./paths";
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
  slug: string;
  /** What the home page shows for this project (GET /api/summary). No secrets. */
  summary(): { slug: string; name: string; repo: string; agents: number; agentsRunning: number; needsYou: number; openPrs: number };
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
  const slug = projectSlug(repo.root);
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

  const refresher = new Refresher(hub, sessions, inbox, planner);
  const commands = makeCommands(hub, sessions, planner, inbox);
  commands.refreshAgent = (id) => refresher.request(String(id ?? ""));
  commands.listHandoffs = (id) => hub.emit({ type: "handoffs", agentId: String(id ?? ""), handoffs: refresher.list(String(id ?? "")) });
  const handle = makeHandler({ hub, inbox, planner, pageToken: o.pageToken, agentToken: token, commands, refresher });
  planner.actions.onAddAgent = (r) => addTeamAgent(hub, r.name, r.role);
  const closer = new BoardCloser(hub, {
    writeHandoff: (id, reason) => refresher.writeHandoff(id, reason),
    stop: (id) => sessions.stop(id),
    inspect: (id) => sessions.inspectWorkspace(id),
    deleteWorktree: async (id) => void (await sessions.removeResources(id, { deleteFolder: true })),
    removeAgent: async (id) => void (await commands.removeAgent(id, { deleteFolder: true })),
    ask: (fromId, title, details, cleanup) => planner.actions!.add(fromId, title, details, false, true, undefined, cleanup),
    notify: (id, text) => planner.notify(id, text),
  });
  planner.onBoardDone = (b) => void closer.finish(b.id).catch((e) => log.warn("board done:", e));
  planner.actions.onCleanup = (req, approved, fromId) => closer.cleanup(req, approved, fromId);
  sessions.startPolling();
  const github = new GitHubSync(hub, planner, repo.github);
  github.start();
  const idleDeps = { stop: (id: string) => sessions.stop(id), hasDraft: (id: string) => sessions.hasDraft(id), pending: (id: string) => inbox.pending(id) };
  const idleCheck = setInterval(() => void stopIdleAgents(hub, idleDeps).catch((e) => log.warn("idle stop:", e)), IDLE_CHECK_MS);

  return {
    handle,
    repoRoot: repo.root,
    slug,
    summary: () => ({
      slug,
      name: hub.snap.config.project.name,
      repo: repo.root,
      agents: hub.snap.config.team.length,
      agentsRunning: hub.snap.agents.filter((a) => a.session.state === "running").length,
      needsYou: selectAttention(hub.snap).total,
      openPrs: hub.snap.pullRequests.filter((p) => !p.merged && !p.closed).length,
    }),
    stop() {
      // tmux keeps the agents running.
      sessions.shutdown();
      github.stop();
      clearInterval(idleCheck);
    },
  };
}

// For Fleet's tests (test/hq.test.js).
export { describePermission, lastAssistantText, turnReplies } from "./hooks";
export { draftFromPromptLine } from "./backends/tmuxCli";
export { pasteSafe } from "./backends/tmux";
export { branchAgent } from "./github";
export { projectSlug } from "./paths";
export { agentBranch } from "./workspace";
export { GitHubSync, passedNotice } from "./githubSync";
export { deleteRole, listRoles, rolePreset, saveRole } from "./roles";
export { newAgent } from "./store";
export { isApproval, parseQuestions, resolutionMessage } from "./actionItems";
export { hookCommand, roleMd, skillText, writeSkills } from "./agentFiles";
export { handleHook, leadBriefing } from "./hooks";
export { buildHandoff, contextUse, contextWindow, Refresher } from "./refresh";
export { BoardCloser, boardAgents, boardSummary } from "./boardDone";
export { dependencyDirs, copyEnvFiles, packagesMatch, shareDependencies } from "./deps";
export { trustSelected } from "./sessions";
export { addTeamAgent, makeCommands, workMessage } from "./commands";
export { Planner } from "./planner";
export { ActionItems } from "./actionItems";
export { stopIdleAgents } from "./idleStop";
export { Hub } from "./hub";
