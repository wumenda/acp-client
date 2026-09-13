// src/shared/bridge-protocol.ts
// 浏览器 ↔ server 的消息契约（仅类型；v1 不含运行时逻辑）
import type { CreateElicitationRequest, ElicitationPropertySchema } from "@agentclientprotocol/sdk"
export type { CreateElicitationRequest, ElicitationPropertySchema }
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
  closeSupported: boolean
  deleteSupported: boolean
  /** agent 支持 prompt 图片输入（promptCapabilities.image，P2-20） */
  imageSupported: boolean
  /** agent 支持 prompt 音频输入（promptCapabilities.audio，P2-20） */
  audioSupported: boolean
  /** 该 agent 配置的客户端侧 MCP server 数量（P1-16） */
  mcpServerCount: number
  authMethods: AgentAuthMethodView[]
}

export type SessionMetaView = { sessionId: string; cwd: string; title?: string; updatedAt: string | number }

// —— ACP Registry（浏览/安装公共 agent 目录）——
export type RegistryAgentView = {
  id: string
  name: string
  version: string
  description?: string
  website?: string
  repository?: string
  license?: string
  authors?: string[]
  /** SVG 16x16 图标 URL */
  icon?: string
  kind: "binary" | "npx" | "uvx"
  /** 当前平台存在可安装的分发形态 */
  supported: boolean
  installed: boolean
  installedVersion?: string
  /** registry 版本 > 已安装版本（X.Y.Z 逐段比较） */
  updateAvailable: boolean
}
export type RegistrySnapshot = { agents: RegistryAgentView[]; fetchedAt: number; stale: boolean }

// —— 会话控制面（P1-11）：modes / configOptions 的统一视图 ——
export type SessionModeView = { id: string; name: string }
export type SessionModesView = { currentModeId: string; availableModes: SessionModeView[] }
export type SessionConfigOptionView =
  | { id: string; name: string; type: "select"; currentValue: string; options: Array<{ value: string; name: string }> }
  | { id: string; name: string; type: "boolean"; currentValue: boolean }

export type BridgeCommand =
  | { type: "agent.start"; agentId: string }
  | { type: "agent.stop"; agentId: string }
  | { type: "session.new"; agentId: string; cwd: string }
  | { type: "session.open"; agentId: string; sessionId: string; cwd: string }
  | { type: "session.list"; agentId: string; cwd?: string }
  | { type: "session.prompt"; agentId: string; sessionId: string; text: string; attachments?: string[] }
  | { type: "session.cancel"; agentId: string; sessionId: string }
  | { type: "session.close"; agentId: string; sessionId: string }
  | { type: "session.delete"; agentId: string; sessionId: string }
  | { type: "session.set_mode"; agentId: string; sessionId: string; modeId: string }
  | { type: "session.set_config_option"; agentId: string; sessionId: string; configId: string; value: string | boolean }
  | { type: "permission.respond"; requestId: number; optionId: string | null }
  | { type: "fs.respond"; requestId: number; allowed: boolean }
  | { type: "term.respond"; requestId: number; allowed: boolean }
  | { type: "elicitation.respond"; requestId: number; action: "accept" | "decline" | "cancel"; content?: Record<string, string | number | boolean | string[]> }
  | { type: "auth.retry"; agentId: string }
  | { type: "log.subscribe"; on: boolean }
  // —— ACP Registry（P2-21）——
  | { type: "registry.refresh" }
  | { type: "registry.install"; id: string }
  | { type: "registry.uninstall"; id: string }

export type BridgeEvent =
  | { type: "snapshot"; agents: AgentStatusView[]; sessions: Record<string, SessionMetaView[]> }
  | { type: "agent.status"; agent: AgentStatusView }
  | { type: "session.list"; agentId: string; sessions: SessionMetaView[] }
  | { type: "session.opened"; agentId: string; sessionId: string; cwd: string; modes?: SessionModesView; configOptions?: SessionConfigOptionView[] }
  | { type: "session.update"; agentId: string; sessionId: string; update: unknown }
  | { type: "prompt.done"; agentId: string; sessionId: string; stopReason: string }
  | { type: "prompt.error"; agentId: string; sessionId: string | null; message: string }
  | { type: "permission.request"; requestId: number; agentId: string; sessionId: string; toolCall: unknown; options: unknown[] }
  | { type: "permission.done"; requestId: number }
  // fs 代理确认（P2-17）：写操作与 cwd 外读需用户在浏览器确认；done = 请求已收场（应答/取消/断连）
  | { type: "fs.confirm"; requestId: number; agentId: string; sessionId: string; kind: "read" | "write"; path: string; content?: string }
  | { type: "fs.done"; requestId: number }
  // terminal 代理确认（P2-18）：命令执行需用户在浏览器确认
  | { type: "term.confirm"; requestId: number; agentId: string; sessionId: string; command: string; args: string[]; cwd?: string }
  | { type: "term.done"; requestId: number }
  // elicitation（P2-19）：agent 请求用户提供结构化输入（form）或引导用户到 URL（url）；
  // fields 为 requestedSchema.properties；done 含 action（URL 模式 complete 通知亦触发 done 清理 UI）
  | {
      type: "elicitation.request"
      requestId: number
      agentId: string
      sessionId?: string
      message: string
      mode: string
      fields?: Record<string, ElicitationPropertySchema>
      required?: string[]
      elicitationId?: string
      url?: string
    }
  | { type: "elicitation.done"; requestId: number; action?: "accept" | "decline" | "cancel" }
  | { type: "session.closed"; agentId: string; sessionId: string; deleted: boolean }
  | { type: "acp.log"; agentId: string; dir: "in" | "out"; data: string }
  // —— ACP Registry（P2-21）：snapshot 与主 snapshot 分离（异步加载不阻塞）；progress stage 单向推进 ——
  | { type: "registry.snapshot"; agents: RegistryAgentView[]; fetchedAt: number; stale: boolean }
  | { type: "registry.progress"; id: string; stage: "downloading" | "verifying" | "extracting" | "registering" | "done" | "error"; message?: string }