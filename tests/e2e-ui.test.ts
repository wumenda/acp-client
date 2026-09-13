// tests/e2e-ui.test.ts
// 浏览器端到端：真实 server（随机端口）+ 真实 fake agent 子进程 + 真实 chromium UI 操作。
// 前提：`npx playwright install chromium`；浏览器缺失时自动跳过（不阻塞普通 CI）。
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createHarness, type Harness } from "./app-harness"

let harness: Harness | null = null
let browser: Browser | null = null
let browserMissing = false
const pageErrors: string[] = []

const CHILD = path.resolve("tests/fake-agent-child.ts")
// Windows 下 spawn shell:true，node 路径含空格需手动加引号（与 agent-process.test 同因）
const WIN_NODE = `"${process.execPath}"`

beforeAll(async () => {
  try {
    // 可用 PLAYWRIGHT_CHROMIUM_PATH 指定既有 chromium 可执行文件（版本近似即可用）
    const exe = process.env.PLAYWRIGHT_CHROMIUM_PATH
    browser = await chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : {}) })
  } catch {
    browserMissing = true
    return
  }
  harness = await createHarness([
    {
      name: "fake",
      command: WIN_NODE,
      args: ["--import", "tsx", `"${CHILD}"`],
      env: { FAKE_ASK_PERMISSION: "1" },
      autoStart: false,
      builtin: false,
    },
  ])
})

afterAll(async () => {
  await browser?.close().catch(() => {})
  await harness?.close()
})

function agentCard(page: Page, name: string) {
  return page.locator(".agent", { hasText: name })
}

describe("E2E UI (headless chromium)", () => {
  it("完整链路：启动 agent → 新建会话 → 发送 → 流式渲染 → 权限弹窗 → 应答 → 完成", async ({ skip }) => {
    if (browserMissing || !browser || !harness) return skip()
    pageErrors.length = 0
    const page = await browser.newPage()
    page.on("pageerror", (e) => pageErrors.push(String(e)))
    await page.goto(`http://127.0.0.1:${harness.port}/?token=${harness.token}`)
    await page.locator(".agent").first().waitFor({ timeout: 20000 })

    // 1. 启动 fake agent，等待 ready
    const fake = agentCard(page, "fake")
    await fake.getByRole("button", { name: "启动" }).click()
    await fake.filter({ hasText: "ready" }).waitFor({ timeout: 15000 })

    // 2. 新建会话
    await fake.locator("input").fill("C:/tmp-e2e")
    await fake.getByRole("button", { name: "新建会话" }).click()
    const composer = page.locator(".composer textarea")
    await composer.waitFor({ state: "visible", timeout: 10000 })

    // 3. 发送 → 用户消息即时回显（本地 echo）→ 思考块 → 回复块 → 工具卡
    await composer.fill("你好，请自我介绍一下")
    await page.locator(".composer").getByRole("button", { name: "发送" }).click()
    const messages = page.locator(".messages")
    await messages.filter({ hasText: "你好，请自我介绍一下" }).waitFor({ timeout: 5000 })
    await messages.filter({ hasText: "[思考] 先看看目录" }).waitFor({ timeout: 10000 })
    await messages.filter({ hasText: "你好，这是 fake agent 的回复。" }).waitFor({ timeout: 10000 })
    await messages.filter({ hasText: "grep TODO" }).waitFor({ timeout: 10000 })

    // 4. 权限弹窗 → Reject → 弹窗关闭、busy 清除
    const modal = page.locator(".modal-mask")
    await modal.waitFor({ state: "visible", timeout: 15000 })
    await modal.filter({ hasText: "rm -rf /" }).waitFor({ timeout: 5000 })
    await modal.getByRole("button", { name: "Reject" }).click()
    await modal.waitFor({ state: "hidden", timeout: 5000 })
    await page.locator(".composer").filter({ hasText: "发送" }).waitFor({ timeout: 10000 })

    // 5. 全程无未捕获页面错误
    expect(pageErrors).toEqual([])
    await page.close()
  }, 90000)
})
