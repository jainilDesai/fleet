// Browser commands → server actions. Names match OfficeDataSource methods.

import { IDLE_STOP_DAYS, PERMISSION_MODES, type AgentConfig, type AgentPatch, type ReviewTool, type WelcomeInput, type Board, type NewAgentInput, type ProjectConfig, type RemoveAgentOptions, type SaveRoleInput, type WorkflowPatch } from "../src/data/types";
import { LEAD_NAME, OFFICE_NAME_MAX } from "../src/data/names";
import { run } from "./lib/exec";
import { agentPalette } from "../src/theme/tokens";
import { Hub } from "./hub";
import type { Inbox } from "./inbox";
import type { Planner } from "./planner";
import type { Sessions } from "./sessions";
import { newAgent } from "./store";
import { cleanSkills } from "./agentFiles";
import { deleteRole, listRoles, saveRole } from "./roles";
import { mergeByNotice } from "./githubSync";
import { hasIterm } from "./setup";
import { OS, openTerminal } from "../../src/platform.js";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "agent";
const str = (v: unknown, max = 2000) => (typeof v === "string" ? v.slice(0, max) : "");

/** AppleScript string literal (same escaping as JSON for what we pass). */
const osaString = (s: string) => JSON.stringify(s);

/** The command that attaches a terminal to an agent's session. Quoted: zsh would expand a bare `=name`. */
const attachCommand = (session: string, tmux = "tmux") => `${tmux} attach -t '=${session}'`;

/** How to let Fleet open the terminal next time, shown with the command when it couldn't. */
const TERMINAL_HINT =
  OS === "mac"
    ? "To let Fleet open it for you: System Settings → Privacy & Security → Automation, and allow the app that runs Fleet to control iTerm or Terminal."
    : OS === "wsl"
      ? "To let Fleet open it for you: install Windows Terminal (wt.exe), or a Linux terminal such as xterm."
      : "To let Fleet open it for you: run Fleet from your desktop session with a terminal installed (gnome-terminal, konsole, xterm…).";

/** Opens a terminal attached to the agent's tmux session: iTerm (else Terminal.app) on macOS. */
async function openInTerminal(session: string) {
  const tmux = (await run("sh", ["-c", "command -v tmux"])).stdout.trim() || "tmux";
  // No shell in between, so `=name` needs no quoting.
  if (OS !== "mac") return void (await openTerminal([tmux, "attach", "-t", `=${session}`]));
  // Session names are [a-z0-9-] only (slugs). iTerm runs the command itself, Terminal.app through your shell.
  const script = hasIterm()
    ? `tell application "iTerm"\n  activate\n  create window with default profile command ${osaString(`${tmux} attach -t =${session}`)}\nend tell`
    : `tell application "Terminal"\n  activate\n  do script ${osaString(attachCommand(session, tmux))}\nend tell`;
  const r = await run("osascript", ["-e", script], { timeoutMs: 10_000 });
  if (!r.ok) throw new Error(r.stderr.trim() || "osascript failed");
}

export function makeCommands(hub: Hub, sessions: Sessions, planner: Planner, inbox: Inbox, exit = (code: number) => process.exit(code)) {
  const team = () => hub.snap.config.team;

  /** Stops every running agent session at once; one that fails is reported and doesn't stop the rest. */
  const stopTeam = () =>
    Promise.all(
      hub.snap.agents
        .filter((a) => a.session.state === "running")
        .map((a) =>
          sessions.stop(a.agentId).catch((err) => hub.activity("session", a.agentId, `Couldn't stop ${hub.name(a.agentId)}: ${err instanceof Error ? err.message : String(err)}`))
        )
    );

  const commands: Record<string, (...args: unknown[]) => unknown> = {
    startAgent: (id) => sessions.start(str(id, 80)),
    stopAgent: (id) => sessions.stop(str(id, 80)),
    stopTeam,
    quitFleet: async () => {
      await stopTeam();
      hub.activity("session", null, "Fleet was quit from the browser.");
      // Later than the reply, and than history.json's 1 s save. Exit 0, so launchd and systemd don't restart it;
      // Fleet's exit handler (src/server.js) removes its registry entry and watcher lock.
      setTimeout(() => exit(0), 1500);
    },
    openWorkspace: (id) => sessions.openWorkspace(str(id, 80)),
    openInIterm: async (id) => {
      const agentId = str(id, 80);
      const st = hub.status(agentId);
      if (st?.session.state !== "running") return;
      const session = sessions.name(agentId);
      try {
        await openInTerminal(session);
        if (st.session.terminalError) hub.setSession(agentId, { terminalError: null });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // The UI shows the command to run yourself, and how to let Fleet open the terminal (Automation permission on macOS).
        hub.setSession(agentId, { terminalError: { message, command: attachCommand(session), hint: TERMINAL_HINT } });
        hub.activity("session", agentId, `Couldn't open ${hub.name(agentId)} in ${OS !== "mac" ? "a terminal" : hasIterm() ? "iTerm" : "Terminal"}: ${message}`);
      }
    },
    trustFolder: (id) => sessions.trustFolder(str(id, 80)),
    recheckSetup: () => sessions.recheckSetup(),

    // You → agent: same delivery path as the lead's assign_task / send_message.
    assignTask: (taskId, agentId) => planner.assign(str(taskId, 40), str(agentId, 80), "you"),
    sendMessage: (toId, text) => planner.message("you", str(toId, 80), str(text, 2000)),

    addAgent: (raw) => {
      const input = (raw ?? {}) as Partial<NewAgentInput>;
      const name = str(input.name, 40).trim() || "Agent";
      let id = slug(name);
      for (let i = 2; team().some((a) => a.id === id); i++) id = `${slug(name)}-${i}`;
      const used = new Set(team().map((a) => a.color));
      const color = agentPalette.find((c) => !used.has(c)) ?? agentPalette[team().length % agentPalette.length];
      const agent = newAgent(id, name, str(input.role, 40).trim() || "Developer", color, false);
      agent.model = str(input.model, 60).trim();
      team().push(agent);
      const status = Hub.freshStatus(id);
      hub.snap.agents.push(status);
      hub.configChanged();
      hub.emit({ type: "agent.updated", agent: structuredClone(status) });
      hub.activity("config", null, `Added ${agent.name} (${agent.role}). They start when the lead first gives them work.`);
    },

    updateAgent: (id, patch) => {
      const agent = hub.cfg(str(id));
      if (!agent) return;
      const p = (patch ?? {}) as AgentPatch;
      for (const k of ["name", "role", "model", "color", "roleMd"] as const) if (typeof p[k] === "string") agent[k] = str(p[k], 8000);
      if (p.workspacePath !== undefined) agent.workspacePath = p.workspacePath ? str(p.workspacePath, 500).trim() || null : null;
      if (Array.isArray(p.skillFiles)) agent.skillFiles = cleanSkills(p.skillFiles);
      if ("permissionMode" in p) {
        if ((PERMISSION_MODES as readonly unknown[]).includes(p.permissionMode)) agent.permissionMode = p.permissionMode;
        else delete agent.permissionMode;
      }
      hub.configChanged();
    },

    inspectWorkspace: async (id) => {
      const info = await sessions.inspectWorkspace(str(id, 80));
      if (info) hub.emit({ type: "workspace.info", info });
    },

    removeAgent: async (id, opts) => {
      const agent = hub.cfg(str(id));
      if (!agent || agent.isLead) return;
      const o = (opts ?? {}) as Partial<RemoveAgentOptions>;
      const removed = await sessions.removeResources(agent.id, { deleteFolder: o.deleteFolder === true });
      hub.snap.config.team = team().filter((a) => a.id !== agent.id);
      hub.snap.agents = hub.snap.agents.filter((a) => a.agentId !== agent.id);
      inbox.forget(agent.id);
      for (const t of hub.snap.tasks)
        if (t.ownerId === agent.id && t.status !== "done") {
          t.ownerId = null;
          if (t.status === "in-progress") t.status = "todo";
          hub.emit({ type: "task.updated", task: { ...t } });
        }
      hub.planChanged();
      hub.emit({ type: "agent.removed", agentId: agent.id });
      hub.configChanged();
      const what = removed.length ? " Deleted their worktree." : "";
      const kept = removed.includes("folder") ? "" : " Their worktree is kept.";
      hub.activity("config", null, `Removed ${agent.name}.${what}${kept}`);
    },

    listRoles: () => hub.emit({ type: "roles", roles: listRoles() }),

    saveRole: (raw) => {
      try {
        const name = saveRole((raw ?? {}) as SaveRoleInput);
        hub.activity("config", null, `Saved ${name} as your role. Any agent that gets it next, on any project, starts with this ROLE.md and its skills.`);
      } catch (err) {
        hub.activity("config", null, `Couldn't save the role: ${err instanceof Error ? err.message : String(err)}`);
      }
      hub.emit({ type: "roles", roles: listRoles() });
    },

    deleteRole: (key) => {
      try {
        deleteRole(str(key, 80));
        hub.activity("config", null, `Removed your saved role ${str(key, 80)} from ~/.fleet/roles.`);
      } catch (err) {
        hub.activity("config", null, `Couldn't remove the role: ${err instanceof Error ? err.message : String(err)}`);
      }
      hub.emit({ type: "roles", roles: listRoles() });
    },

    resolveActionItem: (id, decision, note) => {
      const d = decision === "done" || decision === "dismissed" ? decision : null;
      if (d) planner.actions?.resolve(str(id, 40), d, typeof note === "string" ? str(note, 1000) : undefined);
    },

    completeWelcome: async (raw) => {
      if (!hub.snap.welcome) return;
      const input = (raw ?? {}) as Partial<WelcomeInput>;
      const used = new Set<string>();
      const make = (name: string, role: string, isLead: boolean): AgentConfig => {
        const clean = str(name, 40).trim() || (isLead ? "Lead" : "Agent");
        let id = slug(clean);
        for (let i = 2; used.has(id); i++) id = `${slug(clean)}-${i}`;
        used.add(id);
        return newAgent(id, clean, isLead ? "Lead" : str(role, 40).trim() || "Developer", agentPalette[used.size - 1] ?? agentPalette[0], isLead);
      };
      const lead = make(input.lead?.name ?? LEAD_NAME, "Lead", true);
      const workers = (Array.isArray(input.workers) ? input.workers : []).slice(0, 11).map((w) => make(w?.name ?? "", w?.role ?? "", false));
      if (!workers.length) return hub.activity("config", null, "Add at least one worker to the team.");
      const cfg = hub.snap.config;
      if (typeof input.projectName === "string" && input.projectName.trim()) cfg.project.name = str(input.projectName, 80).trim();
      cfg.team = [lead, ...workers];
      const tools: ReviewTool[] = ["coderabbit", "greptile", "copilot", "human", "custom"];
      if (tools.includes(input.reviewTool as ReviewTool)) cfg.workflow.review.tool = input.reviewTool as ReviewTool;
      if (typeof input.reviewEnabled === "boolean") cfg.workflow.review.enabled = input.reviewEnabled;
      hub.snap.agents = cfg.team.map((a) => Hub.freshStatus(a.id));
      hub.snap.welcome = false;
      hub.configChanged(); // saves config.json in the project's home for the first time
      hub.planChanged();
      await sessions.recheckSetup();
      hub.emit({ type: "snapshot", snapshot: structuredClone(hub.snap) });
      hub.activity("config", null, `Welcome! Team created: ${cfg.team.map((a) => a.name).join(", ")}. Press Start team when you're ready.`);
    },

    updateWorkflow: (patch) => {
      const p = (patch ?? {}) as WorkflowPatch;
      const wf = hub.snap.config.workflow;
      const mergeBy = wf.merge.by;
      Object.assign(wf.review, p.review ?? {});
      if (p.merge?.by === "human" || p.merge?.by === "lead") wf.merge.by = p.merge.by;
      Object.assign(wf.deploy, p.deploy ?? {});
      if ((IDLE_STOP_DAYS as readonly unknown[]).includes(p.stopIdleAfterDays)) wf.stopIdleAfterDays = p.stopIdleAfterDays!;
      hub.configChanged();
      // The lead was told the old rule; tell it the new one now, so no restart is needed.
      const lead = hub.snap.config.team.find((a) => a.isLead);
      if (lead && wf.merge.by !== mergeBy) {
        const waiting = hub.snap.pullRequests.filter((pr) => pr.review === "passed" && !pr.merged && !pr.closed).map((pr) => pr.number);
        planner.notify(lead.id, mergeByNotice(wf.merge.by, waiting));
      }
    },

    updateProject: (patch) => {
      const p = (patch ?? {}) as Partial<ProjectConfig>;
      const project = hub.snap.config.project;
      if (typeof p.name === "string" && p.name.trim()) project.name = str(p.name, 80);
      if (typeof p.repo === "string" && p.repo.trim()) project.repo = str(p.repo, 200);
      if (typeof p.officeName === "string") {
        const name = p.officeName.trim().slice(0, OFFICE_NAME_MAX);
        if (name) project.officeName = name;
        else delete project.officeName;
      }
      const exportOn = typeof p.exportPlan === "boolean" && p.exportPlan && !project.exportPlan;
      if (typeof p.exportPlan === "boolean") project.exportPlan = p.exportPlan;
      hub.configChanged();
      if (exportOn) {
        hub.planChanged();
        hub.activity("config", null, "Plan export on: Fleet writes docs/plan.md in the repo whenever the plan changes.");
      }
    },

    createBoard: (title) => planner.createBoard(str(title, 80)),

    updateBoard: (id, patch) => {
      const p = (patch ?? {}) as Partial<Board>;
      const status = p.status === "active" || p.status === "planned" || p.status === "done" ? p.status : undefined;
      planner.updateBoard(str(id, 20), { title: typeof p.title === "string" ? p.title : undefined, status });
    },
  };

  return commands;
}
