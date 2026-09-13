// src/web/components/SessionView.tsx
import { sendCommand } from "../ws"
import { useFront, setActiveSession, closeSessionTab, saveViewState } from "../state"
import { MessageList } from "./MessageList"
import { Composer } from "./Composer"
import { t } from "../i18n"

export function SessionView() {
  const activeKey = useFront((s) => s.activeKey)
  const openOrder = useFront((s) => s.openOrder)
  const sessions = useFront((s) => s.sessions)
  if (!activeKey) {
    return (
      <main className="main empty">
        <div className="empty-hint">
          <div className="empty-title">{t.emptyTitle}</div>
          <p>{t.emptyHint}</p>
          <div className="empty-keys">
            <span><span className="kbd">Enter</span> {t.emptyKeySend}</span>
            <span><span className="kbd">Shift+Enter</span> {t.emptyKeyNewline}</span>
          </div>
        </div>
      </main>
    )
  }
  const [agentId, sessionId] = activeKey.split(":")
  return (
    <main className="main glass-panel">
      {/* 多会话标签（§2.4-22）：点击本地切换不重放历史；仅内容为空的会话才请求 load */}
      {openOrder.length > 0 && <SessionTabs activeKey={activeKey} openOrder={openOrder} sessions={sessions} />}
      <SessionControls agentId={agentId} sessionId={sessionId} />
      <MessageList agentId={agentId} sessionId={sessionId} />
      <Composer agentId={agentId} sessionId={sessionId} />
    </main>
  )
}

function SessionTabs({ activeKey, openOrder, sessions }: { activeKey: string; openOrder: string[]; sessions: Record<string, Array<{ sessionId: string; title?: string; cwd: string }>> }) {
  const switchTab = (key: string) => {
    const [agentId, sessionId] = key.split(":")
    if (key === activeKey) return
    setActiveSession(agentId, sessionId)
    saveViewState({ openOrder, activeKey: key })
    // 标签切换不做 load（blocks 已在内存）；但刷新恢复进来的其他标签内容为空 → 请求恢复
    if ((useFront.getState().blocks[key] ?? []).length === 0) {
      const cwd = sessions[agentId]?.find((x) => x.sessionId === sessionId)?.cwd
      if (cwd) sendCommand({ type: "session.open", agentId, sessionId, cwd })
    }
  }
  return (
    <div className="session-tabs" role="tablist" aria-label={t.sessionTabs}>
      {openOrder.map((key) => {
        const [agentId, sessionId] = key.split(":")
        const title = sessions[agentId]?.find((x) => x.sessionId === sessionId)?.title ?? sessionId
        return (
          <span key={key} className={`session-tab${key === activeKey ? " is-active" : ""}`}>
            <button role="tab" aria-selected={key === activeKey} title={title} onClick={() => switchTab(key)}>
              <i className={`dot ${useFront.getState().agents[agentId]?.status ?? "stopped"}`} aria-hidden="true" />
              {title}
            </button>
            <button className="tab-close" aria-label={t.closeTab} onClick={() => { closeSessionTab(agentId, sessionId); saveViewState({ openOrder: useFront.getState().openOrder, activeKey: useFront.getState().activeKey }) }}>
              ×
            </button>
          </span>
        )
      })}
    </div>
  )
}

/** 会话控制栏（P1-11）：modes 切换 + configOptions（model / thought level 等）。 */
function SessionControls({ agentId, sessionId }: { agentId: string; sessionId: string }) {
  const ctrl = useFront((s) => s.controls[`${agentId}:${sessionId}`])
  if (!ctrl?.modes && !ctrl?.configOptions?.length) return null
  const setMode = (modeId: string) => sendCommand({ type: "session.set_mode", agentId, sessionId, modeId })
  const setConfig = (configId: string, value: string | boolean) =>
    sendCommand({ type: "session.set_config_option", agentId, sessionId, configId, value })
  return (
    <div className="session-controls">
      {ctrl.modes && ctrl.modes.availableModes.length > 1 && (
        <select
          aria-label={t.sessionMode}
          value={ctrl.modes.currentModeId}
          onChange={(e) => setMode(e.target.value)}
        >
          {ctrl.modes.availableModes.map((m) => (
            <option key={m.id} value={m.id}>{m.name}</option>
          ))}
        </select>
      )}
      {(ctrl.configOptions ?? []).map((o) =>
        o.type === "boolean" ? (
          <label key={o.id} className="config-bool">
            <input type="checkbox" checked={o.currentValue} onChange={(e) => setConfig(o.id, e.target.checked)} />
            {o.name}
          </label>
        ) : (
          <select
            key={o.id}
            aria-label={o.name}
            title={o.name}
            value={o.currentValue}
            onChange={(e) => setConfig(o.id, e.target.value)}
          >
            {o.options.map((v) => (
              <option key={v.value} value={v.value}>{v.name}</option>
            ))}
          </select>
        ),
      )}
    </div>
  )
}
