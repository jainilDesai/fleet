// Fleet's home page (served by `fleet home` on its fixed port): every project, what runs, what
// needs you, what it costs; Open, Start, Stop, and Forget for projects whose repo is gone.

import { useCallback, useEffect, useState } from "react";
import { Logo } from "../ui/Logo";

interface Cost {
  today: number;
  week: number;
  all: number;
}
interface Project {
  slug: string;
  name: string;
  repo: string;
  missing: boolean;
  running: boolean;
  url: string | null;
  autostart: boolean;
  summary: { agents: number; agentsRunning: number; needsYou: number; openPrs: number } | null;
  cost: Cost;
}
interface HomeState {
  port: number;
  projects: Project[];
  total: Cost;
}

const token = (window as { __FLEET_PAGE_TOKEN__?: string }).__FLEET_PAGE_TOKEN__ ?? "";
const usd = (n: number) => `$${n < 100 ? n.toFixed(2) : Math.round(n).toLocaleString("en-US")}`;
const COST_TIP = "API-equivalent cost: what these sessions' tokens would cost at API prices. On a Claude plan (Pro, Max) you don't pay this per session.";

function CostRow({ cost, dark }: { cost: Cost; dark?: boolean }) {
  return (
    <span className={`flex gap-3 font-term text-[18px] ${dark ? "" : "text-ink"}`} title={COST_TIP}>
      <span>
        <span className={dark ? "text-cream-3" : "text-muted"}>Today</span> {usd(cost.today)}
      </span>
      <span>
        <span className={dark ? "text-cream-3" : "text-muted"}>7 days</span> {usd(cost.week)}
      </span>
      <span>
        <span className={dark ? "text-cream-3" : "text-muted"}>All time</span> {usd(cost.all)}
      </span>
    </span>
  );
}

function Card({ p, act }: { p: Project; act: (path: string, slug: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const run = (path: string) => () => {
    setBusy(true);
    act(path, p.slug).finally(() => setBusy(false));
  };
  const s = p.summary;
  const status = p.missing ? { label: "Repo gone", c: "#83769c" } : p.running ? { label: "Running", c: "#00e436" } : { label: "Stopped", c: "#f0dfc2" };
  return (
    <article className={`panel flex flex-col gap-2 p-4 ${p.missing ? "opacity-60" : ""}`}>
      <div className="flex items-center gap-2">
        <h2 className="min-w-0 truncate text-[20px] font-bold" title={p.name}>
          {p.name}
        </h2>
        <span className="chip chip-dot" style={{ ["--c" as string]: status.c }}>
          {status.label}
        </span>
        {p.autostart && (
          <span className="chip" title="Starts at login (fleet --autostart)">
            At login
          </span>
        )}
      </div>
      {/* rtl: a long path loses its start, not the folder name. */}
      <div className="truncate text-left font-term text-[17px] text-muted [direction:rtl]" title={p.repo}>
        <bdi>{p.repo}</bdi>
      </div>
      {p.running && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[15px]">
          <a className="font-term text-[18px] text-navy underline" href={p.url ?? undefined}>
            {p.url?.replace("http://", "")}
          </a>
          {s ? (
            <>
              <span>
                <b>{s.agentsRunning}</b>/{s.agents} agents running
              </span>
              <span className="chip" style={s.needsYou ? { ["--c" as string]: "#ffec27" } : undefined} title="Action items: everything waiting on you">
                {s.needsYou ? `${s.needsYou} need${s.needsYou === 1 ? "s" : ""} you` : "Nothing needs you"}
              </span>
              <span>
                <b>{s.openPrs}</b> open PR{s.openPrs === 1 ? "" : "s"}
              </span>
            </>
          ) : (
            <span className="text-muted">Starting…</span>
          )}
        </div>
      )}
      <CostRow cost={p.cost} />
      <div className="mt-1 flex gap-2">
        {p.missing ? (
          <button
            className="btn text-[14px]"
            disabled={busy}
            onClick={() => {
              if (confirm(`Forget ${p.name}? This deletes Fleet's folder for it (~/.fleet/projects/${p.slug}: team, plan, agents' worktrees). The repo is already gone; nothing else is touched.`)) run("forget")();
            }}
          >
            Forget
          </button>
        ) : p.running ? (
          <>
            <a className="btn text-[14px] no-underline" href={p.url ?? undefined}>
              Open
            </a>
            <button className="btn text-[14px]" disabled={busy} onClick={run("stop")} title="Stops this project's Fleet, like fleet --stop. Agents' tmux sessions keep running.">
              Stop
            </button>
          </>
        ) : (
          <button className="btn text-[14px]" disabled={busy} onClick={run("start")} title={p.autostart ? "Starts its login item now" : "Starts fleet --repo <repo> --no-open in the background"}>
            {busy ? "Starting…" : "Start"}
          </button>
        )}
      </div>
    </article>
  );
}

export function Home() {
  const [state, setState] = useState<HomeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    () =>
      fetch("/api/home")
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((s: HomeState) => (setState(s), setError(null)))
        .catch(() => setError("Fleet's home page isn't answering. Run fleet home to start it again.")),
    [],
  );
  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);
  const act = async (path: string, slug: string) => {
    await fetch(`/api/home/${path}`, { method: "POST", headers: { "content-type": "application/json", "x-fleet-token": token }, body: JSON.stringify({ slug }) });
    await load();
  };

  const projects = state?.projects ?? [];
  const running = projects.filter((p) => p.running).length;
  return (
    <main className="mx-auto flex max-w-[1100px] flex-col gap-4 p-4">
      <header className="panel-dark flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <Logo size={34} />
          <h1 className="text-[26px] font-bold tracking-[0.02em]">Fleet</h1>
        </div>
        <span className="text-[17px]">
          <b>{projects.length}</b> project{projects.length === 1 ? "" : "s"} · <b>{running}</b> running
        </span>
        <div className="flex-1" />
        <div className="flex flex-col items-end">
          <span className="text-[12px] uppercase tracking-[0.12em] text-cream-3" title={COST_TIP}>
            API-equivalent cost ⓘ
          </span>
          {state && <CostRow cost={state.total} dark />}
        </div>
      </header>

      {error && <div className="panel border-red px-4 py-2 text-[15px]">{error}</div>}

      <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {projects.map((p) => (
          <Card key={p.slug} p={p} act={act} />
        ))}
      </section>

      <div className="panel px-4 py-3 text-[15px]">
        <b>Start a new project:</b> <span className="kbd">cd &lt;repo&gt; &amp;&amp; fleet</span>
        {state && !projects.length && <span className="text-muted"> — your projects show up here once Fleet has run in them.</span>}
      </div>
    </main>
  );
}
