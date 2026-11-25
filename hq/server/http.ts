// HQ's routes, mounted inside Fleet's server (src/server.js). Fleet already serves the UI,
// binds 127.0.0.1 and rejects any Host that isn't localhost. Routes:
//   GET  /api/hq/stream         OfficeEvent JSON as Server-Sent Events (same rule as Fleet's /api/stream)
//   POST /api/hq/cmd            { cmd, args } from the page (Fleet's per-run page token)
//   POST /hook/<agent>/<event>  Claude Code hooks (agent token)
//   POST /mcp                   Team MCP (agent token + X-HQ-Agent)

import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { OfficeEvent } from "../src/data/source";
import { describePermission, handleHook, turnReplies, type HookPayload } from "./hooks";
import type { Refresher } from "./refresh";
import { parseQuestions } from "./actionItems";
import type { Hub } from "./hub";
import type { Inbox } from "./inbox";
import { handleMcp } from "./mcp";
import type { Planner } from "./planner";
import { log } from "./lib/log";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { IMAGE_MAX, IMAGE_TYPES, UPLOAD_NAME, saveImage, uploadsDir } from "./uploads";

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const readBody = (req: IncomingMessage, limit = 256 * 1024) => readBytes(req, limit).then((b) => b.toString("utf8"));

function readBytes(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) reject(new Error("too large"));
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

interface Options {
  hub: Hub;
  inbox: Inbox;
  planner: Planner;
  /** Fleet's per-run token, written into the page it serves. */
  pageToken: string;
  agentToken: string;
  commands: Record<string, (...args: unknown[]) => unknown>;
  refresher?: Refresher;
}

/** How long Fleet holds a permission request for your answer. Claude Code's hook timeout is 600s. */
const PERMISSION_WAIT_MS = 570_000;

/**
 * Claude Code's PermissionRequest hook (type "http"): hold the request open, show Allow/Deny in Action
 * items, and reply with your decision. No answer in time, or the agent goes away: reply with no
 * decision, and Claude Code asks in its terminal as usual. Nothing is ever allowed automatically.
 */
async function holdPermission(o: Options, agentId: string, req: IncomingMessage, res: ServerResponse) {
  const actions = o.planner.actions;
  const status = o.hub.status(agentId);
  let body: HookPayload;
  try {
    body = JSON.parse((await readBody(req)) || "{}") as HookPayload;
  } catch {
    res.writeHead(400);
    return void res.end();
  }
  const noDecision = () => {
    if (res.writableEnded) return;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  };
  // Its questions come to Action items through the PreToolUse hook (holdQuestion); if that timed out, ask in the terminal.
  if (!actions || !status || body.tool_name === "AskUserQuestion") return noDecision();
  o.inbox.noteHook(agentId, "PermissionRequest");
  const { title, details } = describePermission(body.tool_name ?? "a tool", body.tool_input);
  const before = { state: status.state, note: status.note };
  o.hub.setStatus(agentId, { state: "needs-input", note: `Asking: ${title}` });
  const { item, answer } = actions.askPermission(agentId, body.tool_name ?? "", title, details);

  const timer = setTimeout(() => actions.expirePermission(item.id, "No answer in time; the agent asked in its terminal instead."), PERMISSION_WAIT_MS);
  // The agent stopped waiting (answered in its terminal, interrupted, or exited).
  res.on("close", () => {
    if (!res.writableEnded) actions.expirePermission(item.id, "The agent stopped waiting for this.");
  });
  const decision = await answer;
  clearTimeout(timer);
  if (!decision) return noDecision();
  o.hub.setStatus(agentId, { state: before.state === "needs-input" ? "working" : before.state, note: decision.behavior === "allow" ? `Allowed: ${title}` : `Denied: ${title}` });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } }));
}

/**
 * Claude Code's PreToolUse hook for AskUserQuestion: hold it, show the questions in Action items, and
 * answer them with your choices (allow + updatedInput.answers, as the hooks reference documents).
 * No answer in time, or the agent goes away: no decision, and the agent asks in its terminal.
 */
async function holdQuestion(o: Options, agentId: string, req: IncomingMessage, res: ServerResponse) {
  const actions = o.planner.actions;
  const status = o.hub.status(agentId);
  let body: HookPayload;
  try {
    body = JSON.parse((await readBody(req)) || "{}") as HookPayload;
  } catch {
    res.writeHead(400);
    return void res.end();
  }
  const noDecision = () => {
    if (res.writableEnded) return;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  };
  const questions = parseQuestions(body.tool_input);
  if (!actions || !status || body.tool_name !== "AskUserQuestion" || !questions) return noDecision();
  const before = { state: status.state, note: status.note };
  const { item, answer } = actions.askQuestions(agentId, questions);
  o.hub.setStatus(agentId, { state: "needs-input", note: `Asking: ${item.title}` });
  const timer = setTimeout(() => actions.expirePermission(item.id, "No answer in time; the agent asked in its terminal instead."), PERMISSION_WAIT_MS);
  res.on("close", () => {
    if (!res.writableEnded) actions.expirePermission(item.id, "The agent stopped waiting for this.");
  });
  const answers = await answer;
  clearTimeout(timer);
  if (!answers) return noDecision();
  o.hub.setStatus(agentId, { state: before.state === "needs-input" ? "working" : before.state, note: "Continuing after your answer" });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...(body.tool_input as object), answers } },
    }),
  );
}

/** Posts the agent's answer to you, once it's in the transcript (checked after 1.5s, then 5s). */
function postReply(planner: Planner, agentId: string, transcript: string, cause?: "team", before?: string, delays = [1500, 5000]) {
  const [wait, ...rest] = delays;
  setTimeout(() => {
    const texts = turnReplies(transcript, 300, before);
    if (texts.length) for (const t of texts) planner.reply(agentId, t, cause);
    else if (rest.length) postReply(planner, agentId, transcript, cause, before, rest);
  }, wait);
}

/** Returns true when the request was one of HQ's routes (and has been answered). */
export type HqHandler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;

export function makeHandler(o: Options): HqHandler {
  const send = (res: ServerResponse, code: number, body: string, type = "text/plain") => {
    res.writeHead(code, { "Content-Type": type });
    res.end(body);
  };

  return async (req, res, url) => {
    if (req.method === "GET" && url.pathname === "/api/hq/stream") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const sendEvent = (e: OfficeEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
      sendEvent({ type: "snapshot", snapshot: o.hub.snap });
      const unsub = o.hub.subscribe(sendEvent);
      req.on("close", unsub);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/hq/cmd") {
      if (!safeEqual(String(req.headers["x-fleet-token"] ?? ""), o.pageToken)) {
        send(res, 403, JSON.stringify({ error: "bad token" }), "application/json");
        return true;
      }
      try {
        const msg = JSON.parse((await readBody(req, 1024 * 1024)) || "{}") as { cmd?: string; args?: unknown[] };
        const fn = msg.cmd ? o.commands[msg.cmd] : undefined;
        if (!fn) {
          log.warn("unknown command", msg.cmd);
          send(res, 404, JSON.stringify({ error: "unknown command" }), "application/json");
          return true;
        }
        await fn(...(Array.isArray(msg.args) ? msg.args : []));
        send(res, 200, JSON.stringify({ ok: true }), "application/json");
      } catch (err) {
        log.warn("command failed:", err instanceof Error ? err.message : err);
        if (!res.headersSent) send(res, 500, JSON.stringify({ error: "command failed" }), "application/json");
      }
      return true;
    }

    // An image you pasted: saved in ~/.fleet/uploads; the page puts "[image: <path>]" in the message.
    if (req.method === "POST" && url.pathname === "/api/hq/upload") {
      if (!safeEqual(String(req.headers["x-fleet-token"] ?? ""), o.pageToken)) {
        send(res, 403, JSON.stringify({ error: "bad token" }), "application/json");
        return true;
      }
      try {
        // The type comes from the bytes (saveImage), not from the request's content-type.
        send(res, 200, JSON.stringify({ path: saveImage(o.hub.slug, await readBytes(req, IMAGE_MAX)) }), "application/json");
      } catch (err) {
        send(res, 400, JSON.stringify({ error: err instanceof Error ? err.message : "upload failed" }), "application/json");
      }
      return true;
    }

    // A picture in a message. Read by <img>, so no token (like the stream); only this project's uploads, by exact name.
    if (req.method === "GET" && url.pathname.startsWith("/api/hq/uploads/")) {
      const name = url.pathname.slice("/api/hq/uploads/".length);
      const bytes = UPLOAD_NAME.test(name) ? await readFile(join(uploadsDir(o.hub.slug), name)).catch(() => null) : null;
      if (!bytes) send(res, 404, "not found");
      else {
        res.writeHead(200, { "Content-Type": IMAGE_TYPES[name.split(".")[1]], "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" });
        res.end(bytes);
      }
      return true;
    }

    if (req.method === "POST" && url.pathname.startsWith("/hook/")) {
      const auth = req.headers.authorization ?? "";
      if (!safeEqual(auth, `Bearer ${o.agentToken}`)) {
        send(res, 401, "unauthorized");
        return true;
      }
      const [, , agentId, event] = url.pathname.split("/");
      if (event === "PermissionRequest") {
        await holdPermission(o, decodeURIComponent(agentId ?? ""), req, res);
        return true;
      }
      if (event === "AskUserQuestion") {
        await holdQuestion(o, decodeURIComponent(agentId ?? ""), req, res);
        return true;
      }
      try {
        const raw = await readBody(req);
        const payload = (raw ? JSON.parse(raw) : {}) as HookPayload;
        const id = decodeURIComponent(agentId ?? "");
        // A permission prompt answered in the terminal: the tool ran, or the agent moved on.
        if (event === "PostToolUse") o.planner.actions?.answeredInTerminal(id, payload.tool_name ?? "");
        else if (event === "Stop" || event === "UserPromptSubmit" || event === "SessionEnd") o.planner.actions?.answeredInTerminal(id);
        const r = handleHook(o.hub, o.inbox, id, event ?? "", payload, (a) => o.refresher?.takeHandoff(a) ?? null);
        if (r.ok) o.refresher?.noteHook(id, event ?? "", payload.transcript_path);
        if (r.typedPrompt) o.planner.typedInTerminal(id, r.typedPrompt);
        if (r.replyTranscript) postReply(o.planner, id, r.replyTranscript, r.replyCause, r.replyBefore);
        if (!r.ok) send(res, 404, "");
        else if (r.response) send(res, 200, JSON.stringify(r.response), "application/json");
        else {
          res.writeHead(204);
          res.end();
        }
      } catch {
        send(res, 400, "bad request");
      }
      return true;
    }

    // Team MCP: agent token + the agent's id (written into its MCP config by Fleet).
    if (url.pathname === "/mcp") {
      const auth = req.headers.authorization ?? "";
      const agentId = String(req.headers["x-hq-agent"] ?? "");
      if (!safeEqual(auth, `Bearer ${o.agentToken}`) || !o.hub.cfg(agentId)) {
        send(res, 401, "unauthorized");
        return true;
      }
      if (req.method !== "POST") {
        send(res, 405, "stateless server");
        return true;
      }
      try {
        const raw = await readBody(req, 1024 * 1024);
        await handleMcp(o.hub, o.planner, agentId, req, res, raw ? JSON.parse(raw) : undefined);
      } catch {
        if (res.headersSent) res.end();
        else send(res, 400, "bad request");
      }
      return true;
    }

    return false;
  };
}
