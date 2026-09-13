// tests/fs-proxy.test.ts
// fs 代理（P2-17）单元测试：子树判定、自动放行策略、确认循环、pending 清理
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { RequestError } from "@agentclientprotocol/sdk"
import { FsGate, within, type FsConfirmRequest } from "../src/server/fs-proxy"

function tmpDir(): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), "acp-fs-")))
}

describe("within（子树判定）", () => {
  const cwd = tmpDir()
  it("cwd 内 / 相同路径 → true；../ 逃逸与同级目录 → false", () => {
    expect(within(cwd, path.join(cwd, "a", "b.txt"))).toBe(true)
    expect(within(cwd, cwd)).toBe(true)
    expect(within(cwd, path.join(cwd, "..", "x.txt"))).toBe(false)
    expect(within(cwd, path.join(cwd + "-sibling", "a.txt"))).toBe(false)
  })
  it("Windows 大小写不敏感", () => {
    if (process.platform !== "win32") return
    expect(within(cwd.toLowerCase(), path.join(cwd.toUpperCase(), "a.txt"))).toBe(true)
  })
})

describe("FsGate", () => {
  function setup(cwdMap?: Record<string, string>) {
    const confirms: FsConfirmRequest[] = []
    const done: number[] = []
    const gate = new FsGate(
      (_agentId, sessionId) => cwdMap?.[sessionId],
      {
        onConfirm: (req) => confirms.push(req),
        onDone: (requestId) => done.push(requestId),
      },
    )
    return { gate, confirms, done }
  }

  it("cwd 子树内读自动放行，不触发确认", async () => {
    const dir = tmpDir()
    const file = path.join(dir, "in.txt")
    writeFileSync(file, "hello")
    const { gate, confirms } = setup({ s1: dir })
    const res = await gate.read("a", { sessionId: "s1", path: file })
    expect(res.content).toBe("hello")
    expect(confirms).toHaveLength(0)
  })

  it("cwd 外读需确认：允许 → 返回内容；拒绝 → RequestError", async () => {
    const dir = tmpDir()
    const outside = tmpDir()
    const file = path.join(outside, "secret.txt")
    writeFileSync(file, "top")
    const { gate, confirms, done } = setup({ s1: dir })

    const p1 = gate.read("a", { sessionId: "s1", path: file })
    await vi_waitFor(() => confirms.length === 1)
    expect(confirms[0]).toMatchObject({ kind: "read", path: path.resolve(file) })
    gate.respond(confirms[0]!.requestId, true)
    await expect(p1).resolves.toEqual({ content: "top" })
    expect(done).toEqual([confirms[0]!.requestId])

    const p2 = gate.read("a", { sessionId: "s1", path: file })
    await vi_waitFor(() => confirms.length === 2)
    gate.respond(confirms[1]!.requestId, false)
    await expect(p2).rejects.toSatisfy((e: unknown) => e instanceof RequestError && /用户拒绝/.test((e as Error).message))
  })

  it("cwd 内写也需确认：允许 → 落盘", async () => {
    const dir = tmpDir()
    const file = path.join(dir, "out.txt")
    const { gate, confirms } = setup({ s1: dir })
    const p = gate.write("a", { sessionId: "s1", path: file, content: "data" })
    await vi_waitFor(() => confirms.length === 1)
    expect(confirms[0]).toMatchObject({ kind: "write", content: "data" })
    gate.respond(confirms[0]!.requestId, true)
    await expect(p).resolves.toEqual({})
    rmSync(file)
  })

  it("line/limit 行切片；../ 逃逸按 cwd 外处理", async () => {
    const dir = tmpDir()
    const file = path.join(dir, "lines.txt")
    writeFileSync(file, "l1\nl2\nl3")
    const { gate, confirms } = setup({ s1: dir })
    const res = await gate.read("a", { sessionId: "s1", path: file, line: 2, limit: 1 })
    expect(res.content).toBe("l2")

    // path.resolve 后逃出 cwd → 需确认
    const p = gate.read("a", { sessionId: "s1", path: path.join(dir, "..", "escape.txt") })
    await vi_waitFor(() => confirms.length === 1)
    gate.respond(confirms[0]!.requestId, false)
    await expect(p).rejects.toBeInstanceOf(RequestError)
  })

  it("不存在 / 目录 → -32602；未知 requestId 应答无效", async () => {
    const dir = tmpDir()
    const sub = path.join(dir, "sub")
    mkdirSync(sub)
    const { gate, confirms } = setup({ s1: dir })
    await expect(gate.read("a", { sessionId: "s1", path: path.join(dir, "nope.txt") })).rejects.toMatchObject({ code: -32602 })
    await expect(gate.read("a", { sessionId: "s1", path: sub })).rejects.toMatchObject({ code: -32602 })
    gate.respond(999, true) // 不应抛错
    expect(confirms).toHaveLength(0)
  })

  it("取消轮次 rejectSession / agent 停止 rejectAgent：pending 按拒绝收场并回调 onDone", async () => {
    const dir = tmpDir()
    const { gate, confirms, done } = setup({ s1: dir, s2: dir })
    const p1 = gate.write("a", { sessionId: "s1", path: path.join(dir, "f1.txt"), content: "1" })
    const p2 = gate.write("a", { sessionId: "s2", path: path.join(dir, "f2.txt"), content: "2" })
    const p3 = gate.write("b", { sessionId: "s2", path: path.join(dir, "f3.txt"), content: "3" })
    await vi_waitFor(() => confirms.length === 3)

    gate.rejectSession("a", "s1")
    await expect(p1).rejects.toBeInstanceOf(RequestError)
    // rejectAgent 只清该 agent：b 的请求仍在
    gate.rejectAgent("b")
    await expect(p3).rejects.toBeInstanceOf(RequestError)
    expect(done).toHaveLength(2)
    expect(confirms.filter((c) => ["f1", "f3"].some((f) => c.path.includes(f)))).toHaveLength(2)

    const { gate: gate2, confirms: c2, done: done2 } = setup({ s1: dir })
    const q = gate2.write("a", { sessionId: "s1", path: path.join(dir, "g.txt"), content: "x" })
    await vi_waitFor(() => c2.length === 1)
    gate2.rejectAllPending()
    await expect(q).rejects.toBeInstanceOf(RequestError)
    expect(done2).toHaveLength(1)

    // 收尾：a 的 s2 请求仍未收场，全量清理后结算
    gate.rejectAllPending()
    await expect(p2).rejects.toBeInstanceOf(RequestError)
    expect(done).toHaveLength(3)
  })
})

async function vi_waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor timeout")
    await new Promise((r) => setTimeout(r, 10))
  }
}
