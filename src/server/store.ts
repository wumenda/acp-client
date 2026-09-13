// src/server/store.ts
import { RequestError } from "@agentclientprotocol/sdk"
import type {
  ContentBlock,
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationPropertySchema,
  NewSessionRequest,
  PermissionOption,
  PromptRequest,
  RequestPermissionOutcome,
  RequestPermissionRequest,
  SessionConfigOption,
  SessionModeState,
  SessionNotification,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk"
import type { AgentDef } from "../shared/agent-def"
import type { AgentStatusView, SessionConfigOptionView, SessionMetaView, SessionModesView } from "../shared/bridge-protocol"
import { spawnAgentProcess, type AgentProcess } from "./agent-process"
import { FsGate } from "./fs-proxy"
import { TerminalManager } from "./terminal-manager"
import { connectAcp, capsOf, canList, type AcpConnection } from "./connection"

export type AgentStatus = "stopped" | "starting" | "ready" | "error" | "needs-auth"

export type SessionMetaPayload = { modes?: SessionModesView; configOptions?: SessionConfigOptionView[] }

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
  onSessionOpened(agentId: string, sessionId: string, cwd: string, meta?: SessionMetaPayload): void
  onSessionList(agentId: string, sessions: SessionMetaView[]): void
  /** fs 代理确认请求（P2-17）：写操作与 cwd 外读需用户在浏览器确认 */
  onFsConfirm?(req: { requestId: number; agentId: string; sessionId: string; kind: "read" | "write"; path: string; content?: string }): void
  /** fs 确认请求收场（应答/取消/断连）：bridge 层据此移除前端弹窗 */
  onFsDone?(requestId: number): void
  /** terminal 代理确认请求（P2-18）：命令执行需用户在浏览器确认 */
  onTermConfirm?(req: { requestId: number; agentId: string; sessionId: string; command: string; args: string[]; cwd?: string }): void
  /** terminal 确认请求收场（应答/取消/停止）：bridge 层据此移除前端弹窗 */
  onTermDone?(requestId: number): void
  /** elicitation 请求（P2-19）：agent 请求用户表单输入 / URL 引导 */
  onElicitationRequest(p: {
    requestId: number
    agentId: string
    sessionId?: string
    message: string
    mode: "form" | "url" | string
    fields?: Record<string, ElicitationPropertySchema>
    required?: string[]
    elicitationId?: string
    url?: string
  }): void
  /** elicitation 收场（应答/complete 通知/取消/停止）；action 缺省 = complete 通知或清理 */
  onElicitationDone(requestId: number, action?: "accept" | "decline" | "cancel"): void
  /** ACP 线上日志（§2.4-26），可选：未实现时 stdio 不做 tee */
  onAcpLog?(agentId: string, dir: "in" | "out", data: string): void
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
  // 记录权限请求归属，取消轮次时需按 agent+session 定向应答 cancelled（协议义务）
  private pending = new Map<number, { resolve: (o: RequestPermissionOutcome) => void; agentId: string; sessionId: string }>()
  private permSeq = 0
  // elicitation（P2-19）：挂起请求 + elicitationId → requestId（url 模式 complete 通知路由）
  private eliPending = new Map<number, { resolve: (r: CreateElicitationResponse) => void; agentId: string; sessionId?: string; eliId?: string }>()
  private eliIds = new Map<string, number>()
  private eliSeq = 0

  constructor(defs: AgentDef[], private events: StoreEvents, private fsGate?: FsGate, private terminals?: TerminalManager) {
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
      const proc = spawnAgentProcess(r.def, this.events.onAcpLog && ((dir, data) => this.events.onAcpLog!(agentId, dir, data)))
      r.proc = proc
      const acp = await connectAcp(proc.stream, {
        onUpdate: (n) => this.events.onSessionUpdate(agentId, n),
        onRequestPermission: (req) => this.handlePermission(agentId, req),
        // fs 代理（P2-17）：提供 FsGate 时声明能力并接管 agent 的文件访问
        ...(this.fsGate
          ? {
              fs: {
                onFsRead: (req) => this.fsGate!.read(agentId, req),
                onFsWrite: (req) => this.fsGate!.write(agentId, req),
              },
            }
          : {}),
        // terminal 代理（P2-18）：提供 TerminalManager 时声明能力并接管 agent 的命令执行
        ...(this.terminals
          ? {
              terminal: {
                onTerminalCreate: (req) => this.terminals!.create(agentId, req),
                onTerminalOutput: (req) => this.terminals!.output(agentId, req),
                onTerminalRelease: (req) => this.terminals!.release(agentId, req),
                onTerminalWaitExit: (req) => this.terminals!.wait(agentId, req),
                onTerminalKill: (req) => this.terminals!.kill(agentId, req),
              },
            }
          : {}),
        // elicitation（P2-19）：form/url 两模式转发浏览器，始终启用（纯 UI 转发无副作用）
        elicitation: {
          onElicitationCreate: (req) => this.handleElicitation(agentId, req),
          onElicitationComplete: (req) => this.completeElicitation(req.elicitationId),
        },
      })
      r.acp = acp
      // 崩溃检测：非主动 stop 的退出 → stopped（v1 手动重启策略）
      void proc.exit.then(() => {
        // removeAgent 后条目已删，闭包仍持有旧 Runtime，兜底防幽灵 status 广播
        if (!this.agents.has(agentId)) return
        if (r.status !== "stopped") {
          r.acp = null
          r.proc = null
          this.setStatus(r, "stopped")
        }
        // 该 agent 的挂起 fs/terminal 确认与终端随之收场（无论崩溃还是主动停止）
        this.fsGate?.rejectAgent(agentId)
        this.terminals?.killAgent(agentId)
        this.cancelElicitations(agentId)
      })
      void acp.closed
        .then(() => {
          this.rejectPendingCancelled()
        })
        .catch(() => {}) // 主动 stop 时 close() 会使 closed 以错误结束，属预期路径
      this.setStatus(r, "ready")
    } catch (e) {
      r.proc = null
      r.acp = null
      r.errorMsg = String((e as Error)?.message ?? e)
      this.setStatus(r, "error")
    }
  }

  /** registry 安装：动态注册一个 stopped 态 agent 并广播 */
  addAgent(def: AgentDef): void {
    if (this.agents.has(def.name)) throw new Error(`agent ${def.name} 已存在`)
    this.agents.set(def.name, { def, proc: null, acp: null, status: "stopped" })
    this.events.onAgentStatus(def.name, this.view(this.agents.get(def.name)!))
  }

  /** registry 卸载：运行中先停，再移除 */
  removeAgent(agentId: string): void {
    const r = this.agents.get(agentId)
    if (!r) return
    if (r.status !== "stopped") this.stop(agentId)
    this.agents.delete(agentId)
  }

  stop(agentId: string): void {
    const r = this.rt(agentId)
    r.status = "stopped" // 先置位，让 exit 回调走 stopped 分支
    r.acp?.close()
    r.acp = null
    r.proc?.kill()
    r.proc = null
    this.rejectPendingCancelled()
    this.fsGate?.rejectAgent(agentId)
    this.terminals?.killAgent(agentId)
    this.cancelElicitations(agentId)
    this.events.onAgentStatus(agentId, this.view(r))
  }

  /** 新建会话；auth_required 时转入 needs-auth 并抛错。 */
  async newSession(agentId: string, cwd: string): Promise<string> {
    const { acp } = this.ready(agentId)
    const r = this.rt(agentId)
    try {
      // mcpServers 转发（P1-16）：把客户端侧配置的 MCP server 交给 agent。
      // params 显式注解：SDK request 的泛型重载对宽松类型会静默失配（见 connection.ts 备注）
      const params: NewSessionRequest = { cwd, mcpServers: r.def.mcpServers ?? [] }
      const res = await acp.agent.request("session/new", params)
      this.events.onSessionOpened(agentId, res.sessionId, cwd, metaOf(res))
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

  async prompt(agentId: string, sessionId: string, text: string | ContentBlock[]): Promise<void> {
    const { acp } = this.ready(agentId)
    try {
      const params: PromptRequest = { sessionId, prompt: typeof text === "string" ? [{ type: "text", text }] : text }
      const res = await acp.agent.request("session/prompt", params)
      this.events.onPromptDone(agentId, sessionId, res.stopReason)
    } catch (e) {
      this.events.onPromptError(agentId, sessionId, String((e as Error)?.message ?? e))
    }
  }

  /** 切换会话模式（plan mode 等，P1-11）。 */
  async setMode(agentId: string, sessionId: string, modeId: string): Promise<void> {
    const { acp } = this.ready(agentId)
    await acp.agent.request("session/set_mode", { sessionId, modeId })
  }

  /** 设置会话配置项（configOptions，P1-11）。 */
  async setConfigOption(agentId: string, sessionId: string, configId: string, value: string | boolean): Promise<void> {
    const { acp } = this.ready(agentId)
    await acp.agent.request("session/set_config_option", {
      sessionId,
      configId,
      ...(typeof value === "boolean" ? { type: "boolean" as const, value } : { value }),
    })
  }

  cancel(agentId: string, sessionId: string): void {
    const { acp } = this.ready(agentId)
    // 协议义务：发出 session/cancel 后，必须把该会话所有挂起权限请求应答为 cancelled，
    // 否则 agent 会在权限回调上一直等待（调研 §1.8 / prompt-turn）
    for (const [id, p] of this.pending) {
      if (p.agentId !== agentId || p.sessionId !== sessionId) continue
      this.pending.delete(id)
      this.events.onPermissionDone(id)
      p.resolve({ outcome: "cancelled" })
    }
    // fs / terminal 确认同理：取消轮次后按拒绝收场（P2-17 / P2-18）；elicitation 按 cancel 收场
    this.fsGate?.rejectSession(agentId, sessionId)
    this.terminals?.rejectSession(agentId, sessionId)
    this.cancelElicitations(agentId, sessionId)
    void acp.agent.notify("session/cancel", { sessionId })
  }

  async listSessions(agentId: string, cwd?: string): Promise<SessionMetaView[]> {
    const { acp } = this.ready(agentId)
    if (!canList(acp.info)) return []
    // 分页拉全（P1-14）：nextCursor 存在则继续翻页；上限 10 页防失控
    const all: Array<{ sessionId: string; cwd: string; title?: string | null; updatedAt?: string | null }> = []
    let cursor: string | null | undefined
    for (let page = 0; page < 10; page++) {
      const res = await acp.agent.request("session/list", { cwd: cwd ?? null, ...(cursor ? { cursor } : {}) })
      all.push(...res.sessions)
      cursor = res.nextCursor
      if (!cursor) break
    }
    const views = all.map((s) => ({
      sessionId: s.sessionId,
      cwd: s.cwd,
      title: s.title ?? undefined,
      updatedAt: s.updatedAt ?? Date.now(),
    }))
    this.events.onSessionList(agentId, views)
    return views
  }

  /** 关闭会话（P1-15）：agent 侧收尾，会话记录保留。 */
  async closeSession(agentId: string, sessionId: string): Promise<void> {
    const { acp } = this.ready(agentId)
    if (capsOf(acp.info).sessionCapabilities?.close == null) throw new Error("该 agent 不支持会话关闭")
    await acp.agent.request("session/close", { sessionId })
  }

  /** 删除会话（P1-15）：从 agent 的会话存储移除；本地缓存由 bridge 层同步清理。 */
  async deleteSession(agentId: string, sessionId: string): Promise<void> {
    const { acp } = this.ready(agentId)
    if (capsOf(acp.info).sessionCapabilities?.delete == null) throw new Error("该 agent 不支持会话删除")
    await acp.agent.request("session/delete", { sessionId })
  }

  /** 恢复会话：优先 load（重放历史），否则 resume，能力都不支持 → "unsupported"。 */
  async openSession(agentId: string, sessionId: string, cwd: string): Promise<"loaded" | "resumed" | "unsupported"> {
    const { acp } = this.ready(agentId)
    const caps = capsOf(acp.info)
    if (caps.loadSession === true) {
      const res = await acp.agent.request("session/load", { sessionId, cwd, mcpServers: [] })
      this.events.onSessionOpened(agentId, sessionId, cwd, metaOf(res))
      return "loaded"
    }
    try {
      const res = await acp.agent.request("session/resume", { sessionId, cwd, mcpServers: [] })
      this.events.onSessionOpened(agentId, sessionId, cwd, metaOf(res))
      return "resumed"
    } catch {
      return "unsupported"
    }
  }

  respondPermission(requestId: number, optionId: string | null): void {
    const p = this.pending.get(requestId)
    if (!p) return
    this.pending.delete(requestId)
    this.events.onPermissionDone(requestId)
    p.resolve(optionId === null ? { outcome: "cancelled" } : { outcome: "selected", optionId })
  }

  /** elicitation（P2-19）：form/url 请求挂起等待浏览器应答。 */
  respondElicitation(requestId: number, action: "accept" | "decline" | "cancel", content?: Record<string, string | number | boolean | string[]>): void {
    const p = this.eliPending.get(requestId)
    if (!p) return
    this.eliPending.delete(requestId)
    // url 模式 accept 后 agent 仍会发 complete 通知（保留 eliIds 映射供 UI 清理），其余直接清映射
    if (action !== "accept" || !p.eliId) {
      for (const [id, rid] of this.eliIds) if (rid === requestId) this.eliIds.delete(id)
    }
    this.events.onElicitationDone(requestId, action)
    p.resolve(action === "accept" ? { action, ...(content ? { content } : {}) } : { action })
  }

  /** url 模式：agent 侧完成后发 complete 通知 → 清理前端 UI（幂等；不改变已应答的 action）。 */
  completeElicitation(elicitationId: string): void {
    const rid = this.eliIds.get(elicitationId)
    if (rid === undefined) return
    this.eliIds.delete(elicitationId)
    // 若仍在挂起（浏览器已 accept 但此通知先到/竞态）：按 cancel 收场避免死等
    const p = this.eliPending.get(rid)
    if (p) {
      this.eliPending.delete(rid)
      p.resolve({ action: "cancel" })
    }
    this.events.onElicitationDone(rid)
  }

  private handleElicitation(agentId: string, req: CreateElicitationRequest): Promise<CreateElicitationResponse> {
    const requestId = ++this.eliSeq
    const eliId = "elicitationId" in req && typeof req.elicitationId === "string" ? req.elicitationId : undefined
    const sessionId = "sessionId" in req && typeof req.sessionId === "string" ? req.sessionId : undefined
    const schema = req.mode === "form" && "requestedSchema" in req ? (req.requestedSchema as { properties?: Record<string, ElicitationPropertySchema>; required?: string[] } | undefined) : undefined
    return new Promise<CreateElicitationResponse>((resolve) => {
      this.eliPending.set(requestId, { resolve, agentId, ...(sessionId ? { sessionId } : {}), ...(eliId ? { eliId } : {}) })
      if (eliId) this.eliIds.set(eliId, requestId)
      this.events.onElicitationRequest({
        requestId,
        agentId,
        ...(sessionId ? { sessionId } : {}),
        message: req.message,
        mode: req.mode,
        ...(schema?.properties ? { fields: schema.properties } : {}),
        ...(schema?.required?.length ? { required: schema.required } : {}),
        ...(eliId ? { elicitationId: eliId } : {}),
        ...(req.mode === "url" && "url" in req && typeof req.url === "string" ? { url: req.url } : {}),
      })
    })
  }

  /** 取消轮次 / agent 停止：挂起 elicitation 按 cancel 收场（协议语义）。 */
  private cancelElicitations(agentId: string, sessionId?: string): void {
    for (const [id, p] of this.eliPending) {
      if (p.agentId !== agentId) continue
      if (sessionId !== undefined && p.sessionId !== sessionId) continue
      this.eliPending.delete(id)
      for (const [eid, rid] of this.eliIds) if (rid === id) this.eliIds.delete(eid)
      this.events.onElicitationDone(id, "cancel")
      p.resolve({ action: "cancel" })
    }
  }

  // —— 内部 ——

  private handlePermission(agentId: string, req: RequestPermissionRequest): Promise<RequestPermissionOutcome> {
    const requestId = ++this.permSeq
    return new Promise<RequestPermissionOutcome>((resolve) => {
      this.pending.set(requestId, { resolve, agentId, sessionId: req.sessionId })
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
    for (const [id, p] of this.pending) {
      this.pending.delete(id)
      this.events.onPermissionDone(id)
      p.resolve({ outcome: "cancelled" })
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
    const sessionCaps = caps.sessionCapabilities ?? {}
    return {
      agentId: r.def.name,
      name: r.def.name,
      builtin: r.def.builtin,
      status: r.status,
      error: r.status === "error" ? r.errorMsg : undefined,
      loadSupported: caps.loadSession === true,
      listSupported: sessionCaps.list != null,
      closeSupported: sessionCaps.close != null,
      deleteSupported: sessionCaps.delete != null,
      // 图片/音频输入（P2-20）：agent 的 promptCapabilities 决定是否开放上传
      imageSupported: caps.promptCapabilities?.image === true,
      audioSupported: caps.promptCapabilities?.audio === true,
      mcpServerCount: r.def.mcpServers?.length ?? 0,
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

/** session/new、session/load、session/resume 响应 → 会话控制面视图（P1-11）。
 *  宽容缺字段：dsh/opencode 的能力公告不一致，缺 modes/configOptions 时不下发。 */
function metaOf(res: { modes?: SessionModeState | null; configOptions?: SessionConfigOption[] | null }): SessionMetaPayload | undefined {
  const modes: SessionModesView | undefined = res.modes?.availableModes?.length
    ? {
        currentModeId: res.modes.currentModeId,
        availableModes: res.modes.availableModes
          .filter((m) => typeof m?.id === "string" && typeof m?.name === "string")
          .map((m) => ({ id: m.id, name: m.name })),
      }
    : undefined
  const configOptions: SessionConfigOptionView[] = []
  for (const o of res.configOptions ?? []) {
    if (typeof o?.id !== "string" || typeof o?.name !== "string") continue
    if (o.type === "boolean") {
      configOptions.push({ id: o.id, name: o.name, type: "boolean", currentValue: o.currentValue === true })
    } else if (o.type === "select" && Array.isArray(o.options)) {
      // options 可能是值组或分组嵌套；v1 只拍平非分组的值项
      const options: Array<{ value: string; name: string }> = []
      for (const x of o.options) {
        if ("value" in x && typeof x.value === "string") options.push({ value: x.value, name: String(x.name ?? x.value) })
      }
      if (options.length) configOptions.push({ id: o.id, name: o.name, type: "select", currentValue: String(o.currentValue ?? ""), options })
    }
  }
  return modes || configOptions.length ? { modes, configOptions: configOptions.length ? configOptions : undefined } : undefined
}
