// The Fleet Team MCP. Agents connect over Streamable HTTP (stateless) at /mcp,
// identified by the agent token + X-HQ-Agent header that Fleet writes into their
// .mcp.json. The lead manages the plan; everyone can message everyone.

import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { PERMISSION_MODES, type PermissionMode } from "../src/data/types";
import type { Hub } from "./hub";
import { MESSAGE_MAX, NOTE_MAX, type Planner } from "./planner";

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };

const ok = (value: unknown): Result => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
/** Tells the agent its text was cut, so it can send the rest. */
const trimmed = (text: string | undefined, max: number) => (text && text.trim().length > max ? ` Your text was trimmed to ${max} characters: send the rest separately.` : "");
const fail = (msg: string): Result => ({ content: [{ type: "text", text: msg }], isError: true });

/** Wraps a tool body: thrown errors become tool errors the agent can read. */
function guard<A>(fn: (args: A) => Result) {
  return async (args: A): Promise<Result> => {
    try {
      return fn(args);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  };
}

/** How much an agent may do without asking you; unset (your Claude default) counts as "default". */
export const looseness = (mode?: PermissionMode | null) => ["plan", "default", "acceptEdits", "auto", "bypassPermissions"].indexOf(mode ?? "default");

function buildServer(hub: Hub, planner: Planner, me: string): McpServer {
  const server = new McpServer({ name: "hq", version: "0.1.0" });
  const isLead = !!hub.cfg(me)?.isLead;
  const leadOnly = () => {
    if (!isLead) throw new Error("Only the lead can do this. Ask the lead with send_message.");
  };
  const taskView = (id: string) => {
    const t = planner.task(id);
    return t && { ...t, owner: t.ownerId ? hub.name(t.ownerId) : null };
  };

  server.registerTool(
    "list_workers",
    { description: "The team: each agent's id, name, role, whether they are running, and what they are doing now." },
    guard(() =>
      ok(
        hub.snap.config.team.map((a) => {
          const st = hub.status(a.id);
          return {
            id: a.id, name: a.name, role: a.role, lead: a.isLead, you: a.id === me,
            running: st?.session.state === "running", state: st?.state, task: st?.currentTaskId ?? null,
            free: st?.session.state === "running" && !a.isLead && !planner.currentTask(a.id),
          };
        }),
      ),
    ),
  );

  server.registerTool(
    "get_status",
    { description: "Live status of every agent (state, note, current task) plus the active boards with task counts." },
    guard(() =>
      ok({
        agents: hub.snap.agents.map((s) => ({ id: s.agentId, name: hub.name(s.agentId), state: s.state, note: s.note, task: s.currentTaskId, session: s.session.state })),
        boards: hub.snap.boards.map((b) => {
          const ts = hub.snap.tasks.filter((t) => t.boardId === b.id);
          const n = (st: string) => ts.filter((t) => t.status === st).length;
          return { id: b.id, title: b.title, status: b.status, todo: n("todo"), inProgress: n("in-progress"), inReview: n("in-review"), blocked: n("blocked"), done: n("done") };
        }),
      }),
    ),
  );

  server.registerTool(
    "list_tasks",
    {
      description: "Tasks, optionally filtered by board, status or owner.",
      inputSchema: {
        boardId: z.string().optional().describe("Board id, e.g. P3"),
        status: z.enum(["todo", "in-progress", "in-review", "done", "blocked"]).optional(),
        owner: z.string().optional().describe("Agent id or name"),
      },
    },
    guard(({ boardId, status, owner }: { boardId?: string; status?: string; owner?: string }) => {
      const ownerId = owner ? planner.agentId(owner) : undefined;
      const list = hub.snap.tasks.filter((t) => (!boardId || t.boardId === boardId) && (!status || t.status === status) && (!owner || t.ownerId === ownerId));
      return ok(list.map((t) => ({ id: t.id, board: t.boardId, title: t.title, status: t.status, owner: t.ownerId ? hub.name(t.ownerId) : null, needs: t.needs })));
    }),
  );

  server.registerTool(
    "create_board",
    { description: "Lead only. Create a board (a phase or an area of work).", inputSchema: { title: z.string(), active: z.boolean().optional().describe("Agents only pick tasks from active boards") } },
    guard(({ title, active }: { title: string; active?: boolean }) => {
      leadOnly();
      return ok(planner.createBoard(title, active ? "active" : "planned"));
    }),
  );

  server.registerTool(
    "create_task",
    {
      description: "Lead only. Add a task. Keep tasks small: one task = one branch = one PR.",
      inputSchema: {
        title: z.string(),
        boardId: z.string().optional().describe("Defaults to the first active board"),
        description: z.string().optional().describe("What to build and why"),
        files: z.array(z.string()).optional().describe("The only files/folders this task may edit"),
        doneWhen: z.string().optional().describe("Acceptance criteria"),
        needs: z.array(z.string()).optional().describe("Task ids that must be done first"),
      },
    },
    guard((args: { title: string; boardId?: string; description?: string; files?: string[]; doneWhen?: string; needs?: string[] }) => {
      leadOnly();
      return ok(planner.createTask(args, me));
    }),
  );

  server.registerTool(
    "update_task",
    {
      description: "Lead only. Edit a task's details or status.",
      inputSchema: {
        taskId: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        files: z.array(z.string()).optional(),
        doneWhen: z.string().optional(),
        needs: z.array(z.string()).optional(),
        status: z.enum(["todo", "in-progress", "in-review", "done", "blocked"]).optional(),
      },
    },
    guard(({ taskId, ...patch }: { taskId: string; title?: string; description?: string; files?: string[]; doneWhen?: string; needs?: string[]; status?: "todo" | "in-progress" | "in-review" | "done" | "blocked" }) => {
      leadOnly();
      return ok(planner.updateTask(taskId, patch));
    }),
  );

  server.registerTool(
    "assign_task",
    {
      description: "Lead only. Give a task to an agent. Fleet tells them to pull main and start it (right away if idle, otherwise when their current turn ends).",
      inputSchema: { taskId: z.string(), agent: z.string().describe("Agent id or name") },
    },
    guard(({ taskId, agent }: { taskId: string; agent: string }) => {
      leadOnly();
      const t = planner.assign(taskId, agent, me);
      return ok(`Assigned ${t.id} to ${hub.name(t.ownerId)}. They have been told to start.`);
    }),
  );

  server.registerTool(
    "get_my_task",
    { description: "Your current task: title, description, the files you may edit, done-when, and what it needs. Marks it in progress." },
    guard(() => {
      const t = planner.currentTask(me);
      if (!t) return ok("You have no task right now. Wait for the lead, or ask with send_message.");
      if (t.status === "todo") planner.setStatus(me, "in-progress");
      const blockedBy = t.needs.filter((n) => planner.task(n)?.status !== "done");
      return ok({ ...taskView(t.id), waitingOn: blockedBy, rules: "Work only on this task, on its own branch. Edit only the listed files. Title the PR `[" + t.id + "] " + t.title + "`. When the PR is open, call set_my_status with in-review and the PR number." });
    }),
  );

  server.registerTool(
    "set_my_status",
    {
      description: `Update one of your tasks: in-progress, blocked (say why), in-review (PR opened), or done. The lead is told automatically, note included. Always pass taskId when you have more than one task. The note holds up to ${NOTE_MAX} characters.`,
      inputSchema: {
        status: z.enum(["in-progress", "blocked", "in-review", "done"]),
        taskId: z.string().optional().describe("Which of your tasks, e.g. RI-T55. Without it: your current task (get_my_task)."),
        note: z.string().optional().describe(`Why you are blocked, or a summary of the result (up to ${NOTE_MAX} characters)`),
        prNumber: z.number().int().optional(),
      },
    },
    guard(({ status, taskId, note, prNumber }: { status: "in-progress" | "blocked" | "in-review" | "done"; taskId?: string; note?: string; prNumber?: number }) => {
      const t = planner.setStatus(me, status, note, prNumber, taskId?.trim() || undefined);
      return ok(`${t.id} is now ${t.status}.${trimmed(note, NOTE_MAX)}`);
    }),
  );

  server.registerTool(
    "ask_user",
    {
      description:
        "Ask the user to do or decide something you can't: create an account, database or API key, change a setting in a dashboard (Vercel, Supabase…), put a value in an env file, or approve a decision (e.g. a deploy, a risky change). It goes to their Action items list. Give a short title and clear steps. Never include secret values; name the variable instead. Fleet messages you when they've done it (Done, with an optional note) or dismissed it. For an approval pass approval: true; the user then sees Approve / Reject.",
      inputSchema: {
        title: z.string().describe("What to do, in a few words"),
        details: z.string().describe("The exact steps: where to go, what to create, which variable name, where to put it, and whether you need a restart. No secret values."),
        waiting: z.boolean().optional().describe("True if you can't continue without it"),
        approval: z.boolean().optional().describe("true when you need the user to approve or reject something, such as a plan or a deploy"),
      },
    },
    guard(({ title, details, waiting, approval }: { title: string; details: string; waiting?: boolean; approval?: boolean }) => {
      if (!planner.actions) throw new Error("Action items aren't available.");
      if (!details.trim()) throw new Error("Add the steps in details, so the user knows exactly what to do.");
      const item = planner.actions.add(me, title, details, !!waiting, approval);
      return ok(`Added to the user's Action items (${item.id}). ${waiting ? "Wait for Fleet's message, or work on something else meanwhile." : "Keep working; Fleet will message you when it's done."}`);
    }),
  );

  server.registerTool(
    "add_agent",
    {
      description:
        "Lead only. Ask the user to add an agent to the team, of any role (another Implementer for parallel work, a Reviewer, QA, a Designer…). The user sees Approve / Reject in Action items; on Approve, Fleet adds the agent in its own new worktree and messages you its id. Then give it work with assign_task.",
      inputSchema: {
        role: z.string().describe("e.g. Implementer, QA, Reviewer, or a new role name"),
        name: z.string().optional().describe("Defaults to the role, numbered if taken (Implementer 2)"),
        why: z.string().describe("Why it's needed, and what it will do"),
      },
    },
    guard(({ role, name, why }: { role: string; name?: string; why: string }) => {
      leadOnly();
      if (!planner.actions) throw new Error("Action items aren't available.");
      const r = role.trim().slice(0, 40);
      if (!r) throw new Error("Give the role.");
      if (!why.trim()) throw new Error("Say why the agent is needed in why.");
      const n = (name ?? "").trim().slice(0, 40);
      const item = planner.actions.add(me, `Approve new agent: ${n || r} (${r})`, `${why.trim()}\n\nFleet adds them in their own new worktree. They start on their first task.`, false, true, { name: n, role: r });
      return ok(`Asked the user (${item.id}). Fleet messages you when they approve or reject it.`);
    }),
  );

  server.registerTool(
    "remove_agent",
    {
      description:
        "Lead only. Remove an agent whose work is finished: its session stops, and it leaves the team with its folder deleted (its branches stay). Refused while it has unfinished tasks or uncommitted files.",
      inputSchema: { agent: z.string().describe("id or name"), why: z.string().describe("Why it's no longer needed") },
    },
    async ({ agent, why }: { agent: string; why: string }) => {
      try {
        leadOnly();
        const id = planner.agentId(agent);
        if (!id || !hub.cfg(id)) throw new Error(`No agent "${agent}".`);
        if (hub.cfg(id)?.isLead) throw new Error("The lead can't remove itself.");
        const open = hub.snap.tasks.filter((t) => t.ownerId === id && t.status !== "done").map((t) => `${t.id} [${t.status}]`);
        if (open.length) throw new Error(`${hub.name(id)} still has ${open.join(", ")}. Finish, reassign or close them first.`);
        if (!planner.removeAgent) throw new Error("Removing agents isn't available.");
        const name = hub.name(id);
        await planner.removeAgent(id);
        hub.activity("config", me, `${hub.name(me)} removed ${name}: ${why.trim().slice(0, 120) || "no longer needed"}`);
        return ok(`Removed ${name}. Ask for an agent again with add_agent if you need one.`);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "set_permission_mode",
    {
      description:
        'Lead only. Change how an agent asks before acting (Claude Code\'s permission mode): default asks the user (Allow / Deny in Action items), acceptEdits allows file edits, auto lets a classifier decide, plan only reads, bypassPermissions never asks. "project" goes back to the project\'s mode. A stricter mode applies right away; a looser one asks the user to approve it first (Fleet messages you). Takes effect when the agent next starts or refreshes.',
      inputSchema: { agent: z.string().describe("id or name"), mode: z.enum([...PERMISSION_MODES, "project"]), why: z.string().describe("Why this agent needs it") },
    },
    guard(({ agent, mode, why }: { agent: string; mode: (typeof PERMISSION_MODES)[number] | "project"; why: string }) => {
      leadOnly();
      const cfg = hub.cfg(planner.agentId(agent) ?? "");
      if (!cfg) throw new Error(`No agent "${agent}".`);
      const next = mode === "project" ? null : mode;
      const label = next ?? "the project's mode";
      // Loosening what an agent may do unasked (the lead's own mode included) is the user's call, never the lead's.
      if (looseness(next ?? hub.snap.config.project.permissionMode) > looseness(cfg.permissionMode ?? hub.snap.config.project.permissionMode)) {
        if (!planner.actions) throw new Error("Action items aren't available.");
        const item = planner.actions.add(me, `Approve permissions for ${cfg.name}: ${label}`, `${why.trim() || "No reason given."}\n\n${cfg.name} would ask you less before acting. Applies when it next starts or refreshes.`, false, true, undefined, undefined, { agentId: cfg.id, mode: next });
        return ok(`Asked the user (${item.id}). Fleet messages you when they approve or reject it.`);
      }
      if (next) cfg.permissionMode = next;
      else delete cfg.permissionMode;
      hub.configChanged();
      hub.activity("config", me, `${hub.name(me)} set ${cfg.name}'s permissions to ${label}: ${why.trim().slice(0, 120) || "no reason given"}`);
      return ok(`${cfg.name} is now ${label}. It applies when ${cfg.name} next starts or refreshes.`);
    }),
  );

  server.registerTool(
    "send_message",
    {
      description: `Send a message to another agent (id, name, or "lead"), or to "you" (the user: shown in their chat with you and as a notification). Fleet delivers it whole: right away if they are idle, otherwise when their current turn ends. Up to ${MESSAGE_MAX} characters.`,
      inputSchema: { to: z.string(), text: z.string() },
    },
    guard(({ to, text }: { to: string; text: string }) => {
      if (planner.agentId(to) === me) throw new Error("That's you.");
      const toId = planner.message(me, to, text);
      return ok(`Sent to ${hub.name(toId)}.${trimmed(text, MESSAGE_MAX)}`);
    }),
  );

  return server;
}

/** Handles one MCP HTTP request for an already-authenticated agent. */
export async function handleMcp(hub: Hub, planner: Planner, agentId: string, req: IncomingMessage, res: ServerResponse, body: unknown) {
  const server = buildServer(hub, planner, agentId);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
