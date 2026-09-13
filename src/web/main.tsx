// src/web/main.tsx
import { createRoot } from "react-dom/client"
import { App } from "./App"
import "../styles.css"

// 渲染前初始化主题（localStorage 优先，其次跟随系统），避免首帧闪烁
const savedTheme = localStorage.getItem("theme")
const initialTheme = savedTheme ?? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
document.documentElement.dataset.theme = initialTheme

createRoot(document.getElementById("root")!).render(<App />)
