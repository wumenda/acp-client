// tests/fake-agent.ts
import { agent, RequestError } from "@agentclientprotocol/sdk"
import type { AgentApp, RequestPermissionOutcome, SessionUpdate } from "@agentclientprotocol/sdk"

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
}

export type FakeAgentState = {
  lastPermissionOutcome: RequestPermissionOutcome | null
  cancelled: boolean
  promptTexts: string[]
  authenticated: boolean
}

let seq = 0

export function createFakeAgent(script: FakeScript = {}): { app: AgentApp; state: FakeAgentState } {
  const state: FakeAgentState = {
    lastPermissionOutcome: null,
    cancelled: false,
    promptTexts: [],
    authenticated: false,
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
    },
    { sessionUpdate: "tool_call_update", toolCallId: "t-1", status: "completed" },
  ]

  const app = agent({ name: "fake-agent" })
    .onRequest("initialize", () => ({
      protocolVersion: 1,
      // SDK 1.4.0 的 AgentCapabilities 无顶层 listSessions 字段，list 能力挂在 sessionCapabilities.list
      agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } },
      authMethods: script.authMethods ?? [],
    }))
    .onRequest("authenticate", () => {
      state.authenticated = true
      return {}
    })
    .onRequest("session/new", (ctx) => {
      if (script.authRequired && !state.authenticated) {
        throw new RequestError(-32000, "Authentication required: run `fake auth login`")
      }
      return { sessionId: `fake-${++seq}` }
    })
    .onRequest("session/load", () => {
      // 重放两块历史，随后正常返回
      return {}
    })
    .onRequest("session/list", () => ({
      sessions: [{ sessionId: "fake-1", cwd: "C:/", title: "fake 会话一", updatedAt: new Date().toISOString() }],
    }))
    .onNotification("session/cancel", () => {
      state.cancelled = true
    })
    .onRequest("session/prompt", async (ctx) => {
      state.promptTexts.push(JSON.stringify(ctx.params.prompt))
      const sessionId = ctx.params.sessionId
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
      return { stopReason: script.stopReason ?? "end_turn" }
    })
  return { app, state }
}
