// src/server/acp-log.ts
// ACP 线上日志（§2.4-26）：per-agent stdio tee → 环形缓冲；前端订阅时回放最近 N 条再增量推送
export type AcpLogItem = { type: "acp.log"; agentId: string; dir: "in" | "out"; data: string }

const MAX_ITEMS = 500
const REPLAY_ITEMS = 200
const MAX_LINE = 4096 // 单条截断，防止 base64/长输出撑爆

export class AcpLog {
  private buf: AcpLogItem[] = []
  private subs = new Set<(e: AcpLogItem) => void>()

  push(agentId: string, dir: "in" | "out", data: string): void {
    const item: AcpLogItem = {
      type: "acp.log", agentId, dir,
      data: data.length > MAX_LINE ? `${data.slice(0, MAX_LINE)}…(${data.length}B)` : data,
    }
    this.buf.push(item)
    if (this.buf.length > MAX_ITEMS) this.buf.splice(0, this.buf.length - MAX_ITEMS)
    for (const fn of this.subs) fn(item)
  }

  /** 订阅增量；返回回放快照（最近 REPLAY_ITEMS 条）。 */
  subscribe(fn: (e: AcpLogItem) => void): { recent: AcpLogItem[]; unsubscribe(): void } {
    this.subs.add(fn)
    return { recent: this.buf.slice(-REPLAY_ITEMS), unsubscribe: () => this.subs.delete(fn) }
  }
}
