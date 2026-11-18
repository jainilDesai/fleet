import { useState, type ReactNode } from "react";
import { TRUST_NOTE, type ActionItem, type AskQuestion } from "../../data/types";
import { officeActions, selectAttention, useOffice } from "../../store/office";
import { ui } from "../../store/ui";
import { ago, Dot, SectionTitle, useNow } from "../kit";
import { DrawerHeader } from "./Drawer";
import { Markdown } from "../Markdown";
import { TrustButton } from "./AgentDrawer";
import { TerminalFallback } from "../setup/SetupChecks";

const rank = (i: ActionItem) => (i.kind === "question" ? 0 : i.kind === "permission" ? 1 : 2);

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
            {/* An agent waiting on your answer comes first: questions, then permission prompts. */}
            {[...open].sort((a, b) => rank(a) - rank(b)).map((item) => (
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

/** An agent's AskUserQuestion: a choice per question (or your own words); the answers go straight back. */
function QuestionItem({ item, from, now }: { item: ActionItem; from?: { id: string; name: string; color: string }; now: number }) {
  const questions = item.questions ?? [];
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string | null>>({}); // null = "Other" not chosen
  const answerOf = (q: AskQuestion) => {
    const chosen = picked[q.question] ?? [];
    const ownOn = other[q.question] != null;
    const own = ownOn ? other[q.question]!.trim() : "";
    if (q.multiSelect) return [...chosen, ...(own ? [own] : [])].join(", ");
    return ownOn ? own : chosen[0] ?? "";
  };
  const answered = questions.filter((q) => answerOf(q)).length;
  const choose = (q: AskQuestion, label: string) => {
    if (q.multiSelect) return setPicked((p) => ({ ...p, [q.question]: (p[q.question] ?? []).includes(label) ? (p[q.question] ?? []).filter((l) => l !== label) : [...(p[q.question] ?? []), label] }));
    setPicked((p) => ({ ...p, [q.question]: [label] }));
    setOther((o) => ({ ...o, [q.question]: null }));
  };
  const chooseOther = (q: AskQuestion) => {
    if (!q.multiSelect) setPicked((p) => ({ ...p, [q.question]: [] }));
    setOther((o) => ({ ...o, [q.question]: q.multiSelect && o[q.question] != null ? null : o[q.question] ?? "" }));
  };
  return (
    <li className="border-[3px] border-ink bg-white px-3 py-2 shadow-[0_3px_0_rgba(36,26,46,0.35)] outline outline-[3px] outline-orange">
      <div className="mb-1 flex items-center gap-1.5 text-[13px]">
        {from && <Dot color={from.color} size={8} />}
        <button className="font-semibold underline" onClick={() => from && ui.openAgent(from.id, "messages")}>
          {from?.name ?? item.fromId}
        </button>
        <span className="text-muted">asks you{questions.length > 1 ? ` ${questions.length} questions` : ""}</span>
        {item.taskId && <span className="text-muted">· {item.taskId}</span>}
        <span className="text-muted">· {ago(item.at, now)} ago</span>
        <span className="chip ml-auto shrink-0 text-[11px]" style={{ background: "#e1f0ff" }}>
          question
        </span>
      </div>
      {questions.map((q, qi) => {
        const group = `${item.id}-${qi}`;
        const ownOn = other[q.question] != null;
        return (
          <fieldset key={q.question} className="mt-2">
            <legend className="mb-1.5 text-[15px] font-semibold leading-snug">
              {q.header && (
                <span className="chip mr-1.5 align-middle text-[11px]" style={{ background: "#fff1d6" }}>
                  {q.header}
                </span>
              )}
              {q.question}
              <span className="ml-1 text-[12px] font-normal text-muted">{q.multiSelect ? "Choose any" : "Choose one"}</span>
            </legend>
            <div className="flex flex-col gap-1.5">
              {q.options.map((o) => {
                const on = (picked[q.question] ?? []).includes(o.label);
                return (
                  <label
                    key={o.label}
                    className={`flex cursor-pointer items-start gap-2 border-2 px-2.5 py-1.5 ${on ? "border-ink bg-[#fff6c9] shadow-[0_2px_0_rgba(36,26,46,0.35)]" : "border-[#c9bfae] bg-white hover:border-ink"}`}
                  >
                    <input
                      type={q.multiSelect ? "checkbox" : "radio"}
                      name={group}
                      className="mt-1 h-4 w-4 shrink-0 accent-[#241a2e]"
                      checked={on}
                      onChange={() => choose(q, o.label)}
                    />
                    <span>
                      <span className="block text-[14px] font-semibold leading-tight">{o.label}</span>
                      {o.description && <span className="block text-[13px] leading-snug text-muted">{o.description}</span>}
                    </span>
                  </label>
                );
              })}
              <label className={`flex cursor-pointer items-start gap-2 border-2 px-2.5 py-1.5 ${ownOn ? "border-ink bg-[#fff6c9]" : "border-dashed border-[#c9bfae] bg-white hover:border-ink"}`}>
                <input
                  type={q.multiSelect ? "checkbox" : "radio"}
                  name={group}
                  className="mt-1 h-4 w-4 shrink-0 accent-[#241a2e]"
                  checked={ownOn}
                  onChange={() => chooseOther(q)}
                />
                <span className="block text-[14px] font-semibold leading-tight">Something else</span>
              </label>
              {ownOn && (
                <input
                  className="field ml-6 text-[13px]"
                  autoFocus
                  aria-label={`Your answer: ${q.question}`}
                  value={other[q.question] ?? ""}
                  placeholder="Write your answer"
                  onChange={(e) => setOther((x) => ({ ...x, [q.question]: e.target.value }))}
                />
              )}
            </div>
          </fieldset>
        );
      })}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-[12px] text-muted">
          {questions.length > 1 ? `${answered} of ${questions.length} answered` : answered ? "Ready to send" : "Pick an answer"}
        </span>
        <button className="btn ml-auto px-2 text-[12px]" onClick={() => officeActions.resolveActionItem(item.id, "dismissed")} title="Close this here; the agent asks in its terminal instead">
          Answer in terminal
        </button>
        <button
          className="btn px-3 text-[13px] font-semibold"
          style={{ background: answered === questions.length ? "#b8f5c4" : undefined }}
          disabled={answered < questions.length}
          onClick={() => officeActions.answerQuestion(item.id, Object.fromEntries(questions.map((q) => [q.question, answerOf(q)])))}
        >
          Send {questions.length > 1 ? "answers" : "answer"}
        </button>
      </div>
    </li>
  );
}

/** An AskUserQuestion from before Fleet 0.10 came as an Allow/Deny prompt with JSON: its questions, readable. */
function legacyQuestions(item: ActionItem): AskQuestion[] | null {
  if (item.kind !== "permission" || item.title !== "Use AskUserQuestion") return null;
  try {
    const qs = (JSON.parse(item.details) as { questions?: AskQuestion[] }).questions;
    return Array.isArray(qs) && qs.every((q) => typeof q?.question === "string" && Array.isArray(q.options)) ? qs : null;
  } catch {
    return null;
  }
}

function QuestionList({ questions }: { questions: AskQuestion[] }) {
  return (
    <div className="flex flex-col gap-2">
      {questions.map((q) => (
        <div key={q.question}>
          <b className="text-[14px]">{q.question}</b>
          <ul className="mt-0.5 list-disc pl-5 text-[13px]">
            {q.options.map((o) => (
              <li key={o.label}>
                <b>{o.label}</b>
                {o.description && <span className="text-muted"> · {o.description}</span>}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
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
  const legacy = legacyQuestions(item);
  const long = !legacy && (item.details.split("\n").length > 6 || item.details.length > 400);
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
      {legacy && <QuestionList questions={legacy} />}
      {item.details && perm && !legacy && (
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
