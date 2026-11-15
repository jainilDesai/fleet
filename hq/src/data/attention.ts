import type { OfficeSnapshot } from "./types";

/** Everything waiting on the user: open action items, agents asking in their terminal, PRs ready to merge. */
export function selectAttention(snap: OfficeSnapshot | null) {
  if (!snap) return { items: [], asking: [], readyPrs: [], total: 0 };
  const items = (snap.actionItems ?? []).filter((i) => i.status === "open");
  // An open permission item is the same prompt the terminal shows: count it once.
  const asking = snap.agents.filter((a) => a.state === "needs-input" && !items.some((i) => i.kind === "permission" && i.fromId === a.agentId));
  const readyPrs = snap.pullRequests.filter((p) => p.review === "passed" && p.mergeable && !p.merged && !p.closed);
  return { items, asking, readyPrs, total: items.length + asking.length + readyPrs.length };
}
