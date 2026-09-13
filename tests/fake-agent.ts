// tests/fake-agent.ts
import { agent, RequestError } from "@agentclientprotocol/sdk"
import type { AgentApp, RequestPermissionOutcome, SessionConfigOption, SessionUpdate } from "@agentclientprotocol/sdk"

export type FakeScript = {
  /** session/prompt 后按序推送的 update；缺省 = 一条思考+一条正文+一条工具卡 */
  updates?: SessionUpdate[]
  /** 是否在 prompt 中发起一次权限请求 */
  askPermission?: boolean
  /** session/new 直接抛 auth_required(-32000) */
  authRequired?: boolean
  /** initialize 返回的 authMethods（非空 → 客户端应显示认证指引） */
  authMethods?: Array<{ type: "agent"; id: string; name: string; description?: string }>
  stopReason?: "end_turn" | "cancelled"
  /** 会话控制面（P1-11）：session/new / session/load 响应携带 */
  modes?: { currentModeId: string; availableModes: Array<{ id: string; name: string }> }
  configOptions?: SessionConfigOption[]
  /** fs 代理（P2-17）：prompt 中向客户端发起写/读请求；结果回推消息 fs-write:ok / fs-write:denied:<msg> */
  askFsWrite?: { path: string; content: string }
  askFsRead?: { path: string }
  /** terminal 代理（P2-18）：prompt 中向客户端发起命令执行；结果回推消息 term:ok:<exitCode>:<output> */
  askTerminal?: { command: string; args?: string[] }
  /** elicitation（P2-19）：form 模式请求；结果回推消息 eli:<action>:<json content> */
  askElicitForm?: { message: string; requestedSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] } }
  /** elicitation（P2-19）：url 模式请求；agent 收到 accept 后模拟完成并发 complete 通知；回推 eli-url:<action> */
  askElicitUrl?: { message: string; url: string }
  /** prompt 输入能力公告（P2-20）：image/audio */
  promptCaps?: { image?: boolean; audio?: boolean }
}

export type FakeAgentState = {
  lastPermissionOutcome: RequestPermissionOutcome | null
  cancelled: boolean
  promptTexts: string[]
  authenticated: boolean
  lastSetMode: string | null
  lastSetConfig: { configId: string; value: string | boolean } | null
  closed: string[]
  deleted: string[]
}

let seq = 0

export function createFakeAgent(script: FakeScript = {}): { app: AgentApp; state: FakeAgentState } {
  let configState: SessionConfigOption[] | null = null
  const state: FakeAgentState = {
    lastPermissionOutcome: null,
    cancelled: false,
    promptTexts: [],
    authenticated: false,
    lastSetMode: null,
    lastSetConfig: null,
    closed: [],
    deleted: [],
  }
  const defaultUpdates: SessionUpdate[] = [
    { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "[思考] 先看看目录" } },
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "你好，这是 fake agent 的回复。" } },
    {
      sessionUpdate: "tool_call",
      toolCallId: "t-1",
      kind: "search",
      status: "in_progress",
      title: "grep TODO",
      content: [{ type: "content", content: { type: "text", text: "src/app.ts:12: // TODO 连接重试" } }],
    },
    { sessionUpdate: "tool_call_update", toolCallId: "t-1", status: "completed" },
  ]

  const app = agent({ name: "fake-agent" })
    .onRequest("initialize", () => ({
      protocolVersion: 1,
      // SDK 1.4.0 的 AgentCapabilities 无顶层 listSessions 字段，list 能力挂在 sessionCapabilities.list
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { list: {}, close: {}, delete: {} },
        ...(script.promptCaps ? { promptCapabilities: script.promptCaps } : {}),
      },
      authMethods: script.authMethods ?? [],
    }))
    .onRequest("authenticate", () => {
      state.authenticated = true
      return {}
    })
    .onRequest("session/new", async (ctx) => {
      if (script.authRequired && !state.authenticated) {
        throw new RequestError(-32000, "Authentication required: run `fake auth login`")
      }
      const mcpServers = ctx.params.mcpServers ?? []
      const sessionId = `fake-${++seq}`
      // mcpServers 转发证据（P1-16）：收到非空列表时回推一条计数消息，供测试断言转发链路
      if (mcpServers.length) {
        await ctx.client.notify("session/update", {
          sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `mcp:${mcpServers.length}` } },
        })
      }
      return { sessionId, ...(script.modes ? { modes: script.modes } : {}), ...(script.configOptions ? { configOptions: script.configOptions } : {}) }
    })
    .onRequest("session/load", () => {
      // 重放两块历史，随后正常返回；modes/configOptions 同 session/new 下发（P1-11）
      return {
        ...(script.modes ? { modes: script.modes } : {}),
        ...(script.configOptions ? { configOptions: script.configOptions } : {}),
      }
    })
    .onRequest("session/set_mode", async (ctx) => {
      state.lastSetMode = ctx.params.modeId
      // 模拟真实 agent 行为：切换后回推 current_mode_update（P1-11 链路验证）
      await ctx.client.notify("session/update", {
        sessionId: ctx.params.sessionId,
        update: { sessionUpdate: "current_mode_update", currentModeId: ctx.params.modeId },
      })
      return {}
    })
    .onRequest("session/set_config_option", async (ctx) => {
      const value = ctx.params.value
      state.lastSetConfig = { configId: ctx.params.configId, value }
      // 协议要求响应回传全量 configOptions；同时 notify 一次模拟推送（P1-11 链路验证）
      // agent 侧维护当前值（可变状态），每次全量推送都基于最新状态
      const current = (configState ??= (script.configOptions ?? []).map((o) => ({ ...o })))
      const configOptions = current.map((o) =>
        o.id === ctx.params.configId
          ? o.type === "boolean"
            ? { ...o, currentValue: value === true }
            : { ...o, currentValue: String(value) }
          : o,
      )
      configState = configOptions
      await ctx.client.notify("session/update", {
        sessionId: ctx.params.sessionId,
        update: { sessionUpdate: "config_option_update", configOptions },
      })
      return { configOptions }
    })
    .onRequest("session/list", () => ({
      sessions: [{ sessionId: "fake-1", cwd: "C:/", title: "fake 会话一", updatedAt: new Date().toISOString() }],
    }))
    .onRequest("session/close", (ctx) => {
      state.closed.push(ctx.params.sessionId)
      return {}
    })
    .onRequest("session/delete", (ctx) => {
      state.deleted.push(ctx.params.sessionId)
      return {}
    })
    .onNotification("session/cancel", () => {
      state.cancelled = true
    })
    .onRequest("session/prompt", async (ctx) => {
      state.promptTexts.push(JSON.stringify(ctx.params.prompt))
      const sessionId = ctx.params.sessionId
      // 音频输入（P2-20）：prompt 携带 audio block 时回推 mime 供测试断言
      for (const block of ctx.params.prompt) {
        if ("type" in block && block.type === "audio") {
          await ctx.client.notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `audio:${block.mimeType}` } } })
        }
      }
      const updates = script.updates ?? defaultUpdates
      for (const update of updates) {
        await ctx.client.notify("session/update", { sessionId, update })
      }
      if (script.askPermission) {
        const res = await ctx.client.request("session/request_permission", {
          sessionId,
          toolCall: { toolCallId: "t-perm", kind: "execute", status: "pending", title: "rm -rf /" },
          options: [
            { optionId: "allow", name: "Allow once", kind: "allow_once" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        })
        state.lastPermissionOutcome = res.outcome
      }
      // fs 代理（P2-17）：写/读请求经客户端 FsGate；结果以消息块回推供测试断言
      for (const [key, req] of [
        ["fs-write", script.askFsWrite] as const,
        ["fs-read", script.askFsRead ? { ...script.askFsRead } : null] as const,
      ]) {
        if (!req) continue
        try {
          if (key === "fs-write") {
            await ctx.client.request("fs/write_text_file", { sessionId, path: req.path, content: (req as { content: string }).content })
          } else {
            const r = await ctx.client.request("fs/read_text_file", { sessionId, path: req.path })
            await ctx.client.notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `fs-read:${r.content}` } } })
            continue
          }
          await ctx.client.notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${key}:ok` } } })
        } catch (e) {
          await ctx.client.notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${key}:denied:${(e as Error).message}` } } })
        }
      }
      // terminal 代理（P2-18）：create → wait → output → release 全流程
      if (script.askTerminal) {
        try {
          const c = await ctx.client.request("terminal/create", { sessionId, command: script.askTerminal.command, args: script.askTerminal.args ?? [] })
          const w = await ctx.client.request("terminal/wait_for_exit", { sessionId, terminalId: c.terminalId })
          const o = await ctx.client.request("terminal/output", { sessionId, terminalId: c.terminalId })
          await ctx.client.request("terminal/release", { sessionId, terminalId: c.terminalId })
          await ctx.client.notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `term:ok:${w.exitCode}:${o.output}` } } })
        } catch (e) {
          await ctx.client.notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `term:denied:${(e as Error).message}` } } })
        }
      }
      // elicitation（P2-19）：form 模式 → 用户应答回传；url 模式 → accept 后模拟 complete 通知
      if (script.askElicitForm) {
        try {
          const res = await ctx.client.request("elicitation/create", { sessionId, mode: "form", message: script.askElicitForm.message, requestedSchema: script.askElicitForm.requestedSchema })
          const content = res.action === "accept" ? (res.content ?? null) : null
          await ctx.client.notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `eli:${res.action}:${JSON.stringify(content)}` } } })
        } catch (e) {
          await ctx.client.notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `eli:denied:${(e as Error).message}` } } })
        }
      }
      if (script.askElicitUrl) {
        try {
          const elicitationId = `eli-${Date.now()}`
          const res = await ctx.client.request("elicitation/create", { sessionId, mode: "url", message: script.askElicitUrl.message, elicitationId, url: script.askElicitUrl.url })
          if (res.action === "accept") {
            // 模拟用户在浏览器完成 OAuth 流程后 agent 收到回调，通知客户端清理 UI
            await ctx.client.notify("elicitation/complete", { elicitationId })
          }
          await ctx.client.notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `eli-url:${res.action}` } } })
        } catch (e) {
          await ctx.client.notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `eli-url:denied:${(e as Error).message}` } } })
        }
      }
      return { stopReason: script.stopReason ?? "end_turn" }
    })
  return { app, state }
}
