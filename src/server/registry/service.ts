// RegistryService：registry 索引拉取/缓存 + 安装/卸载编排 + 事件回调
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { AgentDef } from "../../shared/agent-def"
import type { RegistryAgentView } from "../../shared/bridge-protocol"
import { installBinary, loadManifest, registerRemoteInstall, removeInstall } from "./installer"
import { RegistryIndexSchema, platformTarget, resolveDistribution, semverGt, type RegistryAgent } from "./schema"

export type RegistryEvents = {
  onSnapshot(view: { agents: RegistryAgentView[]; fetchedAt: number; stale: boolean }): void
  onProgress(p: { id: string; stage: "downloading" | "verifying" | "extracting" | "registering" | "done" | "error"; message?: string }): void
  onInstalled(def: AgentDef): void      // → store.addAgent
  onUninstalled(agentId: string): void  // → app 层先 store.stop 再 removeAgent
}

export const DEFAULT_REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json"
const TTL_MS = 60 * 60 * 1000

export class RegistryService {
  private agents: RegistryAgent[] = []
  private fetchedAt = 0
  private inflight: Promise<void> | null = null

  constructor(private p: { home: string; url?: string; events: RegistryEvents; autoRefresh?: boolean }) {
    void this.loadCache()
    if (p.autoRefresh !== false) void this.refresh(false).catch(() => {})
  }

  view(): { agents: RegistryAgentView[]; fetchedAt: number; stale: boolean } {
    const target = (() => { try { return platformTarget() } catch { return "" } })()
    const installedMap = new Map(loadManifest(this.p.home).installs.map((i) => [i.id, i]))
    return {
      fetchedAt: this.fetchedAt,
      stale: this.fetchedAt > 0 && Date.now() - this.fetchedAt > TTL_MS,
      agents: this.agents.map((a) => {
        const inst = installedMap.get(a.id)
        const resolved = target ? resolveDistribution(a.distribution, target) : null
        return {
          id: a.id, name: a.name, version: a.version,
          description: a.description, website: a.website, repository: a.repository,
          license: a.license, authors: a.authors, icon: a.icon,
          kind: resolved?.kind ?? "binary",
          supported: resolved != null,
          installed: inst != null,
          installedVersion: inst?.version,
          updateAvailable: inst != null && semverGt(a.version, inst.version),
        }
      }),
    }
  }

  async loadCache(): Promise<void> {
    const f = path.join(this.p.home, "registry-cache.json")
    if (!existsSync(f)) return
    try {
      const c = JSON.parse(readFileSync(f, "utf8")) as { agents: RegistryAgent[]; fetchedAt: number }
      this.agents = c.agents
      this.fetchedAt = c.fetchedAt
    } catch { /* 坏缓存忽略 */ }
  }

  private saveCache(): void {
    const f = path.join(this.p.home, "registry-cache.json")
    const tmp = f + ".tmp"
    writeFileSync(tmp, JSON.stringify({ agents: this.agents, fetchedAt: this.fetchedAt }))
    renameSync(tmp, f)
  }

  /** 拉取并重建索引；inflight 去重，TTL 内非强制跳过。 */
  async refresh(force: boolean): Promise<void> {
    if (this.inflight) return this.inflight
    if (!force && this.fetchedAt > 0 && Date.now() - this.fetchedAt < TTL_MS) return
    this.inflight = (async () => {
      const res = await fetch(this.p.url ?? DEFAULT_REGISTRY_URL)
      if (!res.ok) throw new Error(`registry 拉取失败: HTTP ${res.status}`)
      const idx = RegistryIndexSchema.parse(await res.json())
      this.agents = idx.agents
      this.fetchedAt = Date.now()
      this.saveCache()
      this.p.events.onSnapshot(this.view())
    })().finally(() => { this.inflight = null })
    return this.inflight
  }

  async install(id: string): Promise<void> {
    const a = this.agents.find((x) => x.id === id)
    if (!a) throw new Error(`registry 中不存在 ${id}`)
    if (loadManifest(this.p.home).installs.some((i) => i.id === id)) throw new Error(`${id} 已安装`)
    const target = platformTarget()
    const resolved = resolveDistribution(a.distribution, target)
    if (!resolved) throw new Error(`当前平台 ${target} 无可用分发包`)
    try {
      if (resolved.kind === "binary") {
        const { def } = await installBinary({
          id, name: a.name, version: a.version, spec: resolved.spec, home: this.p.home,
          onProgress: (stage) => this.p.events.onProgress({ id, stage }),
        })
        this.p.events.onProgress({ id, stage: "registering" })
        this.p.events.onInstalled(def)
      } else {
        const def = registerRemoteInstall({ id, name: a.name, version: a.version, kind: resolved.kind, package: resolved.package, args: resolved.args, home: this.p.home })
        this.p.events.onInstalled(def)
      }
      this.p.events.onProgress({ id, stage: "done" })
      this.p.events.onSnapshot(this.view())
    } catch (e) {
      this.p.events.onProgress({ id, stage: "error", message: String((e as Error)?.message ?? e) })
      throw e
    }
  }

  uninstall(id: string): void {
    if (!loadManifest(this.p.home).installs.some((i) => i.id === id)) throw new Error(`${id} 未安装`)
    this.p.events.onUninstalled(id)
    removeInstall(this.p.home, id)
    this.p.events.onSnapshot(this.view())
  }
}
