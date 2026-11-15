// Settings → Workflow → Stop idle agents after. An idle agent does nothing on its own, but its
// session holds memory, and waking it days later re-sends a long context the prompt cache has
// long dropped. Stopping it is cheap: the next start is a fresh session with its role and task.

import type { Hub } from "./hub";

const DAY_MS = 86_400_000;
export const IDLE_CHECK_MS = 15 * 60_000;

interface Deps {
  stop(id: string): Promise<void>;
  /** Unsent text at the agent's prompt, typed by you in its terminal. */
  hasDraft(id: string): Promise<boolean>;
  /** Messages queued for the agent (it's about to get work). */
  pending(id: string): number;
}

/** Stops every running agent idle longer than the setting allows. Returns who was stopped. */
export async function stopIdleAgents(hub: Hub, deps: Deps, now = Date.now()): Promise<string[]> {
  const days = hub.snap.config.workflow.stopIdleAfterDays;
  if (!days) return [];
  const stopped: string[] = [];
  for (const st of hub.snap.agents) {
    const id = st.agentId;
    if (st.session.state !== "running" || st.state !== "idle" || deps.pending(id)) continue;
    if (hub.snap.actionItems?.some((i) => i.fromId === id && i.status === "open")) continue;
    // No saved activity yet (a new agent, or history from an older Fleet): the clock starts when Fleet did.
    const idleMs = now - (Date.parse(hub.lastActive[id] ?? "") || hub.startedAt);
    if (idleMs < days * DAY_MS || (await deps.hasDraft(id))) continue;
    try {
      await deps.stop(id);
      stopped.push(id);
      const n = Math.floor(idleMs / DAY_MS);
      hub.activity("session", id, `Stopped ${hub.name(id)} after ${n} day${n === 1 ? "" : "s"} idle. Start team or a new task brings it back.`);
    } catch (err) {
      hub.activity("session", id, `Couldn't stop ${hub.name(id)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return stopped;
}
