// tests/terminal-manager.test.ts
// terminal 代理（P2-18）单元测试：确认门、执行链路、输出截断、句柄清理
import { describe, expect, it } from "vitest"
import { RequestError } from "@agentclientprotocol/sdk"
import { TerminalManager, type TermConfirmRequest } from "../src/server/terminal-manager"

function setup() {
  const confirms: TermConfirmRequest[] = []
  const done: number[] = []
  const mgr = new TerminalManager({
    onConfirm: (req) => confirms.push(req),
    onDone: (requestId) => done.push(requestId),
  })
  return { mgr, confirms, done }
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor timeout")
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe("TerminalManager", () => {
  it("create 拒绝 → RequestError，不执行命令", async () => {
    const { mgr, confirms } = setup()
    const p = mgr.create("a", { sessionId: "s1", command: "node", args: ["-e", "console.log(1)"] })
    await waitFor(() => confirms.length === 1)
    expect(confirms[0]).toMatchObject({ command: "node", args: ["-e", "console.log(1)"], sessionId: "s1" })
    mgr.respond(confirms[0]!.requestId, false)
    await expect(p).rejects.toSatisfy((e: unknown) => e instanceof RequestError && /用户拒绝/.test((e as Error).message))
  })

  it("create 允许 → 执行 + wait/output/release 全链路", async () => {
    const { mgr, confirms, done } = setup()
    const p = mgr.create("a", { sessionId: "s1", command: "node", args: ["-e", "console.log(40+2)"] })
    await waitFor(() => confirms.length === 1)
    mgr.respond(confirms[0]!.requestId, true)
    const { terminalId } = await p
    expect(terminalId).toMatch(/^term-/)
    expect(done).toEqual([confirms[0]!.requestId])

    const exit = await mgr.wait("a", { sessionId: "s1", terminalId })
    expect(exit.exitCode).toBe(0)
    // stdout 异步聚合：轮询到输出出现
    await waitFor(() => mgr.output("a", { sessionId: "s1", terminalId }).output.includes("42"))
    const out = mgr.output("a", { sessionId: "s1", terminalId })
    expect(out.truncated).toBe(false)
    expect(out.exitStatus?.exitCode).toBe(0)

    mgr.release("a", { sessionId: "s1", terminalId })
    expect(() => mgr.output("a", { sessionId: "s1", terminalId })).toThrow(RequestError)
  })

  it("outputByteLimit 截断：超限丢头部且 truncated=true（字符边界）", async () => {
    const { mgr, confirms } = setup()
    // 输出 40 字符 + 换行，限制 10 字符
    const p = mgr.create("a", { sessionId: "s1", command: "node", args: ["-e", "console.log('x'.repeat(40))"], outputByteLimit: 10 })
    await waitFor(() => confirms.length === 1)
    mgr.respond(confirms[0]!.requestId, true)
    const { terminalId } = await p
    await mgr.wait("a", { sessionId: "s1", terminalId })
    await waitFor(() => mgr.output("a", { sessionId: "s1", terminalId }).truncated)
    const out = mgr.output("a", { sessionId: "s1", terminalId })
    expect(out.truncated).toBe(true)
    expect(out.output.length).toBeLessThanOrEqual(10)
    expect(out.output).toMatch(/^x+\r?\n?$/)
  })

  it("kill 终止运行中命令（wait 收到非零/信号收场）；未知 terminalId → -32602", async () => {
    const { mgr, confirms } = setup()
    // Windows 上 kill 落到强杀，退出码/信号不保证形态，只要 wait 能收场
    const p = mgr.create("a", { sessionId: "s1", command: "node", args: ["-e", "setInterval(()=>{},1000)"] })
    await waitFor(() => confirms.length === 1)
    mgr.respond(confirms[0]!.requestId, true)
    const { terminalId } = await p
    await waitFor(() => mgr.output("a", { sessionId: "s1", terminalId }).exitStatus == null)
    mgr.kill("a", { sessionId: "s1", terminalId })
    const exit = await mgr.wait("a", { sessionId: "s1", terminalId })
    expect(exit.exitCode == null || exit.exitCode !== 0 || exit.signal != null).toBe(true)
    expect(() => mgr.output("a", { sessionId: "s1", terminalId: "term-999" })).toThrow(/终端不存在/)
  })

  it("killAgent：杀该 agent 全部终端 + 拒挂起确认；其它 agent 不受影响", async () => {
    const { mgr, confirms } = setup()
    const pa = mgr.create("a", { sessionId: "s1", command: "node", args: ["-e", "setInterval(()=>{},1000)"] })
    await waitFor(() => confirms.length === 1)
    mgr.respond(confirms[0]!.requestId, true)
    const { terminalId } = await pa

    const pb = mgr.create("b", { sessionId: "s2", command: "node", args: ["-e", "console.log(1)"] })
    await waitFor(() => confirms.length === 2)
    mgr.killAgent("b") // b 的挂起确认被拒
    await expect(pb).rejects.toBeInstanceOf(RequestError)

    // a 的终端仍可读；killAgent("a") 后消失
    mgr.output("a", { sessionId: "s1", terminalId })
    mgr.killAgent("a")
    expect(() => mgr.output("a", { sessionId: "s1", terminalId })).toThrow(RequestError)
  })

  it("取消轮次 rejectSession：仅拒该会话挂起确认，运行中终端不受影响", async () => {
    const { mgr, confirms } = setup()
    const p1 = mgr.create("a", { sessionId: "s1", command: "node", args: ["-e", "console.log(1)"] })
    await waitFor(() => confirms.length === 1)
    mgr.rejectSession("a", "s1")
    await expect(p1).rejects.toBeInstanceOf(RequestError)

    const p2 = mgr.create("a", { sessionId: "s2", command: "node", args: ["-e", "console.log(2)"] })
    await waitFor(() => confirms.length === 2)
    mgr.respond(confirms[1]!.requestId, true)
    await expect(p2).resolves.toMatchObject({ terminalId: expect.stringMatching(/^term-/) })
    mgr.killAgent("a")
  })
})
