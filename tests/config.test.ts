// tests/config.test.ts
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { loadAgentDefs } from "../src/server/config"

function tmpHome() {
  return mkdtempSync(path.join(tmpdir(), "acp-client-"))
}

describe("loadAgentDefs", () => {
  it("无配置文件时写入默认文件并返回内置模板", () => {
    const dir = tmpHome()
    const defs = loadAgentDefs(dir)
    expect(defs.map((d) => d.name)).toContain("dsh")
    expect(defs.map((d) => d.name)).toContain("opencode")
    const written = JSON.parse(readFileSync(path.join(dir, "agents.json"), "utf8"))
    expect(written.agents).toHaveLength(2)
  })

  it("用户同名条目覆盖模板的 command/args/env，保留 builtin 标记", () => {
    const dir = tmpHome()
    writeFileSync(
      path.join(dir, "agents.json"),
      JSON.stringify({
        agents: [{ name: "dsh", command: "C:/bin/dsh.exe", args: ["acp"] }],
      }),
    )
    const dsh = loadAgentDefs(dir).find((d) => d.name === "dsh")!
    expect(dsh.command).toBe("C:/bin/dsh.exe")
    expect(dsh.args).toEqual(["acp"])
    expect(dsh.builtin).toBe(true)
  })

  it("用户新增条目追加在模板之后；非法条目抛错", () => {
    const dir = tmpHome()
    writeFileSync(
      path.join(dir, "agents.json"),
      JSON.stringify({ agents: [{ name: "fake", command: "node" }, { name: "" }] }),
    )
    expect(() => loadAgentDefs(dir)).toThrow()
    writeFileSync(
      path.join(dir, "agents.json"),
      JSON.stringify({ agents: [{ name: "fake", command: "node" }] }),
    )
    expect(loadAgentDefs(dir).map((d) => d.name)).toEqual(["dsh", "opencode", "fake"])
  })
})
