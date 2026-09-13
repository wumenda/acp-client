// src/server/session-cache.ts
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"

export type SessionMeta = { sessionId: string; cwd: string; title?: string; updatedAt: number }
type CacheData = Record<string, Record<string, SessionMeta>>

/** 会话元数据缓存（可随时丢弃重建，见 ADR-0004）。tmp+rename 原子写。 */
export class SessionCache {
  private data: CacheData = {}
  private file: string

  constructor(dir: string) {
    this.file = path.join(dir, "session-cache.json")
    if (existsSync(this.file)) {
      this.data = JSON.parse(readFileSync(this.file, "utf8")) as CacheData
    }
  }

  list(agentId: string, cwd?: string): SessionMeta[] {
    const all = Object.values(this.data[agentId] ?? {})
    const filtered = cwd ? all.filter((s) => s.cwd === cwd) : all
    return filtered.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  upsert(agentId: string, meta: SessionMeta): void {
    const bucket = (this.data[agentId] ??= {})
    const prev = bucket[meta.sessionId]
    bucket[meta.sessionId] = { ...prev, ...meta }
    this.save()
  }

  touch(agentId: string, sessionId: string, at: number): void {
    const cur = this.data[agentId]?.[sessionId]
    if (!cur) return
    cur.updatedAt = at
    this.save()
  }

  /** 动态标题（session_info_update）：无记录时忽略，等 open/list 建档后再写。 */
  setTitle(agentId: string, sessionId: string, title: string): void {
    const cur = this.data[agentId]?.[sessionId]
    if (!cur) return
    if (cur.title === title) return
    cur.title = title
    this.save()
  }

  /** 会话删除（session/delete）：同步清掉本地缓存条目。 */
  remove(agentId: string, sessionId: string): void {
    const bucket = this.data[agentId]
    if (!bucket?.[sessionId]) return
    delete bucket[sessionId]
    this.save()
  }

  private save(): void {
    mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = this.file + ".tmp"
    writeFileSync(tmp, JSON.stringify(this.data))
    renameSync(tmp, this.file)
  }
}
