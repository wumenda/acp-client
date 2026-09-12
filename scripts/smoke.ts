// scripts/smoke.ts
// 用法: pnpm smoke:dsh [cwd]   |   pnpm smoke:opencode [cwd]
// 前提: 对应 CLI 已安装并在 PATH；仅用于人工验证，不进 CI
import { loadAgentDefs } from "../src/server/config"
import { spawnAgentProcess } from "../src/server/agent-process"
import { connectAcp } from "../src/server/connection"

async function main() {
  const name = process.argv[2]
  const cwd = process.argv[3] ?? process.cwd()
  const def = loadAgentDefs().find((d) => d.name === name)
  if (!def) throw new Error(`未知 agent: ${name}`)

  console.log(`[smoke] 启动 ${def.command} ${def.args.join(" ")}`)
  const proc = spawnAgentProcess(def)
  const acp = await connectAcp(proc.stream, {
    onUpdate: (n) => {
      const u = n.update as { sessionUpdate: string; content?: { text?: string }; title?: string; status?: string }
      if (u.sessionUpdate.endsWith("_chunk")) console.log(`  [${u.sessionUpdate}]`, u.content?.text ?? "")
      else console.log(`  [${u.sessionUpdate}]`, u.title ?? u.status ?? "")
    },
    onRequestPermission: async (req) => {
      console.log(`  [权限请求]`, req.toolCall.title, "→ 自动拒绝")
      return { outcome: "selected" as const, optionId: req.options.find((o) => o.kind.startsWith("reject"))?.optionId ?? req.options[0].optionId }
    },
  })
  console.log(`[smoke] protocolVersion=${acp.info.protocolVersion} authMethods=${acp.info.authMethods?.length ?? 0}`)

  const { sessionId } = await acp.agent.request("session/new", { cwd, mcpServers: [] })
  console.log(`[smoke] sessionId=${sessionId}`)
  const res = await acp.agent.request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "用一句话介绍这个目录里有什么，不要执行任何工具。" }],
  })
  console.log(`[smoke] stopReason=${res.stopReason}`)
  proc.kill()
  await proc.exit
  process.exit(0)
}

main().catch((e) => {
  console.error("[smoke] 失败:", e)
  process.exit(1)
})
