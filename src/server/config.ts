// src/server/config.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { AgentDefSchema, BUILTIN_AGENT_DEFS, type AgentDef } from "../shared/agent-def"

export function configDir(): string {
  return process.env.ACP_CLIENT_HOME ?? path.join(os.homedir(), ".config", "acp-client")
}

/** 读取 agents.json；不存在则用内置模板初始化。用户同名条目覆盖模板字段。 */
export function loadAgentDefs(dir: string = configDir()): AgentDef[] {
  const file = path.join(dir, "agents.json")
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, JSON.stringify({ agents: BUILTIN_AGENT_DEFS }, null, 2))
    return BUILTIN_AGENT_DEFS
  }
  const raw = JSON.parse(readFileSync(file, "utf8")) as { agents?: unknown[] }
  const userDefs = (raw.agents ?? []).map((a) => AgentDefSchema.parse(a))
  const remaining = new Map(userDefs.map((d) => [d.name, d]))
  const merged = BUILTIN_AGENT_DEFS.map((b) => {
    const u = remaining.get(b.name)
    if (!u) return b
    remaining.delete(b.name)
    return { ...b, ...u, name: b.name, builtin: true }
  })
  return [...merged, ...remaining.values()]
}
