// src/shared/agent-def.ts
import { z } from "zod"

/** session/new 转发给 agent 的 MCP server（P1-16）：stdio / http / sse 三形态，结构对齐 SDK 1.4.0 */
export const McpServerSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("stdio"),
    name: z.string().min(1),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    // SDK 1.4.0 的 MCP env 是 EnvVariable[]（{name, value}），不是 Record
    env: z.array(z.object({ name: z.string(), value: z.string() })).default([]),
  }),
  z.object({
    type: z.literal("http"),
    name: z.string().min(1),
    url: z.string().min(1),
    headers: z.array(z.object({ name: z.string(), value: z.string() })).default([]),
  }),
  z.object({
    type: z.literal("sse"),
    name: z.string().min(1),
    url: z.string().min(1),
    headers: z.array(z.object({ name: z.string(), value: z.string() })).default([]),
  }),
])

export const AgentDefSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  /** Windows 上 .cmd shim 需要 shell；缺省 = win32 */
  shell: z.boolean().optional(),
  /** server 启动时自动拉起该 agent */
  autoStart: z.boolean().default(false),
  builtin: z.boolean().default(false),
  /** session/new 时转发给 agent 的客户端侧 MCP servers（P1-16） */
  mcpServers: z.array(McpServerSchema).optional(),
})

export type AgentDef = z.infer<typeof AgentDefSchema>

/** 启动命令来自对两个仓库的实测（见 CONTEXT.md「内置模板」） */
export const BUILTIN_AGENT_DEFS: AgentDef[] = [
  { name: "dsh", command: "dsh", args: ["--profile", "acp"], env: {}, autoStart: false, builtin: true },
  { name: "opencode", command: "opencode", args: ["acp"], env: {}, autoStart: false, builtin: true },
]
