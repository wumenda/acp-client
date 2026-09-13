// src/web/App.tsx
import { useEffect, useRef, useState } from "react"
import { connectBridge, sendCommand } from "./ws"
import { useFront, saveViewState, matchPermissionRule, logBus } from "./state"
import type { BridgeEvent } from "../shared/bridge-protocol"
import { AgentSidebar } from "./components/AgentSidebar"
import { SessionView } from "./components/SessionView"
import { PermissionModal } from "./components/PermissionModal"
import { FsConfirmModal } from "./components/FsConfirmModal"
import { TerminalConfirmModal } from "./components/TerminalConfirmModal"
import { ElicitationModal } from "./components/ElicitationModal"
import { RegistryModal } from "./components/RegistryModal"
import { LogPanel } from "./components/LogPanel"
import { AuthCard } from "./components/AuthCard"
import { t } from "./i18n"

function applyTheme(next: "light" | "dark") {
  document.documentElement.dataset.theme = next
  localStorage.setItem("theme", next)
}

function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    document.documentElement.dataset.theme === "dark" ? "dark" : "light",
  )
  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark"
    // 原生 View Transitions：整页交叉淡化；不支持则即时切换
    const doc = document as Document & { startViewTransition?: (cb: () => void) => void }
    if (doc.startViewTransition) doc.startViewTransition(() => applyTheme(next))
    else applyTheme(next)
    setTheme(next)
  }
  return (
    <button className="icon-btn" onClick={toggle} title={t.themeToggle} aria-label={t.themeToggle}>
      {theme === "dark" ? (
        // 太阳：点击切回浅色
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        // 月亮：点击切到深色
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
      )}
    </button>
  )
}

export function App() {
  const apply = useFront((s) => s.apply)
  const connected = useFront((s) => s.connected)
  const registryOpen = useFront((s) => s.registryOpen)
  const lastError = useFront((s) => s.lastError)
  const [logOpen, setLogOpen] = useState(false)

  // 刷新恢复（P0-3）①：视图态（openOrder/activeKey）变化时写入 localStorage
  useEffect(() => {
    let prev = { openOrder: useFront.getState().openOrder, activeKey: useFront.getState().activeKey }
    return useFront.subscribe((s) => {
      if (s.openOrder === prev.openOrder && s.activeKey === prev.activeKey) return
      prev = { openOrder: s.openOrder, activeKey: s.activeKey }
      saveViewState(s)
    })
  }, [])

  // 刷新恢复（P0-3）②：snapshot 到达后自动重开活跃会话（服务端会先拉起未就绪的 agent）。
  // 同一 key 只恢复一次，避免断线重连后重复 load 重放历史
  const restoredKey = useRef<string | null>(null)
  useEffect(() => {
    const applyOnce = (e: BridgeEvent) => {
      // ACP 线上日志（§2.4-26）：走独立 bus，不入消息流 state
      if (e.type === "acp.log") {
        logBus.emit(e)
        return
      }
      // 权限记忆（§2.4-23）：命中规则的请求直接自动应答，不弹窗不入队
      if (e.type === "permission.request") {
        const optionId = matchPermissionRule(e.agentId, e.toolCall)
        if (optionId !== null) {
          sendCommand({ type: "permission.respond", requestId: e.requestId, optionId })
          return
        }
      }
      apply(e)
      if (e.type !== "snapshot") return
      const { activeKey, openOrder, sessions } = useFront.getState()
      if (!activeKey || !openOrder.includes(activeKey) || restoredKey.current === activeKey) return
      const [agentId, sessionId] = activeKey.split(":")
      const meta = sessions[agentId]?.find((x) => x.sessionId === sessionId)
      if (meta) {
        restoredKey.current = activeKey
        sendCommand({ type: "session.open", agentId, sessionId, cwd: meta.cwd })
      }
    }
    return connectBridge(applyOnce, (c) => useFront.setState({ connected: c }))
  }, [apply])

  return (
    <div className="app">
      <header className="topbar glass-panel">
        <span className="brand-text">{t.title}</span>
        <button className="icon-btn" onClick={() => setLogOpen(true)} title={t.logTitle} aria-label={t.logTitle}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 9l-4 3 4 3M16 9l4 3-4 3M13 5l-2 14" />
          </svg>
        </button>
        <ThemeToggle />
      </header>
      {!connected && <div className="banner">{t.disconnected}</div>}
      {/* 全局操作错误（session.new/open 失败等无会话上下文的错误）：横幅展示，可关闭 */}
      {lastError && (
        <div className="banner banner-error" role="alert">
          <span className="banner-err-text">
            <b>{t.errorBanner}：</b>
            {lastError}
          </span>
          <button
            className="icon-btn banner-close"
            aria-label={t.close}
            title={t.close}
            onClick={() => useFront.setState({ lastError: undefined })}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}
      <AuthCard />
      <div className="layout">
        <AgentSidebar />
        <SessionView />
      </div>
      <PermissionModal />
      <FsConfirmModal />
      <TerminalConfirmModal />
      <ElicitationModal />
      {registryOpen && <RegistryModal onClose={() => useFront.setState({ registryOpen: false })} />}
      {logOpen && <LogPanel onClose={() => setLogOpen(false)} />}
    </div>
  )
}
