import { useEffect, useState } from "react";
import type { Board, BoardStatus, PastBoard, Task, TaskStatus } from "../../data/types";
import { officeActions, useOffice } from "../../store/office";
import { ui, useUi, wallBoard } from "../../store/ui";
import { Dot } from "../kit";
import { Markdown } from "../Markdown";
import { DrawerHeader } from "./Drawer";

const COLUMNS: { id: TaskStatus; label: string; color: string }[] = [
  { id: "todo", label: "To do", color: "#83769c" },
  { id: "in-progress", label: "Doing", color: "#29adff" },
  { id: "in-review", label: "Review", color: "#ffa300" },
  { id: "done", label: "Done", color: "#00e436" },
  { id: "blocked", label: "Blocked", color: "#ff004d" },
];

const STATUS_LABEL: Record<BoardStatus, string> = { active: "Active", planned: "Planned", done: "Done → History" };

export function BoardsDrawer({ initialBoardId }: { initialBoardId?: string }) {
  const snap = useOffice((s) => s.snap);
  const planBoardId = useUi((s) => s.planBoardId);
  const all = [...(snap?.boards ?? [])].sort((a, b) => a.order - b.order);
  // Done boards live in History, not in the list.
  const boards = all.filter((b) => b.status !== "done");
  const done = all.filter((b) => b.status === "done").sort((a, b) => (b.doneAt ?? "").localeCompare(a.doneAt ?? ""));
  // Opens on the newest board: the work you just sent or saved.
  const [boardId, setBoardId] = useState(initialBoardId ?? boards.at(-1)?.id);
  const [history, setHistory] = useState(false);
  if (!snap) return null;
  // A board marked done moves to History, so the drawer follows it there (not before: Done may wait for your confirmation).
  if (history || done.some((b) => b.id === boardId))
    return (
      <BoardHistory
        boards={done}
        onBack={() => {
          setHistory(false);
          setBoardId(boards.at(-1)?.id);
        }}
      />
    );
  const board = boards.find((b) => b.id === boardId);
  const lead = snap.config.team.find((a) => a.isLead);
  const tasks = snap.tasks.filter((t) => t.boardId === boardId);
  const cols = COLUMNS.filter((c) => c.id !== "blocked" || tasks.some((t) => t.status === "blocked"));
  const shownOnWall = (planBoardId ?? wallBoard(boards)?.id) === boardId;

  return (
    <>
      <DrawerHeader>
        <b className="text-[18px]">Boards</b>
        <span className="text-[14px] text-muted">{boards.length} in {snap.config.project.name}</span>
        <button className="btn ml-auto px-2 text-[14px]" onClick={() => setHistory(true)} title="Boards marked done: what came of them, and Reopen">
          History{done.length ? ` · ${done.length}` : ""}
        </button>
        <button className="btn px-2 text-[14px]" onClick={() => ui.openNewWork()} title="Send a prompt to the lead, on a new board, optionally with extra agents">
          + New work
        </button>
      </DrawerHeader>
      <div className="flex flex-wrap gap-1.5 border-b-[3px] border-ink px-3 py-2">
        {boards.map((b) => (
          <button key={b.id} className="btn px-2 text-[13px]" aria-pressed={b.id === boardId} onClick={() => setBoardId(b.id)}>
            {b.status === "active" && <span className="mr-1 text-blue">●</span>}
            {b.title}
          </button>
        ))}
      </div>
      {board && (
        <div className="flex items-center gap-2 border-b-[3px] border-ink bg-cream-2 px-3 py-1.5 text-[14px]">
          <span className="text-muted">Status</span>
          <select
            className="field w-[120px] py-0 text-[14px]"
            value={board.status}
            onChange={(e) => officeActions.updateBoard(board.id, { status: e.target.value as BoardStatus })}
            title="Done stops this board's agents (each saves a handoff), deletes their worktrees and moves the board to History. If an agent is mid-turn or has uncommitted work, you're asked to confirm first"
          >
            {(Object.keys(STATUS_LABEL) as BoardStatus[]).map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
          <span className="text-[12px] text-muted">Agents only pick tasks from active boards.</span>
          <button className="btn ml-auto px-2 text-[13px]" disabled={shownOnWall} onClick={() => ui.showBoardOnWall(board.id)}>
            {shownOnWall ? "On the wall" : "Show on wall"}
          </button>
        </div>
      )}
      {board?.brief && (
        <div className="border-b-[3px] border-ink px-3 py-2 text-[13px]">
          <div className="flex items-center gap-2">
            <b>{board.brief.investigate ? "Investigation" : "New work"}</b>
            <span className="text-muted">
              {board.brief.startedAt ? `sent to the lead ${new Date(board.brief.startedAt).toLocaleString()}` : "saved, not started"}
              {board.brief.crew.length > 0 && ` · agents: ${board.brief.crew.map((c) => `${c.count}× ${c.role}`).join(", ")}`}
            </span>
            {board.brief.startedAt ? (
              lead && (
                <button className="btn ml-auto px-2 text-[13px]" onClick={() => ui.openAgent(lead.id, "messages")} title={`Plans, answers and results come back in ${lead.name}'s Messages`}>
                  {lead.name}'s replies
                </button>
              )
            ) : (
              <button className="btn ml-auto px-2 text-[13px]" onClick={() => officeActions.startWork(board.id)}>
                Start now
              </button>
            )}
          </div>
          <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-muted" title={board.brief.prompt}>
            {board.brief.prompt}
          </p>
        </div>
      )}
      <div className="scroll-thin grid min-h-0 flex-1 auto-cols-[minmax(200px,1fr)] grid-flow-col gap-2 overflow-auto bg-[#f7f3ea] p-3">
        {cols.map((c) => {
          const list = tasks.filter((t) => t.status === c.id);
          if (c.id === "done") list.reverse();
          return (
            <div key={c.id} className="min-w-0">
              <h4 className="mb-2 flex justify-between border-b-[3px] pb-0.5 text-[14px] font-semibold" style={{ borderColor: c.color }}>
                {c.label} <span className="font-term text-[17px] text-muted">{list.length}</span>
              </h4>
              <div className="flex flex-col gap-2">
                {list.map((t) => (
                  <TaskCard key={t.id} task={t} />
                ))}
              </div>
            </div>
          );
        })}
        {tasks.length === 0 && <p className="col-span-full p-6 text-center text-muted">No tasks on this board yet. The lead adds tasks when a board is active.</p>}
      </div>
    </>
  );
}

/** Boards marked done, newest first: the summary written when each was done, and Reopen. */
/** New work's prompt to pick up a board of another team: what it was and what came of it. */
const revivePrompt = (p: PastBoard) =>
  [
    `Pick up earlier work: "${p.board.title}" (from ${p.teamName}).`,
    "",
    "What it was:",
    p.board.brief?.prompt ?? p.board.title,
    "",
    "What came of it:",
    p.board.summary ?? "No summary yet: its board wasn't marked done. Check its branches and PRs.",
  ]
    .join("\n")
    .slice(0, 4000);

/** Every board of this project, from all its teams: this team's done ones (Reopen) and the other teams' (Revive). */
function BoardHistory({ boards, onBack }: { boards: Board[]; onBack: () => void }) {
  const live = useOffice((s) => s.live);
  const history = useOffice((s) => s.history);
  useEffect(() => officeActions.listHistory(), []);
  // Until Fleet answers: this team's own done boards.
  const past: PastBoard[] = history ?? boards.map((board) => ({ team: "", teamName: "", board, own: true, url: null }));
  return (
    <>
      <DrawerHeader>
        <button className="btn px-2 text-[14px]" onClick={onBack}>
          ← Boards
        </button>
        <b className="text-[18px]">History</b>
        <span className="text-[14px] text-muted">{past.length} in this project</span>
      </DrawerHeader>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto bg-[#f7f3ea] p-3">
        {past.length === 0 && <p className="p-6 text-center text-muted">No finished boards yet. Set a board's status to Done and it moves here, with what came of it.</p>}
        {past.map(({ team, teamName, board: b, own, url }) => (
          <div key={`${team}/${b.id}`} className="mb-3 border-2 border-ink bg-white px-3 py-2 shadow-[0_3px_0_rgba(36,26,46,0.35)]">
            <div className="flex flex-wrap items-center gap-2">
              <b className="text-[15px]">{b.title}</b>
              <span className="text-[12px] text-muted">
                {b.status === "done" ? (b.doneAt ? `done ${new Date(b.doneAt).toLocaleString()}` : "done") : `${b.status} on its team`}
              </span>
              <span className="ml-auto flex gap-1.5">
                {url && (
                  <a className="btn px-2 text-[13px]" href={url} target="_blank" rel="noreferrer" title="Its team's page (that team's Fleet is running)">
                    Open
                  </a>
                )}
                {live && own && (
                  <button className="btn px-2 text-[13px]" onClick={() => (officeActions.reopenBoard(b.id), officeActions.listHistory())} title="Make it active again: the lead gets this summary and carries on">
                    Reopen
                  </button>
                )}
                {live && !own && (
                  <button className="btn px-2 text-[13px]" onClick={() => ui.openNewWork(revivePrompt({ team, teamName, board: b, own, url }))} title="New work on a fresh team, with this board's brief and what came of it">
                    Revive
                  </button>
                )}
              </span>
            </div>
            {!own && <div className="text-[12px] text-muted">{teamName}</div>}
            {b.summary ? (
              <div className="mt-1 text-[13px]">
                <Markdown text={b.summary} lines={6} />
              </div>
            ) : (
              <p className="mt-1 text-[13px] text-muted">{b.brief?.prompt ?? "No summary: it was finished before Fleet kept one."}</p>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

function TaskCard({ task }: { task: Task }) {
  const snap = useOffice((s) => s.snap);
  const owner = snap?.config.team.find((a) => a.id === task.ownerId);
  const workers = snap?.config.team.filter((a) => !a.isLead) ?? [];
  const blockedBy = task.needs.filter((n) => snap?.tasks.find((t) => t.id === n)?.status !== "done");
  return (
    <div className={`border-2 border-ink px-2 py-1.5 shadow-[0_3px_0_rgba(36,26,46,0.35)] ${task.status === "done" ? "bg-[#e8e1d2] text-muted" : "bg-white"}`}>
      <div className="font-term text-[16px] leading-none text-muted">
        {task.id}
        {task.prNumber && <span className="ml-1.5">#{task.prNumber}</span>}
      </div>
      <div
        className={`text-[14px] font-semibold leading-tight ${task.status === "done" ? "line-through" : ""}`}
        title={[task.description, task.files?.length ? `Files: ${task.files.join(", ")}` : "", task.doneWhen ? `Done when: ${task.doneWhen}` : ""].filter(Boolean).join("\n\n") || undefined}
      >
        {task.title}
      </div>
      {task.status === "blocked" && task.note && <div className="text-[12px] text-red">{task.note}</div>}
      <div className="mt-1 flex items-center gap-1.5 text-[12px]">
        {owner ? (
          <>
            <Dot color={owner.color} size={8} /> {owner.name}
          </>
        ) : (
          <span className="text-muted">Unassigned</span>
        )}
      </div>
      {blockedBy.length > 0 && task.status === "todo" && <div className="text-[12px] text-red">Waits on {blockedBy.join(", ")}</div>}
      {task.status === "todo" && (
        <select
          className="field mt-1 py-0 text-[12px]"
          value=""
          onChange={(e) => e.target.value && officeActions.assignTask(task.id, e.target.value)}
          aria-label={`Assign ${task.id}`}
        >
          <option value="">Assign to…</option>
          {workers.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} ({a.role})
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
