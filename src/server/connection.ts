// src/server/connection.ts
import {
  PROTOCOL_VERSION,
  client,
  ndJsonStream,
  type ClientApp,
  type ClientConnection,
  type ClientContext,
  type Implementation,
  type InitializeResponse,
  type RequestPermissionOutcome,
  type RequestPermissionRequest,
  type SessionNotification,
  type Stream,
} from "@agentclientprotocol/sdk"
import { Writable, Readable } from "node:stream"

export type AcpHandlers = {
  onUpdate(n: SessionNotification): void
  onRequestPermission(req: RequestPermissionRequest): Promise<RequestPermissionOutcome>
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

/** 注册客户端回调面（session/update + request_permission）。 */
export function buildClientApp(h: AcpHandlers, name = CLIENT_INFO.name): ClientApp {
  return client({ name })
    .onNotification("session/update", (ctx) => {
      h.onUpdate(ctx.params)
    })
    .onRequest("session/request_permission", async (ctx) => ({
      outcome: await h.onRequestPermission(ctx.params),
    }))
}

/** 连接一条 ACP stream 并完成 initialize 握手。 */
export async function connectAcp(stream: Stream, h: AcpHandlers): Promise<AcpConnection> {
  const conn: ClientConnection = buildClientApp(h).connect(stream)
  try {
    const info = await conn.agent.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      // v1 不实现客户端 fs 回调（agent 自己读写文件）；声明 terminal-auth 能力（opencode 检查 _meta["terminal-auth"]）
      clientCapabilities: { auth: { terminal: true }, _meta: { "terminal-auth": true } },
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

/** agentCapabilities 的窄化读取（避免 any，容忍字段缺失）。 */
export type CoreCaps = { loadSession?: boolean; listSessions?: boolean }
export function capsOf(info: InitializeResponse): CoreCaps {
  return (info.agentCapabilities ?? {}) as CoreCaps
}
