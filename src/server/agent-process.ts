// src/server/agent-process.ts
import { spawn, type ChildProcess } from "node:child_process"
import { Readable, Writable } from "node:stream"
import type { Stream } from "@agentclientprotocol/sdk"
import { stdioToStream } from "./connection"
import type { AgentDef } from "../shared/agent-def"

export type AgentProcess = {
  stream: Stream
  proc: ChildProcess
  /** stderr 尾部（诊断用，最多 4KB） */
  readonly stderrTail: string
  exit: Promise<{ code: number | null; signal: string | null }>
  kill(): void
}

export function spawnAgentProcess(def: AgentDef): AgentProcess {
  const proc = spawn(def.command, def.args, {
    env: { ...process.env, ...def.env },
    // Windows 的 dsh/opencode 是 .cmd shim，必须走 shell
    shell: def.shell ?? process.platform === "win32",
    stdio: ["pipe", "pipe", "pipe"],
  })
  const stream = stdioToStream(proc.stdin!, proc.stdout!)
  let tail = ""
  proc.stderr!.on("data", (d: Buffer) => {
    tail = (tail + d.toString()).slice(-4096)
  })
  const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    proc.once("exit", (code, signal) => resolve({ code, signal: signal ?? null }))
    proc.once("error", () => resolve({ code: null, signal: null }))
  })
  return { stream, proc, get stderrTail() { return tail }, exit, kill: () => proc.kill() }
}
