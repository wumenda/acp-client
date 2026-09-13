// Registry binary 安装管线：下载 / sha256 校验 / tar 解压 / 清单持久化 / 卸载
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { pipeline } from "node:stream/promises"
import { Readable } from "node:stream"
import type { AgentDef } from "../../shared/agent-def"
import type { PlatformSpec } from "./schema"

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
