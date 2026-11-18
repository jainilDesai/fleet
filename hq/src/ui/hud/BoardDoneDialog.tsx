import { officeActions, useOffice } from "../../store/office";

/** Confirms a Done that would stop agents mid-turn or put uncommitted work at risk. Until then the board stays put. */
export function BoardDoneDialog() {
  const check = useOffice((s) => s.doneCheck);
  if (!check) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[rgba(36,26,46,0.55)] p-4" role="dialog" aria-modal="true" aria-label="Mark board done">
      <div className="panel w-[min(560px,100%)] p-4">
        <h3 className="mb-1 text-[20px] font-bold">Mark "{check.title}" done?</h3>
        <p className="mb-2 text-[13px] text-muted">This board isn't finished. It stays where it is unless you confirm.</p>
        <ul className="mb-3 list-disc pl-5 text-[13px]">
          {check.running.length > 0 && (
            <li>
              Working right now: <b>{check.running.join(", ")}</b>. Done stops them mid-turn.
            </li>
          )}
          {check.openTasks.length > 0 && (
            <li>
              {check.openTasks.length} task{check.openTasks.length > 1 ? "s" : ""} not done:
              <ul className="list-[circle] pl-5 text-muted">
                {check.openTasks.slice(0, 6).map((t) => (
                  <li key={t}>{t}</li>
                ))}
                {check.openTasks.length > 6 && <li>and {check.openTasks.length - 6} more</li>}
              </ul>
            </li>
          )}
          {check.dirty.map((d) => (
            <li key={d.name}>
              <b>{d.name}</b> has {d.files} uncommitted file{d.files > 1 ? "s" : ""}.
            </li>
          ))}
        </ul>
        <p className="mb-3 text-[13px] text-muted">
          If you confirm, each agent saves a handoff and stops, and the board moves to History. Folders with uncommitted work are not deleted: you're asked about
          them in Action items.
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <button className="btn" onClick={() => officeActions.answerDone(false)} autoFocus>
            Keep the board
          </button>
          <button className="btn text-red" onClick={() => officeActions.answerDone(true)}>
            Mark done anyway
          </button>
        </div>
      </div>
    </div>
  );
}
