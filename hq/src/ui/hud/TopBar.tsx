import type { SimSpeed } from "../../data/source";
import { officeActions, selectAttention, useOffice } from "../../store/office";
import { ui, useUi } from "../../store/ui";

const SPEEDS: SimSpeed[] = [1, 2, 4];

function Logo() {
  return (
    <svg className="h-[30px] w-[30px] shrink-0" viewBox="0 0 10 10" shapeRendering="crispEdges" aria-hidden>
      <rect x="1" y="1" width="8" height="8" fill="#241a2e" />
      <rect x="2" y="2" width="6" height="6" fill="#29adff" />
      <rect x="3" y="3" width="1" height="2" fill="#fff6e9" />
      <rect x="6" y="3" width="1" height="2" fill="#fff6e9" />
      <rect x="3" y="6" width="4" height="1" fill="#1d2b53" />
      <rect x="4" y="0" width="2" height="1" fill="#ffec27" />
    </svg>
  );
}

export function TopBar() {
  const snap = useOffice((s) => s.snap);
  const speed = useOffice((s) => s.speed);
  const hasDev = useOffice((s) => s.presets !== null);
  const planBoardId = useUi((s) => s.planBoardId);
  const attention = selectAttention(snap).total;
  const debugOpen = useUi((s) => s.debugOpen);
  const live = useOffice((s) => s.live);
  if (!snap) return null;
  // Only the lead is started by hand; the others start when the lead first gives them work.
  const lead = snap.config.team.find((a) => a.isLead);
  const leadStatus = snap.agents.find((a) => a.agentId === lead?.id);
  const leadStopped = leadStatus?.session.state === "stopped" || leadStatus?.session.state === "failed";
  const running = snap.agents.filter((a) => a.session.state === "running").length;
  const boards = [...snap.boards].sort((a, b) => a.order - b.order);
  const active = boards.filter((b) => b.status === "active");
  const openPrs = snap.pullRequests.filter((p) => !p.merged && !p.closed).length;

  return (
    <header className="panel fixed left-4 right-4 top-[10px] z-10 flex h-[50px] items-center gap-4 px-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <Logo />
        <b className="whitespace-nowrap text-[22px] font-bold tracking-[0.02em]">Fleet</b>
        {!live && (
          <span className="chip shrink-0 text-[12px]" style={{ ["--c" as string]: "#ffec27" }} title="Running on mock data. Start the real one with `npm run build && fleet`.">
            Demo data
          </span>
        )}
        <span className="truncate text-[16px] text-muted">
          — <em className="font-semibold not-italic text-ink">{snap.config.project.name}</em>{" "}
          <span className="font-term text-[17px]">{snap.config.project.repo}</span>
        </span>
      </div>
      <div className="flex-1" />

      <label className="flex items-center gap-2 text-[14px]">
        <span className="text-muted">Plan wall</span>
        <select
          className="field w-[190px] py-0 text-[14px]"
          value={planBoardId ?? ""}
          onChange={(e) => ui.showBoardOnWall(e.target.value || null)}
          aria-label="Board shown on the plan wall"
        >
          <option value="">First active ({active[0]?.title ?? "none"})</option>
          {boards.map((b) => (
            <option key={b.id} value={b.id}>
              {b.title} · {b.status}
            </option>
          ))}
        </select>
      </label>

      {hasDev && (
        <div className="flex items-center gap-1.5" role="group" aria-label="Simulation speed">
          {SPEEDS.map((s) => (
            <button key={s} className="btn px-2 text-[14px]" aria-pressed={speed === s} onClick={() => officeActions.setSpeed(s)}>
              {s}x
            </button>
          ))}
        </div>
      )}

      <div className="flex gap-1.5">
        <button className="btn w-8 px-0 text-[18px] leading-none" aria-label="Zoom out" onClick={() => ui.zoom(-1)}>
          −
        </button>
        <button className="btn w-8 px-0 text-[18px] leading-none" aria-label="Zoom in" onClick={() => ui.zoom(1)}>
          +
        </button>
      </div>

      <div
        className="flex items-center gap-2 whitespace-nowrap border-[3px] border-ink bg-navy px-2.5 py-0.5 text-[15px] text-cream"
        title="Each agent runs Claude Code in its own tmux session and git worktree"
      >
        <span>
          Agents · <b>{running}</b> running
        </span>
        <i className="led" style={running ? undefined : { background: "#83769c", animation: "none" }} />
      </div>

      {live && lead && leadStopped && (
        <button className="btn text-[14px]" onClick={() => officeActions.startAgent(lead.id)} title={`Starts ${lead.name}. The others start when ${lead.name} first gives them work.`}>
          Start team
        </button>
      )}
      <div className="flex gap-1.5">
        <button
          className="btn text-[14px]"
          style={attention ? { background: "#ffec27" } : undefined}
          onClick={() => ui.openActions()}
          title="Everything waiting on you"
        >
          Action items{attention ? ` · ${attention}` : ""}
        </button>
        <button className="btn text-[14px]" onClick={() => ui.openBoards(planBoardId ?? undefined)}>
          Boards
        </button>
        <button className="btn text-[14px]" onClick={() => ui.openPrs()}>
          PRs{openPrs ? ` · ${openPrs}` : ""}
        </button>
      </div>
      <button className="btn text-[14px]" onClick={() => ui.openSettings("team")}>
        Settings
      </button>
      <button className="btn text-[14px]" aria-pressed={debugOpen} onClick={() => ui.toggleDebug()} title="Debug panel (D)">
        Debug
      </button>
    </header>
  );
}
