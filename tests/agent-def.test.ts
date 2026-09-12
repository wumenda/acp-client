// tests/agent-def.test.ts
import { describe, expect, it } from "vitest"
import { AgentDefSchema, BUILTIN_AGENT_DEFS } from "../src/shared/agent-def"

describe("AgentDefSchema", () => {
  it("补全默认值 args=[] env={} builtin=false", () => {
    const def = AgentDefSchema.parse({ name: "x", command: "x" })
    expect(def.args).toEqual([])
    expect(def.env).toEqual({})
    expect(def.builtin).toBe(false)
    expect(def.shell).toBeUndefined()
  })

  it("拒绝空 command", () => {
    expect(() => AgentDefSchema.parse({ name: "x", command: "" })).toThrow()
  })
})

describe("BUILTIN_AGENT_DEFS", () => {
  it("包含 dsh 与 opencode 的实测启动命令", () => {
    const dsh = BUILTIN_AGENT_DEFS.find((d) => d.name === "dsh")!
    expect(dsh.args).toEqual(["--profile", "acp"])
    const oc = BUILTIN_AGENT_DEFS.find((d) => d.name === "opencode")!
    expect(oc.args).toEqual(["acp"])
  })
})
