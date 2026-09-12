// src/shared/bridge-protocol.ts
// 浏览器 ↔ server 的消息契约（仅类型；v1 不含运行时逻辑）
export type AgentAuthMethodView = {
  id: string
  name: string
  description?: string
  type: "agent" | "terminal"
}

export type AgentStatusView = {
  agentId: string
  name: string
  builtin: boolean
  status: "stopped" | "starting" | "ready" | "error" | "needs-auth"
  error?: string
  loadSupported: boolean
  listSupported: boolean
  authMethods: AgentAuthMethodView[]
}

export type SessionMetaView = { sessionId: string; cwd: string; title?: string; updatedAt: string | number }

export type BridgeCommand =
  | { type: "agent.start"; agentId: string }
  | { type: "agent.stop"; agentId: string }
  | { type: "session.new"; agentId: string; cwd: string }
  | { type: "session.open"; agentId: string; sessionId: string; cwd: string }
  | { type: "session.list"; agentId: string; cwd?: string }
  | { type: "session.prompt"; agentId: string; sessionId: string; text: string }
  | { type: "session.cancel"; agentId: string; sessionId: string }
  | { type: "permission.respond"; requestId: number; optionId: string | null }
  | { type: "auth.retry"; agentId: string }

export type BridgeEvent =
  | { type: "snapshot"; agents: AgentStatusView[] }
  | { type: "agent.status"; agent: AgentStatusView }
  | { type: "session.list"; agentId: string; sessions: SessionMetaView[] }
  | { type: "session.opened"; agentId: string; sessionId: string; cwd: string }
  | { type: "session.update"; agentId: string; sessionId: string; update: unknown }
  | { type: "prompt.done"; agentId: string; sessionId: string; stopReason: string }
  | { type: "prompt.error"; agentId: string; sessionId: string | null; message: string }
  | { type: "permission.request"; requestId: number; agentId: string; sessionId: string; toolCall: unknown; options: unknown[] }
  | { type: "permission.done"; requestId: number }
