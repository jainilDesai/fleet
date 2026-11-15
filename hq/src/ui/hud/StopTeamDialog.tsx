import { officeActions, useOffice } from "../../store/office";

/** Confirms stopping every running agent, and optionally Fleet itself. */
export function StopTeamDialog({ onClose }: { onClose: () => void }) {
  const snap = useOffice((s) => s.snap);
  const running = (snap?.agents ?? []).filter((a) => a.session.state === "running").map((a) => snap?.config.team.find((c) => c.id === a.agentId)?.name ?? a.agentId);
  const stop = (quit: boolean) => {
    if (quit) officeActions.quitFleet();
    else officeActions.stopTeam();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[rgba(36,26,46,0.55)] p-4" role="dialog" aria-modal="true" aria-label="Stop team">
      <div className="panel w-[min(560px,100%)] p-4">
        <h3 className="mb-1 text-[20px] font-bold">Stop the team?</h3>
        <p className="mb-2 text-[13px] text-muted">
          Running now: <b className="text-ink">{running.join(", ") || "nobody"}</b>
        </p>
        <p className="mb-3 text-[13px] text-muted">
          This ends their Claude Code sessions. Work they already committed stays, and their worktrees, branches, plans and the team are kept. Start team brings them
          back.
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn text-red" onClick={() => stop(true)}>
            Stop agents and quit Fleet
          </button>
          <button className="btn text-red" onClick={() => stop(false)}>
            Stop agents
          </button>
        </div>
      </div>
    </div>
  );
}
