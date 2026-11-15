import { useState } from "react";
import { DEFAULT_ROLES, LEAD_NAME, nextAgentName } from "../../data/names";
import type { ReviewTool } from "../../data/types";
import { officeActions, reviewToolLabel, useOffice } from "../../store/office";
import { agentPalette } from "../../theme/tokens";
import { Field, Portrait } from "../kit";
import { RolePicker, useRoles } from "../settings/RolePicker";
import { SetupChecks } from "./SetupChecks";

interface WorkerDraft {
  name: string;
  role: string;
}

const MAX_WORKERS = 11;

/** First run on a repo: name the project and pick the team. Nothing is saved until "Create team". */
export function WelcomeModal() {
  const snap = useOffice((s) => s.snap);
  const [projectName, setProjectName] = useState(snap?.config.project.name ?? "");
  const [leadName, setLeadName] = useState(LEAD_NAME);
  const [workers, setWorkers] = useState<WorkerDraft[]>(DEFAULT_ROLES.map((r) => ({ name: r, role: r })));
  // Defaults come from what Fleet detected in the repo (e.g. a CodeRabbit config). No GitHub remote or gh: no PRs to review.
  const checks = snap?.setup.checks ?? [];
  const github = ["gh", "gh-remote"].every((id) => checks.find((c) => c.id === id)?.status === "ok");
  const [reviewEnabled, setReviewEnabled] = useState((snap?.config.workflow.review.enabled ?? true) && github);
  const [reviewTool, setReviewTool] = useState<ReviewTool>(snap?.config.workflow.review.tool ?? "human");
  const [sending, setSending] = useState(false);
  const roles = useRoles();
  if (!snap) return null;

  const setWorker = (i: number, patch: Partial<WorkerDraft>) => setWorkers((ws) => ws.map((w, j) => (j === i ? { ...w, ...patch } : w)));
  const addWorker = () => setWorkers((ws) => [...ws, { name: nextAgentName([leadName, ...ws.map((w) => w.name)]), role: "Developer" }]);
  const valid = leadName.trim() && workers.length > 0 && workers.every((w) => w.name.trim());

  const submit = () => {
    if (!valid) return;
    setSending(true);
    officeActions.completeWelcome({
      projectName: projectName.trim(),
      lead: { name: leadName, cli: "claude" },
      workers: workers.map((w) => ({ ...w, cli: "claude" })),
      reviewTool,
      reviewEnabled,
    });
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[rgba(36,26,46,0.55)] p-4" role="dialog" aria-modal="true" aria-label="Set up your team">
      <div className="panel flex max-h-[calc(100dvh-2rem)] w-[min(720px,100%)] flex-col">
        <div className="border-b-[3px] border-ink px-4 py-2">
          <h2 className="m-0 text-[22px] font-bold">Set up your team</h2>
          <p className="m-0 text-[14px] text-muted">
            For <b className="text-ink">{snap.config.project.repo || snap.config.project.name}</b>. You can change all of this later in Settings.
          </p>
        </div>

        <div className="scroll-thin flex min-h-0 flex-col gap-4 overflow-y-auto px-4 py-3">
          <section>
            <h3 className="mb-1 text-[16px] font-bold">This Mac</h3>
            <SetupChecks />
            {!snap.setup.localReady && <p className="mt-1 text-[13px] text-red">Agents can't start until the ✗ items above are fixed. Fix them, then press Check again.</p>}
          </section>

          <Field label="Project name">
            <input className="field w-full" value={projectName} maxLength={80} onChange={(e) => setProjectName(e.target.value)} />
          </Field>

          <section>
            <h3 className="mb-1 text-[16px] font-bold">Lead</h3>
            <p className="mb-2 text-[13px] text-muted">You talk to the lead. It plans the work, creates tasks and hands them to the others.</p>
            <div className="grid grid-cols-[40px_1fr] items-end gap-2">
              <Portrait color={agentPalette[0]} lead />
              <Field label="Name">
                <input className="field w-full" value={leadName} maxLength={40} onChange={(e) => setLeadName(e.target.value)} />
              </Field>
            </div>
          </section>

          <section>
            <h3 className="mb-1 text-[16px] font-bold">Team · {workers.length}</h3>
            <p className="mb-2 text-[13px] text-muted">
              Each one gets its own desk and git worktree, and starts when the lead first gives it work. A role you saved (Settings → Team → Save as my role) brings its ROLE.md and skills.
            </p>
            <div className="flex flex-col gap-2">
              {workers.map((w, i) => (
                <div key={i} className="grid grid-cols-[40px_1fr_1fr_auto] items-end gap-2">
                  <Portrait color={agentPalette[(i + 1) % agentPalette.length]} lead={false} />
                  <Field label="Name">
                    <input className="field w-full" value={w.name} maxLength={40} onChange={(e) => setWorker(i, { name: e.target.value })} />
                  </Field>
                  <Field label="Role">
                    <RolePicker value={w.role} roles={roles} onChange={(role) => setWorker(i, { role })} />
                  </Field>
                  <button
                    className="btn px-2 text-[13px]"
                    disabled={workers.length === 1}
                    aria-label={`Remove ${w.name || "agent"}`}
                    onClick={() => setWorkers((ws) => ws.filter((_, j) => j !== i))}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
            <button className="btn mt-2 text-[13px]" disabled={workers.length >= MAX_WORKERS} onClick={addWorker}>
              + Add agent
            </button>
          </section>

          <section>
            <h3 className="mb-1 text-[16px] font-bold">Code review</h3>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-[14px]">
                <input type="checkbox" checked={reviewEnabled} onChange={(e) => setReviewEnabled(e.target.checked)} />
                Review PRs before merge
              </label>
              <select className="field w-[220px]" value={reviewTool} disabled={!reviewEnabled} onChange={(e) => setReviewTool(e.target.value as ReviewTool)} aria-label="Review tool">
                {(Object.keys(reviewToolLabel) as ReviewTool[]).map((t) => (
                  <option key={t} value={t}>
                    {reviewToolLabel[t]}
                  </option>
                ))}
              </select>
            </div>
            {!github && <p className="mt-1 text-[13px] text-muted">No GitHub remote or GitHub CLI, so there are no PRs to review: agents work on branches you merge locally.</p>}
          </section>
        </div>

        <div className="flex items-center justify-between gap-3 border-t-[3px] border-ink px-4 py-2">
          <span className="text-[12px] text-muted">Saved in ~/.fleet, never in your repo. Agents don't start until you press Start team.</span>
          <button className="btn" disabled={!valid || sending} onClick={submit}>
            {sending ? "Creating…" : "Create team"}
          </button>
        </div>
      </div>
    </div>
  );
}
