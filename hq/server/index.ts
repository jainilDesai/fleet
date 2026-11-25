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
import { agentToken, namedSlug, projectHome, projectSlug } from "./paths";
import { Planner } from "./planner";
import { detectRepo } from "./repo";
import { Sessions } from "./sessions";
import { runSetupChecks } from "./setup";
import { loadConfig, loadPlan, saveConfig } from "./store";
import { rootSlug, teamName } from "./teams";

export interface HqOptions {
  /** Any folder inside the repo the team works on. */
  repo: string;
  /** Fleet's port: agents' hooks and Team MCP call back to it. */
  port: number;
  /** Fleet's per-run page token: commands from the page must carry it. */
  pageToken: string;
  /** A named project on this repo (`fleet --project`): a separate team made by New work. */
  project?: string;
}

export interface Hq {
  handle: HqHandler;
  repoRoot: string;
  slug: string;
  name(): string;
  /** A separate team made by New work (`fleet --project`), not the repo's main project. */
  team: boolean;
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
  const slug = o.project ? namedSlug(repo.root, o.project) : projectSlug(repo.root);
  const home = projectHome(slug);
  const { config, isNew } = loadConfig(home, repo, o.port);
  config.project.id = slug;
  config.project.path = repo.root;
  config.project.hqPort = o.port;
  if (config.project.parent) {
    // Before 0.11 a team made from another team's page was that team's child, named after it: point it at the project.
    const fixed = { parent: rootSlug(slug), name: teamName(slug) };
    if (fixed.parent !== config.project.parent || fixed.name !== config.project.name) saveConfig(home, Object.assign(config, { project: { ...config.project, ...fixed } }));
  }
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
  // A separate team whose boards are all done shuts down, its Fleet included (no port, no GitHub polling); its
  // boards stay in the project's History. Not while you still have to decide about uncommitted work it left.
  const finished = () =>
    !!o.project && hub.snap.boards.length > 0 && hub.snap.boards.every((b) => b.status === "done") && !(hub.snap.actionItems ?? []).some((i) => i.status === "open" && i.cleanup);
  const shutIfFinished = () => finished() && void commands.quitFleet("All of this team's work is done: its agents and its Fleet stopped. Start it again on the home page to pick the work back up.");
  planner.onBoardDone = (b) => void closer.finish(b.id).then(shutIfFinished).catch((e) => log.warn("board done:", e));
  planner.actions.onCleanup = async (req, approved, fromId) => {
    await closer.cleanup(req, approved, fromId);
    if (approved) shutIfFinished(); // kept: the lead asks you what to do with that work, so the team stays up
  };
  // A separate team's board (seeded by New work in another project): start the work now.
  for (const b of hub.snap.boards) if (b.brief?.autoStart && !b.brief.startedAt) void commands.startWork(b.id);
  // A team that shut down when its work was done, started again from the home page: its last board picks up again.
  const last = finished() ? [...hub.snap.boards].sort((a, b) => (b.doneAt ?? "").localeCompare(a.doneAt ?? ""))[0] : null;
  if (last) commands.reopenBoard(last.id);
  planner.removeAgent = async (id) => {
    const ws = await sessions.inspectWorkspace(id);
    if (ws?.exists && ws.managed && ws.changedFiles)
      throw new Error(`${hub.name(id)} has ${ws.changedFiles} uncommitted file(s) in its folder. Have it commit and push (or discard) them first.`);
    await commands.removeAgent(id, { deleteFolder: true });
  };
  sessions.startPolling();
  const github = new GitHubSync(hub, planner, repo.github);
  github.start();
  const idleDeps = { stop: (id: string) => sessions.stop(id), hasDraft: (id: string) => sessions.hasDraft(id), pending: (id: string) => inbox.pending(id) };
  const idleCheck = setInterval(() => void stopIdleAgents(hub, idleDeps).catch((e) => log.warn("idle stop:", e)), IDLE_CHECK_MS);

  return {
    handle,
    repoRoot: repo.root,
    slug,
    name: () => hub.snap.config.project.name,
    team: !!o.project,
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
export { launchArgs } from "./adapters";
export { looseness } from "./mcp";
export { isApproval, parseQuestions, resolutionMessage } from "./actionItems";
export { hookCommand, roleMd, skillText, writeSkills } from "./agentFiles";
export { handleHook, leadBriefing } from "./hooks";
export { buildHandoff, contextUse, contextWindow, Refresher } from "./refresh";
export { BoardCloser, boardAgents, boardSummary } from "./boardDone";
export { dependencyDirs, copyEnvFiles, packagesMatch, shareDependencies } from "./deps";
export { trustSelected } from "./sessions";
export { addTeamAgent, makeCommands, workMessage } from "./commands";
export { namedSlug } from "./paths";
export { projectHistory, rootSlug, seedTeam, teamName, teamSlug } from "./teams";
export { copyImage, saveImage, UPLOAD_NAME } from "./uploads";
export { Planner } from "./planner";
export { ActionItems } from "./actionItems";
export { stopIdleAgents } from "./idleStop";
export { Hub } from "./hub";
