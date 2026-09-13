// src/web/components/ToolCallCard.tsx
import { useState } from "react"
import type { Block } from "../state"

const STATUS_ICON: Record<string, string> = { pending: "…", in_progress: "⏳", completed: "✔", failed: "✘" }

/** 把 ToolCallContent 摊平为可读文本；二进制块（image/audio/blob）只显示占位，绝不 dump base64 */
function contentText(c: unknown): string {
  if (typeof c === "string") return c
  if (c == null || typeof c !== "object") return ""
  const o = c as Record<string, unknown>
  switch (o.type) {
    case "content": return contentText(o.content)
    case "text": return String(o.text ?? "")
    case "image": return `[图片 ${str(o.mimeType)}]`.trim()
    case "audio": return `[音频 ${str(o.mimeType)}]`.trim()
    case "resource_link": return str(o.uri)
    case "resource": return resourceText(o.resource)
    case "diff": return `diff: ${str(o.path)}`
    case "terminal": return "[终端输出]"
    default: return truncateJson(c)
  }
}

function resourceText(r: unknown): string {
  if (r == null || typeof r !== "object") return ""
  const o = r as { uri?: unknown; mimeType?: unknown; text?: unknown; blob?: unknown }
  if (typeof o.text === "string") return o.text
  const label = [str(o.uri), str(o.mimeType)].filter(Boolean).join(" · ")
  return `[资源${label ? ` ${label}` : ""}${typeof o.blob === "string" ? "（二进制内容省略）" : ""}]`
}

function str(v: unknown): string {
  return typeof v === "string" ? v : ""
}

function truncateJson(v: unknown): string {
  const s = JSON.stringify(v)
  return s.length > 400 ? `${s.slice(0, 400)}…` : s
}

function isDiff(c: unknown): boolean {
  return !!c && typeof c === "object" && (c as { type?: unknown }).type === "diff"
}

/** diff 审阅视图（P1-12）：协议直接给出 oldText/newText，行级 -/+ 直映，不做算法 diff */
function DiffView({ c }: { c: { path?: unknown; oldText?: unknown; newText?: unknown } }) {
  const path = str(c.path)
  const oldText = typeof c.oldText === "string" ? c.oldText : null
  const newText = typeof c.newText === "string" ? c.newText : ""
  const lines: Array<{ sign: "-" | "+"; text: string }> = []
  if (oldText !== null && oldText !== "") for (const l of oldText.split("\n")) lines.push({ sign: "-", text: l })
  if (newText !== "") for (const l of newText.split("\n")) lines.push({ sign: "+", text: l })
  return (
    <div className="diff-view">
      <div className="diff-path" title={path}>{path || "(diff)"}</div>
      <pre className="diff-body">
        {lines.map((l, i) => (
          <div key={i} className={`diff-line ${l.sign === "-" ? "diff-del" : "diff-add"}`}>
            <span className="diff-sign">{l.sign}</span>
            <span className="diff-text">{l.text}</span>
          </div>
        ))}
      </pre>
    </div>
  )
}

export function ToolCallCard({ block }: { block: Extract<Block, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false)
  const [showRaw, setShowRaw] = useState(false)
  const statusIcon = STATUS_ICON[block.status ?? "pending"] ?? "·"
  const hasContent = Array.isArray(block.content) && block.content.length > 0
  const diffs = hasContent ? block.content!.filter(isDiff) as Array<Record<string, unknown>> : []
  const plainText = hasContent ? block.content!.filter((c) => !isDiff(c)).map(contentText).join("\n") : ""
  const hasRaw = block.rawInput !== undefined || block.rawOutput !== undefined
  const toggle = () => { if (hasContent || hasRaw) setOpen((v) => !v) }
  return (
    <div className={`tool tool-${block.status ?? "pending"}${open ? " expanded" : ""}`}>
      <div
        className={`tool-head${hasContent || hasRaw ? " clickable" : ""}`}
        role={hasContent || hasRaw ? "button" : undefined}
        tabIndex={hasContent || hasRaw ? 0 : undefined}
        aria-expanded={hasContent || hasRaw ? open : undefined}
        onClick={toggle}
        onKeyDown={(e) => { if ((hasContent || hasRaw) && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); toggle() } }}
      >
        <span className="tool-icon">{statusIcon}</span>
        <b title={block.title ?? block.toolCallId}>{block.title ?? block.toolCallId}</b>
        {/* dsh 的 title 即工具名、opencode 的 kind 常与工具名相同 —— 与 title 重复时隐藏 */}
        {block.toolKind && block.toolKind !== block.title && <span className="badge">{block.toolKind}</span>}
        {(hasContent || hasRaw) && (
          <svg
            className="chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
            style={{ transform: open ? "none" : "rotate(-90deg)" }}
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        )}
      </div>
      {/* locations 跟随（P1-13）：agent 报告涉及的具体文件/行 */}
      {!!block.locations?.length && (
        <div className="tool-locations">
          {block.locations.map((l, i) => (
            <span key={i} className="loc-chip" title={l.line ? `${l.path}:${l.line}` : l.path}>
              {l.path}{l.line ? `:${l.line}` : ""}
            </span>
          ))}
        </div>
      )}
      {open && (
        <>
          {diffs.length > 0 && diffs.map((d, i) => <DiffView key={i} c={d} />)}
          {plainText.trim() && <pre className="tool-content">{plainText}</pre>}
          {/* rawInput/rawOutput（§2.4-28）：排障用原始参数视图 */}
          {hasRaw && (
            <div className="tool-raw">
              <button
                type="button"
                className="tool-raw-toggle"
                onClick={(e) => { e.stopPropagation(); setShowRaw((v) => !v) }}
              >
                {t_rawLabel(showRaw)}
              </button>
              {showRaw && (
                <pre className="tool-content">
                  {[
                    block.rawInput !== undefined ? `输入: ${truncateJson(block.rawInput)}` : null,
                    block.rawOutput !== undefined ? `输出: ${truncateJson(block.rawOutput)}` : null,
                  ].filter(Boolean).join("\n")}
                </pre>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function t_rawLabel(show: boolean): string {
  return show ? "收起输入/输出" : "查看输入/输出"
}
