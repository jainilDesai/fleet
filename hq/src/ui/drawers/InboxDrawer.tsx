import { useEffect, useState } from "react";
import { HUMAN_ID } from "../../data/types";
import { useOffice } from "../../store/office";
import { ui, useUi } from "../../store/ui";
import { ago, Dot, SectionTitle, useNow } from "../kit";
import { DrawerHeader } from "./Drawer";
import { Markdown } from "../Markdown";

/**
 * Every message an agent sent you, from any agent, newest first: one place to read them instead of
 * opening each agent. Reply opens that agent's chat. Open = read.
 */
export function InboxDrawer() {
  const snap = useOffice((s) => s.snap);
  const readAt = useUi((s) => s.inboxReadAt);
  const [seenBefore] = useState(readAt); // "new" = unread when you opened it
  const now = useNow(10_000);
  const list = (snap?.messages ?? []).filter((m) => m.toId === HUMAN_ID);
  const newest = list[0]?.at ?? "";
  // Read while it's open, new ones included; the unread marks below use the time it was opened.
  useEffect(() => {
    if (newest) ui.markInboxRead(newest);
  }, [newest]);
  if (!snap) return null;
  const agent = (id: string) => snap.config.team.find((a) => a.id === id);

  return (
    <>
      <DrawerHeader>
        <b className="text-[18px]">Inbox</b>
        <span className="text-[13px] text-muted">Messages to you from every agent</span>
      </DrawerHeader>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-4">
        <SectionTitle>Newest first</SectionTitle>
        {list.length === 0 && <p className="text-[15px] text-muted">No messages yet. When any agent writes to you, it shows up here.</p>}
        <ul className="flex flex-col gap-2">
          {list.map((m) => {
            const from = agent(m.fromId);
            const update = m.cause === "team";
            return (
              <li key={m.id} className={`border-2 border-ink px-2.5 py-1.5 ${update ? "bg-cream opacity-80" : "bg-cream-2"}`}>
                <div className="flex items-center gap-1.5 text-[13px] text-muted">
                  {from && <Dot color={from.color} size={8} />}
                  <b className="text-ink">{from?.name ?? m.fromId}</b>
                  {update && <span title="Written after a teammate's report, not in answer to you">update</span>}
                  {m.at > seenBefore && <span className="chip text-[11px]" style={{ ["--c" as string]: "#ffec27" }}>new</span>}
                  <span className="ml-auto font-term text-[15px]">{ago(m.at, now)}</span>
                </div>
                <Markdown text={m.text} />
                {from && (
                  <button className="btn mt-1 px-2 text-[12px]" onClick={() => ui.openAgent(from.id, "messages")}>
                    Reply to {from.name}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </>
  );
}
