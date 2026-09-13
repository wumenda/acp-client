// src/server/config.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { AgentDefSchema, BUILTIN_AGENT_DEFS, type AgentDef } from "../shared/agent-def"

export function configDir(): string {
  return process.env.ACP_CLIENT_HOME ?? path.join(os.homedir(), ".config", "acp-client")
}

/** 读取 agents.json；不存在则用内置模板初始化。用户同名条目覆盖模板字段。
 *  最后合并 registry 安装清单（registry-installs.json）的固化 AgentDef。 */
export function loadAgentDefs(dir: string = configDir()): AgentDef[] {
  const file = path.join(dir, "agents.json")
  let merged: AgentDef[]
  const remaining = new Map<string, AgentDef>()
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, JSON.stringify({ agents: BUILTIN_AGENT_DEFS }, null, 2))
    merged = [...BUILTIN_AGENT_DEFS]
  } else {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { agents?: unknown[] }
    const userDefs = (raw.agents ?? []).map((a) => AgentDefSchema.parse(a))
    for (const d of userDefs) remaining.set(d.name, d)
    merged = BUILTIN_AGENT_DEFS.map((b) => {
      const u = remaining.get(b.name)
      if (!u) return b
      remaining.delete(b.name)
      return { ...b, ...u, name: b.name, builtin: true }
    })
    merged.push(...remaining.values())
  }
  // 合并 registry 安装清单：内置 → 用户 → 安装项；同名跳过 + warn
  const installsFile = path.join(dir, "registry-installs.json")
  if (existsSync(installsFile)) {
    const m = JSON.parse(readFileSync(installsFile, "utf8")) as { installs?: Array<{ def: unknown }> }
    for (const i of m.installs ?? []) {
      const def = AgentDefSchema.parse(i.def)
      if (merged.some((d) => d.name === def.name)) {
        console.warn(`[config] registry 安装项 ${def.name} 与现有 agent 同名，已跳过`)
        continue
      }
      merged.push(def)
    }
  }
  return merged
}
