// tests/app.test.ts
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { BridgeCommand } from "../src/shared/bridge-protocol"
import { createHarness, type Harness } from "./app-harness"

const CHILD = path.resolve("tests/fake-agent-child.ts")

// shell:true 下 args 只拼接不转义（DEP0190），含空格路径需自带引号（同 store.test 的做法）
const FAKE_DEF = {
  name: "fake",
  command: `"${process.execPath}"`,
  args: ["--import", "tsx", `"${CHILD}"`],
  env: {},
  builtin: false,
}

describe("app", () => {
  let h: Harness

  beforeAll(async () => {
    h = await createHarness([{ ...FAKE_DEF }])
  })
  afterAll(() => h.close())

  it("未带 token 的 HTTP 请求 → 401；带 token → 200", async () => {
    const no = await h.request("/api/health")
    expect(no.status).toBe(401)
    const ok = await h.request(`/api/health?token=${h.token}`)
    expect(ok.status).toBe(200)
  })

  it("WS 全链路：snapshot → agent.start → session.new → prompt 收流", async () => {
    const ws = await h.connectWs()
    const snapshot = (await ws.next((e) => e.type === "snapshot")) as { agents: { agentId: string }[] }
    expect(snapshot.agents.map((a) => a.agentId)).toEqual(["fake"])

    ws.send({ type: "agent.start", agentId: "fake" } satisfies BridgeCommand)
    await ws.next((e) => e.type === "agent.status" && e.agent.status === "ready")

    ws.send({ type: "session.new", agentId: "fake", cwd: "C:/tmp" } satisfies BridgeCommand)
    const opened = (await ws.next((e) => e.type === "session.opened")) as { sessionId: string }
    const sessionId = opened.sessionId

    ws.send({ type: "session.prompt", agentId: "fake", sessionId, text: "hi" } satisfies BridgeCommand)
    const echo = (await ws.next((e) => e.type === "session.update")) as {
      update: { sessionUpdate: string; content?: { type: string; text: string } }
    }
    expect(echo.update.sessionUpdate).toBe("user_message_chunk")
    expect(echo.update.content).toMatchObject({ type: "text", text: "hi" })
    await ws.next((e) => e.type === "session.update")
    const done = await ws.next((e) => e.type === "prompt.done")
    expect((done as { stopReason: string }).stopReason).toBe("end_turn")
    ws.close()
  }, 20000)

  it("权限流：permission.request → permission.respond → permission.done", async () => {
    // 用带 FAKE_ASK_PERMISSION 的第二个 agent
    const h2 = await createHarness([
      {
        name: "fakeperm",
        command: `"${process.execPath}"`,
        args: ["--import", "tsx", `"${CHILD}"`],
        env: { FAKE_ASK_PERMISSION: "1" },
        builtin: false,
      },
    ])
    const ws = await h2.connectWs()
    await ws.next((e) => e.type === "snapshot")
    ws.send({ type: "agent.start", agentId: "fakeperm" })
    await ws.next((e) => e.type === "agent.status" && e.agent.status === "ready")
    ws.send({ type: "session.new", agentId: "fakeperm", cwd: "C:/tmp" })
    const opened = (await ws.next((e) => e.type === "session.opened")) as { sessionId: string }
    ws.send({ type: "session.prompt", agentId: "fakeperm", sessionId: opened.sessionId, text: "go" })
    const perm = (await ws.next((e) => e.type === "permission.request")) as { requestId: number }
    expect(perm.requestId).toBeGreaterThan(0)
    ws.send({ type: "permission.respond", requestId: perm.requestId, optionId: "reject" })
    const doneEv = (await ws.next((e) => e.type === "permission.done")) as { requestId: number }
    expect(doneEv.requestId).toBe(perm.requestId)
    const done = (await ws.next((e) => e.type === "prompt.done")) as { stopReason: string }
    expect(done.stopReason).toBe("end_turn")
    ws.close()
    await h2.close()
  }, 20000)
})
