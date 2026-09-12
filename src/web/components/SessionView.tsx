// src/web/components/SessionView.tsx
import { useFront } from "../state"
import { MessageList } from "./MessageList"
import { Composer } from "./Composer"

export function SessionView() {
  const activeKey = useFront((s) => s.activeKey)
  if (!activeKey) return <main className="main empty">选择或新建会话</main>
  const [agentId, sessionId] = activeKey.split(":")
  return (
    <main className="main">
      <MessageList agentId={agentId} sessionId={sessionId} />
      <Composer agentId={agentId} sessionId={sessionId} />
    </main>
  )
}
