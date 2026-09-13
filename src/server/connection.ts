// src/server/connection.ts
import {
  PROTOCOL_VERSION,
  client,
  ndJsonStream,
  type ClientApp,
  type ClientConnection,
  type ClientContext,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type Implementation,
  type InitializeResponse,
  type RequestPermissionOutcome,
  type RequestPermissionRequest,
  type SessionNotification,
  type Stream,
} from "@agentclientprotocol/sdk"
import { Writable, Readable } from "node:stream"

export type AcpFsHandlers = {
  onFsRead(req: { sessionId: string; path: string; line?: number | null; limit?: number | null }): Promise<{ content: string }>
  onFsWrite(req: { sessionId: string; path: string; content: string }): Promise<Record<string, never>>
}

export type AcpTerminalHandlers = {
  onTerminalCreate(req: { sessionId: string; command: string; args?: string[]; env?: Array<{ name: string; value: string }>; cwd?: string | null; outputByteLimit?: number | null }): Promise<{ terminalId: string }>
  /** output 为同步快照读取（SDK onRequest 会 async 包装） */
  onTerminalOutput(req: { sessionId: string; terminalId: string }): { output: string; truncated: boolean; exitStatus?: { exitCode?: number | null; signal?: string | null } | null }
  onTerminalRelease(req: { sessionId: string; terminalId: string }): Record<string, never> | Promise<Record<string, never>>
  onTerminalWaitExit(req: { sessionId: string; terminalId: string }): Promise<{ exitCode?: number | null; signal?: string | null }>
  onTerminalKill(req: { sessionId: string; terminalId: string }): Record<string, never> | Promise<Record<string, never>>
}

export type AcpHandlers = {
  onUpdate(n: SessionNotification): void
  onRequestPermission(req: RequestPermissionRequest): Promise<RequestPermissionOutcome>
  /** fs 代理（P2-17）：提供时声明 clientCapabilities.fs 并注册回调 */
  fs?: AcpFsHandlers
  /** terminal 代理（P2-18）：提供时声明 clientCapabilities.terminal 并注册回调 */
  terminal?: AcpTerminalHandlers
  /** elicitation（P2-19）：提供时声明 clientCapabilities.elicitation 并注册回调 */
  elicitation?: {
    onElicitationCreate(req: CreateElicitationRequest): Promise<CreateElicitationResponse>
    /** url 模式：agent 侧完成后通知（用于清理前端 URL 引导 UI） */
    onElicitationComplete(req: { elicitationId: string }): void
  }
}

export type AcpConnection = {
  agent: ClientContext
  info: InitializeResponse
  closed: Promise<void>
  close(): void
}

// 显式 Implementation 注解：推断类型常量会让 initialize 请求的泛型重载
// 静默失配（fallback 到 string 重载返回 unknown），见实现备注
const CLIENT_INFO: Implementation = { name: "acp-client", title: "ACP Client", version: "0.1.0" }

/** 注册客户端回调面（session/update + request_permission + fs 代理）。 */
export function buildClientApp(h: AcpHandlers, name = CLIENT_INFO.name): ClientApp {
  const app = client({ name })
    .onNotification("session/update", (ctx) => {
      h.onUpdate(ctx.params)
    })
    .onRequest("session/request_permission", async (ctx) => ({
      outcome: await h.onRequestPermission(ctx.params),
    }))
  if (h.fs) {
    app
      .onRequest("fs/read_text_file", async (ctx) => await h.fs!.onFsRead(ctx.params))
      .onRequest("fs/write_text_file", async (ctx) => await h.fs!.onFsWrite(ctx.params))
  }
  if (h.terminal) {
    app
      .onRequest("terminal/create", async (ctx) => await h.terminal!.onTerminalCreate(ctx.params))
      .onRequest("terminal/output", async (ctx) => await h.terminal!.onTerminalOutput(ctx.params))
      .onRequest("terminal/release", async (ctx) => await h.terminal!.onTerminalRelease(ctx.params))
      .onRequest("terminal/wait_for_exit", async (ctx) => await h.terminal!.onTerminalWaitExit(ctx.params))
      .onRequest("terminal/kill", async (ctx) => await h.terminal!.onTerminalKill(ctx.params))
  }
  if (h.elicitation) {
    app
      .onRequest("elicitation/create", async (ctx) => await h.elicitation!.onElicitationCreate(ctx.params))
      .onNotification("elicitation/complete", (ctx) => {
        h.elicitation!.onElicitationComplete(ctx.params)
      })
  }
  return app
}

/** 连接一条 ACP stream 并完成 initialize 握手。 */
export async function connectAcp(stream: Stream, h: AcpHandlers): Promise<AcpConnection> {
  const conn: ClientConnection = buildClientApp(h).connect(stream)
  try {
    const info = await conn.agent.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      // v1 不实现客户端 fs 回调（agent 自己读写文件）；声明 terminal-auth 能力（opencode 检查 _meta["terminal-auth"]）
      // fs 代理（P2-17）：仅在调用方提供 fs 处理器时声明，agent 才会发起 fs 请求
      clientCapabilities: {
        auth: { terminal: true },
        _meta: { "terminal-auth": true },
        // fs 代理（P2-17）：仅在调用方提供 fs 处理器时声明，agent 才会发起 fs 请求
        ...(h.fs ? { fs: { readTextFile: true, writeTextFile: true } } : {}),
        // terminal 代理（P2-18）：支持全部 terminal* 方法
        ...(h.terminal ? { terminal: true } : {}),
        // elicitation（P2-19）：form + url 两模式
        ...(h.elicitation ? { elicitation: { form: {}, url: {} } } : {}),
      },
      clientInfo: CLIENT_INFO,
    })
    return { agent: conn.agent, info, closed: conn.closed, close: () => conn.close() }
  } catch (e) {
    conn.close()
    throw e
  }
}

/** 把子进程 stdio 变成 ACP stream（agent-process 也可能用）。 */
export function stdioToStream(stdin: Writable, stdout: Readable): Stream {
  return ndJsonStream(
    Writable.toWeb(stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(stdout) as ReadableStream<Uint8Array>,
  )
}

/** agentCapabilities 的窄化读取（避免 any，容忍字段缺失）。
 *  实测（Task 5 修正）：listSessions 不是顶层字段，list/resume/close 能力挂在 agentCapabilities.sessionCapabilities 下。 */
export type CoreCaps = {
  loadSession?: boolean
  promptCapabilities?: { image?: boolean; audio?: boolean }
  sessionCapabilities?: { list?: unknown; resume?: unknown; close?: unknown; delete?: unknown }
}
export function capsOf(info: InitializeResponse): CoreCaps {
  return (info.agentCapabilities ?? {}) as CoreCaps
}
export function canList(info: InitializeResponse): boolean {
  return capsOf(info).sessionCapabilities?.list != null
}
