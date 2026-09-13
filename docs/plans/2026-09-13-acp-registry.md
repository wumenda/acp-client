# ACP Registry 立项执行计划

> **For agentic workers:** 按任务逐个执行本计划，每个步骤用 `- [x]` 复选框跟踪。延续 acp-client 既有立项节奏（协议面确认 → 服务端 → bridge → 前端 → fake/测试 → 全量验证）。

**Goal:** 接入 ACP Registry（Zed + JetBrains 2026-01 联合上线的公共 agent 目录）：server 端拉取/缓存 registry 索引，用户在浏览器中浏览、安装（binary 下载+校验+解压 / npx / uvx 三种分发）、更新与卸载 agent；安装的 agent 作为一等 AgentDef 进入既有启动/会话/权限全链路。

**Architecture:** 新增 `src/server/registry/` 三模块：`schema.ts`（zod 宽容解析 + 平台映射 + distribution→AgentDef 解析）、`installer.ts`（下载/sha256/解压/清单持久化/卸载）、`service.ts`（fetch 缓存 + 安装编排 + hub 广播）。AgentStore 增加 `addAgent/removeAgent` 动态注册。bridge 新增 `registry.*` 命令与事件，前端新增 RegistryModal。

**Tech Stack:** 零新增依赖（Node 22 全局 fetch + `node:crypto` sha256 + 系统 `tar` 解压；zod 沿用）。

**共识文档:** [CONTEXT.md](../../CONTEXT.md) · [ADR-0003 单SDK依赖+宽容解析](../adr/0003-single-sdk-dependency.md)

---

## 前置事实速查（Registry 协议调研结论，写代码前必读）

来源：`github.com/agentclientprotocol/registry` README + `FORMAT.md`（2026-09 调研）；SDK 1.4.0 实测确认**不含任何 Registry 协议类型**（`ConnectionRegistry` 是 SDK 内部连接管理，无关）。

- **索引端点（CDN）**：`https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`。同目录另有 JetBrains 变体 `registry-for-jetbrains.json` / `registry-for-jetbrains-preview.json`（完整 drop-in 替换）。本立项**只消费标准 registry.json**。
- **顶层结构**：`{ "version": "1.0.0", "agents": [...] }`。
- **agent entry 字段**：`id` / `name` / `version`（必须 `X.Y.Z`）/ `description` / `repository` / `website` / `authors` / `license` / `license_url` / `icon`（SVG 16x16 的 URL）/ `distribution`。
- **distribution 三形态**（对象内恰好一个 key）：
  - `binary`：**平台 map**，key ∈ `darwin-aarch64` | `darwin-x86_64` | `linux-aarch64` | `linux-x86_64` | `windows-aarch64` | `windows-x86_64`；每平台 `{ archive, sha256, cmd, args?, env? }`。`archive` 支持 `.zip` / `.tar.gz` / `.tgz` / `.tar.bz2` / `.tbz2` / 裸二进制；`cmd` 为解压后可执行文件路径。
  - `npx`：`{ package, args? }` → 本地以 `npx -y <package> [args...]` 启动。
  - `uvx`：`{ package, args? }` → 本地以 `uvx <package> [args...]` 启动。
- **preview 通道**：仅存在于 JetBrains preview 变体（`X.Y.Z-preview.N`，只允许 npx/uvx）；标准发布产物**不含** preview 字段。本立项 schema 预留宽容兼容，**不实现 preview 安装**。
- **更新节奏**：上游每小时 cron 从 npm/PyPI/GitHub releases 重建索引 → 客户端侧 1 小时 TTL 的 stale-while-revalidate 足够。
- **图标**：SVG 16x16，直接 `<img src>`。

## 关键设计决策

1. **安装清单独立成 `registry-installs.json`**（configDir 下），**不改写用户的 agents.json**。清单项在安装时固化完整 AgentDef（含绝对路径），`loadAgentDefs` 合并顺序：内置模板 → 用户条目 → registry 安装项（同名冲突跳过 + warn）。
2. **解压用系统 `tar`**：Windows 10+ 自带 `System32\tar.exe`（bsdtar），macOS/Linux 原生 tar，三者都支持 `-xf` 自动识别 zip/tar.gz/tar.bz2。零新增依赖；tar 缺失时报可读错误。
3. **npx/uvx 不落盘**：安装 = 仅写清单 + 注册 AgentDef（`command: "npx"|"uvx"`）；binary 才有下载-校验-解压管线（安装目录 `configDir()/installed/<id>/`，重装先清空实现升级）。
4. **平台映射**：`win32+x64→windows-x86_64`、`win32+arm64→windows-aarch64`、`darwin/{x64,arm64}`、`linux/{x64,arm64}`；其余平台/架构该条目 `supported: false`（UI 置灰），不阻断列表。
5. **动态注册**：`AgentStore.addAgent(def)`（stopped 态入表 + 广播 status）、`removeAgent(name)`（先 stop 再移除，exit 回调加条目存在性兜底）。安装即注册，卸载即注销，重启后由 config 合并恢复。
6. **事件流**：registry 数据不经主 snapshot（加载时机不同步），独立 `registry.snapshot` 事件：WS 打开且已有数据时补发一次；refresh/install/uninstall 后重发。安装进度用 `registry.progress`（stage 单向推进：downloading → verifying → extracting → registering → done | error）。

## 文件结构（新增 / 修改）

```
acp-client/
├── src/
│   ├── server/registry/
│   │   ├── schema.ts        # 新建：zod schema + platformTarget + resolveDistribution + semver 比较
│   │   ├── installer.ts     # 新建：下载/sha256/解压 + 清单读写 + 卸载清理
│   │   └── service.ts       # 新建：fetch 缓存 + install/uninstall 编排 + 事件回调
│   ├── server/
│   │   ├── store.ts         # 修改：addAgent / removeAgent + exit 回调兜底
│   │   ├── config.ts        # 修改：loadAgentDefs 合并 registry-installs.json
│   │   ├── app.ts           # 修改：AppDeps.registry + dispatch 三命令 + onOpen 补发
│   │   └── main.ts          # 修改：创建 RegistryService 并接入
│   ├── shared/bridge-protocol.ts  # 修改：RegistryAgentView + 3 命令 + 2 事件
│   └── web/
│       ├── state.ts         # 修改：registry 切片 + reducer case
│       ├── i18n.ts          # 修改：registry 文案
│       ├── App.tsx          # 修改：挂载 RegistryModal
│       ├── components/AgentSidebar.tsx  # 修改：「安装 Agent」按钮
│       └── components/RegistryModal.tsx # 新建
└── tests/
    ├── registry-schema.test.ts      # 新建
    ├── registry-installer.test.ts   # 新建（本地 HTTP fixture + 真 tar.gz）
    ├── registry-service.test.ts     # 新建（npx 装卸 + 缓存 stale）
    ├── store.test.ts                # 修改：动态注册用例
    ├── config.test.ts               # 修改：清单合并用例
    ├── state.test.ts                # 修改：registry reducer 用例
    └── registry-app.test.ts         # 新建（WS 全链路：装→启→会话→卸）
```

---

### Task 1: registry schema + 平台映射 + distribution 解析

**Files:** Create `src/server/registry/schema.ts`；Test `tests/registry-schema.test.ts`

- [x] **Step 1: 写失败测试**

```ts
// tests/registry-schema.test.ts
import { describe, expect, it } from "vitest"
import { RegistryIndexSchema, platformTarget, resolveDistribution, semverGt } from "../src/server/registry/schema"

const ENTRY = {
  id: "example-agent", name: "Example Agent", version: "1.2.3",
  description: "demo", website: "https://example.com",
  authors: ["A"], license: "MIT",
  icon: "https://cdn.example.com/icon.svg",
  distribution: {
    binary: {
      "windows-x86_64": { archive: "https://x/a.zip", sha256: "abc", cmd: "bin/agent.exe", args: ["--acp"] },
      "linux-aarch64": { archive: "https://x/a.tgz", sha256: "def", cmd: "bin/agent" },
    },
  },
}

describe("RegistryIndexSchema", () => {
  it("解析标准索引", () => {
    const idx = RegistryIndexSchema.parse({ version: "1.0.0", agents: [ENTRY] })
    expect(idx.agents[0].id).toBe("example-agent")
  })
  it("宽容：未知字段容忍；version 非 X.Y.Z 拒绝", () => {
    expect(RegistryIndexSchema.parse({ version: "1", agents: [{ ...ENTRY, extra: 1 } as never] }).agents).toHaveLength(1)
    expect(() => RegistryIndexSchema.parse({ version: "1.0.0", agents: [{ ...ENTRY, version: "v1.2" }] })).toThrow()
  })
  it("distribution 必须至少一个已知形态", () => {
    expect(() => RegistryIndexSchema.parse({ version: "1", agents: [{ ...ENTRY, distribution: {} }] })).toThrow()
  })
})

describe("platformTarget", () => {
  it("常见组合映射", () => {
    expect(platformTarget("win32", "x64")).toBe("windows-x86_64")
    expect(platformTarget("win32", "arm64")).toBe("windows-aarch64")
    expect(platformTarget("darwin", "arm64")).toBe("darwin-aarch64")
    expect(platformTarget("darwin", "x64")).toBe("darwin-x86_64")
    expect(platformTarget("linux", "x64")).toBe("linux-x86_64")
    expect(platformTarget("linux", "arm64")).toBe("linux-aarch64")
  })
  it("不支持的组合抛错", () => {
    expect(() => platformTarget("sunos", "x64")).toThrow()
    expect(() => platformTarget("linux", "mips")).toThrow()
  })
})

describe("resolveDistribution", () => {
  it("binary 命中当前平台 → { kind:'binary', spec }", () => {
    const r = resolveDistribution(ENTRY.distribution, "windows-x86_64")
    expect(r?.kind).toBe("binary")
  })
  it("binary 无当前平台 → null；npx/uvx 平台无关", () => {
    expect(resolveDistribution(ENTRY.distribution, "darwin-x86_64")).toBeNull()
    expect(resolveDistribution({ npx: { package: "foo", args: ["--x"] } }, "windows-x86_64")?.kind).toBe("npx")
    expect(resolveDistribution({ uvx: { package: "foo" } }, "windows-x86_64")?.kind).toBe("uvx")
  })
})

describe("semverGt", () => {
  it("逐段数值比较", () => {
    expect(semverGt("1.10.0", "1.9.9")).toBe(true)
    expect(semverGt("1.2.3", "1.2.3")).toBe(false)
    expect(semverGt("0.9.0", "1.0.0")).toBe(false)
  })
})
```

- [x] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/registry-schema.test.ts`
Expected: FAIL（模块不存在）

- [x] **Step 3: 实现 schema.ts**

```ts
// src/server/registry/schema.ts
import { z } from "zod"

export const PlatformSpecSchema = z.object({
  archive: z.string().min(1),
  sha256: z.string().min(1),
  cmd: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
})

export const DistributionSchema = z.union([
  z.object({ binary: z.record(z.string(), PlatformSpecSchema) }),
  z.object({ npx: z.object({ package: z.string().min(1), args: z.array(z.string()).optional() }) }),
  z.object({ uvx: z.object({ package: z.string().min(1), args: z.array(z.string()).optional() }) }),
])

export const RegistryAgentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, "version 必须是 X.Y.Z"),
  description: z.string().optional(),
  repository: z.string().optional(),
  website: z.string().optional(),
  authors: z.array(z.string()).optional(),
  license: z.string().optional(),
  license_url: z.string().optional(),
  icon: z.string().optional(),
  distribution: DistributionSchema,
  // preview 块仅 JetBrains 变体出现；本立项不消费，宽容放行
  preview: z.unknown().optional(),
})

export const RegistryIndexSchema = z.object({
  version: z.string(),
  agents: z.array(RegistryAgentSchema),
})
export type RegistryAgent = z.infer<typeof RegistryAgentSchema>
export type PlatformSpec = z.infer<typeof PlatformSpecSchema>

export type Resolved =
  | { kind: "binary"; spec: PlatformSpec }
  | { kind: "npx"; package: string; args: string[] }
  | { kind: "uvx"; package: string; args: string[] }

export function platformTarget(platform: NodeJS.Platform = process.platform, arch = process.arch): string {
  const a = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : null
  if (!a) throw new Error(`不支持的 CPU 架构: ${arch}`)
  if (platform === "win32") return `windows-${a}`
  if (platform === "darwin") return `darwin-${a}`
  if (platform === "linux") return `linux-${a}`
  throw new Error(`不支持的操作系统: ${platform}`)
}

export function resolveDistribution(d: unknown, target: string): Resolved | null {
  if (d && typeof d === "object" && "binary" in d) {
    const spec = (d as { binary: Record<string, PlatformSpec> }).binary[target]
    return spec ? { kind: "binary", spec } : null
  }
  if (d && typeof d === "object" && "npx" in d) {
    const n = (d as { npx: { package: string; args?: string[] } }).npx
    return { kind: "npx", package: n.package, args: n.args ?? [] }
  }
  if (d && typeof d === "object" && "uvx" in d) {
    const u = (d as { uvx: { package: string; args?: string[] } }).uvx
    return { kind: "uvx", package: u.package, args: u.args ?? [] }
  }
  return null
}

/** X.Y.Z 逐段数值比较：a > b */
export function semverGt(a: string, b: string): boolean {
  const pa = a.split(".").map(Number)
  const pb = b.split(".").map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0)
  }
  return false
}
```

> 注意：`z.union` 各分支都要求「恰好该 key」并不严格（多余 key 不报错），`distribution: {}` 会被三个分支全拒绝——Step 1 第三条用例依赖此行为。若 zod 版本行为不符，用 `z.custom` 校验 `"binary" in d || "npx" in d || "uvx" in d`。

- [x] **Step 4: 运行确认通过**

Run: `pnpm vitest run tests/registry-schema.test.ts`
Expected: PASS (6 tests)

- [x] **Step 5: Commit**

```bash
git add src/server/registry/schema.ts tests/registry-schema.test.ts
git commit -m "feat(registry): index schema, platform target, distribution resolution"
```

---

### Task 2: installer（下载 / sha256 / 解压 / 清单 / 卸载）

**Files:** Create `src/server/registry/installer.ts`；Test `tests/registry-installer.test.ts`

- [x] **Step 1: 写失败测试（本地 HTTP fixture + 真 tar.gz）**

```ts
// tests/registry-installer.test.ts
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createServer, type Server } from "node:http"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { installBinary, loadManifest, removeInstall } from "../src/server/registry/installer"

let http: Server
let base = ""
let fixtureSha = ""
let home: string
let work: string

beforeAll(async () => {
  home = mkdtempSync(path.join(tmpdir(), "reg-home-"))
  work = mkdtempSync(path.join(tmpdir(), "reg-work-"))
  // 用系统 tar 组装真 tar.gz（Windows bsdtar / unix tar 通用），内含 file.txt
  const pkg = path.join(work, "pkg")
  writeFileSync(path.join(pkg, "file.txt"), "payload")
  spawnSync("tar", ["-czf", path.join(work, "a.tgz"), "-C", pkg, "."])
  const buf = readFileSync(path.join(work, "a.tgz"))
  fixtureSha = createHash("sha256").update(buf).digest("hex")
  http = createServer((req, res) => {
    if (req.url === "/a.tgz") { res.end(buf); return }
    res.statusCode = 404; res.end("nope")
  })
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${(http.address() as { port: number }).port}`
})
afterAll(() => {
  http.close()
  rmSync(home, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
})

const SPEC = () => ({ archive: `${base}/a.tgz`, sha256: fixtureSha, cmd: "file.txt" })

describe("installer", () => {
  it("binary 安装：下载 → sha256 通过 → 解压 → 清单含固化 AgentDef", async () => {
    const stages: string[] = []
    const res = await installBinary({ id: "ex", name: "Ex Agent", version: "1.0.0", spec: SPEC(), home, onProgress: (s) => stages.push(s) })
    expect(res.def.command.replace(/\\/g, "/")).toContain("installed/ex/file.txt")
    expect(existsSync(res.def.command)).toBe(true)
    expect(stages).toEqual(["downloading", "verifying", "extracting", "done"])
    const m = loadManifest(home)
    expect(m.installs[0]).toMatchObject({ id: "ex", version: "1.0.0", kind: "binary" })
  })

  it("sha256 不符 → 报错且不写清单、不留目录", async () => {
    await expect(installBinary({ id: "bad", name: "b", version: "1.0.0", spec: { ...SPEC(), sha256: "0".repeat(64) }, home, onProgress: () => {} })).rejects.toThrow(/sha256|校验/i)
    expect(loadManifest(home).installs.some((i) => i.id === "bad")).toBe(false)
    expect(existsSync(path.join(home, "installed", "bad"))).toBe(false)
  })

  it("卸载：清单移除 + 安装目录删除", async () => {
    await installBinary({ id: "ex2", name: "e2", version: "1.0.0", spec: SPEC(), home, onProgress: () => {} })
    expect(existsSync(path.join(home, "installed", "ex2"))).toBe(true)
    removeInstall(home, "ex2")
    expect(loadManifest(home).installs.some((i) => i.id === "ex2")).toBe(false)
    expect(existsSync(path.join(home, "installed", "ex2"))).toBe(false)
  })
})
```

> `file.txt` 用作 cmd 只验证管线（下载/校验/解压/路径拼接），可执行性由 Task 6 的 e2e（真 launcher 脚本）覆盖。

- [x] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/registry-installer.test.ts`
Expected: FAIL（模块不存在）

- [x] **Step 3: 实现 installer.ts**

```ts
// src/server/registry/installer.ts
import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { pipeline } from "node:stream/promises"
import { Readable } from "node:stream"
import type { PlatformSpec } from "./schema"
import type { AgentDef } from "../../shared/agent-def"

export type ManifestInstall = {
  id: string; name: string; version: string
  kind: "binary" | "npx" | "uvx"
  installedAt: number
  /** 安装时固化的完整 AgentDef（重启后由 config 合并直接复用） */
  def: AgentDef
}
export type InstallManifest = { installs: ManifestInstall[] }

export function manifestPath(home: string): string { return path.join(home, "registry-installs.json") }

export function loadManifest(home: string): InstallManifest {
  const f = manifestPath(home)
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as InstallManifest) : { installs: [] }
}

function saveManifest(home: string, m: InstallManifest): void {
  mkdirSync(home, { recursive: true })
  const tmp = manifestPath(home) + ".tmp"
  writeFileSync(tmp, JSON.stringify(m, null, 2))
  renameSync(tmp, manifestPath(home))
}

export function installDirOf(home: string, id: string): string { return path.join(home, "installed", id) }

export type InstallStage = "downloading" | "verifying" | "extracting" | "done"

/** binary 分发：下载 → sha256 → 解压(系统 tar) → 固化 AgentDef → 写清单 */
export async function installBinary(p: {
  id: string; name: string; version: string; spec: PlatformSpec; home: string
  onProgress(stage: InstallStage): void
}): Promise<{ def: AgentDef }> {
  const dir = installDirOf(p.home, p.id)
  rmSync(dir, { recursive: true, force: true }) // 重装/升级：先清空旧版本目录
  mkdirSync(dir, { recursive: true })
  const archivePath = path.join(dir, path.basename(new URL(p.spec.archive).pathname))

  p.onProgress("downloading")
  const res = await fetch(p.spec.archive)
  if (!res.ok || !res.body) throw new Error(`下载失败: HTTP ${res.status}`)
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(archivePath))

  p.onProgress("verifying")
  const actual = createHash("sha256").update(readFileSync(archivePath)).digest("hex")
  if (actual !== p.spec.sha256.toLowerCase()) {
    rmSync(dir, { recursive: true, force: true })
    throw new Error(`sha256 校验失败：期望 ${p.spec.sha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…`)
  }

  p.onProgress("extracting")
  await extractArchive(archivePath, dir)

  const command = path.resolve(dir, p.spec.cmd)
  if (!existsSync(command)) throw new Error(`解压后未找到 ${p.spec.cmd}`)
  if (process.platform !== "win32") chmodSync(command, 0o755)

  const def: AgentDef = {
    name: p.id, // AgentDef.name = registry id；显示名用 entry.name（RegistryAgentView）
    command, args: p.spec.args ?? [], env: p.spec.env ?? {},
    shell: process.platform === "win32" && command.toLowerCase().endsWith(".cmd") ? true : undefined,
    autoStart: false, builtin: false,
  }
  const m = loadManifest(p.home)
  m.installs = m.installs.filter((i) => i.id !== p.id)
  m.installs.push({ id: p.id, name: p.name, version: p.version, kind: "binary", installedAt: Date.now(), def })
  saveManifest(p.home, m)
  p.onProgress("done")
  return { def }
}

async function extractArchive(archive: string, dir: string): Promise<void> {
  const r = spawn("tar", ["-xf", archive, "-C", dir], { stdio: "pipe" })
  const err: string[] = []
  r.stderr?.on("data", (d) => err.push(String(d)))
  await new Promise<void>((resolve, reject) => {
    r.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`tar 解压失败(code=${code})：${err.join("").slice(0, 400)}`))))
    r.once("error", (e) => reject(new Error(`tar 不可用（Windows 10+/macOS/Linux 自带）：${e.message}`)))
  })
}

/** 注册 npx/uvx 安装（不落盘，仅清单 + AgentDef）。 */
export function registerRemoteInstall(p: {
  id: string; name: string; version: string; kind: "npx" | "uvx"; package: string; args: string[]; home: string
}): AgentDef {
  const def: AgentDef = {
    name: p.id,
    command: p.kind === "npx" ? "npx" : "uvx",
    args: p.kind === "npx" ? ["-y", p.package, ...p.args] : [p.package, ...p.args],
    env: {}, autoStart: false, builtin: false,
  }
  const m = loadManifest(p.home)
  m.installs = m.installs.filter((i) => i.id !== p.id)
  m.installs.push({ id: p.id, name: p.name, version: p.version, kind: p.kind, installedAt: Date.now(), def })
  saveManifest(p.home, m)
  return def
}

export function removeInstall(home: string, id: string): void {
  const m = loadManifest(home)
  m.installs = m.installs.filter((i) => i.id !== id)
  saveManifest(home, m)
  rmSync(installDirOf(home, id), { recursive: true, force: true })
}
```

- [x] **Step 4: 运行确认通过**

Run: `pnpm vitest run tests/registry-installer.test.ts`
Expected: PASS (3 tests)。若 Windows 上 `tar -czf` 打包 fixture 失败，改用 `tar -a -cf a.zip ...`（bsdtar 依扩展名定格式），解压逻辑不变。

- [x] **Step 5: Commit**

```bash
git add src/server/registry/installer.ts tests/registry-installer.test.ts
git commit -m "feat(registry): installer with sha256 gate, tar extraction, manifest"
```

---

### Task 3: service（fetch 缓存 + 编排）+ store 动态注册 + config 合并

**Files:** Create `src/server/registry/service.ts`；Modify `src/server/store.ts`、`src/server/config.ts`；Test `tests/registry-service.test.ts`、扩展 `tests/store.test.ts`、`tests/config.test.ts`

- [x] **Step 1: 写失败测试**

```ts
// tests/registry-service.test.ts
import { createServer, type Server } from "node:http"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { RegistryService } from "../src/server/registry/service"

// fixture：npx 条目安装无网络副作用，最适合单测
const REGISTRY = {
  version: "1.0.0",
  agents: [{
    id: "npmed", name: "NPM Agent", version: "2.0.1", description: "d",
    distribution: { npx: { package: "some-agent", args: ["--acp"] } },
  }],
}

describe("RegistryService", () => {
  let http: Server, url: string, home: string
  beforeAll(async () => {
    home = mkdtempSync(path.join(tmpdir(), "reg-svc-"))
    http = createServer((_q, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(REGISTRY)) })
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r))
    url = `http://127.0.0.1:${(http.address() as { port: number }).port}/registry.json`
  })
  afterAll(() => { http.close(); rmSync(home, { recursive: true, force: true }) })

  const noopEvents = () => ({ onSnapshot: () => {}, onProgress: () => {}, onInstalled: () => {}, onUninstalled: () => {} })

  it("refresh 拉取 + 缓存落盘 + 视图标记", async () => {
    const svc = new RegistryService({ home, url, events: noopEvents(), autoRefresh: false })
    await svc.refresh(true)
    const v = svc.view()
    expect(v.agents[0]).toMatchObject({ id: "npmed", kind: "npx", supported: true, installed: false, updateAvailable: false })
    expect(v.fetchedAt).toBeGreaterThan(0)
  })

  it("install(npx) → onInstalled 回调；view 变 installed；重复安装报错；uninstall 还原", async () => {
    const installed: string[] = []
    const svc = new RegistryService({ home, url, events: { ...noopEvents(), onInstalled: (def) => installed.push(def.name) }, autoRefresh: false })
    await svc.refresh(true)
    await svc.install("npmed")
    expect(installed).toEqual(["npmed"])
    expect(svc.view().agents[0].installed).toBe(true)
    await expect(svc.install("npmed")).rejects.toThrow(/已安装/i)
    svc.uninstall("npmed")
    expect(svc.view().agents[0].installed).toBe(false)
  })

  it("源不可达 → refresh 抛错；有缓存时 loadCache 后 view() 仍可服务", async () => {
    const svc = new RegistryService({ home, url: "http://127.0.0.1:1/nope", events: noopEvents(), autoRefresh: false })
    await expect(svc.refresh(true)).rejects.toThrow()
    // 先造缓存（用可达源），再用不可达源实例只 loadCache
    const warm = new RegistryService({ home, url, events: noopEvents(), autoRefresh: false })
    await warm.refresh(true)
    const cold = new RegistryService({ home, url: "http://127.0.0.1:1/nope", events: noopEvents(), autoRefresh: false })
    await cold.loadCache()
    expect(cold.view().agents).toHaveLength(1)
  })
})
```

store.test.ts 追加：

```ts
it("addAgent/removeAgent：动态注册后可 start，移除后未知", async () => {
  const r = recorder()
  const store = new AgentStore([], r.base)
  store.addAgent({ name: "dyn", command: process.execPath, args: ["--import", "tsx", CHILD], env: {}, autoStart: false, builtin: false })
  await store.start("dyn")
  expect(store.statusOf("dyn")).toBe("ready")
  store.removeAgent("dyn")
  expect(() => store.statusOf("dyn")).toThrow(/未知/)
}, 15000)
```

config.test.ts 追加：

```ts
it("loadAgentDefs 合并 registry-installs.json 的固化 AgentDef", () => {
  const dir = tmpHome()
  writeFileSync(path.join(dir, "registry-installs.json"), JSON.stringify({
    installs: [{ id: "npmed", name: "n", version: "1.0.0", kind: "npx", installedAt: 1, def: { name: "npmed", command: "npx", args: ["-y", "pkg"], env: {}, autoStart: false, builtin: false } }],
  }))
  const defs = loadAgentDefs(dir)
  expect(defs.find((d) => d.name === "npmed")?.command).toBe("npx")
  expect(defs.filter((d) => d.name === "npmed")).toHaveLength(1)
})
```

- [x] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/registry-service.test.ts tests/store.test.ts tests/config.test.ts`
Expected: FAIL（service 不存在；新增 store/config 用例失败）

- [x] **Step 3: 实现 service.ts**

```ts
// src/server/registry/service.ts
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { RegistryIndexSchema, platformTarget, resolveDistribution, semverGt, type RegistryAgent } from "./schema"
import { installBinary, loadManifest, registerRemoteInstall, removeInstall } from "./installer"
import type { AgentDef } from "../../shared/agent-def"
import type { RegistryAgentView } from "../../shared/bridge-protocol"

export type RegistryEvents = {
  onSnapshot(view: { agents: RegistryAgentView[]; fetchedAt: number; stale: boolean }): void
  onProgress(p: { id: string; stage: "downloading" | "verifying" | "extracting" | "registering" | "done" | "error"; message?: string }): void
  onInstalled(def: AgentDef): void      // → store.addAgent
  onUninstalled(agentId: string): void  // → app 层先 store.stop 再 removeAgent
}

export const DEFAULT_REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json"
const TTL_MS = 60 * 60 * 1000

export class RegistryService {
  private agents: RegistryAgent[] = []
  private fetchedAt = 0
  private inflight: Promise<void> | null = null

  constructor(private p: { home: string; url?: string; events: RegistryEvents; autoRefresh?: boolean }) {
    void this.loadCache()
    if (p.autoRefresh !== false) void this.refresh(false).catch(() => {})
  }

  view(): { agents: RegistryAgentView[]; fetchedAt: number; stale: boolean } {
    const target = (() => { try { return platformTarget() } catch { return "" } })()
    const installedMap = new Map(loadManifest(this.p.home).installs.map((i) => [i.id, i]))
    return {
      fetchedAt: this.fetchedAt,
      stale: this.fetchedAt > 0 && Date.now() - this.fetchedAt > TTL_MS,
      agents: this.agents.map((a) => {
        const inst = installedMap.get(a.id)
        const resolved = target ? resolveDistribution(a.distribution, target) : null
        return {
          id: a.id, name: a.name, version: a.version,
          description: a.description, website: a.website, repository: a.repository,
          license: a.license, authors: a.authors,
          kind: resolved?.kind ?? "binary",
          supported: resolved != null,
          installed: inst != null,
          installedVersion: inst?.version,
          updateAvailable: inst != null && semverGt(a.version, inst.version),
        }
      }),
    }
  }

  async loadCache(): Promise<void> {
    const f = path.join(this.p.home, "registry-cache.json")
    if (!existsSync(f)) return
    try {
      const c = JSON.parse(readFileSync(f, "utf8")) as { agents: RegistryAgent[]; fetchedAt: number }
      this.agents = c.agents
      this.fetchedAt = c.fetchedAt
    } catch { /* 坏缓存忽略 */ }
  }

  private saveCache(): void {
    const f = path.join(this.p.home, "registry-cache.json")
    const tmp = f + ".tmp"
    writeFileSync(tmp, JSON.stringify({ agents: this.agents, fetchedAt: this.fetchedAt }))
    renameSync(tmp, f)
  }

  async refresh(force: boolean): Promise<void> {
    if (this.inflight) return this.inflight
    if (!force && this.fetchedAt > 0 && Date.now() - this.fetchedAt < TTL_MS) return
    this.inflight = (async () => {
      const res = await fetch(this.p.url ?? DEFAULT_REGISTRY_URL)
      if (!res.ok) throw new Error(`registry 拉取失败: HTTP ${res.status}`)
      const idx = RegistryIndexSchema.parse(await res.json())
      this.agents = idx.agents
      this.fetchedAt = Date.now()
      this.saveCache()
      this.p.events.onSnapshot(this.view())
    })().finally(() => { this.inflight = null })
    return this.inflight
  }

  async install(id: string): Promise<void> {
    const a = this.agents.find((x) => x.id === id)
    if (!a) throw new Error(`registry 中不存在 ${id}`)
    if (loadManifest(this.p.home).installs.some((i) => i.id === id)) throw new Error(`${id} 已安装`)
    const target = platformTarget()
    const resolved = resolveDistribution(a.distribution, target)
    if (!resolved) throw new Error(`当前平台 ${target} 无可用分发包`)
    try {
      if (resolved.kind === "binary") {
        const { def } = await installBinary({
          id, name: a.name, version: a.version, spec: resolved.spec, home: this.p.home,
          onProgress: (stage) => this.p.events.onProgress({ id, stage }),
        })
        this.p.events.onProgress({ id, stage: "registering" })
        this.p.events.onInstalled(def)
      } else {
        const def = registerRemoteInstall({ id, name: a.name, version: a.version, kind: resolved.kind, package: resolved.package, args: resolved.args, home: this.p.home })
        this.p.events.onInstalled(def)
      }
      this.p.events.onProgress({ id, stage: "done" })
      this.p.events.onSnapshot(this.view())
    } catch (e) {
      this.p.events.onProgress({ id, stage: "error", message: String((e as Error)?.message ?? e) })
      throw e
    }
  }

  uninstall(id: string): void {
    if (!loadManifest(this.p.home).installs.some((i) => i.id === id)) throw new Error(`${id} 未安装`)
    this.p.events.onUninstalled(id)
    removeInstall(this.p.home, id)
    this.p.events.onSnapshot(this.view())
  }
}
```

store.ts 增补（紧邻 start/stop；同时给 `start()` 的 exit 崩溃检测回调开头加 `if (!this.agents.has(agentId)) return` 兜底，防 removeAgent 后幽灵 status）：

```ts
/** registry 安装：动态注册一个 stopped 态 agent 并广播 */
addAgent(def: AgentDef): void {
  if (this.agents.has(def.name)) throw new Error(`agent ${def.name} 已存在`)
  this.agents.set(def.name, { def, proc: null, acp: null, status: "stopped" })
  this.events.onAgentStatus(def.name, this.view(this.agents.get(def.name)!))
}

/** registry 卸载：运行中先停，再移除 */
removeAgent(agentId: string): void {
  const r = this.agents.get(agentId)
  if (!r) return
  if (r.status !== "stopped") this.stop(agentId)
  this.agents.delete(agentId)
}
```

config.ts `loadAgentDefs` 返回前追加（`merged` 改为可变数组）：

```ts
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
```

- [x] **Step 4: 运行确认通过**

Run: `pnpm vitest run tests/registry-service.test.ts tests/store.test.ts tests/config.test.ts`
Expected: PASS（新增用例全绿，存量不回归）

- [x] **Step 5: Commit**

```bash
git add src/server/registry/service.ts src/server/store.ts src/server/config.ts tests/registry-service.test.ts tests/store.test.ts tests/config.test.ts
git commit -m "feat(registry): service orchestration, dynamic store registration, config merge"
```

---

### Task 4: bridge 协议 + app/main 接线

**Files:** Modify `src/shared/bridge-protocol.ts`、`src/server/app.ts`、`src/server/main.ts`

- [x] **Step 1: bridge-protocol.ts 增类型**

```ts
// —— registry（P2-21）——
export type RegistryAgentView = {
  id: string
  name: string
  version: string
  description?: string
  website?: string
  repository?: string
  license?: string
  authors?: string[]
  kind: "binary" | "npx" | "uvx"
  supported: boolean
  installed: boolean
  installedVersion?: string
  updateAvailable: boolean
}

// BridgeCommand 追加：
| { type: "registry.refresh" }
| { type: "registry.install"; id: string }
| { type: "registry.uninstall"; id: string }

// BridgeEvent 追加：
| { type: "registry.snapshot"; agents: RegistryAgentView[]; fetchedAt: number; stale: boolean }
| { type: "registry.progress"; id: string; stage: "downloading" | "verifying" | "extracting" | "registering" | "done" | "error"; message?: string }
```

- [x] **Step 2: app.ts 接线**

- `AppDeps` 增 `registry?: RegistryPort`；为避免 app.ts 反向依赖 service 具体类型，用结构类型：

```ts
export type RegistryPort = {
  refresh(force: boolean): Promise<void>
  install(id: string): Promise<void>
  uninstall(id: string): void
  view(): { agents: unknown[]; fetchedAt: number; stale: boolean }
}
```

- `createApp` 增 `wireRegistryEvents(hub, store)`（main.ts 调用，或由 createApp 内部组装后注入 service）：`onSnapshot → hub.emit({ type: "registry.snapshot", ...v })`；`onProgress → hub.emit({ type: "registry.progress", ...p })`；`onInstalled(def) → store.addAgent(def)`；`onUninstalled(id) → try { store.stop(id) } catch {} ; store.removeAgent(id)`。
- WS `onOpen`：发完主 snapshot 后，`if (deps.registry && deps.registry.view().fetchedAt > 0) ws.send(JSON.stringify({ type: "registry.snapshot", ...deps.registry.view() } satisfies BridgeEvent))`。
- `dispatch` 增三分支：

```ts
case "registry.refresh":
  void deps.registry?.refresh(true).catch((e) => ws.send(JSON.stringify({ type: "prompt.error", agentId: "", sessionId: null, message: `registry 刷新失败: ${String((e as Error).message ?? e)}` } satisfies BridgeEvent)))
  break
case "registry.install":
  void deps.registry?.install(cmd.id).catch((e) => hub.emit({ type: "prompt.error", agentId: cmd.id, sessionId: null, message: `安装失败: ${String((e as Error).message ?? e)}` } satisfies BridgeEvent))
  break
case "registry.uninstall":
  try { deps.registry?.uninstall(cmd.id) } catch (e) {
    ws.send(JSON.stringify({ type: "prompt.error", agentId: cmd.id, sessionId: null, message: String((e as Error).message ?? e) } satisfies BridgeEvent))
  }
  break
```

- [x] **Step 3: main.ts 创建服务**

```ts
import { RegistryService } from "./registry/service"
// hub/store 建好之后、createApp 之前：
const registry = new RegistryService({
  home: dir,
  events: {
    onSnapshot: (v) => hub.emit({ type: "registry.snapshot", ...v }),
    onProgress: (p) => hub.emit({ type: "registry.progress", ...p }),
    onInstalled: (def) => store.addAgent(def),
    onUninstalled: (id) => { try { store.stop(id) } catch { /* 未启动 */ } store.removeAgent(id) },
  },
})
// createApp({ token, store, hub, cache, registry, staticRoot: "dist/web", ... })
```

- [x] **Step 4: 全量回归**

Run: `pnpm typecheck ; pnpm vitest run`
Expected: typecheck 0 errors；全部测试 PASS（本任务不新增 e2e，Task 6 补）。

- [x] **Step 5: Commit**

```bash
git add src/shared/bridge-protocol.ts src/server/app.ts src/server/main.ts
git commit -m "feat(registry): bridge commands/events, app wiring, main bootstrap"
```

---

### Task 5: 前端（state + RegistryModal + 侧边栏入口 + i18n + 样式）

**Files:** Modify `src/web/state.ts`、`src/web/i18n.ts`、`src/web/App.tsx`、`src/web/components/AgentSidebar.tsx`、`src/styles.css`；Create `src/web/components/RegistryModal.tsx`；扩展 `tests/state.test.ts`

- [x] **Step 1: state.test.ts 追加用例**

```ts
it("registry.snapshot 填充列表；registry.progress 推进；agent.status 动态条目入 agents", () => {
  let s = initialFrontState()
  s = reduceEvent(s, { type: "registry.snapshot", agents: [{ id: "a", name: "A", version: "1.0.0", kind: "npx", supported: true, installed: false, updateAvailable: false }], fetchedAt: 1, stale: false } as BridgeEvent)
  expect(s.registry?.agents).toHaveLength(1)
  s = reduceEvent(s, { type: "registry.progress", id: "a", stage: "downloading" } as BridgeEvent)
  expect(s.registry?.progress["a"]?.stage).toBe("downloading")
  s = reduceEvent(s, { type: "registry.progress", id: "a", stage: "done" } as BridgeEvent)
  expect(s.registry?.progress["a"]?.stage).toBe("done")
})
```

- [x] **Step 2: state.ts 增切片与 reducer case**

```ts
export type RegistryProgress = { stage: "downloading" | "verifying" | "extracting" | "registering" | "done" | "error"; message?: string }
// FrontState 追加：
registry: {
  agents: RegistryAgentView[]
  fetchedAt: number
  stale: boolean
  progress: Record<string, RegistryProgress>
} | null
// initialFrontState 追加 registry: null

// reduceEvent 追加 case：
case "registry.snapshot":
  return { ...s, registry: { agents: e.agents, fetchedAt: e.fetchedAt, stale: e.stale, progress: {} } }
case "registry.progress": {
  if (!s.registry) return s
  return { ...s, registry: { ...s.registry, progress: { ...s.registry.progress, [e.id]: { stage: e.stage, message: e.message } } } }
}
```

- [x] **Step 3: i18n.ts 追加文案**

```ts
// registry
registryTitle: "安装 Agent",
registrySubtitle: "来自 ACP Registry 的公共 agent 目录",
registryRefresh: "刷新",
registryEmpty: "目录为空（尚未加载或无条目）",
registryStale: "缓存已过期，点击刷新更新",
registryUnsupported: "当前平台不可用",
registryInstalled: "已安装",
registryUpdate: "有更新",
registryInstall: "安装",
registryUninstall: "卸载",
registryInstalling: "安装中",
registryLoading: "加载中…",
registryLicense: "许可",
registryBy: "作者",
registryClose: "关闭",
```

- [x] **Step 4: RegistryModal.tsx 实现**

```tsx
// src/web/components/RegistryModal.tsx
import { useEffect } from "react"
import { sendCommand } from "../ws"
import { t } from "../i18n"
import { useFront } from "../state"

export function RegistryModal({ onClose }: { onClose: () => void }) {
  const registry = useFront((s) => s.registry)
  useEffect(() => { if (!registry) sendCommand({ type: "registry.refresh" }) }, []) // 打开时强制刷新一次

  const stageText: Record<string, string> = {
    downloading: "下载中…", verifying: "校验中…", extracting: "解压中…", registering: "注册中…", done: "", error: "失败",
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal registry" onClick={(e) => e.stopPropagation()}>
        <div className="registry-head">
          <h3>{t.registryTitle}</h3>
          <div className="registry-head-actions">
            {registry?.stale && <span className="muted">{t.registryStale}</span>}
            <button onClick={() => sendCommand({ type: "registry.refresh" })}>{t.registryRefresh}</button>
            <button onClick={onClose}>{t.registryClose}</button>
          </div>
        </div>
        {!registry && <div className="muted">{t.registryLoading}</div>}
        {registry && registry.agents.length === 0 && <div className="muted">{t.registryEmpty}</div>}
        <ul className="registry-list">
          {registry?.agents.map((a) => {
            const prog = registry.progress[a.id]
            const busy = prog != null && !["done", "error"].includes(prog.stage)
            return (
              <li key={a.id} className={`registry-item ${a.supported ? "" : "disabled"}`}>
                {a.icon && <img src={a.icon} alt="" width={16} height={16} />}
                <div className="registry-main">
                  <div className="registry-line">
                    <b>{a.name}</b>
                    <span className="muted">v{a.version}</span>
                    <span className="badge">{a.kind}</span>
                    {a.installed && <span className="badge ok">{t.registryInstalled}{a.installedVersion !== a.version ? ` v${a.installedVersion}` : ""}</span>}
                    {a.updateAvailable && <span className="badge update">{t.registryUpdate} v{a.version}</span>}
                    {!a.supported && <span className="badge">{t.registryUnsupported}</span>}
                  </div>
                  {a.description && <div className="muted desc">{a.description}</div>}
                  <div className="muted meta">
                    {a.authors?.length ? `${t.registryBy}: ${a.authors.join(", ")}` : ""}{a.license ? ` · ${t.registryLicense}: ${a.license}` : ""}
                  </div>
                  {prog && prog.stage !== "done" && (
                    <div className={prog.stage === "error" ? "err" : "muted"}>{prog.stage === "error" ? `失败: ${prog.message ?? ""}` : stageText[prog.stage]}</div>
                  )}
                </div>
                <div className="registry-actions">
                  {a.installed ? (
                    <button disabled={busy} onClick={() => sendCommand({ type: "registry.uninstall", id: a.id })}>{t.registryUninstall}</button>
                  ) : (
                    <button className="primary" disabled={!a.supported || busy} onClick={() => sendCommand({ type: "registry.install", id: a.id })}>
                      {busy ? t.registryInstalling : t.registryInstall}
                    </button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
```

- [x] **Step 5: AgentSidebar「安装 Agent」按钮 + App.tsx 挂载 + styles.css**

- AgentSidebar 底部：`<button onClick={() => useFront.setState({ registryOpen: true })}>{t.registryTitle}</button>`（`registryOpen: boolean` 加入 FrontState，或本地 App state；**推荐 FrontState**，state.test 可覆盖）。
- App.tsx：`registryOpen && <RegistryModal onClose={() => useFront.setState({ registryOpen: false })} />`（与 PermissionModal 同层）。
- styles.css 追加：`.registry` 宽 `min(720px, 94vw)`、`.registry-list` 滚动列表（max-height 60vh）、`.registry-item` 行布局 + `.disabled` 置灰、`.badge.ok` 绿 / `.badge.update` 蓝点语义。

- [x] **Step 6: 全量回归**

Run: `pnpm typecheck ; pnpm vitest run tests/state.test.ts`
Expected: PASS

- [x] **Step 7: Commit**

```bash
git add src/web tests/state.test.ts src/styles.css
git commit -m "feat(registry): browser install/update/uninstall UI"
```

---

### Task 6: WS 全链路 e2e（真装真跑 fake agent）

**Files:** Create `tests/registry-app.test.ts`；复用 `tests/app-harness.ts`

- [x] **Step 1: 写 e2e 测试**

fixture registry 含一个 binary 条目：archive 由测试用系统 tar 现场打包，包内是**平台 launcher 脚本**（win: `agent.cmd` → `@node --import tsx <abs tests/fake-agent-child.ts> %*`；unix: `agent.sh`），sha256 现场计算。断言链路：

```ts
// 用例骨架（三段式，复用 app-harness 的 connectWs/next(pred) 模式）
it("registry 全链路：snapshot → install(binary) → agent.status(stopped) → start → session.new → prompt end_turn → uninstall", async () => {
  // 1. 打开 WS：snapshot（无 registry 数据时不强制出现 registry.snapshot —— harness 不注入则跳过）
  // 2. ws.send registry.install
  //    → registry.progress 序列（downloading…done，用 next(pred) 逐个收）
  //    → agent.status(agentId=<fixture id>, status=stopped)（addAgent 广播）
  // 3. ws.send agent.start → agent.status(ready)
  //    → session.new → session.opened
  //    → session.prompt("hi") → prompt.done(stopReason=end_turn)
  //    → session.cancel / agent.stop 收尾
  // 4. ws.send registry.uninstall → registry.snapshot(agents 中该条目 installed=false)
  //    → 后续 agent.status 事件中不再出现该 agentId（removeAgent 生效）
}, 30000)
```

- [x] **Step 2: 运行确认通过**

Run: `pnpm vitest run tests/registry-app.test.ts`
Expected: PASS (1 test)。Windows 上 launcher 用 `.cmd` + AgentDef.shell 自动 true；若 `--import tsx` 解析问题，参照既有 app.test.ts 的子进程写法修正。

- [x] **Step 3: Commit**

```bash
git add tests/registry-app.test.ts tests/app-harness.ts
git commit -m "test(registry): ws end-to-end install/run/uninstall with binary fixture"
```

---

### Task 7: 收尾验证 + 文档

- [x] **Step 1: 全量门禁**

Run: `pnpm typecheck ; pnpm test ; pnpm build`
Expected: typecheck 0 errors；全部测试 PASS；`dist/web` 产出。

- [x] **Step 2: 手动冒烟（可选，需外网）**

Run: `pnpm start` → 打开 UI → 「安装 Agent」→ 应看到 registry 真实条目（claude-code-codev 等 npx 类最易验证）→ 安装 → 启动 → 新建会话 → 卸载。

- [x] **Step 3: CONTEXT.md 增补一节「ACP Registry」**（端点、三种分发、清单文件、平台映射表），并在项目记忆中标记 backlog 已清零。

- [x] **Step 4: 最终提交**

```bash
git add -A
git commit -m "feat(registry): ACP Registry integration complete (P2-21)"
```

---

## 覆盖对照（设计决策 → 任务）

| 设计决策 | 任务 |
|---|---|
| registry.json 宽容 schema + preview 兼容 | Task 1 |
| 三种 distribution → 平台判定/命令生成 | Task 1（判定）/ Task 2（生成） |
| binary 下载-sha256-tar 解压管线，零新依赖 | Task 2 |
| registry-installs.json 清单 + 重启恢复 | Task 2（读写）/ Task 3（合并） |
| npx/uvx 免下载安装 | Task 2（registerRemoteInstall） |
| AgentStore 动态 add/remove + 幽灵回调兜底 | Task 3 |
| 1h TTL stale-while-revalidate + 磁盘缓存 | Task 3（service） |
| bridge registry.* 命令/事件 + WS onOpen 补发 | Task 4 |
| 浏览器安装/更新蓝点/卸载 UI（参照 JetBrains 交互） | Task 5 |
| 全链路真装真跑 | Task 6 |

## 已知取舍（写给实现者）

1. **preview 通道不实现**：标准产物无 preview 字段；schema 已宽容放行，未来需要时在 service.install 加 `channel` 参数 + 拉 `registry-for-jetbrains-preview.json` 即可。
2. **uvx/npx 依赖用户机器装有对应运行时**：缺失时表现为 agent.start 报错（走既有 error 状态面），不在安装时预检。
3. **AgentDef.name = registry id**：id 是 URL/文件名安全的小写标识，避免 entry.name 里的空格/特殊字符破坏 agents map key；侧边栏显示名用 RegistryAgentView.name。若 id 与既有 agent 重名，config 合并与 addAgent 都会拦截。
4. **解压 trust 边界**：registry 是受信任来源（ACP 官方 CDN），tar 解压不做 zip-slip 防护；sha256 门在解压前，篡改包过不了校验。
5. **registry.snapshot 与主 snapshot 分离**：加载时机不同（异步 fetch vs 同步构造），避免 snapshot 事件被 registry 拉取阻塞。
6. **SearchReplace 工具的 "IDE Command timeout" 是误报**：编辑实际成功，用 Grep/Read 验证落盘后继续，勿重复编辑。
