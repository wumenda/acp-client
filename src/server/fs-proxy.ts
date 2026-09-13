// src/server/fs-proxy.ts
// fs 代理（P2-17，安全边界）：agent 对文件系统的所有访问都经此处。
// 策略：会话 cwd 子树内的「读」自动放行（高频、低危）；「写」一律需用户确认；
// cwd 子树外的一切访问需确认。路径统一 resolve 后做子树包含检查，杜绝 ../ 逃逸。
import { readFile, writeFile, stat } from "node:fs/promises"
import path from "node:path"
import { RequestError } from "@agentclientprotocol/sdk"

export type FsReadRequest = { sessionId: string; path: string; line?: number | null; limit?: number | null }
export type FsWriteRequest = { sessionId: string; path: string; content: string }

export type FsConfirmRequest = {
  requestId: number
  agentId: string
  sessionId: string
  kind: "read" | "write"
  path: string
  /** write 时携带将写入的完整内容，供用户审阅 */
  content?: string
}

const MAX_READ_BYTES = 5 * 1024 * 1024

export class FsGate {
  private pending = new Map<number, { resolve: (allowed: boolean) => void; agentId: string; sessionId: string }>()
  private seq = 0

  constructor(
    /** sessionId → cwd 解析（会话子树判定依据） */
    private cwdOf: (agentId: string, sessionId: string) => string | undefined,
    private hooks: {
      onConfirm(req: FsConfirmRequest): void
      /** 请求收场（应答/取消/断连）：bridge 层据此移除前端弹窗 */
      onDone(requestId: number): void
    },
  ) {}

  async read(agentId: string, req: FsReadRequest): Promise<{ content: string }> {
    const target = path.resolve(req.path)
    const cwd = this.cwdOf(agentId, req.sessionId)
    const inside = !!cwd && within(cwd, target)
    if (!inside) await this.confirm({ agentId, sessionId: req.sessionId, kind: "read", path: target })

    let st
    try {
      st = await stat(target)
    } catch {
      throw new RequestError(-32602, `文件不存在或不可访问: ${target}`)
    }
    if (st.isDirectory()) throw new RequestError(-32602, `目标是目录，不是文件: ${target}`)
    if (st.size > MAX_READ_BYTES) throw new RequestError(-32603, `文件超过读取上限（${MAX_READ_BYTES} 字节）: ${target}`)

    let content = await readFile(target, "utf8")
    if (req.line != null || req.limit != null) {
      const lines = content.split("\n")
      const start = Math.max(0, (req.line ?? 1) - 1)
      const end = req.limit != null ? start + Math.max(0, req.limit) : lines.length
      content = lines.slice(start, end).join("\n")
    }
    return { content }
  }

  async write(agentId: string, req: FsWriteRequest): Promise<Record<string, never>> {
    const target = path.resolve(req.path)
    await this.confirm({ agentId, sessionId: req.sessionId, kind: "write", path: target, content: req.content })
    try {
      await writeFile(target, req.content, "utf8")
    } catch (e) {
      throw new RequestError(-32603, `写入失败: ${String((e as Error)?.message ?? e)}`)
    }
    return {}
  }

  /** 浏览器侧的用户决定；未确认前 agent 请求一直挂起。 */
  respond(requestId: number, allowed: boolean): void {
    const p = this.pending.get(requestId)
    if (!p) return
    this.pending.delete(requestId)
    p.resolve(allowed)
    this.hooks.onDone(requestId)
  }

  /** 取消轮次：该会话所有待确认请求按拒绝收场，避免 agent 死等（协议义务同权限请求）。 */
  rejectSession(agentId: string, sessionId: string): void {
    for (const [id, p] of this.pending) {
      if (p.agentId !== agentId || p.sessionId !== sessionId) continue
      this.pending.delete(id)
      p.resolve(false)
      this.hooks.onDone(id)
    }
  }

  /** agent 进程退出：该 agent 的全部待确认按拒绝收场（pending 跨 agent 共存，不能全量清）。 */
  rejectAgent(agentId: string): void {
    for (const [id, p] of this.pending) {
      if (p.agentId !== agentId) continue
      this.pending.delete(id)
      p.resolve(false)
      this.hooks.onDone(id)
    }
  }

  /** 连接断开 / 全量清理：所有待确认按拒绝收场。 */
  rejectAllPending(): void {
    for (const [id, p] of this.pending) {
      p.resolve(false)
      this.hooks.onDone(id)
    }
    this.pending.clear()
  }

  private async confirm(req: Omit<FsConfirmRequest, "requestId">): Promise<void> {
    const requestId = ++this.seq
    const allowed = await new Promise<boolean>((resolve) => {
      this.pending.set(requestId, { resolve, agentId: req.agentId, sessionId: req.sessionId })
      this.hooks.onConfirm({ requestId, ...req })
    })
    if (!allowed) throw new RequestError(-32002, `用户拒绝了对 ${req.path} 的${req.kind === "write" ? "写入" : "读取"}`)
  }
}

/** target 是否位于 cwd 子树内（Windows 不区分大小写，比较前统一小写）。 */
export function within(cwd: string, target: string): boolean {
  const rel = path.relative(path.resolve(cwd), path.resolve(target))
  const norm = process.platform === "win32" ? rel.toLowerCase() : rel
  return norm === "" || (!norm.startsWith("..") && !path.isAbsolute(norm))
}
