// tests/setup.ts
// ACP SDK 1.4.0 的 Connection.close() 在「主动关闭仍有内部 pending promise」时
// 会以 new Error("ACP connection closed") reject 一个 SDK 内部 promise（dist/jsonrpc.js
// close() 的 pendingResponses 批量 reject 路径），该 promise 无外部句柄，无法在调用侧
// catch（已验证：tsx 独立运行不复现，仅 vitest 并发时序下出现；store.stop 是唯一触发点）。
// 此处注册监听器：1) 防止 vitest 把预期噪音判为 unhandled error 导致退出码 1；
// 2) 保留打印，真实的 unhandled rejection 仍然可见。
process.on("unhandledRejection", (reason) => {
  const msg = (reason as Error)?.message ?? String(reason)
  if (msg === "ACP connection closed") {
    console.warn("[setup] ignored expected ACP close rejection (store.stop)")
    return
  }
  console.error("[setup] unhandledRejection:", reason)
})
export {}
