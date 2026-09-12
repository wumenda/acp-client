// src/web/components/ToolCallCard.tsx
import type { Block } from "../state"

const STATUS_ICON: Record<string, string> = { pending: "…", in_progress: "⏳", completed: "✔", failed: "✘" }

export function ToolCallCard({ block }: { block: Extract<Block, { kind: "tool" }> }) {
  const statusIcon = STATUS_ICON[block.status ?? "pending"] ?? "·"
  return (
    <div className={`tool tool-${block.status ?? "pending"}`}>
      <div className="tool-head">
        <span>{statusIcon}</span>
        <b>{block.title ?? block.toolCallId}</b>
        {block.toolKind && <span className="badge">{block.toolKind}</span>}
      </div>
      {Array.isArray(block.content) && (
        <pre className="tool-content">{JSON.stringify(block.content, null, 2)}</pre>
      )}
    </div>
  )
}
