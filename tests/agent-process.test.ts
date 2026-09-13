// tests/agent-process.test.ts
import path from "node:path"
import { describe, expect, it } from "vitest"
import type { RequestPermissionOutcome, SessionNotification } from "@agentclientprotocol/sdk"
import { spawnAgentProcess } from "../src/server/agent-process"
import { connectAcp } from "../src/server/connection"

const CHILD = path.resolve("tests/fake-agent-child.ts")

describe("spawnAgentProcess", () => {
  it("通过真实 stdio 完成 initialize + prompt + 杀进程", async () => {
    // shell:true 下 args 只拼接不转义（DEP0190），含空格的路径需自带引号（计划已知取舍 2）
    const proc = spawnAgentProcess({
      name: "fake",
      command: `"${process.execPath}"`,
      args: ["--import", "tsx", `"${CHILD}"`],
      env: {},
      autoStart: false,
      builtin: false,
    })
    const updates: SessionNotification[] = []
    const acp = await connectAcp(proc.stream, {
      onUpdate: (n) => updates.push(n),
      onRequestPermission: () => Promise.resolve<RequestPermissionOutcome>({ outcome: "cancelled" }),
    })
    expect(acp.info.protocolVersion).toBe(1)

    const { sessionId } = await acp.agent.request("session/new", { cwd: "C:/tmp", mcpServers: [] })
    const done = acp.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hi" }] })
    const start = Date.now()
    while (updates.length < 4 && Date.now() - start < 5000) await new Promise((r) => setTimeout(r, 20))
    const res = await done
    expect(res.stopReason).toBe("end_turn")

    proc.kill()
    const exit = await proc.exit
    expect(exit.code ?? exit.signal).toBeTruthy()
    await acp.closed
  }, 15000)
})
