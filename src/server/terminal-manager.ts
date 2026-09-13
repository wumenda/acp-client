// src/server/terminal-manager.ts
// terminal 代理（P2-18，安全边界）：agent 请求在客户端执行命令，均经此处。
// 策略：create（执行命令）一律需用户确认（高风险、无子树概念）；确认后 spawn 捕获输出。
// 终端生命周期由 agent 控制（release）；agent 停止/崩溃时全量 kill；取消轮次仅拒挂起确认，不误杀运行中终端。
import { spawn, type ChildProcess } from "node:child_process"
import { RequestError } from "@agentclientprotocol/sdk"
import type { CreateTerminalRequest, TerminalExitStatus, TerminalOutputResponse } from "@agentclientprotocol/sdk"

export type TermConfirmRequest = {
  requestId: number
  agentId: string
  sessionId: string
  command: string
  args: string[]
  cwd?: string
}

const DEFAULT_OUTPUT_LIMIT = 1024 * 1024 // 字符上限（缺省 1Mi），环形丢弃头部

type TerminalState = {
  proc: ChildProcess
  output: string
  truncated: boolean
  exited: boolean
  exitStatus: TerminalExitStatus | null
  /** wait_for_exit 的幂等入口：退出前挂起，退出后立即返回缓存结果 */
  exit: Promise<TerminalExitStatus>
}

export class TerminalManager {
  private terms = new Map<string, TerminalState>()
  private owners = new Map<string, string>()
  private pending = new Map<number, { resolve: (allowed: boolean) => void; agentId: string; sessionId: string }>()
  private seq = 0
  private termSeq = 0

  constructor(
    private hooks: {
      onConfirm(req: TermConfirmRequest): void
      /** 确认请求收场（应答/取消/停止）：bridge 层据此移除前端弹窗 */
      onDone(requestId: number): void
    },
  ) {}

  async create(agentId: string, req: CreateTerminalRequest): Promise<{ terminalId: string }> {
    const args = req.args ?? []
    await this.confirm({ agentId, sessionId: req.sessionId, command: req.command, args, ...(req.cwd ? { cwd: req.cwd } : {}) })

    const env = { ...process.env, ...Object.fromEntries((req.env ?? []).map((e) => [e.name, e.value])) }
    // Windows shim 脚本需 shell（同 agent-process 约定）；stdin 关闭避免子进程等待输入挂起
    const proc = spawn(req.command, args, {
      ...(req.cwd ? { cwd: req.cwd } : {}),
      env,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    })
    const limit = Math.max(0, Math.floor(req.outputByteLimit ?? DEFAULT_OUTPUT_LIMIT))
    const terminalId = `term-${++this.termSeq}`
    const state: TerminalState = {
      proc,
      output: "",
      truncated: false,
      exited: false,
      exitStatus: null,
      exit: new Promise<TerminalExitStatus>((resolve) => {
        proc.once("exit", (code, signal) => {
          state.exited = true
          state.exitStatus = { exitCode: code ?? null, signal: signal ?? null }
          resolve(state.exitStatus)
        })
        proc.once("error", (e) => {
          state.exited = true
          state.exitStatus = { exitCode: null, signal: String((e as Error)?.message ?? e) }
          resolve(state.exitStatus)
        })
      }),
    }
    for (const stream of [proc.stdout, proc.stderr]) {
      stream!.setEncoding("utf8") // 保证不从多字节字符中间切开
      stream!.on("data", (chunk: string) => {
        if (limit <= 0) {
          state.output = ""
          state.truncated = true
          return
        }
        let text = state.output + chunk
        if (text.length > limit) {
          text = text.slice(text.length - limit)
          // 字符边界：切出的首码元若处于代理对低位，再丢一位（协议要求截断不破字符）
          const c = text.charCodeAt(0)
          if (c >= 0xdc00 && c <= 0xdfff) text = text.slice(1)
          state.truncated = true
        }
        state.output = text
      })
    }
    this.terms.set(terminalId, state)
    this.owners.set(terminalId, agentId)
    return { terminalId }
  }

  output(_agentId: string, req: { sessionId: string; terminalId: string }): TerminalOutputResponse {
    const t = this.get(req.terminalId)
    return { output: t.output, truncated: t.truncated, ...(t.exitStatus ? { exitStatus: t.exitStatus } : {}) }
  }

  async wait(_agentId: string, req: { sessionId: string; terminalId: string }): Promise<TerminalExitStatus> {
    return await this.get(req.terminalId).exit
  }

  kill(_agentId: string, req: { sessionId: string; terminalId: string }): Record<string, never> {
    const t = this.get(req.terminalId)
    if (!t.exited) t.proc.kill()
    return {}
  }

  release(_agentId: string, req: { sessionId: string; terminalId: string }): Record<string, never> {
    const t = this.get(req.terminalId)
    if (!t.exited) t.proc.kill()
    this.terms.delete(req.terminalId)
    this.owners.delete(req.terminalId)
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

  /** 取消轮次：该会话挂起的 create 确认按拒绝收场；运行中终端不杀（生命周期归 agent/release）。 */
  rejectSession(agentId: string, sessionId: string): void {
    for (const [id, p] of this.pending) {
      if (p.agentId !== agentId || p.sessionId !== sessionId) continue
      this.pending.delete(id)
      p.resolve(false)
      this.hooks.onDone(id)
    }
  }

  /** agent 停止/崩溃：杀其全部终端 + 拒全部挂起确认。 */
  killAgent(agentId: string): void {
    for (const [id, p] of this.pending) {
      if (p.agentId !== agentId) continue
      this.pending.delete(id)
      p.resolve(false)
      this.hooks.onDone(id)
    }
    for (const [tid, owner] of this.owners) {
      if (owner !== agentId) continue
      const t = this.terms.get(tid)
      if (t && !t.exited) t.proc.kill()
      this.terms.delete(tid)
      this.owners.delete(tid)
    }
  }

  private get(terminalId: string): TerminalState {
    const t = this.terms.get(terminalId)
    if (!t) throw new RequestError(-32602, `终端不存在或已释放: ${terminalId}`)
    return t
  }

  private async confirm(req: Omit<TermConfirmRequest, "requestId">): Promise<void> {
    const requestId = ++this.seq
    const allowed = await new Promise<boolean>((resolve) => {
      this.pending.set(requestId, { resolve, agentId: req.agentId, sessionId: req.sessionId })
      this.hooks.onConfirm({ requestId, ...req })
    })
    if (!allowed) throw new RequestError(-32002, `用户拒绝了命令执行: ${req.command}`)
  }
}
