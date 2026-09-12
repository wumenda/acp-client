// src/web/i18n.ts
// 中文文案集中此处；键结构为后续 en 预留（共识 Q10）
export const zh = {
  title: "ACP 客户端",
  start: "启动",
  stop: "停止",
  restarting: "已停止，点击启动",
  offline: "Agent 进程已退出",
  error: "出错",
  needsAuth: "需要认证",
  authGuide: "请在你的系统终端运行以下命令完成登录，然后点击重试：",
  retryAuth: "重试",
  newSession: "新建会话",
  cwdPlaceholder: "项目目录的绝对路径",
  listSessions: "会话列表",
  loadUnsupported: "该 agent 不支持会话恢复",
  send: "发送",
  cancel: "停止生成",
  composerPlaceholder: "输入消息，Enter 发送，Shift+Enter 换行",
  permissionTitle: "权限请求",
  permissionFrom: "Agent 请求执行以下操作：",
  unknownUpdate: "未知的更新类型",
  disconnected: "与服务端断开，重连中…",
} as const
export type I18n = typeof zh
export const t = zh
