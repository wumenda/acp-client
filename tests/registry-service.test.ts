import { createServer, type Server } from "node:http"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { RegistryService } from "../src/server/registry/service"

// fixture：npx 条目安装无网络副作用，最适合单测
const REGISTRY = {
  version: "1.0.0",
  agents: [{
    id: "npmed", name: "NPM Agent", version: "2.0.1", description: "d",
    distribution: { npx: { package: "some-agent", args: ["--acp"] } },
  }],
}

describe("RegistryService", () => {
  let http: Server, url: string, home: string
  beforeAll(async () => {
    home = mkdtempSync(path.join(tmpdir(), "reg-svc-"))
    http = createServer((_q, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(REGISTRY)) })
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r))
    url = `http://127.0.0.1:${(http.address() as { port: number }).port}/registry.json`
  })
  afterAll(() => { http.close(); rmSync(home, { recursive: true, force: true }) })

  const noopEvents = () => ({ onSnapshot: () => {}, onProgress: () => {}, onInstalled: () => {}, onUninstalled: () => {} })

  it("refresh 拉取 + 缓存落盘 + 视图标记", async () => {
    const svc = new RegistryService({ home, url, events: noopEvents(), autoRefresh: false })
    await svc.refresh(true)
    const v = svc.view()
    expect(v.agents[0]).toMatchObject({ id: "npmed", kind: "npx", supported: true, installed: false, updateAvailable: false })
    expect(v.fetchedAt).toBeGreaterThan(0)
  })

  it("install(npx) → onInstalled 回调；view 变 installed；重复安装报错；uninstall 还原", async () => {
    const installed: string[] = []
    const svc = new RegistryService({ home, url, events: { ...noopEvents(), onInstalled: (def) => installed.push(def.name) }, autoRefresh: false })
    await svc.refresh(true)
    await svc.install("npmed")
    expect(installed).toEqual(["npmed"])
    expect(svc.view().agents[0].installed).toBe(true)
    await expect(svc.install("npmed")).rejects.toThrow(/已安装/i)
    svc.uninstall("npmed")
    expect(svc.view().agents[0].installed).toBe(false)
  })

  it("源不可达 → refresh 抛错；有缓存时 loadCache 后 view() 仍可服务", async () => {
    const svc = new RegistryService({ home, url: "http://127.0.0.1:1/nope", events: noopEvents(), autoRefresh: false })
    await expect(svc.refresh(true)).rejects.toThrow()
    // 先造缓存（用可达源），再用不可达源实例只 loadCache
    const warm = new RegistryService({ home, url, events: noopEvents(), autoRefresh: false })
    await warm.refresh(true)
    const cold = new RegistryService({ home, url: "http://127.0.0.1:1/nope", events: noopEvents(), autoRefresh: false })
    await cold.loadCache()
    expect(cold.view().agents).toHaveLength(1)
  })
})
