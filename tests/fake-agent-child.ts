// tests/fake-agent-child.ts
// 用途：① 子进程集成测试 ② UI 开发时的 fake agent（agents.example.json 有对应条目）
import { Writable, Readable } from "node:stream"
import process from "node:process"
import { ndJsonStream } from "@agentclientprotocol/sdk"
import { createFakeAgent } from "./fake-agent"

const { app } = createFakeAgent({
  askPermission: process.env.FAKE_ASK_PERMISSION === "1",
  authRequired: process.env.FAKE_AUTH_REQUIRED === "1",
})
app.connect(
  ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  ),
)
