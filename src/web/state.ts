// src/web/state.ts
import { create } from "zustand"
import type { BridgeEvent, ElicitationPropertySchema, RegistryAgentView, SessionConfigOptionView, SessionMetaView, SessionModesView } from "../shared/bridge-protocol"

export type Block =
  | { kind: "user"; text: string; messageId?: string }
  | { kind: "assistant-text"; text: string; messageId?: string }
  | { kind: "thought"; text: string; messageId?: string }
  | {
      kind: "tool"; toolCallId: string; title?: string; toolKind?: string; status?: string; content?: unknown[]
      locations?: Array<{ path: string; line?: number }>; rawInput?: unknown; rawOutput?: unknown
    }
  | { kind: "notice"; level: "info" | "warn" | "error"; text: string }
  | { kind: "plan"; entries: PlanEntryView[]; planId?: string }
  | { kind: "unknown"; sessionUpdate: string }

export type PlanEntryView = { content: string; priority: string; status: string }

export type PermissionView = { requestId: number; agentId: string; sessionId: string; toolCall: unknown; options: Array<{ optionId: string; name: string; kind: string }> }

/** fs 代理确认（P2-17）：写操作与 cwd 外读的浏览器确认弹窗视图 */
export type FsConfirmView = { requestId: number; agentId: string; sessionId: string; kind: "read" | "write"; path: string; content?: string }

/** terminal 代理确认（P2-18）：命令执行的浏览器确认弹窗视图 */
export type TermConfirmView = { requestId: number; agentId: string; sessionId: string; command: string; args: string[]; cwd?: string }

/** elicitation（P2-19）：agent 请求结构化输入（form）或 URL 引导（url）的弹窗视图 */
export type ElicitationView = {
  requestId: number
  agentId: string
  sessionId?: string
  message: string
  mode: "form" | "url" | string
  fields?: Record<string, ElicitationPropertySchema>
  required?: string[]
  elicitationId?: string
  url?: string
}

/** 排队中的输入（§2.4-21）：busy 期间发送的 prompt，轮末自动提交 */
export type QueuedPrompt = { text: string; attachments?: string[] }

/** usage_update：上下文占用与累计费用（P1-7） */
export type UsageView = { used: number; size: number; costAmount?: number; costCurrency?: string }

/** 会话控制面（P1-11）：modes + configOptions */
export type SessionControls = { modes?: SessionModesView; configOptions?: SessionConfigOptionView[] }

/** ACP Registry（P2-21）：安装进度（stage 单向推进，error 终态附带 message） */
export type RegistryProgress = { stage: "downloading" | "verifying" | "extracting" | "registering" | "done" | "error"; message?: string }

export type FrontState = {
  agents: Record<string, import("../shared/bridge-protocol").AgentStatusView>
  sessions: Record<string, SessionMetaView[]>
  blocks: Record<string, Block[]>
  openOrder: string[]
  activeKey: string | null
  permission: PermissionView | null
  permissions: PermissionView[]
  fsConfirms: FsConfirmView[]
  fsConfirm: FsConfirmView | null
  termConfirms: TermConfirmView[]
  termConfirm: TermConfirmView | null
  elicitations: ElicitationView[]
  elicitation: ElicitationView | null
  busy: Record<string, boolean>
  usage: Record<string, UsageView>
  commands: Record<string, Array<{ name: string; description: string }>>
  controls: Record<string, SessionControls>
  queues: Record<string, QueuedPrompt[]>
  /** ACP Registry（P2-21）：目录视图 + 安装进度；null = 尚未收到 snapshot */
  registry: {
    agents: RegistryAgentView[]
    fetchedAt: number
    stale: boolean
    progress: Record<string, RegistryProgress>
  } | null
  registryOpen: boolean
  connected: boolean
  lastError?: string
}

// 视图态（打开顺序 / 活跃会话）属浏览器本地状态：localStorage 持久化，刷新即恢复（P0-3）
const VIEW_STATE_KEY = "acp-client.view"
type ViewState = { openOrder?: string[]; activeKey?: string | null }

function loadViewState(): ViewState {
  if (typeof localStorage === "undefined") return {} // node 测试环境
  try {
    return JSON.parse(localStorage.getItem(VIEW_STATE_KEY) ?? "{}") as ViewState
  } catch {
    return {}
  }
}

export function saveViewState(s: Pick<FrontState, "openOrder" | "activeKey">): void {
  if (typeof localStorage === "undefined") return
  try {
    localStorage.setItem(VIEW_STATE_KEY, JSON.stringify({ openOrder: s.openOrder, activeKey: s.activeKey }))
  } catch {
    /* 隐私模式等存储不可用时静默跳过：仅影响刷新恢复 */
  }
}

export const initialFrontState = (): FrontState => {
  const v = loadViewState()
  return {
    agents: {},
    sessions: {},
    blocks: {},
    openOrder: v.openOrder ?? [],
    activeKey: v.activeKey ?? null,
    permission: null,
    permissions: [],
    fsConfirms: [],
    fsConfirm: null,
    termConfirms: [],
    termConfirm: null,
    elicitations: [],
    elicitation: null,
    busy: {},
    usage: {},
    commands: {},
    controls: {},
    queues: {},
    registry: null,
    registryOpen: false,
    connected: false,
  }
}

export const sessionKey = (agentId: string, sessionId: string) => `${agentId}:${sessionId}`

// —— 权限记忆（§2.4-23）：agent+工具类型 → 自动应答的选项，localStorage 持久化 ——
const PERM_RULES_KEY = "acp-client.perm-rules"
type PermRule = { agentId: string; toolKind: string; optionId: string }

export function loadPermissionRules(): PermRule[] {
  if (typeof localStorage === "undefined") return []
  try {
    return JSON.parse(localStorage.getItem(PERM_RULES_KEY) ?? "[]") as PermRule[]
  } catch {
    return []
  }
}

export function savePermissionRules(agentId: string, toolKind: string, optionId: string): void {
  const rules = loadPermissionRules().filter((r) => !(r.agentId === agentId && r.toolKind === toolKind))
  try {
    localStorage.setItem(PERM_RULES_KEY, JSON.stringify([...rules, { agentId, toolKind, optionId }]))
  } catch {
    /* 存储不可用时静默跳过：仅影响自动应答记忆 */
  }
}

/** 权限请求命中记忆规则 → 返回应自动选择的 optionId（未命中返回 null）。 */
export function matchPermissionRule(agentId: string, toolCall: unknown): string | null {
  const toolKind = (toolCall as { kind?: unknown } | null)?.kind
  if (typeof toolKind !== "string") return null
  const rule = loadPermissionRules().find((r) => r.agentId === agentId && r.toolKind === toolKind)
  return rule?.optionId ?? null
}

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

function planEntriesOf(raw: unknown): PlanEntryView[] | null {
  if (!Array.isArray(raw)) return null
  const entries = raw.flatMap((e) => {
    const x = (e ?? {}) as { content?: unknown; priority?: unknown; status?: unknown }
    if (typeof x.content !== "string") return []
    return [{ content: x.content, priority: typeof x.priority === "string" ? x.priority : "medium", status: typeof x.status === "string" ? x.status : "pending" }]
  })
  return entries
}

/** plan 整表替换：已有 plan 块 → 替换最后一个（同 planId 优先）；否则追加。 */
function upsertPlan(blocks: Block[], entries: PlanEntryView[], planId: string | undefined): Block[] {
  let idx = -1
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]!
    if (b.kind !== "plan") continue
    if (planId === undefined || b.planId === undefined || b.planId === planId) { idx = i; break }
  }
  const block: Block = { kind: "plan", entries, planId }
  if (idx < 0) return [...blocks, block]
  return [...blocks.slice(0, idx), block, ...blocks.slice(idx + 1)]
}

function reduceSessionUpdate(s: FrontState, agentId: string, sessionId: string, update: unknown): FrontState {
  const u = (update && typeof update === "object" ? update : null) as Record<string, unknown> | null
  const rawKind = u?.sessionUpdate
  const kind = typeof rawKind === "string" ? rawKind : undefined
  if (kind === "agent_message_chunk" || kind === "agent_thought_chunk" || kind === "user_message_chunk") {
    const target = kind === "agent_message_chunk" ? "assistant-text" : kind === "agent_thought_chunk" ? "thought" : "user"
    const text = textOf(u?.content)
    // messageId 相同 = 同一条消息的分片（协议语义）；无 messageId 时退回「相邻同类合并」
    const mid = typeof u?.messageId === "string" && u.messageId.length > 0 ? u.messageId : undefined
    return withBlocks(s, agentId, sessionId, (blocks) => {
      let idx = -1
      if (mid !== undefined) {
        for (let i = blocks.length - 1; i >= 0; i--) {
          const b = blocks[i]!
          if (b.kind === target && b.messageId === mid) { idx = i; break }
        }
      } else if (blocks.at(-1)?.kind === target) {
        idx = blocks.length - 1
      }
      if (idx >= 0) {
        const last = blocks[idx] as Extract<Block, { kind: typeof target }>
        const merged = { ...last, text: last.text + text }
        return [...blocks.slice(0, idx), merged, ...blocks.slice(idx + 1)]
      }
      return [...blocks, { kind: target, text, messageId: mid } as Block]
    })
  }
  if (kind === "tool_call" || kind === "tool_call_update") {
    const toolCallId = typeof u?.toolCallId === "string" ? u.toolCallId : ""
    const title = typeof u?.title === "string" ? u.title : undefined
    const toolKind = typeof u?.kind === "string" ? u.kind : undefined
    const status = typeof u?.status === "string" ? u.status : undefined
    const content = Array.isArray(u?.content) ? u.content : undefined
    // locations 跟随（P1-13）与 rawInput/rawOutput（§2.4-28）：非 undefined 才覆盖
    const locations = Array.isArray(u?.locations)
      ? (u!.locations as Array<{ path?: unknown; line?: unknown }>).flatMap((l) =>
          typeof l?.path === "string" ? [{ path: l.path, ...(typeof l.line === "number" ? { line: l.line } : {}) }] : [])
      : undefined
    const rawInput = u && "rawInput" in u && u.rawInput !== undefined ? u.rawInput : undefined
    const rawOutput = u && "rawOutput" in u && u.rawOutput !== undefined ? u.rawOutput : undefined
    return withBlocks(s, agentId, sessionId, (blocks) => {
      const i = blocks.findIndex((b) => b.kind === "tool" && b.toolCallId === toolCallId)
      if (i < 0) {
        return [...blocks, { kind: "tool", toolCallId, title, toolKind, status, content, locations, rawInput, rawOutput }]
      }
      const prev = blocks[i] as Extract<Block, { kind: "tool" }>
      const merged = {
        ...prev,
        title: title ?? prev.title,
        toolKind: toolKind ?? prev.toolKind,
        status: status ?? prev.status,
        content: content ?? prev.content,
        locations: locations ?? prev.locations,
        rawInput: rawInput ?? prev.rawInput,
        rawOutput: rawOutput ?? prev.rawOutput,
      }
      return [...blocks.slice(0, i), merged, ...blocks.slice(i + 1)]
    })
  }
  if (kind === "plan" || kind === "plan_update") {
    // 任务计划（P1-9）：整表替换。plan_update 是 unstable 扩展，v1 只处理 items 形态
    const payload = kind === "plan_update" ? (u?.plan as { type?: unknown; entries?: unknown; planId?: unknown } | undefined) : u
    if (payload && payload.type !== undefined && payload.type !== "items") return s // file/markdown 形态：知情不渲染
    const entries = planEntriesOf(payload?.entries)
    if (!entries) return s
    const planId = typeof payload?.planId === "string" ? payload.planId : undefined
    return withBlocks(s, agentId, sessionId, (blocks) => upsertPlan(blocks, entries, planId))
  }
  if (kind === "plan_removed") {
    // unstable：按 planId 移除；无匹配则移除最后一个 plan 块
    const planId = typeof u?.planId === "string" ? u.planId : undefined
    return withBlocks(s, agentId, sessionId, (blocks) => {
      let idx = -1
      for (let i = blocks.length - 1; i >= 0; i--) {
        const b = blocks[i]!
        if (b.kind !== "plan") continue
        if (planId === undefined || b.planId === undefined || b.planId === planId) { idx = i; break }
      }
      if (idx < 0) return blocks
      return [...blocks.slice(0, idx), ...blocks.slice(idx + 1)]
    })
  }
  if (kind === "usage_update") {
    // 上下文占用：整值替换（agent 每次发全量），存到会话维度供输入区展示（P1-7）
    const used = typeof u?.used === "number" ? u.used : null
    const size = typeof u?.size === "number" ? u.size : null
    if (used === null || size === null) return s
    const cost = (u?.cost ?? null) as { amount?: unknown; currency?: unknown } | null
    const k = sessionKey(agentId, sessionId)
    const usage: UsageView = {
      used,
      size,
      ...(typeof cost?.amount === "number" && typeof cost?.currency === "string"
        ? { costAmount: cost.amount, costCurrency: cost.currency }
        : {}),
    }
    return { ...s, usage: { ...s.usage, [k]: usage } }
  }
  if (kind === "session_info_update") {
    // 动态标题（P1-8）：实时更新侧栏会话列表；title 为 null 表示清除
    const title = u?.title
    if (typeof title !== "string") return s
    const list = s.sessions[agentId] ?? []
    if (!list.some((x) => x.sessionId === sessionId)) return s
    return {
      ...s,
      sessions: {
        ...s.sessions,
        [agentId]: list.map((x) => (x.sessionId === sessionId ? { ...x, title } : x)),
      },
    }
  }
  if (kind === "available_commands_update") {
    // slash 命令表（P1-10）：全量替换
    const raw = u?.availableCommands
    if (!Array.isArray(raw)) return s
    const commands = raw.flatMap((c) => {
      const x = (c ?? {}) as { name?: unknown; description?: unknown }
      return typeof x.name === "string" ? [{ name: x.name, description: typeof x.description === "string" ? x.description : "" }] : []
    })
    return { ...s, commands: { ...s.commands, [sessionKey(agentId, sessionId)]: commands } }
  }
  if (kind === "current_mode_update") {
    // 模式切换结果（P1-11）：更新当前模式 id
    const modeId = u?.currentModeId
    if (typeof modeId !== "string") return s
    const k = sessionKey(agentId, sessionId)
    const ctrl = s.controls[k]
    if (!ctrl?.modes) return s
    return { ...s, controls: { ...s.controls, [k]: { ...ctrl, modes: { ...ctrl.modes, currentModeId: modeId } } } }
  }
  if (kind === "config_option_update") {
    // 配置项全量替换（P1-11）
    const raw = u?.configOptions
    if (!Array.isArray(raw)) return s
    const k = sessionKey(agentId, sessionId)
    const configOptions = raw.filter((x): x is SessionConfigOptionView =>
      !!x && typeof x === "object" && typeof (x as { id?: unknown }).id === "string" && typeof (x as { name?: unknown }).name === "string")
    return { ...s, controls: { ...s.controls, [k]: { ...s.controls[k], configOptions } } }
  }
  // 真正未知的 variant 才降级为 unknown 块（ADR-0003）；已知 variant 均有对应处理器
  return withBlocks(s, agentId, sessionId, (blocks) => [
    ...blocks,
    { kind: "unknown", sessionUpdate: String(kind ?? "unknown") },
  ])
}

/** StopReason → 会话流提示块；refusal 按协议要求必须让用户可见（该轮不计入下文）。 */
const STOP_NOTICES: Record<string, { level: "info" | "warn" | "error"; text: string }> = {
  end_turn: { level: "info", text: "" }, // 正常结束，不打扰
  cancelled: { level: "info", text: "已停止生成" },
  max_tokens: { level: "warn", text: "已达最大 token 上限，回答可能被截断" },
  max_turn_requests: { level: "warn", text: "已达单轮模型请求次数上限，回答可能不完整" },
  refusal: { level: "warn", text: "模型拒绝继续；该轮内容不计入后续对话" },
}

function stopNoticeBlock(stopReason: string): Block | null {
  const n = STOP_NOTICES[stopReason]
  if (!n || n.text === "") return null
  return { kind: "notice", level: n.level, text: n.text }
}

export function reduceEvent(s: FrontState, e: BridgeEvent): FrontState {
  switch (e.type) {
    case "snapshot": {
      // 刷新恢复（P0-3）：合并服务端缓存的会话元数据；localStorage 恢复的 activeKey
      // 若对应会话已不在缓存中（缓存被清），落回空态而非空白会话
      const sessions = { ...s.sessions, ...e.sessions }
      let activeKey = s.activeKey && s.openOrder.includes(s.activeKey) ? s.activeKey : null
      if (activeKey) {
        const [agentId, sessionId] = activeKey.split(":")
        if (!sessions[agentId]?.some((x) => x.sessionId === sessionId)) activeKey = null
      }
      return { ...s, agents: Object.fromEntries(e.agents.map((a) => [a.agentId, a])), sessions, activeKey }
    }
    case "agent.status":
      return { ...s, agents: { ...s.agents, [e.agent.agentId]: e.agent } }
    case "session.list":
      return { ...s, sessions: { ...s.sessions, [e.agentId]: e.sessions } }
    case "session.opened": {
      const k = sessionKey(e.agentId, e.sessionId)
      const openOrder = s.openOrder.includes(k) ? s.openOrder : [...s.openOrder, k]
      // 新建/恢复的会话即时写入侧栏列表：不支持 list 的 agent 也能看到刚建的会话；
      // 支持 list 的 agent 随后会被自动刷新的权威列表覆盖（标题由 agent 生成后亦然）
      const list = s.sessions[e.agentId] ?? []
      const sessions = list.some((x) => x.sessionId === e.sessionId)
        ? s.sessions
        : { ...s.sessions, [e.agentId]: [{ sessionId: e.sessionId, cwd: e.cwd, updatedAt: Date.now() }, ...list] }
      const controls = e.modes || e.configOptions ? { ...s.controls, [k]: { modes: e.modes, configOptions: e.configOptions } } : s.controls
      return { ...s, openOrder, sessions, controls, activeKey: k, blocks: { ...s.blocks, [k]: s.blocks[k] ?? [] } }
    }
    case "session.update":
      return reduceSessionUpdate(s, e.agentId, e.sessionId, e.update)
    case "prompt.done": {
      const busy = { ...s.busy, [sessionKey(e.agentId, e.sessionId)]: false }
      const notice = stopNoticeBlock(e.stopReason)
      return notice ? withBlocks({ ...s, busy }, e.agentId, e.sessionId, (blocks) => [...blocks, notice]) : { ...s, busy }
    }
    case "prompt.error": {
      const sid = e.sessionId
      const busy = { ...s.busy, ...(sid ? { [sessionKey(e.agentId, sid)]: false } : {}) }
      // 会话内错误落到消息流（用户正在看的会话能直接看到）；无会话上下文的维持 lastError
      if (!sid) return { ...s, busy, lastError: e.message }
      return withBlocks({ ...s, busy }, e.agentId, sid, (blocks) => [
        ...blocks,
        { kind: "notice", level: "error", text: e.message } as Block,
      ])
    }
    case "permission.request": {
      // 队列化（§2.4-24）：多个权限请求逐个应答，后到者不再覆盖前者
      const v: PermissionView = { requestId: e.requestId, agentId: e.agentId, sessionId: e.sessionId, toolCall: e.toolCall, options: e.options as PermissionView["options"] }
      const permissions = [...s.permissions, v]
      return { ...s, permissions, permission: s.permission ?? v }
    }
    case "permission.done": {
      const permissions = s.permissions.filter((x) => x.requestId !== e.requestId)
      // 队首被移除后展示下一个；非队首完成（应已不可能）仅同步队列
      const permission = s.permission?.requestId === e.requestId ? permissions[0] ?? null : s.permission
      return { ...s, permissions, permission }
    }
    case "fs.confirm": {
      // fs 确认队列（P2-17）：与权限请求同构，逐个应答
      const v: FsConfirmView = { requestId: e.requestId, agentId: e.agentId, sessionId: e.sessionId, kind: e.kind, path: e.path, content: e.content }
      const fsConfirms = [...s.fsConfirms, v]
      return { ...s, fsConfirms, fsConfirm: s.fsConfirm ?? v }
    }
    case "fs.done": {
      const fsConfirms = s.fsConfirms.filter((x) => x.requestId !== e.requestId)
      const fsConfirm = s.fsConfirm?.requestId === e.requestId ? fsConfirms[0] ?? null : s.fsConfirm
      return { ...s, fsConfirms, fsConfirm }
    }
    case "term.confirm": {
      // terminal 确认队列（P2-18）：与 fs 确认同构，逐个应答
      const v: TermConfirmView = { requestId: e.requestId, agentId: e.agentId, sessionId: e.sessionId, command: e.command, args: e.args, ...(e.cwd ? { cwd: e.cwd } : {}) }
      const termConfirms = [...s.termConfirms, v]
      return { ...s, termConfirms, termConfirm: s.termConfirm ?? v }
    }
    case "term.done": {
      const termConfirms = s.termConfirms.filter((x) => x.requestId !== e.requestId)
      const termConfirm = s.termConfirm?.requestId === e.requestId ? termConfirms[0] ?? null : s.termConfirm
      return { ...s, termConfirms, termConfirm }
    }
    case "elicitation.request": {
      // elicitation 队列（P2-19）：与 fs/term 确认同构，逐个应答
      const v: ElicitationView = {
        requestId: e.requestId,
        agentId: e.agentId,
        ...(e.sessionId ? { sessionId: e.sessionId } : {}),
        message: e.message,
        mode: e.mode,
        ...(e.fields ? { fields: e.fields } : {}),
        ...(e.required ? { required: e.required } : {}),
        ...(e.elicitationId ? { elicitationId: e.elicitationId } : {}),
        ...(e.url ? { url: e.url } : {}),
      }
      const elicitations = [...s.elicitations, v]
      return { ...s, elicitations, elicitation: s.elicitation ?? v }
    }
    case "elicitation.done": {
      const elicitations = s.elicitations.filter((x) => x.requestId !== e.requestId)
      const elicitation = s.elicitation?.requestId === e.requestId ? elicitations[0] ?? null : s.elicitation
      return { ...s, elicitations, elicitation }
    }
    case "session.closed": {
      // 会话被关闭/删除（P1-15）：从列表、视图态与块缓存移除
      const k = sessionKey(e.agentId, e.sessionId)
      const list = (s.sessions[e.agentId] ?? []).filter((x) => x.sessionId !== e.sessionId)
      const openOrder = s.openOrder.filter((x) => x !== k)
      const activeKey = s.activeKey === k ? openOrder.at(-1) ?? null : s.activeKey
      const { [k]: _removed, ...blocks } = s.blocks
      return { ...s, sessions: { ...s.sessions, [e.agentId]: list }, openOrder, activeKey, blocks }
    }
    // ACP Registry（P2-21）：snapshot 整体替换并重置进度（done/error 之外的进行中状态以最新快照为准）
    case "registry.snapshot":
      return { ...s, registry: { agents: e.agents, fetchedAt: e.fetchedAt, stale: e.stale, progress: {} } }
    case "registry.progress": {
      if (!s.registry) return s
      return { ...s, registry: { ...s.registry, progress: { ...s.registry.progress, [e.id]: { stage: e.stage, ...(e.message ? { message: e.message } : {}) } } } }
    }
    default:
      return s
  }
}

/** 会话标签切换（§2.4-22）：本地动作，不触发 session/load 重放。 */
export function setActiveSession(agentId: string, sessionId: string): void {
  useFront.setState((s) => ({ ...s, activeKey: sessionKey(agentId, sessionId) }))
}

// —— 输入排队（§2.4-21）：busy 期间发送入队，轮末自动提交队首 ——

export function enqueuePrompt(agentId: string, sessionId: string, item: QueuedPrompt): void {
  useFront.setState((s) => {
    const k = sessionKey(agentId, sessionId)
    return { ...s, queues: { ...s.queues, [k]: [...(s.queues[k] ?? []), item] } }
  })
}

/** 原子取出队首（提交后即移除）；空队列返回 null。 */
export function takeQueuedPrompt(agentId: string, sessionId: string): QueuedPrompt | null {
  const k = sessionKey(agentId, sessionId)
  const queue = useFront.getState().queues[k] ?? []
  if (queue.length === 0) return null
  const [head, ...rest] = queue
  useFront.setState((s) => ({ ...s, queues: { ...s.queues, [k]: rest } }))
  return head ?? null
}

/** 关闭会话标签（§2.4-22）：仅移出视图态，agent 侧会话不受影响。 */
export function closeSessionTab(agentId: string, sessionId: string): void {
  useFront.setState((s) => {
    const k = sessionKey(agentId, sessionId)
    const openOrder = s.openOrder.filter((x) => x !== k)
    const activeKey = s.activeKey === k ? openOrder.at(-1) ?? null : s.activeKey
    return { ...s, openOrder, activeKey }
  })
}

export const useFront = create<FrontState & { apply: (e: BridgeEvent) => void }>((set) => ({
  ...initialFrontState(),
  apply: (e) => set((s) => reduceEvent(s, e)),
}))

// ACP 线上日志（§2.4-26）走独立 bus：不入 zustand（高频推送会拖垮消息流渲染），仅日志面板订阅
export const logBus = {
  listeners: new Set<(e: { agentId: string; dir: "in" | "out"; data: string }) => void>(),
  emit(e: { agentId: string; dir: "in" | "out"; data: string }): void {
    for (const fn of this.listeners) fn(e)
  },
  subscribe(fn: (e: { agentId: string; dir: "in" | "out"; data: string }) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  },
}
