// src/web/App.tsx
import { useEffect } from "react"
import { connectBridge } from "./ws"
import { useFront } from "./state"
import { AgentSidebar } from "./components/AgentSidebar"
import { SessionView } from "./components/SessionView"
import { PermissionModal } from "./components/PermissionModal"
import { AuthCard } from "./components/AuthCard"
import { t } from "./i18n"

export function App() {
  const apply = useFront((s) => s.apply)
  const connected = useFront((s) => s.connected)
  useEffect(() => connectBridge(apply, (c) => useFront.setState({ connected: c })), [apply])
  return (
    <div className="app">
      {!connected && <div className="banner">{t.disconnected}</div>}
      <AuthCard />
      <div className="layout">
        <AgentSidebar />
        <SessionView />
      </div>
      <PermissionModal />
    </div>
  )
}
