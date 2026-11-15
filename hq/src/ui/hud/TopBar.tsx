import { useEffect, useState } from "react";
import type { SimSpeed } from "../../data/source";
import { officeActions, selectAttention, useOffice } from "../../store/office";
import { ui, useUi } from "../../store/ui";
import { Logo } from "../Logo";
import { StopTeamDialog } from "./StopTeamDialog";

const SPEEDS: SimSpeed[] = [1, 2, 4];

interface Fleet {
  slug: string;
  name: string;
  repo: string;
  url: string;
  current: boolean;
}

/** The home page's URL, written into the page by Fleet's server (unset in `npm run dev`). */
const home = (window as { __FLEET_HOME__?: string }).__FLEET_HOME__;
const homeUrl = home && !home.startsWith("__") ? home : "http://localhost:7788";

/** The other Fleet projects running on this Mac (from Fleet's registry), as links. Hidden when there are none. */
function ProjectSwitcher() {
  const [others, setOthers] = useState<Fleet[]>([]);
  useEffect(() => {
    const load = () =>
      fetch("/api/fleets")
        .then((r) => (r.ok ? r.json() : []))
        .then((list: Fleet[]) => setOthers(list.filter((f) => !f.current)))
        .catch(() => setOthers([]));
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);
  if (!others.length) return null;
  return (
    <details className="relative shrink-0">
      <summary className="btn list-none px-2 text-[14px] [&::-webkit-details-marker]:hidden" title="Other Fleet projects running on this Mac">
        ⇄ {others.length}
      </summary>
      <ul className="panel absolute left-0 top-[34px] min-w-[220px] py-1">
        {others.map((f) => (
          <li key={f.url}>
            <a className="block px-3 py-1 text-[15px] hover:bg-white" href={f.url} title={f.repo}>
              <b>{f.slug}</b> <span className="font-term text-[16px] text-muted">{f.url.replace("http://", "")}</span>
            </a>
          </li>
        ))}
      </ul>
    </details>
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
  const quit = useOffice((s) => s.quit);
  const [stopping, setStopping] = useState(false);
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
    <header className="panel fixed left-4 right-4 top-[10px] z-20 flex h-[50px] items-center gap-2 px-3 2xl:gap-4">
      <div className="flex min-w-0 items-center gap-2.5">
        <Logo />
        <b className="whitespace-nowrap text-[22px] font-bold tracking-[0.02em]">Fleet</b>
        {!live && (
          <span className="chip shrink-0 text-[12px]" style={{ ["--c" as string]: "#ffec27" }} title="Running on mock data. Start the real one with `npm run build && fleet`.">
            Demo data
          </span>
        )}
        {/* The project name gives way first at 1280px (Home and ⇄ stay whole); the repo path only shows on wide screens (hover shows both). */}
        <span className="min-w-[6ch] max-w-[24ch] truncate text-[16px] text-muted 2xl:max-w-none 2xl:shrink" title={`${snap.config.project.name} · ${snap.config.project.repo}`}>
          — <em className="font-semibold not-italic text-ink">{snap.config.project.name}</em>{" "}
          <span className="hidden font-term text-[17px] 2xl:inline">{snap.config.project.repo}</span>
        </span>
        {live && (
          <a className="btn shrink-0 px-2 text-[14px] no-underline" href={homeUrl} title="Fleet's home page: every project, what's running, cost">
            Home
          </a>
        )}
        {live && <ProjectSwitcher />}
      </div>
      <div className="flex-1" />

      <label className="flex shrink-0 items-center gap-2 text-[14px]">
        <span className="hidden whitespace-nowrap text-muted 2xl:inline">Plan wall</span>
        <select
          className="field w-[140px] py-0 text-[14px] 2xl:w-[190px]"
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
          <span className="hidden 2xl:inline">Agents · </span>
          <b>{running}</b> running
        </span>
        <i className="led" style={running ? undefined : { background: "#83769c", animation: "none" }} />
      </div>

      {live && !quit && lead && leadStopped && (
        <button className="btn text-[14px]" onClick={() => officeActions.startAgent(lead.id)} title={`Starts ${lead.name}. The others start when ${lead.name} first gives them work.`}>
          Start team
        </button>
      )}
      {live && running > 0 && (
        <button className="btn text-[14px]" onClick={() => setStopping(true)} title="Stop every running agent, and optionally Fleet too">
          Stop team
        </button>
      )}
      {stopping && <StopTeamDialog onClose={() => setStopping(false)} />}
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
