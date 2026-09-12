// src/web/state.ts
import { create } from "zustand"
import type { BridgeEvent, SessionMetaView } from "../shared/bridge-protocol"

export type Block =
  | { kind: "user"; text: string }
  | { kind: "assistant-text"; text: string }
  | { kind: "thought"; text: string }
  | { kind: "tool"; toolCallId: string; title?: string; toolKind?: string; status?: string; content?: unknown[] }
  | { kind: "unknown"; sessionUpdate: string }

export type PermissionView = { requestId: number; agentId: string; sessionId: string; toolCall: unknown; options: Array<{ optionId: string; name: string; kind: string }> }

export type FrontState = {
  agents: Record<string, import("../shared/bridge-protocol").AgentStatusView>
  sessions: Record<string, SessionMetaView[]>
  blocks: Record<string, Block[]>
  openOrder: string[]
  activeKey: string | null
  permission: PermissionView | null
  busy: Record<string, boolean>
  connected: boolean
  lastError?: string
}

export const initialFrontState = (): FrontState => ({
  agents: {},
  sessions: {},
  blocks: {},
  openOrder: [],
  activeKey: null,
  permission: null,
  busy: {},
  connected: false,
})

export const sessionKey = (agentId: string, sessionId: string) => `${agentId}:${sessionId}`

function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.map(textOf).join("")
  if (content && typeof content === "object" && (content as { type?: string }).type === "text") {
    return (content as { text?: string }).text ?? ""
  }
  return content == null ? "" : `[${(content as { type?: string }).type ?? "content"}]`
}

function withBlocks(s: FrontState, agentId: string, sessionId: string, fn: (blocks: Block[]) => Block[]): FrontState {
  const k = sessionKey(agentId, sessionId)
  return { ...s, blocks: { ...s.blocks, [k]: fn(s.blocks[k] ?? []) } }
}

function reduceSessionUpdate(s: FrontState, agentId: string, sessionId: string, update: unknown): FrontState {
  const u = (update && typeof update === "object" ? update : null) as Record<string, unknown> | null
  const rawKind = u?.sessionUpdate
  const kind = typeof rawKind === "string" ? rawKind : undefined
  if (kind === "agent_message_chunk" || kind === "agent_thought_chunk" || kind === "user_message_chunk") {
    const target = kind === "agent_message_chunk" ? "assistant-text" : kind === "agent_thought_chunk" ? "thought" : "user"
    const text = textOf(u?.content)
    return withBlocks(s, agentId, sessionId, (blocks) => {
      const last = blocks.at(-1)
      if (last && last.kind === target) {
        return [...blocks.slice(0, -1), { ...last, text: (last as { text: string }).text + text }]
      }
      return [...blocks, { kind: target, text } as Block]
    })
  }
  if (kind === "tool_call" || kind === "tool_call_update") {
    const toolCallId = typeof u?.toolCallId === "string" ? u.toolCallId : ""
    const title = typeof u?.title === "string" ? u.title : undefined
    const toolKind = typeof u?.kind === "string" ? u.kind : undefined
    const status = typeof u?.status === "string" ? u.status : undefined
    const content = Array.isArray(u?.content) ? u.content : undefined
    return withBlocks(s, agentId, sessionId, (blocks) => {
      const i = blocks.findIndex((b) => b.kind === "tool" && b.toolCallId === toolCallId)
      if (i < 0) {
        return [...blocks, { kind: "tool", toolCallId, title, toolKind, status, content }]
      }
      const prev = blocks[i] as Extract<Block, { kind: "tool" }>
      const merged = { ...prev, title: title ?? prev.title, toolKind: toolKind ?? prev.toolKind, status: status ?? prev.status, content: content ?? prev.content }
      return [...blocks.slice(0, i), merged, ...blocks.slice(i + 1)]
    })
  }
  return withBlocks(s, agentId, sessionId, (blocks) => [
    ...blocks,
    { kind: "unknown", sessionUpdate: String(kind ?? "unknown") },
  ])
}

export function reduceEvent(s: FrontState, e: BridgeEvent): FrontState {
  switch (e.type) {
    case "snapshot":
      return { ...s, agents: Object.fromEntries(e.agents.map((a) => [a.agentId, a])) }
    case "agent.status":
      return { ...s, agents: { ...s.agents, [e.agent.agentId]: e.agent } }
    case "session.list":
      return { ...s, sessions: { ...s.sessions, [e.agentId]: e.sessions } }
    case "session.opened": {
      const k = sessionKey(e.agentId, e.sessionId)
      const openOrder = s.openOrder.includes(k) ? s.openOrder : [...s.openOrder, k]
      return { ...s, openOrder, activeKey: k, blocks: { ...s.blocks, [k]: s.blocks[k] ?? [] } }
    }
    case "session.update":
      return reduceSessionUpdate(s, e.agentId, e.sessionId, e.update)
    case "prompt.done": {
      const busy = { ...s.busy, [sessionKey(e.agentId, e.sessionId)]: false }
      return { ...s, busy }
    }
    case "prompt.error": {
      const k2 = e.sessionId ? sessionKey(e.agentId, e.sessionId) : ""
      const busy = { ...s.busy, ...(k2 ? { [k2]: false } : {}) }
      return { ...s, busy, lastError: e.message }
    }
    case "permission.request":
      return { ...s, permission: { requestId: e.requestId, agentId: e.agentId, sessionId: e.sessionId, toolCall: e.toolCall, options: e.options as PermissionView["options"] } }
    case "permission.done":
      return s.permission?.requestId === e.requestId ? { ...s, permission: null } : s
    default:
      return s
  }
}

export const useFront = create<FrontState & { apply: (e: BridgeEvent) => void }>((set) => ({
  ...initialFrontState(),
  apply: (e) => set((s) => reduceEvent(s, e)),
}))
