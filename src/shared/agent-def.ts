// src/shared/agent-def.ts
import { z } from "zod"

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
})

export type AgentDef = z.infer<typeof AgentDefSchema>

/** 启动命令来自对两个仓库的实测（见 CONTEXT.md「内置模板」） */
export const BUILTIN_AGENT_DEFS: AgentDef[] = [
  { name: "dsh", command: "dsh", args: ["--profile", "acp"], env: {}, autoStart: false, builtin: true },
  { name: "opencode", command: "opencode", args: ["acp"], env: {}, autoStart: false, builtin: true },
]
