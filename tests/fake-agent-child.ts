// tests/fake-agent-child.ts
// 用途：① 子进程集成测试 ② UI 开发时的 fake agent（agents.example.json 有对应条目）
import { Writable, Readable } from "node:stream"
import process from "node:process"
import { ndJsonStream } from "@agentclientprotocol/sdk"
import { createFakeAgent } from "./fake-agent"

const { app } = createFakeAgent({
  askPermission: process.env.FAKE_ASK_PERMISSION === "1",
  authRequired: process.env.FAKE_AUTH_REQUIRED === "1",
  // authRequired 时声明 agent 型认证方式（真实 agent 必然公告，authenticate 需要 methodId）
  authMethods:
    process.env.FAKE_AUTH_REQUIRED === "1"
      ? [{ type: "agent" as const, id: "fake-login", name: "Fake Login" }]
      : [],
})
app.connect(
  ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  ),
)
