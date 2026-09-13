// tests/fake-agent-child.ts
// 用途：① 子进程集成测试 ② UI 开发时的 fake agent（agents.example.json 有对应条目）
import { Writable, Readable } from "node:stream"
import process from "node:process"
import { ndJsonStream } from "@agentclientprotocol/sdk"
import { createFakeAgent } from "./fake-agent"

const FAKE_CONTROLS = process.env.FAKE_CONTROLS === "1"

const { app } = createFakeAgent({
  askPermission: process.env.FAKE_ASK_PERMISSION === "1",
  authRequired: process.env.FAKE_AUTH_REQUIRED === "1",
  // authRequired 时声明 agent 型认证方式（真实 agent 必然公告，authenticate 需要 methodId）
  authMethods:
    process.env.FAKE_AUTH_REQUIRED === "1"
      ? [{ type: "agent" as const, id: "fake-login", name: "Fake Login" }]
      : [],
  // 会话控制面（P1-11）：modes/configOptions 由 env 开关注入
  modes: FAKE_CONTROLS
    ? { currentModeId: "ask", availableModes: [{ id: "ask", name: "Ask" }, { id: "plan", name: "Plan" }] }
    : undefined,
  configOptions: FAKE_CONTROLS
    ? [
        { id: "model", name: "模型", type: "select" as const, currentValue: "m1", options: [{ value: "m1", name: "M1" }, { value: "m2", name: "M2" }] },
        { id: "verbose", name: "详细输出", type: "boolean" as const, currentValue: false },
      ]
    : undefined,
  // fs 代理（P2-17）：写/读请求由 env 注入（路径/内容经 FAKE_FS_PATH / FAKE_FS_CONTENT）
  askFsWrite: process.env.FAKE_FS_WRITE === "1" ? { path: process.env.FAKE_FS_PATH ?? "out.txt", content: process.env.FAKE_FS_CONTENT ?? "hi" } : undefined,
  askFsRead: process.env.FAKE_FS_READ === "1" ? { path: process.env.FAKE_FS_PATH ?? "out.txt" } : undefined,
  // terminal 代理（P2-18）：执行 node -e <code>（"node" 走 PATH，避免 execPath 空格的 shell 拼接问题）
  askTerminal: process.env.FAKE_TERM_RUN === "1" ? { command: "node", args: ["-e", process.env.FAKE_TERM_CODE ?? "console.log(40+2)"] } : undefined,
  // elicitation（P2-19）：form/url 请求由 env 开关注入
  askElicitForm:
    process.env.FAKE_ELICIT_FORM === "1"
      ? {
          message: "请提供部署信息",
          requestedSchema: {
            type: "object" as const,
            properties: {
              name: { type: "string", title: "名称" },
              replicas: { type: "integer", title: "副本数", default: 2 },
              confirm: { type: "boolean", title: "确认" },
            },
            required: ["name"],
          },
        }
      : undefined,
  askElicitUrl: process.env.FAKE_ELICIT_URL === "1" ? { message: "请完成登录", url: "https://example.com/login" } : undefined,
  // prompt 输入能力公告（P2-20）：image/audio 由 env 开关注入
  promptCaps: process.env.FAKE_PROMPT_CAPS === "1" ? { image: true, audio: true } : undefined,
})
app.connect(
  ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  ),
)
