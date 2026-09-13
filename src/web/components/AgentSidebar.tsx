// src/web/components/AgentSidebar.tsx
import { useEffect, useRef, useState } from "react"
import { sendCommand } from "../ws"
import { t } from "../i18n"
import { useFront } from "../state"

export function AgentSidebar() {
  const agents = useFront((s) => s.agents)
  const sessions = useFront((s) => s.sessions)
  const openOrder = useFront((s) => s.openOrder)
  const busy = useFront((s) => s.busy)
  const [cwd, setCwd] = useState("C:/")
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  // 自动刷新 ①：agent 进入 ready 后拉取一次权威列表。不判断 sessions 是否已有数据：
  // snapshot 的缓存条目（历史建档）可能已与 agent 侧存储脱节，权威 list 负责收敛
  const refreshed = useRef(new Set<string>())
  useEffect(() => {
    for (const a of Object.values(agents)) {
      if (a.status === "ready" && a.listSupported && !refreshed.current.has(a.agentId)) {
        refreshed.current.add(a.agentId)
        sendCommand({ type: "session.list", agentId: a.agentId })
      }
    }
  }, [agents])

  // 自动刷新 ②：新建/恢复会话后刷新一次（拿到 agent 侧的权威列表）
  const openCount = openOrder.length
  useEffect(() => {
    if (openCount === 0) return
    const agentId = openOrder[openCount - 1].split(":")[0]
    const a = agents[agentId]
    if (a?.status === "ready" && a.listSupported) sendCommand({ type: "session.list", agentId })
    // 仅在会话数量变化时触发；agents/sessions 读最新值即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openCount])

  // 自动刷新 ③：prompt 结束（busy 全部清空）后刷新已加载的列表，标题由 agent 生成后可见
  const anyBusy = Object.values(busy).some(Boolean)
  const prevAnyBusy = useRef(false)
  useEffect(() => {
    if (prevAnyBusy.current && !anyBusy) {
      for (const a of Object.values(agents)) {
        if (a.status === "ready" && a.listSupported && sessions[a.agentId] !== undefined) {
          sendCommand({ type: "session.list", agentId: a.agentId })
        }
      }
    }
    prevAnyBusy.current = anyBusy
  }, [anyBusy, agents, sessions])

  return (
    <aside className={`sidebar glass-panel${sidebarCollapsed ? " collapsed" : ""}`}>
      <button
        className="icon-btn sidebar-toggle"
        onClick={() => setSidebarCollapsed((v) => !v)}
        title={sidebarCollapsed ? t.expand : t.collapse}
        aria-label={sidebarCollapsed ? t.expand : t.collapse}
      >
        <svg
          width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          style={{ transform: sidebarCollapsed ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}
        >
          <path d="M15 18l-6-6 6-6" />
        </svg>
      </button>
      {sidebarCollapsed ? (
        <div className="mini-agents">
          {Object.values(agents).map((a) => (
            <span key={a.agentId} className={`dot ${a.status}`} title={`${a.name} · ${t[a.status as keyof typeof t] ?? a.status}`} />
          ))}
          <button
            className="icon-btn registry-mini"
            title={t.registryTitle}
            aria-label={t.registryTitle}
            onClick={() => useFront.setState({ registryOpen: true })}
          >
            +
          </button>
        </div>
      ) : (
        Object.values(agents).map((a) => {
          const isCollapsed = collapsed[a.agentId] ?? false
          return (
            <div key={a.agentId} className={`agent agent-${a.status}`}>
              <div
                className="agent-head clickable"
                role="button"
                tabIndex={0}
                onClick={() => setCollapsed((c) => ({ ...c, [a.agentId]: !isCollapsed }))}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setCollapsed((c) => ({ ...c, [a.agentId]: !isCollapsed })) } }}
              >
                <svg
                  className="chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                  style={{ transform: isCollapsed ? "rotate(-90deg)" : "none" }}
                >
                  <path d="M6 9l6 6 6-6" />
                </svg>
                <span className={`dot ${a.status}`} />
                <b>{a.name}</b>
                {a.mcpServerCount > 0 && (
                  <span className="badge" title={t.mcpServersTitle}>{a.mcpServerCount} MCP</span>
                )}
                <span className="badge">{t[a.status as keyof typeof t] ?? a.status}</span>
              </div>
              {!isCollapsed && (
                <>
                  {(a.status === "stopped" || a.status === "starting") && (
                    <button
                      className="btn-start"
                      disabled={a.status === "starting"}
                      onClick={() => sendCommand({ type: "agent.start", agentId: a.agentId })}
                    >
                      {a.status === "starting" ? <span className="btn-spinner" aria-hidden="true" /> : null}
                      {a.status === "starting" ? t.starting : t.start}
                    </button>
                  )}
                  {a.status === "ready" && <button onClick={() => sendCommand({ type: "agent.stop", agentId: a.agentId })}>{t.stop}</button>}
                  {(a.status === "ready" || a.status === "needs-auth") && (
                    <div className="new-session">
                      <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder={t.cwdPlaceholder} />
                      <button onClick={() => sendCommand({ type: "session.new", agentId: a.agentId, cwd })} disabled={a.status !== "ready"}>
                        {t.newSession}
                      </button>
                      {a.listSupported && (
                        // 不带 cwd：ACP session/list 的 cwd 是过滤条件，传输入框默认值会让列表被按目录过滤而跳变
                        <button onClick={() => sendCommand({ type: "session.list", agentId: a.agentId })}>{t.listSessions}</button>
                      )}
                    </div>
                  )}
                  {a.status === "error" && <div className="err">{a.error}</div>}
                  <SessionList agentId={a.agentId} />
                </>
              )}
            </div>
          )
        })
      )}
      {!sidebarCollapsed && (
        <button className="registry-open" onClick={() => useFront.setState({ registryOpen: true })}>
          {t.registryTitle}
        </button>
      )}
    </aside>
  )
}

function SessionList({ agentId }: { agentId: string }) {
  const sessions = useFront((s) => s.sessions[agentId]) ?? []
  const activeKey = useFront((s) => s.activeKey)
  const deleteSupported = useFront((s) => s.agents[agentId]?.deleteSupported) ?? false
  if (!sessions.length) return null
  return (
    <ul className="session-list">
      {sessions.map((s) => {
        const key = `${agentId}:${s.sessionId}`
        return (
          <li key={s.sessionId} className="session-item">
            <button
              className={activeKey === key ? "is-active" : ""}
              title={s.title ?? s.sessionId}
              onClick={() => sendCommand({ type: "session.open", agentId, sessionId: s.sessionId, cwd: s.cwd })}
            >
              {/* 聊天气泡图标：标识这是可恢复的历史会话 */}
              <svg className="session-ico" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              <span className="session-name">{s.title ?? s.sessionId}</span>
            </button>
            {/* 删除会话（P1-15）：仅当 agent 声明 delete 能力 */}
            {deleteSupported && (
              <button
                className="session-delete icon-btn"
                title={t.deleteSession}
                aria-label={t.deleteSession}
                onClick={() => sendCommand({ type: "session.delete", agentId, sessionId: s.sessionId })}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            )}
          </li>
        )
      })}
    </ul>
  )
}
