import { useOffice } from "../../store/office";

/** New work's separate team is running: a link to its page (it's on the home page too). */
export function TeamStartedBanner() {
  const t = useOffice((s) => s.teamStarted);
  if (!t) return null;
  return (
    <div className="fixed bottom-4 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 border-[3px] border-ink bg-cream px-3 py-2 shadow-[0_3px_0_rgba(36,26,46,0.35)]" role="status">
      <span className="text-[14px]">
        <b>{t.title}</b> has its own team.
      </span>
      <a className="btn px-2 text-[13px]" href={t.url} target="_blank" rel="noreferrer">
        Open its page ↗
      </a>
      <button className="btn px-2 text-[13px]" aria-label="Dismiss" onClick={() => useOffice.setState({ teamStarted: null })}>
        ×
      </button>
    </div>
  );
}
