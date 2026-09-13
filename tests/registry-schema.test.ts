import { describe, expect, it } from "vitest"
import { RegistryIndexSchema, platformTarget, resolveDistribution, semverGt } from "../src/server/registry/schema"

const ENTRY = {
  id: "example-agent", name: "Example Agent", version: "1.2.3",
  description: "demo", website: "https://example.com",
  authors: ["A"], license: "MIT",
  icon: "https://cdn.example.com/icon.svg",
  distribution: {
    binary: {
      "windows-x86_64": { archive: "https://x/a.zip", sha256: "abc", cmd: "bin/agent.exe", args: ["--acp"] },
      "linux-aarch64": { archive: "https://x/a.tgz", sha256: "def", cmd: "bin/agent" },
    },
  },
}

describe("RegistryIndexSchema", () => {
  it("解析标准索引", () => {
    const idx = RegistryIndexSchema.parse({ version: "1.0.0", agents: [ENTRY] })
    expect(idx.agents[0].id).toBe("example-agent")
  })
  it("宽容：未知字段容忍；version 非 X.Y.Z 拒绝", () => {
    expect(RegistryIndexSchema.parse({ version: "1", agents: [{ ...ENTRY, extra: 1 } as never] }).agents).toHaveLength(1)
    expect(() => RegistryIndexSchema.parse({ version: "1.0.0", agents: [{ ...ENTRY, version: "v1.2" }] })).toThrow()
  })
  it("distribution 必须至少一个已知形态", () => {
    expect(() => RegistryIndexSchema.parse({ version: "1", agents: [{ ...ENTRY, distribution: {} }] })).toThrow()
  })
})

describe("platformTarget", () => {
  it("常见组合映射", () => {
    expect(platformTarget("win32", "x64")).toBe("windows-x86_64")
    expect(platformTarget("win32", "arm64")).toBe("windows-aarch64")
    expect(platformTarget("darwin", "arm64")).toBe("darwin-aarch64")
    expect(platformTarget("darwin", "x64")).toBe("darwin-x86_64")
    expect(platformTarget("linux", "x64")).toBe("linux-x86_64")
    expect(platformTarget("linux", "arm64")).toBe("linux-aarch64")
  })
  it("不支持的组合抛错", () => {
    expect(() => platformTarget("sunos", "x64")).toThrow()
    expect(() => platformTarget("linux", "mips")).toThrow()
  })
})

describe("resolveDistribution", () => {
  it("binary 命中当前平台 → { kind:'binary', spec }", () => {
    const r = resolveDistribution(ENTRY.distribution, "windows-x86_64")
    expect(r?.kind).toBe("binary")
  })
  it("binary 无当前平台 → null；npx/uvx 平台无关", () => {
    expect(resolveDistribution(ENTRY.distribution, "darwin-x86_64")).toBeNull()
    expect(resolveDistribution({ npx: { package: "foo", args: ["--x"] } }, "windows-x86_64")?.kind).toBe("npx")
    expect(resolveDistribution({ uvx: { package: "foo" } }, "windows-x86_64")?.kind).toBe("uvx")
  })
})

describe("semverGt", () => {
  it("逐段数值比较", () => {
    expect(semverGt("1.10.0", "1.9.9")).toBe(true)
    expect(semverGt("1.2.3", "1.2.3")).toBe(false)
    expect(semverGt("0.9.0", "1.0.0")).toBe(false)
  })
})
