import { useState } from "react";
import { HUMAN_ID, TRUST_NOTE, type AgentConfig, type AgentStatus, type OfficeSnapshot } from "../../data/types";
import { officeActions, useOffice } from "../../store/office";
import { ui, type AgentTab } from "../../store/ui";
import { ago, Dot, Portrait, ReviewChip, SectionTitle, StateChip, Tabs, useNow } from "../kit";
import { DrawerHeader } from "./Drawer";
import { Markdown } from "../Markdown";
import { TerminalFallback } from "../setup/SetupChecks";

export function AgentDrawer({ id, initialTab }: { id: string; initialTab?: AgentTab }) {
  const snap = useOffice((s) => s.snap);
  const [tab, setTab] = useState<AgentTab>(initialTab ?? "task");
  const agent = snap?.config.team.find((a) => a.id === id);
  const status = snap?.agents.find((a) => a.agentId === id);
  if (!snap || !agent || !status) {
    return (
      <>
        <DrawerHeader>
          <b>Agent removed</b>
        </DrawerHeader>
      </>
    );
  }
  const unread = snap.messages.filter((m) => m.toId === id).length;

  return (
    <>
      <DrawerHeader>
        <Portrait color={agent.color} lead={agent.isLead} size={36} />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <b className="text-[18px]">{agent.name}</b>
            <StateChip state={status.state} />
          </div>
          <div className="truncate font-term text-[17px] text-muted">
            {agent.role} · Claude Code{agent.model ? ` ${agent.model}` : ""} · tmux + worktree
          </div>
        </div>
      </DrawerHeader>
      <SessionBar agent={agent} status={status} />
      {status.note && (
        <div className={`flex items-center gap-2 border-b-[3px] border-ink px-3 py-1.5 text-[14px] ${status.state === "needs-input" ? "bg-[#ffe1ea] text-[#a3002f]" : "bg-cream-2"}`}>
          <span className="flex-1">{status.note}</span>
          {status.note === TRUST_NOTE && !agent.workspacePath && <TrustButton id={agent.id} />}
        </div>
      )}
      {status.session.terminalError && <TerminalFallback error={status.session.terminalError} />}
      <div className="border-b-[3px] border-ink px-3 py-2">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "task", label: "Task" },
            { id: "messages", label: `Messages${unread ? ` · ${unread}` : ""}` },
          ]}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === "task" && <TaskTab snap={snap} agent={agent} taskId={status.currentTaskId} />}
        {tab === "messages" && <MessagesTab snap={snap} agent={agent} />}
      </div>
    </>
  );
}

const SESSION_COLOR = { running: "#00e436", starting: "#29adff", stopped: "#83769c", failed: "#ff004d" } as const;

/** Answers the folder-trust prompt with "Yes, I trust this folder". */
export function TrustButton({ id }: { id: string }) {
  return (
    <button className="btn shrink-0 px-2 text-[12px]" style={{ background: "#b8f5c4" }} onClick={() => officeActions.trustFolder(id)} title="Answer Claude Code's prompt with “Yes, I trust this folder” (a worktree Fleet made for this agent)">
      Trust folder
    </button>
  );
}

/** Session state + Start/Stop + the agent's folder + its tmux session in a terminal. */
function SessionBar({ agent, status }: { agent: AgentConfig; status: AgentStatus }) {
  const s = status.session;
  const live = useOffice((st) => st.live);
  return (
    <div className="flex items-center gap-2 border-b-[3px] border-ink bg-cream px-3 py-1.5 text-[13px]">
      <span className={`chip chip-dot ${s.state === "starting" ? "blink" : ""}`} style={{ ["--c" as string]: SESSION_COLOR[s.state] }}>
        {s.state === "running" ? "Session running" : s.state === "starting" ? "Starting" : s.state === "failed" ? "Failed" : "Stopped"}
      </span>
      <span className="min-w-0 flex-1 truncate font-term text-[15px] text-muted" title={s.workspace ?? undefined}>
        {s.state === "starting" ? s.detail : (s.workspace ?? "")}
      </span>
      {s.workspace && live && (
        <button className="btn px-2 text-[12px]" onClick={() => officeActions.openWorkspace(agent.id)} title="Open the agent's folder">
          Open folder
        </button>
      )}
      {s.state === "running" && live && (
        <button className="btn px-2 text-[12px]" onClick={() => officeActions.openInIterm(agent.id)} title="Attach a terminal window (iTerm, else Terminal.app) to the agent's tmux session">
          Open in terminal
        </button>
      )}
      {s.state === "running" || s.state === "starting" ? (
        <button className="btn px-2 text-[12px]" disabled={s.state === "starting"} onClick={() => officeActions.stopAgent(agent.id)}>
          Stop
        </button>
      ) : (
        <button className="btn px-2 text-[12px]" onClick={() => officeActions.startAgent(agent.id)}>
          Start
        </button>
      )}
    </div>
  );
}

function TaskTab({ snap, agent, taskId }: { snap: OfficeSnapshot; agent: AgentConfig; taskId: string | null }) {
  const task = taskId ? snap.tasks.find((t) => t.id === taskId) : null;
  const pr = task?.prNumber ? snap.pullRequests.find((p) => p.number === task.prNumber) : null;
  const active = snap.boards.filter((b) => b.status === "active");
  const free = snap.tasks.filter((t) => t.status === "todo" && active.some((b) => b.id === t.boardId));
  const [pick, setPick] = useState("");

  if (agent.isLead) {
    return (
      <div className="scroll-thin h-full overflow-y-auto p-4">
        <SectionTitle>Planning</SectionTitle>
        <p className="mb-3 text-[15px]">The lead plans and assigns work through the Team MCP. It writes no app code.</p>
        {active.map((b) => {
          const tasks = snap.tasks.filter((t) => t.boardId === b.id);
          const count = (s: string) => tasks.filter((t) => t.status === s).length;
          return (
            <button key={b.id} className="panel mb-2 block w-full px-3 py-2 text-left" onClick={() => ui.openBoards(b.id)}>
              <b>{b.title}</b>
              <div className="font-term text-[17px] text-muted">
                {count("todo")} to do · {count("in-progress")} in progress · {count("in-review")} in review · {count("done")} done
              </div>
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className="scroll-thin h-full overflow-y-auto p-4">
      <SectionTitle>Current task</SectionTitle>
      {task ? (
        <div className="panel mb-4 px-3 py-2">
          <div className="font-term text-[18px] text-muted">{task.id} · {snap.boards.find((b) => b.id === task.boardId)?.title}</div>
          <b className="text-[17px]">{task.title}</b>
          <div className="mt-1 text-[14px]">Status: {task.status}</div>
          {task.note && (
            <div className="mt-1">
              <Markdown text={task.note} lines={8} />
            </div>
          )}
          {task.description && (
            <div className="mt-1">
              <Markdown text={task.description} lines={10} />
            </div>
          )}
          {!!task.files?.length && (
            <div className="mt-1 text-[13px]">
              Files: {task.files.map((f) => <code key={f} className="mr-1 bg-cream-2 px-1 font-term text-[15px]">{f}</code>)}
            </div>
          )}
          {task.doneWhen && <div className="mt-1 text-[13px]"><b>Done when:</b> {task.doneWhen}</div>}
          {task.needs.length > 0 && (
            <div className="text-[14px]">
              Needs: {task.needs.map((n) => `${n} (${snap.tasks.find((t) => t.id === n)?.status ?? "?"})`).join(", ")}
            </div>
          )}
          {pr && (
            <div className="mt-2 flex items-center gap-2 text-[14px]">
              <button className="font-semibold underline" onClick={() => ui.openPrs()}>
                PR #{pr.number}
              </button>
              <ReviewChip review={pr.review} merged={pr.merged} />
              {pr.openComments > 0 && <span>{pr.openComments} comments</span>}
            </div>
          )}
        </div>
      ) : (
        <p className="mb-4 text-[15px] text-muted">No task right now.</p>
      )}
      <SectionTitle>Assign a task</SectionTitle>
      <div className="flex gap-2">
        <select className="field" value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Task to assign">
          <option value="">Pick a to-do task…</option>
          {free.map((t) => (
            <option key={t.id} value={t.id}>
              {t.id} {t.title}
            </option>
          ))}
        </select>
        <button className="btn" disabled={!pick} onClick={() => (officeActions.assignTask(pick, agent.id), setPick(""))}>
          Assign
        </button>
      </div>
      <p className="mt-1 text-[12px] text-muted">If {agent.name} is free, the lead tells them to start right away.</p>
    </div>
  );
}

function MessagesTab({ snap, agent }: { snap: OfficeSnapshot; agent: AgentConfig }) {
  const now = useNow(1000);
  const [draft, setDraft] = useState("");
  const list = snap.messages.filter((m) => m.fromId === agent.id || m.toId === agent.id);
  const who = (id: string) =>
    id === HUMAN_ID ? { name: "You", color: "#ffec27" } : id === "hq" ? { name: "Fleet", color: "#3ee0d0" } : snap.config.team.find((a) => a.id === id);
  const running = snap.agents.find((a) => a.agentId === agent.id)?.session.state === "running";
  const send = () => {
    if (!draft.trim()) return;
    officeActions.sendMessage(agent.id, draft.trim());
    setDraft("");
  };
  return (
    <div className="flex h-full flex-col">
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-4">
        <SectionTitle>Team MCP messages</SectionTitle>
        <p className="mb-3 text-[13px] text-muted">Agents don't talk to each other directly. Every message goes through Fleet.</p>
        {list.length === 0 && <p className="text-[15px] text-muted">No messages yet.</p>}
        <ul className="flex flex-col gap-2">
          {list.map((m) => {
            const out = m.fromId === agent.id;
            const other = who(out ? m.toId : m.fromId);
            return (
              <li key={m.id} className={`border-2 border-ink px-2.5 py-1.5 ${out ? "ml-8 bg-white" : "mr-8 bg-cream-2"}`}>
                <div className="flex items-center gap-1.5 text-[13px] text-muted">
                  {other && <Dot color={other.color} size={8} />}
                  {out ? `To ${other?.name ?? "?"}` : `From ${other?.name ?? "?"}`}
                  <span className="ml-auto font-term text-[15px]">{ago(m.at, now)}</span>
                </div>
                <Markdown text={m.text} />
              </li>
            );
          })}
        </ul>
      </div>
      <form
        className="flex gap-2 border-t-[3px] border-ink bg-cream p-2"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <input className="field" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={`Message ${agent.name}…`} aria-label={`Message ${agent.name}`} />
        <button className="btn" type="submit" disabled={!draft.trim()}>
          Send
        </button>
      </form>
      <p className="bg-cream px-2 pb-1.5 text-[11px] text-muted">
        {running ? "Delivered now if idle, otherwise when the current turn ends." : `${agent.name} isn't running; it starts and gets this message.`}
      </p>
    </div>
  );
}
