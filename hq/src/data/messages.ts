import { HUMAN_ID, type AgentMessage } from "./types";

/** A message between you and an agent (its chat, your Inbox), as opposed to agents' traffic with each other. */
export const isYours = (m: AgentMessage) => m.fromId === HUMAN_ID || m.toId === HUMAN_ID;

/**
 * Newest first: up to `team` messages of agents' traffic and, counted apart, up to `yours` of yours,
 * so a busy team never pushes your conversation out.
 */
export function keepMessages(list: AgentMessage[], team: number, yours: number): AgentMessage[] {
  let t = 0;
  let y = 0;
  return list.filter((m) => (isYours(m) ? ++y <= yours : ++t <= team));
}

/** Messages to you newer than `readAt` (your Inbox's unread count). */
export const unreadForYou = (list: AgentMessage[], readAt: string) => list.filter((m) => m.toId === HUMAN_ID && m.at > readAt).length;
