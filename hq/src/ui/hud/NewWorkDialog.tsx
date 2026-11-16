import { useEffect, useState } from "react";
import { BUILT_IN_ROLES, LEAD_NAME } from "../../data/names";
import { officeActions, useOffice } from "../../store/office";
import { ui } from "../../store/ui";

/** Matches CREW_MAX in hq/server/commands.ts. */
const CREW_MAX = 6;

/** New work: your prompt goes to the lead, on a board of its own, optionally with extra agents. */
export function NewWorkDialog() {
  const snap = useOffice((s) => s.snap);
  const saved = useOffice((s) => s.roles);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [investigate, setInvestigate] = useState(false);
  const [extra, setExtra] = useState(false);
  const [counts, setCounts] = useState<Record<string, number>>({ Implementer: 1 });
  useEffect(() => officeActions.listRoles(), []);
  if (!snap) return null;

  const lead = snap.config.team.find((a) => a.isLead)?.name ?? LEAD_NAME;
  const roles = [...BUILT_IN_ROLES, ...(saved ?? []).filter((r) => !r.builtIn && !r.lead).map((r) => r.name)];
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const crew = extra ? Object.entries(counts).filter(([, n]) => n > 0).map(([role, count]) => ({ role, count })) : [];
  const set = (role: string, n: number) => setCounts((c) => ({ ...c, [role]: Math.max(0, Math.min(3, n, (c[role] ?? 0) + CREW_MAX - total)) }));
  const submit = (startNow: boolean) => {
    officeActions.newWork({ title: title.trim() || undefined, prompt: prompt.trim(), investigate, crew, startNow });
    ui.closeNewWork();
    if (!startNow) ui.openBoards();
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[rgba(36,26,46,0.55)] p-4" role="dialog" aria-modal="true" aria-label="New work">
      <div className="panel scroll-thin max-h-[90vh] w-[min(620px,100%)] overflow-auto p-4">
        <h3 className="mb-1 text-[20px] font-bold">New work</h3>
        <p className="mb-3 text-[13px] text-muted">
          Goes to {lead} on a board of its own. {lead} plans it, asks you to approve the plan in Action items, and hands out the tasks.
        </p>

        <label className="mb-2 flex flex-col gap-1">
          <span className="text-[14px] font-semibold">What should the team do?</span>
          <textarea className="field min-h-[120px] text-[15px]" value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={4000} autoFocus placeholder="Add a /health endpoint that returns ok, with a test" />
        </label>
        <label className="mb-3 flex flex-col gap-1">
          <span className="text-[14px] font-semibold">
            Board name <span className="font-normal text-muted">(optional, defaults to the first line)</span>
          </span>
          <input className="field" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} />
        </label>

        <label className="mb-3 flex items-start gap-2 text-[14px]">
          <input type="checkbox" className="mt-1" checked={investigate} onChange={(e) => setInvestigate(e.target.checked)} />
          <span>
            <b>Investigation only</b>
            <span className="block text-[13px] text-muted">Find out and report back with evidence: no code changes, no branches, no PRs.</span>
          </span>
        </label>

        <fieldset className="mb-3 border-[3px] border-ink p-3">
          <legend className="px-1 text-[14px] font-semibold">Agents</legend>
          <label className="mb-1 flex items-start gap-2 text-[14px]">
            <input type="radio" name="crew" className="mt-1" checked={!extra} onChange={() => setExtra(false)} />
            <span>
              <b>Current team</b>
              <span className="block text-[13px] text-muted">No new agents or worktrees. Work queues behind what they're doing now.</span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-[14px]">
            <input type="radio" name="crew" className="mt-1" checked={extra} onChange={() => setExtra(true)} />
            <span>
              <b>Add agents for this work</b>
              <span className="block text-[13px] text-muted">Runs next to the current work. Each new agent gets its own worktree and branch from main, and starts on its first task.</span>
            </span>
          </label>
          {extra && (
            <div className="mt-2 grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 pl-6">
              {roles.map((r) => (
                <div key={r} className="contents">
                  <span className="text-[14px]">{r}</span>
                  <span className="flex items-center gap-1">
                    <button className="btn w-7 px-0" aria-label={`Fewer ${r}`} onClick={() => set(r, (counts[r] ?? 0) - 1)} disabled={!counts[r]}>
                      −
                    </button>
                    <span className="w-5 text-center font-term text-[18px]">{counts[r] ?? 0}</span>
                    <button className="btn w-7 px-0" aria-label={`More ${r}`} onClick={() => set(r, (counts[r] ?? 0) + 1)} disabled={(counts[r] ?? 0) >= 3 || total >= CREW_MAX}>
                      +
                    </button>
                  </span>
                </div>
              ))}
              <span className="col-span-2 text-[12px] text-muted">
                Up to 3 per role, {CREW_MAX} in all. {lead} can ask you for more later; you approve each one. Remove them in Settings → Team when the work is done.
              </span>
            </div>
          )}
        </fieldset>

        <div className="flex flex-wrap justify-end gap-2">
          <button className="btn" onClick={() => ui.closeNewWork()}>
            Cancel
          </button>
          <button className="btn" disabled={!prompt.trim()} onClick={() => submit(false)} title="Saves it on a planned board. Start it from Boards whenever you want.">
            Save for later
          </button>
          <button className="btn" disabled={!prompt.trim() || (extra && crew.length === 0)} onClick={() => submit(true)}>
            Send to {lead}
          </button>
        </div>
      </div>
    </div>
  );
}
