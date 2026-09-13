// tests/session-cache.test.ts
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { SessionCache } from "../src/server/session-cache"

describe("SessionCache", () => {
  it("upsert 后重新加载仍可读（持久化）", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "acp-client-"))
    const a = new SessionCache(dir)
    a.upsert("dsh", { sessionId: "s1", cwd: "C:/proj", updatedAt: 1, title: "t" })
    const b = new SessionCache(dir)
    expect(b.list("dsh")).toEqual([{ sessionId: "s1", cwd: "C:/proj", updatedAt: 1, title: "t" }])
  })

  it("list 支持按 cwd 过滤且按 updatedAt 倒序", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "acp-client-"))
    const c = new SessionCache(dir)
    c.upsert("dsh", { sessionId: "s1", cwd: "C:/a", updatedAt: 1 })
    c.upsert("dsh", { sessionId: "s2", cwd: "C:/b", updatedAt: 3 })
    c.upsert("dsh", { sessionId: "s3", cwd: "C:/a", updatedAt: 2 })
    const inA = c.list("dsh", "C:/a")
    expect(inA.map((s) => s.sessionId)).toEqual(["s3", "s1"])
  })

  it("touch 更新 updatedAt；空缓存 list 返回 []", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "acp-client-"))
    const c = new SessionCache(dir)
    c.upsert("dsh", { sessionId: "s1", cwd: "C:/a", updatedAt: 1 })
    c.touch("dsh", "s1", 99)
    expect(c.list("dsh")[0].updatedAt).toBe(99)
    expect(c.list("nope")).toEqual([])
  })

  it("setTitle 更新已建档会话标题并持久化；未建档忽略", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "acp-client-"))
    const c = new SessionCache(dir)
    c.upsert("dsh", { sessionId: "s1", cwd: "C:/a", updatedAt: 1 })
    c.setTitle("dsh", "s1", "新标题")
    c.setTitle("dsh", "ghost", "无记录应忽略")
    const b = new SessionCache(dir)
    expect(b.list("dsh")).toEqual([{ sessionId: "s1", cwd: "C:/a", updatedAt: 1, title: "新标题" }])
  })
})
