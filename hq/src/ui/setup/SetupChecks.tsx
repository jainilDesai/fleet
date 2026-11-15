import { useState } from "react";
import type { SetupCheck } from "../../data/types";
import { officeActions, useOffice } from "../../store/office";

const NONE: SetupCheck[] = [];

const MARK: Record<SetupCheck["status"], { icon: string; color: string }> = {
  ok: { icon: "✓", color: "#00873a" },
  warning: { icon: "!", color: "#a86a00" },
  missing: { icon: "✗", color: "#c2003a" },
  unsupported: { icon: "✗", color: "#c2003a" },
};

/** A command in a monospace box with a Copy button. */
export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <code className="min-w-0 truncate border-2 border-ink bg-cream-2 px-1.5 font-term text-[16px]" title={command}>
        {command}
      </code>
      <button
        className="btn shrink-0 px-2 text-[12px]"
        onClick={() =>
          void navigator.clipboard?.writeText(command).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}

/** "Open in terminal" failed: the command to run yourself, and how to let Fleet open the terminal next time. */
export function TerminalFallback({ error }: { error: { message: string; command: string; hint?: string } }) {
  return (
    <div className="border-[3px] border-ink bg-[#fff1d6] px-3 py-2 text-[13px]">
      <p className="m-0 mb-1">
        Couldn't open a terminal window: <span className="text-muted">{error.message}</span>
      </p>
      <p className="m-0 mb-1">Run this in any terminal to attach to the agent:</p>
      <CopyCommand command={error.command} />
      {error.hint && <p className="m-0 mt-1 text-muted">{error.hint}</p>}
    </div>
  );
}

/** What this machine has for Fleet (tmux, Claude Code, gh, …), each with its fix. Checked when Fleet starts. */
export function SetupChecks() {
  const checks = useOffice((s) => s.snap?.setup.checks ?? NONE);
  if (!checks.length) return null;
  return (
    <ul className="flex flex-col gap-1 text-[14px]">
      {checks.map((c) => (
        <li key={c.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <b className="w-4 text-center" style={{ color: MARK[c.status].color }} aria-label={c.status}>
            {MARK[c.status].icon}
          </b>
          <span className="font-semibold">{c.label}</span>
          <span className="text-muted">{c.detail}</span>
          {c.fix && c.status !== "ok" && <CopyCommand command={c.fix.command} />}
          {c.fix?.docs && c.status !== "ok" && (
            <a className="text-[12px] underline" href={c.fix.docs} target="_blank" rel="noreferrer">
              Help ↗
            </a>
          )}
        </li>
      ))}
      <li>
        <button className="btn mt-1 px-2 text-[12px]" onClick={() => officeActions.recheckSetup()} title="Run the checks again after installing or signing in">
          Check again
        </button>
      </li>
    </ul>
  );
}
