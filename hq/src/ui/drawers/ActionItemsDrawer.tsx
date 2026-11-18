import { useState, type ReactNode } from "react";
import { TRUST_NOTE, type ActionItem } from "../../data/types";
import { officeActions, selectAttention, useOffice } from "../../store/office";
import { ui } from "../../store/ui";
import { ago, Dot, SectionTitle, useNow } from "../kit";
import { DrawerHeader } from "./Drawer";
import { Markdown } from "../Markdown";
import { TrustButton } from "./AgentDrawer";
import { TerminalFallback } from "../setup/SetupChecks";

/** Everything waiting on the user: agents' action items first, then the other things that need them. */
export function ActionItemsDrawer() {
  const snap = useOffice((s) => s.snap);
  const now = useNow(10_000);
  const [showClosed, setShowClosed] = useState(false);
  if (!snap) return null;
  const a = selectAttention(snap);
  const agent = (id: string) => snap.config.team.find((x) => x.id === id);
  const closed = (snap.actionItems ?? [])
    .filter((i) => i.status !== "open")
    .sort((x, y) => (y.closedAt ?? "").localeCompare(x.closedAt ?? ""))
    .slice(0, 20);
  // Waiting items first, then oldest first (what's been waiting longest).
  const open = [...a.items].sort((x, y) => Number(y.waiting) - Number(x.waiting) || x.at.localeCompare(y.at));
  const others = a.asking.length + a.readyPrs.length;

  return (
    <>
      <DrawerHeader>
        <b className="text-[18px]">Action items</b>
        <span className="text-[13px] text-muted">{a.total ? `${a.total} waiting on you` : "Nothing waiting on you"}</span>
      </DrawerHeader>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-4">
        <SectionTitle>From agents</SectionTitle>
        {open.length === 0 ? (
          <p className="mb-4 text-[13px] text-muted">No requests. When an agent needs you to do something it can't do itself, it shows up here.</p>
        ) : (
          <ul className="mb-4 flex flex-col gap-2">
            {open.map((item) => (
              <Item key={item.id} item={item} from={agent(item.fromId)} now={now} />
            ))}
          </ul>
        )}

        {others > 0 && (
          <>
            <SectionTitle>Also waiting on you</SectionTitle>
            <ul className="mb-4 flex flex-col gap-1.5 text-[14px]">
              {a.asking.map((s) => {
                const trust = s.note === TRUST_NOTE && !agent(s.agentId)?.workspacePath;
                return (
                  <Row
                    key={`ask-${s.agentId}`}
                    color={agent(s.agentId)?.color}
                    text={trust ? `${agent(s.agentId)?.name ?? s.agentId} asks you to trust its new worktree (first start only)` : `${agent(s.agentId)?.name ?? s.agentId} is asking you something in its terminal`}
                    button="Open in terminal"
                    onOpen={() => officeActions.openInIterm(s.agentId)}
                    extra={trust ? <TrustButton id={s.agentId} /> : undefined}
                    below={s.session.terminalError ? <TerminalFallback error={s.session.terminalError} /> : undefined}
                  />
                );
              })}
              {a.readyPrs.map((p) =>
                p.url ? (
                  <li key={`pr-${p.number}`} className="flex items-center gap-2 border-[3px] border-ink bg-white px-2.5 py-1.5">
                    <span className="flex-1">
                      PR <b>#{p.number}</b> {p.title} passed review and is ready to merge
                    </span>
                    <a className="btn px-2 text-[12px]" href={p.url} target="_blank" rel="noreferrer">
                      Open ↗
                    </a>
                  </li>
                ) : (
                  <Row key={`pr-${p.number}`} text={`PR #${p.number} ${p.title} passed review and is ready to merge`} onOpen={() => ui.openPrs()} />
                ),
              )}
            </ul>
          </>
        )}

        {closed.length > 0 && (
          <>
            <button className="text-[13px] underline" onClick={() => setShowClosed(!showClosed)}>
              {showClosed ? "Hide closed" : `Show closed (${closed.length})`}
            </button>
            {showClosed && (
              <ul className="mt-2 flex flex-col gap-1 text-[13px] text-muted">
                {closed.map((i) => (
                  <li key={i.id} className="border-t-2 border-dashed border-cream-3 py-1">
                    <span className={i.status === "dismissed" ? "line-through" : ""}>{i.title}</span> · {agent(i.fromId)?.name ?? i.fromId} ·{" "}
                    {i.approval ? (i.status === "done" ? "approved" : "rejected") : i.status} {i.closedAt ? `${ago(i.closedAt, now)} ago` : ""}
                    {i.note && <div className="pl-3">“{i.note}”</div>}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </>
  );
}

function Row({ text, color, button = "Open", onOpen, extra, below }: { text: string; color?: string; button?: string; onOpen: () => void; extra?: ReactNode; below?: ReactNode }) {
  return (
    <li className="flex flex-wrap items-center gap-2 border-[3px] border-ink bg-white px-2.5 py-1.5">
      {color && <Dot color={color} size={8} />}
      <span className="flex-1">{text}</span>
      {extra}
      <button className="btn px-2 text-[12px]" onClick={onOpen}>
        {button}
      </button>
      {below && <div className="basis-full">{below}</div>}
    </li>
  );
}

function Item({ item, from, now }: { item: ActionItem; from?: { id: string; name: string; color: string }; now: number }) {
  if (item.kind === "question") return <QuestionItem item={item} from={from} now={now} />;
  return <RequestItem item={item} from={from} now={now} />;
}

/** An agent's AskUserQuestion: pick an option per question (or write your own); the answers go straight back. */
function QuestionItem({ item, from, now }: { item: ActionItem; from?: { id: string; name: string; color: string }; now: number }) {
  const questions = item.questions ?? [];
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const answerOf = (q: string) => other[q]?.trim() || (picked[q] ?? []).join(", ");
  const ready = questions.every((q) => answerOf(q.question));
  const toggle = (q: string, label: string, multi?: boolean) => {
    setOther((o) => ({ ...o, [q]: "" }));
    setPicked((p) => {
      const cur = p[q] ?? [];
      return { ...p, [q]: multi ? (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]) : [label] };
    });
  };
  return (
    <li className="border-[3px] border-ink bg-white px-3 py-2 shadow-[0_3px_0_rgba(36,26,46,0.35)] outline outline-[3px] outline-orange">
      <div className="flex items-start gap-2">
        <b className="flex-1 text-[15px]">{questions.length > 1 ? `${questions.length} questions` : "Question"}</b>
        <span className="chip shrink-0 text-[11px]" style={{ background: "#e1f0ff" }}>question</span>
      </div>
      <div className="mb-1 flex items-center gap-1.5 text-[12px] text-muted">
        {from && <Dot color={from.color} size={8} />}
        <button className="underline" onClick={() => from && ui.openAgent(from.id, "messages")}>
          {from?.name ?? item.fromId}
        </button>
        {item.taskId && <span>· {item.taskId}</span>}
        <span>· {ago(item.at, now)} ago</span>
      </div>
      {questions.map((q) => (
        <fieldset key={q.question} className="mt-2">
          <legend className="text-[14px] font-semibold">
            {q.header && <span className="mr-1 text-muted">{q.header}:</span>}
            {q.question}
            {q.multiSelect && <span className="ml-1 text-[12px] font-normal text-muted">(pick any)</span>}
          </legend>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {q.options.map((o) => (
              <button
                key={o.label}
                className="btn px-2 text-[13px]"
                aria-pressed={(picked[q.question] ?? []).includes(o.label) && !other[q.question]?.trim()}
                title={o.description}
                onClick={() => toggle(q.question, o.label, q.multiSelect)}
              >
                {o.label}
              </button>
            ))}
          </div>
          <input
            className="field mt-1 w-full text-[13px]"
            value={other[q.question] ?? ""}
            placeholder="Or write your own answer"
            onChange={(e) => setOther((x) => ({ ...x, [q.question]: e.target.value }))}
          />
        </fieldset>
      ))}
      <div className="mt-2 flex items-center justify-end gap-2">
        <button className="btn px-2 text-[12px]" onClick={() => officeActions.resolveActionItem(item.id, "dismissed")} title="The agent asks in its terminal instead">
          Answer in terminal
        </button>
        <button
          className="btn px-2 text-[12px]"
          style={{ background: "#b8f5c4" }}
          disabled={!ready}
          onClick={() => officeActions.answerQuestion(item.id, Object.fromEntries(questions.map((q) => [q.question, answerOf(q.question)])))}
        >
          Send answers
        </button>
      </div>
    </li>
  );
}

function RequestItem({ item, from, now }: { item: ActionItem; from?: { id: string; name: string; color: string }; now: number }) {
  const [note, setNote] = useState("");
  // A permission prompt: Allow / Deny go back to Claude Code (done = allow, dismissed = deny).
  const perm = item.kind === "permission";
  // An approval request: Approve / Reject (done = approved, dismissed = rejected).
  const approval = !perm && !!item.approval;
  const yesNo = perm || approval;
  const [expanded, setExpanded] = useState(false);
  const long = item.details.split("\n").length > 6 || item.details.length > 400;
  return (
    <li className={`border-[3px] border-ink bg-white px-3 py-2 shadow-[0_3px_0_rgba(36,26,46,0.35)] ${item.waiting ? "outline outline-[3px] outline-orange" : ""}`}>
      <div className="flex items-start gap-2">
        <b className="flex-1 text-[15px]">{item.title}</b>
        {perm ? (
          <span className="chip shrink-0 text-[11px]" style={{ background: "#ffe1ea" }}>permission</span>
        ) : (
          item.waiting && <span className="chip shrink-0 text-[11px]" style={{ background: "#fff1d6" }}>waiting</span>
        )}
      </div>
      <div className="mb-1 flex items-center gap-1.5 text-[12px] text-muted">
        {from && <Dot color={from.color} size={8} />}
        <button className="underline" onClick={() => from && ui.openAgent(from.id, "messages")}>
          {from?.name ?? item.fromId}
        </button>
        {item.taskId && <span>· {item.taskId}</span>}
        <span>· {ago(item.at, now)} ago</span>
      </div>
      {item.details && perm && (
        <div className={`whitespace-pre-wrap border-2 border-ink bg-cream-2 px-2 py-1 font-term text-[16px] leading-tight ${long && !expanded ? "line-clamp-6" : ""}`}>{item.details}</div>
      )}
      {/* An agent's request is Markdown (steps, lists); a permission shows the exact command or file as is. */}
      {item.details && !perm && <Markdown text={item.details} lines={10} />}
      {long && perm && (
        <button className="text-[12px] underline" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show less" : "Show all"}
        </button>
      )}
      <div className="mt-2 flex items-center gap-2">
        <input
          className="field min-w-0 flex-1 text-[13px]"
          value={note}
          placeholder={perm ? "Note for the agent, sent with Allow or Deny (optional)" : approval ? "Reason, sent to the agent (optional)" : "Note for the agent (optional, no secrets)"}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !yesNo && officeActions.resolveActionItem(item.id, "done", note)}
        />
        <button className="btn px-2 text-[12px]" style={yesNo ? { background: "#b8f5c4" } : undefined} onClick={() => officeActions.resolveActionItem(item.id, "done", note)}>
          {perm ? "Allow" : approval ? "Approve" : "Done"}
        </button>
        <button className="btn px-2 text-[12px]" style={yesNo ? { background: "#ffc2d1" } : undefined} onClick={() => officeActions.resolveActionItem(item.id, "dismissed", note)}>
          {perm ? "Deny" : approval ? "Reject" : "Dismiss"}
        </button>
      </div>
    </li>
  );
}
