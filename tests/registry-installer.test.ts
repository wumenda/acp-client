import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
  mkdirSync(pkg, { recursive: true })
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
