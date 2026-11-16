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
            <a className="btn text-[14px] no-underline" href={p.url ? `${p.url}#new-work` : undefined} title="Opens the project with the New work dialog: a prompt for its lead">
              New work
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

const post = (path: string, body: unknown) =>
  fetch(`/api/home/${path}`, { method: "POST", headers: { "content-type": "application/json", "x-fleet-token": token }, body: JSON.stringify(body) }).then((r) => r.json());

/** New project: pick a folder, optionally a first task for its lead; Fleet starts there and opens it. */
function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const [folder, setFolder] = useState("");
  const [prompt, setPrompt] = useState("");
  const [suggest, setSuggest] = useState<{ folders: string[]; canPick: boolean }>({ folders: [], canPick: false });
  const [needsInit, setNeedsInit] = useState<"repo" | "commit" | null>(null);
  const [init, setInit] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/home/folders")
      .then((r) => r.json())
      .then(setSuggest)
      .catch(() => {});
  }, []);
  const choose = async () => {
    setBusy("Choose the folder in the window that opened…");
    const r = await post("pick", {}).catch(() => null);
    setBusy(null);
    if (r?.path) pick(r.path);
  };
  const pick = (f: string) => {
    setFolder(f);
    setNeedsInit(null);
    setInit(false);
    setError(null);
  };
  const start = async () => {
    setBusy("Starting Fleet in that folder…");
    setError(null);
    const r = await post("create", { folder, init }).catch(() => ({ error: "Fleet's home page isn't answering." }));
    setBusy(null);
    if (r.url) return void location.assign(`${r.url}#new-work${prompt.trim() ? `=${encodeURIComponent(prompt.trim())}` : ""}`);
    setError(r.error ?? "Couldn't start it.");
    if (r.needsInit) setNeedsInit(r.needsInit);
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[rgba(36,26,46,0.55)] p-4" role="dialog" aria-modal="true" aria-label="New project">
      <div className="panel scroll-thin max-h-[90vh] w-[min(620px,100%)] overflow-auto p-4">
        <h3 className="mb-1 text-[20px] font-bold">New project</h3>
        <p className="mb-3 text-[13px] text-muted">Fleet starts a team on a folder. You set up the team next, then your first task goes to its lead.</p>

        <label className="mb-1 flex flex-col gap-1">
          <span className="text-[14px] font-semibold">Folder</span>
          <span className="flex gap-2">
            <input className="field flex-1 font-term text-[17px]" value={folder} onChange={(e) => pick(e.target.value)} list="fleet-folders" placeholder="~/code/my-app" autoFocus />
            {suggest.canPick && (
              <button className="btn" onClick={choose} disabled={!!busy}>
                Choose…
              </button>
            )}
          </span>
          <datalist id="fleet-folders">
            {suggest.folders.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
        </label>
        <p className="mb-3 text-[12px] text-muted">Suggestions are folders you've used Claude Code in. Any folder inside a git repo works; Fleet uses the repo's top folder.</p>

        {needsInit && (
          <label className="mb-3 flex items-start gap-2 border-[3px] border-ink bg-cream-2 p-2 text-[14px]">
            <input type="checkbox" className="mt-1" checked={init} onChange={(e) => setInit(e.target.checked)} />
            <span>
              <b>{needsInit === "repo" ? "Make it a git repo" : "Make the first commit"}</b>
              <span className="block text-[13px] text-muted">
                Agents work in git worktrees, which start from a commit. Fleet runs {needsInit === "repo" ? "git init, then " : ""}a first commit of every file in the folder (except what .gitignore lists). Check there are no secrets in it first.
              </span>
            </span>
          </label>
        )}

        <label className="mb-3 flex flex-col gap-1">
          <span className="text-[14px] font-semibold">
            First task <span className="font-normal text-muted">(optional, sent to the lead after you set up the team)</span>
          </span>
          <textarea className="field min-h-[90px] text-[15px]" value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={4000} placeholder="Add a /health endpoint that returns ok, with a test" />
        </label>

        {error && <p className="mb-2 text-[14px] text-red">{error}</p>}
        {busy && <p className="mb-2 text-[14px] text-muted">{busy}</p>}
        <div className="flex justify-end gap-2">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" onClick={start} disabled={!folder.trim() || !!busy || (!!needsInit && !init)}>
            Start
          </button>
        </div>
      </div>
    </div>
  );
}

export function Home() {
  const [newProject, setNewProject] = useState(false);
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

      <div className="panel flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 text-[15px]">
        <button className="btn" onClick={() => setNewProject(true)}>
          + New project
        </button>
        <span className="text-muted">
          Pick any folder. Or in a terminal: <span className="kbd">cd &lt;repo&gt; &amp;&amp; fleet</span>
        </span>
      </div>
      {newProject && <NewProjectDialog onClose={() => setNewProject(false)} />}
    </main>
  );
}
