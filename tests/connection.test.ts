// tests/connection.test.ts
import { describe, expect, it } from "vitest"
import type {
  InitializeRequest,
  RequestPermissionOutcome,
  SessionNotification,
} from "@agentclientprotocol/sdk"
import { buildClientApp } from "../src/server/connection"
import { createFakeAgent } from "./fake-agent"

function setup(script: Parameters<typeof createFakeAgent>[0]) {
  const { app: fakeApp, state } = createFakeAgent(script)
  const updates: SessionNotification[] = []
  let permissionResolve: ((o: RequestPermissionOutcome) => void) | null = null
  const clientApp = buildClientApp({
    onUpdate: (n) => updates.push(n),
    onRequestPermission: () =>
      new Promise<RequestPermissionOutcome>((resolve) => {
        permissionResolve = resolve
      }),
  })
  const conn = clientApp.connect(fakeApp)
  return { conn, state, updates, answerPermission: (o: RequestPermissionOutcome) => permissionResolve!(o) }
}

// 显式 InitializeRequest 注解：模块级推断类型常量会让 request 的泛型重载
// 静默失配（返回 unknown），与 connection.ts 的 CLIENT_INFO 同因
const INIT: InitializeRequest = {
  protocolVersion: 1 as const,
  clientCapabilities: { auth: { terminal: true }, _meta: { "terminal-auth": true } },
  clientInfo: { name: "acp-client", version: "0.1.0" },
}

describe("buildClientApp", () => {
  it("initialize 握手成功且收到 authMethods", async () => {
    const { conn } = setup({ authMethods: [{ type: "agent", id: "login", name: "Login" }] })
    const info = await conn.agent.request("initialize", INIT)
    expect(info.protocolVersion).toBe(1)
    expect(info.authMethods).toHaveLength(1)
    conn.close()
  })

  it("session/new → prompt：按序收到 update，最终 stopReason=end_turn", async () => {
    const { conn, updates } = setup({})
    await conn.agent.request("initialize", INIT)
    const { sessionId } = await conn.agent.request("session/new", { cwd: "C:/tmp", mcpServers: [] })
    const done = conn.agent.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "hi" }],
    })
    // 等 updates 流入后再等待 prompt 返回
    await vi_waitFor(() => updates.length >= 4)
    const res = await done
    expect(res.stopReason).toBe("end_turn")
    expect(updates[0].update.sessionUpdate).toBe("agent_thought_chunk")
    expect(updates.map((u) => u.sessionId)).toContain(sessionId)
    conn.close()
  })

  it("权限请求桥接：客户端选择映射为 optionId 返回给 agent", async () => {
    const { conn, updates, state, answerPermission } = setup({ askPermission: true })
    await conn.agent.request("initialize", INIT)
    const { sessionId } = await conn.agent.request("session/new", { cwd: "C:/tmp", mcpServers: [] })
    const done = conn.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] })
    await vi_waitFor(() => updates.some((u) => u.update.sessionUpdate === "tool_call"))
    answerPermission({ outcome: "selected", optionId: "allow" })
    await done
    expect(state.lastPermissionOutcome).toEqual({ outcome: "selected", optionId: "allow" })
    conn.close()
  })
})

async function vi_waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor timeout")
    await new Promise((r) => setTimeout(r, 10))
  }
}
