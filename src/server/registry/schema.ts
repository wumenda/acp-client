// ACP Registry 索引 schema 与 distribution 解析
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

/** Node platform/arch → registry 平台 key（如 win32+x64 → windows-x86_64） */
export function platformTarget(platform: NodeJS.Platform = process.platform, arch = process.arch): string {
  const a = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : null
  if (!a) throw new Error(`不支持的 CPU 架构: ${arch}`)
  if (platform === "win32") return `windows-${a}`
  if (platform === "darwin") return `darwin-${a}`
  if (platform === "linux") return `linux-${a}`
  throw new Error(`不支持的操作系统: ${platform}`)
}

/** distribution → 当前平台可安装形态；binary 无当前平台返回 null */
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
