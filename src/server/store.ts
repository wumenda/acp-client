// src/server/store.ts
import { RequestError } from "@agentclientprotocol/sdk"
import type {
  PermissionOption,
  RequestPermissionOutcome,
  RequestPermissionRequest,
  SessionNotification,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk"
import type { AgentDef } from "../shared/agent-def"
import type { AgentStatusView, SessionMetaView } from "../shared/bridge-protocol"
import { spawnAgentProcess, type AgentProcess } from "./agent-process"
import { connectAcp, capsOf, canList, type AcpConnection } from "./connection"

export type AgentStatus = "stopped" | "starting" | "ready" | "error" | "needs-auth"

export type StoreEvents = {
  onAgentStatus(agentId: string, view: AgentStatusView): void
  onSessionUpdate(agentId: string, n: SessionNotification): void
  onPermissionRequest(p: {
    requestId: number
    agentId: string
    sessionId: string
    toolCall: ToolCallUpdate
    options: PermissionOption[]
  }): void
  onPermissionDone(requestId: number): void
  onPromptDone(agentId: string, sessionId: string, stopReason: string): void
  onPromptError(agentId: string, sessionId: string | null, message: string): void
  onSessionOpened(agentId: string, sessionId: string, cwd: string): void
  onSessionList(agentId: string, sessions: SessionMetaView[]): void
}

type Runtime = {
  def: AgentDef
  proc: AgentProcess | null
  acp: AcpConnection | null
  status: AgentStatus
  errorMsg?: string
  authErrorCommand?: string
}

const AUTH_REQUIRED = -32000

export class AgentStore {
  private agents = new Map<string, Runtime>()
  private pending = new Map<number, (o: RequestPermissionOutcome) => void>()
  private permSeq = 0

  constructor(defs: AgentDef[], private events: StoreEvents) {
    for (const def of defs) {
      this.agents.set(def.name, { def, proc: null, acp: null, status: "stopped" })
    }
  }

  list(): AgentStatusView[] {
    return [...this.agents.values()].map((r) => this.view(r))
  }

  statusOf(agentId: string): AgentStatus {
    return this.rt(agentId).status
  }

  processOf(agentId: string): AgentProcess | null {
    return this.rt(agentId).proc
  }

  async start(agentId: string): Promise<void> {
    const r = this.rt(agentId)
    if (r.status === "starting" || r.status === "ready") return
    this.setStatus(r, "starting")
    try {
      const proc = spawnAgentProcess(r.def)
      r.proc = proc
      const acp = await connectAcp(proc.stream, {
        onUpdate: (n) => this.events.onSessionUpdate(agentId, n),
        onRequestPermission: (req) => this.handlePermission(agentId, req),
      })
      r.acp = acp
      // 崩溃检测：非主动 stop 的退出 → stopped（v1 手动重启策略）
      void proc.exit.then(() => {
        if (r.status !== "stopped") {
          r.acp = null
          r.proc = null
          this.setStatus(r, "stopped")
        }
      })
      void acp.closed.then(() => {
        this.rejectPendingCancelled()
      })
      this.setStatus(r, "ready")
    } catch (e) {
      r.proc = null
      r.acp = null
      r.errorMsg = String((e as Error)?.message ?? e)
      this.setStatus(r, "error")
    }
  }

  stop(agentId: string): void {
    const r = this.rt(agentId)
    r.status = "stopped" // 先置位，让 exit 回调走 stopped 分支
    r.acp?.close()
    r.acp = null
    r.proc?.kill()
    r.proc = null
    this.rejectPendingCancelled()
    this.events.onAgentStatus(agentId, this.view(r))
  }

  /** 新建会话；auth_required 时转入 needs-auth 并抛错。 */
  async newSession(agentId: string, cwd: string): Promise<string> {
    const { acp } = this.ready(agentId)
    try {
      const res = await acp.agent.request("session/new", { cwd, mcpServers: [] })
      this.events.onSessionOpened(agentId, res.sessionId, cwd)
      return res.sessionId
    } catch (e) {
      if (e instanceof RequestError && e.code === AUTH_REQUIRED) {
        const r = this.rt(agentId)
        const m = r.acp?.info.authMethods?.[0]
        r.authErrorCommand =
          m && "type" in m && m.type === "terminal"
            ? [m.id, ...((m as { args?: string[] }).args ?? [])].join(" ")
            : undefined
        this.setStatus(r, "needs-auth")
        throw new Error(`需要认证：${m?.name ?? m?.id ?? "unknown"}（请在系统终端完成登录后重试）`)
      }
      throw e
    }
  }

  async authenticate(agentId: string): Promise<void> {
    const r = this.rt(agentId)
    const method = r.acp?.info.authMethods?.[0]
    if (!method) throw new Error("该 agent 未声明认证方式")
    await r.acp!.agent.request("authenticate", { methodId: method.id })
    this.setStatus(r, "ready")
  }

  async prompt(agentId: string, sessionId: string, text: string): Promise<void> {
    const { acp } = this.ready(agentId)
    try {
      const res = await acp.agent.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text" as const, text }],
      })
      this.events.onPromptDone(agentId, sessionId, res.stopReason)
    } catch (e) {
      this.events.onPromptError(agentId, sessionId, String((e as Error)?.message ?? e))
    }
  }

  cancel(agentId: string, sessionId: string): void {
    const { acp } = this.ready(agentId)
    void acp.agent.notify("session/cancel", { sessionId })
  }

  async listSessions(agentId: string, cwd?: string): Promise<SessionMetaView[]> {
    const { acp } = this.ready(agentId)
    if (!canList(acp.info)) return []
    const res = await acp.agent.request("session/list", { cwd: cwd ?? null })
    const views = res.sessions.map((s) => ({
      sessionId: s.sessionId,
      cwd: s.cwd,
      title: s.title ?? undefined,
      updatedAt: s.updatedAt ?? Date.now(),
    }))
    this.events.onSessionList(agentId, views)
    return views
  }

  /** 恢复会话：优先 load（重放历史），否则 resume，能力都不支持 → "unsupported"。 */
  async openSession(agentId: string, sessionId: string, cwd: string): Promise<"loaded" | "resumed" | "unsupported"> {
    const { acp } = this.ready(agentId)
    const caps = capsOf(acp.info)
    if (caps.loadSession === true) {
      await acp.agent.request("session/load", { sessionId, cwd, mcpServers: [] })
      this.events.onSessionOpened(agentId, sessionId, cwd)
      return "loaded"
    }
    try {
      await acp.agent.request("session/resume", { sessionId, cwd, mcpServers: [] })
      this.events.onSessionOpened(agentId, sessionId, cwd)
      return "resumed"
    } catch {
      return "unsupported"
    }
  }

  respondPermission(requestId: number, optionId: string | null): void {
    const resolve = this.pending.get(requestId)
    if (!resolve) return
    this.pending.delete(requestId)
    this.events.onPermissionDone(requestId)
    resolve(optionId === null ? { outcome: "cancelled" } : { outcome: "selected", optionId })
  }

  // —— 内部 ——

  private handlePermission(agentId: string, req: RequestPermissionRequest): Promise<RequestPermissionOutcome> {
    const requestId = ++this.permSeq
    return new Promise<RequestPermissionOutcome>((resolve) => {
      this.pending.set(requestId, resolve)
      this.events.onPermissionRequest({
        requestId,
        agentId,
        sessionId: req.sessionId,
        toolCall: req.toolCall,
        options: req.options,
      })
    })
  }

  private rejectPendingCancelled(): void {
    for (const [id, resolve] of this.pending) {
      this.pending.delete(id)
      this.events.onPermissionDone(id)
      resolve({ outcome: "cancelled" })
    }
  }

  private ready(agentId: string): { acp: AcpConnection } {
    const r = this.rt(agentId)
    if (!r.acp) throw new Error(`agent ${agentId} 未就绪（当前 ${r.status}）`)
    return { acp: r.acp }
  }

  private rt(agentId: string): Runtime {
    const r = this.agents.get(agentId)
    if (!r) throw new Error(`未知 agent: ${agentId}`)
    return r
  }

  private view(r: Runtime): AgentStatusView {
    const caps = r.acp ? capsOf(r.acp.info) : {}
    return {
      agentId: r.def.name,
      name: r.def.name,
      builtin: r.def.builtin,
      status: r.status,
      error: r.status === "error" ? r.errorMsg : undefined,
      loadSupported: caps.loadSession === true,
      listSupported: caps.sessionCapabilities?.list != null,
      authMethods:
        r.acp?.info.authMethods?.map((m) => ({
          id: m.id,
          name: m.name,
          description: m.description ?? undefined,
          // AuthMethodAgent 无 type 字段（SDK 1.4.0），agent 为缺省值
          type: "type" in m ? m.type : ("agent" as const),
        })) ?? [],
    }
  }

  private setStatus(r: Runtime, status: AgentStatus): void {
    r.status = status
    this.events.onAgentStatus(r.def.name, this.view(r))
  }
}

/** server 启动时拉起所有标记 autoStart 的 agent；不阻塞，失败经 onAgentStatus 上报为 error。 */
export function startAutoAgents(store: AgentStore, defs: AgentDef[]): string[] {
  const names = defs.filter((d) => d.autoStart === true).map((d) => d.name)
  for (const name of names) void store.start(name)
  return names
}
