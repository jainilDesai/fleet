// The real data source: Fleet's local server.
// Server → browser: OfficeEvent JSON over Server-Sent Events (GET /api/hq/stream).
// Browser → server: { cmd, args } as a POST to /api/hq/cmd, carrying Fleet's per-run token.

import type { ConnectionStatus, OfficeDataSource, OfficeEvent } from "../source";

export function createSseSource(token: string): OfficeDataSource {
  let onStatusRef: ((s: ConnectionStatus) => void) | undefined;
  // Commands run one after another so the server sees them in the order you clicked.
  let chain: Promise<unknown> = Promise.resolve();

  const send = (cmd: string, ...args: unknown[]) => {
    chain = chain
      .then(() =>
        fetch("/api/hq/cmd", {
          method: "POST",
          headers: { "content-type": "application/json", "x-fleet-token": token },
          body: JSON.stringify({ cmd, args }),
        })
      )
      .then((r) => {
        // A new token means Fleet restarted: this page must be reloaded to get it.
        if (r.status === 403) onStatusRef?.("unauthorized");
      })
      .catch(() => onStatusRef?.("reconnecting"));
  };

  const source: OfficeDataSource = {
    connect(onEvent, onStatus) {
      onStatusRef = onStatus;
      onStatus?.("connecting");
      // EventSource reconnects by itself; the server sends a full snapshot on every (re)connect.
      const es = new EventSource("/api/hq/stream");
      es.onopen = () => onStatus?.("open");
      es.onerror = () => onStatus?.("reconnecting");
      es.onmessage = (m) => {
        try {
          onEvent(JSON.parse(String(m.data)) as OfficeEvent);
        } catch {
          /* ignore malformed frames */
        }
      };
      return () => {
        es.close();
        onStatusRef = undefined;
      };
    },
    assignTask: (taskId, agentId) => send("assignTask", taskId, agentId),
    sendMessage: (toId, text) => send("sendMessage", toId, text),
    startAgent: (id) => send("startAgent", id),
    stopAgent: (id) => send("stopAgent", id),
    stopTeam: () => send("stopTeam"),
    quitFleet: () => send("quitFleet"),
    openWorkspace: (id) => send("openWorkspace", id),
    openInIterm: (id) => send("openInIterm", id),
    trustFolder: (id) => send("trustFolder", id),
    recheckSetup: () => send("recheckSetup"),
    addAgent: (input) => send("addAgent", input),
    updateAgent: (id, patch) => send("updateAgent", id, patch),
    removeAgent: (id, opts) => send("removeAgent", id, opts),
    inspectWorkspace: (id) => send("inspectWorkspace", id),
    updateWorkflow: (patch) => send("updateWorkflow", patch),
    updateProject: (patch) => send("updateProject", patch),
    createBoard: (title) => send("createBoard", title),
    updateBoard: (id, patch) => send("updateBoard", id, patch),
    completeWelcome: (input) => send("completeWelcome", input),
    resolveActionItem: (id, decision, note) => send("resolveActionItem", id, decision, note),
  };
  return source;
}
