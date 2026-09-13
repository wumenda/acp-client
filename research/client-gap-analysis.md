# acp-client 与主流 ACP 客户端差距分析

> 日期：2026-09-13。协议事实与竞品事实均出自一手来源调研（见 [acp-ecosystem.md](./acp-ecosystem.md)，下称「调研」），本文只做对标分析与结论。源码引用为 `acp-client/` 相对路径。

## 1. 现状盘点

当前实现（src/server + src/web）：

| 领域 | 已实现 | 说明 |
| --- | --- | --- |
| 传输 | stdio JSON-RPC（SDK 1.4.0），多 agent 子进程管理 | [agent-process.ts](../src/server/agent-process.ts)、[connection.ts](../src/server/connection.ts) |
| 握手 | `initialize`，声明 `clientCapabilities: { auth.terminal }` + `_meta["terminal-auth"]` | 未声明 fs / terminal / elicitation / configOptions（布尔） |
| 会话 | `session/new`、`session/load`、`session/resume`、`session/list`（无分页） | [store.ts](../src/server/store.ts)；`session/close`/`session/delete` 未接 |
| Prompt | `session/prompt`、`session/cancel`、本地用户回显、busy 态 | [app.ts](../src/server/app.ts) |
| 更新渲染 | message/thought chunk 合并、tool_call/update 合并折叠卡 | [state.ts](../src/web/state.ts)；其余 variant 全部落入 `unknown` 块 |
| 权限 | 弹窗应答、Esc 取消、danger 样式 | [PermissionModal.tsx](../src/web/components/PermissionModal.tsx) |
| 认证 | `authenticate` 重试 + 终端指引卡（auth_required 落卡） | v1 设计决策（CONTEXT.md） |
| 持久化 | 会话元数据缓存（原子写 JSON） | [session-cache.ts](../src/server/session-cache.ts)，但**刷新后不下发给前端** |
| 安全 | 127.0.0.1 绑定、query token 鉴权 | token 走 URL query，会进访问日志 |

## 2. 差距矩阵

优先级：**P0** = 正确性缺陷；**P1** = 协议覆盖缺口（主流客户端普遍具备）；**P2** = 体验增强。工作量 S/M/L 为粗估。

### 2.1 正确性缺陷（P0，先修）

| # | 问题 | 依据 | 影响 | 工作量 |
| --- | --- | --- | --- | --- |
| 1 | **取消轮次时挂起权限未应答 `cancelled`**：`store.cancel()` 只发 `session/cancel`，`pending` 中的权限请求无人应答 | 协议要求 cancel 后客户端必须以 cancelled 结局应答所有挂起权限请求，agent 会一直等待（调研 §1.8） | agent 侧挂死直到超时；dsh/opencode 实测会卡住 | S |
| 2 | **未知 `session/update` variant 全部渲染为噪音块**：`plan`、`usage_update`、`session_info_update`、`available_commands_update`、`current_mode_update`、`config_option_update` 都被塞进 `unknown` 消息流 | 这些是协议正式 variant（调研 §1.6），dsh 每轮必发 `usage_update` | 对话流被「未知的更新类型」刷屏；且丢失了本可利用的数据 | S |
| 3 | **浏览器刷新丢失全部会话视图**：WS `onOpen` 只下发 agent snapshot，`blocks`/`activeKey`/`sessions` 不恢复 | session-cache 已有数据但未在 snapshot 中下发 | 刷新 = 回到空态，主流客户端（Zed/agent-shell）均恢复视图 | M |
| 4 | **StopReason 未展示**：`end_turn` 之外的 `max_tokens`、`max_turn_requests`、`refusal`、`cancelled` 被静默吞掉 | 协议要求 refusal 时 UI 需体现该轮不计入下文（调研 §1.5） | 用户不知道回答被截断/被拒 | S |
| 5 | **消息分片合并仅看相邻 kind**：assistant 与 thought 交替时同一条消息被拆成多块；未消费 `messageId` | 协议提供不透明 `messageId` 标识消息边界（调研 §1.5） | 长回答被思考块切碎，渲染碎片化 | M |

### 2.2 协议覆盖缺口（P1）

| # | 能力 | 主流做法 | 本客户端 | 工作量 |
| --- | --- | --- | --- | --- |
| 6 | **Markdown 渲染** | 协议明确 agent_message_chunk 为 Markdown、客户端应按 Markdown 渲染（调研 §1.6）；所有主流客户端均渲染 | 纯文本 `pre`，代码/列表/表格全失真 | M |
| 7 | **token 用量与费用**：消费 `usage_update`（used/size/cost） | Zed/Gemini 系均展示上下文占用 | 未实现，且当前把它当噪音块 | S |
| 8 | **会话动态标题**：`session_info_update` + `session/list` 的 title | agent 生成标题后各客户端实时更新侧栏 | 有自动刷新机制（标题可到），但 `session_info_update` 被丢弃 | S |
| 9 | **plan/todo 渲染**：`plan` update 整表替换，含 priority/status | claude-code-acp TODO、Zed 均渲染任务列表 | 落入 unknown | M |
| 10 | **slash 命令**：`available_commands_update` → 命令面板/补全，执行=并入 prompt | Zed/agent-shell/opencode 标配 | 未实现 | M |
| 11 | **会话模式 / config options**：`availableModes`+`set_mode`，新体系 `configOptions`（category: mode/model/thought_level） | Gemini CLI 用它切审批级别；规范说支持 configOptions 的客户端应忽略 modes | 未实现（plan mode 不可切换） | M |
| 12 | **diff 审阅**：`ToolCallContent::Diff`（path/oldText/newText）渲染编辑审批 | Exo「原生 diff 审批」、claude-code-acp Edit review、Zed 内联 diff | diff 目前落进通用文本兜底（显示 `diff: path`），无实际 diff 视图 | M |
| 13 | **locations 跟随**：tool call 的 `locations[]`（path+line）打开/高亮文件 | claude-code-acp「Following」、Zed 跟随 | 未消费 locations | S |
| 14 | **session/list 分页与过滤**：`cursor`/`nextCursor`、`cwd` 过滤 | 会话多的 agent（opencode）需要 | 只发一次 `cwd: null`，长列表静默截断 | S |
| 15 | **session/close / delete**：会话收尾与清理 | 主流客户端均有关闭会话入口 | 未接，会话只能被遗忘 | S |
| 16 | **mcpServers 转发**：`session/new` 传 MCP server 列表，把客户端侧工具给 agent | Zed/JetBrains 把 IDE 的 MCP 转发（调研 §2） | 恒传 `[]` | M |

### 2.3 客户端侧扩展能力（P1/P2）

| # | 能力 | 说明 | 优先级 |
| --- | --- | --- | --- |
| 17 | **fs 代理**（`fs/read_text_file`/`write_text_file`） | 安全特性：agent 只能经客户端触达允许的文件（Gemini CLI 官方定位，调研 §3.20）。我们不声明则 agent 自行读写，安全边界完全在 agent 侧 | P2（涉及文件选择 UI） |
| 18 | **terminal/**（五方法 + `ToolCallContent::Terminal` 实时输出） | 嵌入式终端卡片；claude-code-acp 支持交互式终端 | P2 |
| 19 | **elicitation**（form/url 结构化输入） | agent 主动索要表单/外链授权；声明能力才可收到 | P2 |
| 20 | **图片/音频输入** | 按 `promptCapabilities.image/audio` 开放上传；agent-shell 支持剪贴板贴图 | P2 |

### 2.4 UX 与工程增强（P2）

| # | 项 | 对标 | 说明 |
| --- | --- | --- | --- |
| 21 | 输入排队 + steering | agent-shell：工作中 prompt 排队、轮末提交；`_session/steering` 扩展可当轮纠偏 | 现在生成中输入框直接禁用 |
| 22 | 多会话并行视图 | Exo/Braide/agent-shell-workspace：多会话标签、worktree 隔离 | 现在 `openOrder` 维护了会话序但 UI 只显示单 active 会话，无标签切换 |
| 23 | 权限记忆（allow_always） | 协议 option kind 含 allow_always/reject_always，客户端按用户设置自动应答 | 现在每次都弹窗 |
| 24 | 权限队列化 UI | agent-shell-permission-transient：多个请求逐个紧凑应答 | 并发多请求时后者覆盖前者视图（state 只存一个 permission） |
| 25 | 完成/需操作通知 | Superlite push notifications | 长任务完成无提醒 |
| 26 | 协议日志面板 | Zed `dev: open acp logs`、JetBrains Get ACP Logs、ACP Inspector | 排障只能看 server stdout |
| 27 | ACP Registry 接入 | Zed/JetBrains 内置 Registry 安装与更新提示 | agent 手工配置 agents.json |
| 28 | rawInput/rawOutput 查看 | 协议提供原始输入输出供客户端展开 | 工具卡未提供「输入参数」视图（排障常用） |
| 29 | ws.ts 重连上限后死掉：10 次退避后放弃，UI 永久断连且无手动重连入口 | — | S |
| 30 | 鉴权硬化：token 在 URL query（进日志/Referer），无 CSP 头 | — | S |

## 3. 结构性观察

1. **适配层是正确的设计**：dsh（SDK 语义、固定 `kind:"other"`、title=工具名）与 opencode 的差异已由 store/connection 吸收，方向与 CONTEXT.md 一致；差距不在架构而在协议覆盖面。
2. **server 是唯一的 ACP 会话面**：浏览器只连 bridge。这意味着 P0-3（刷新恢复）应在 bridge snapshot 中带上 session-cache + openOrder/activeKey 持久化即可解决，无需动 ACP 层。
3. **state reducer 是渲染正确性的关键路径**：P0-2/5 与 P1-7/8/9/11 全部落在 [state.ts](../src/web/state.ts) 的 `reduceSessionUpdate` 一个函数上。建议先把「协议 variant → 处理器」做成显式分派表（识别的进对应状态槽、已知但未实现的**静默忽略**、真正未知才进 unknown），这是一切后续协议工作的地基。
4. **测试资产可直接复用**：fake-agent（[fake-agent.ts](../tests/fake-agent.ts)）加 script 字段即可驱动新 variant（plan/usage/commands/modes）的单测与 e2e，无需真实 agent。

## 4. 建议路线图

| 阶段 | 内容 | 对应项 |
| --- | --- | --- |
| 第 1 步：正确性 | 取消时权限应答 cancelled；unknown 分派表（静默已知 variant）；StopReason 展示；消息分片按 messageId 合并 | P0-1/2/4/5 |
| 第 2 步：看得懂 | Markdown 渲染（含代码高亮）；刷新恢复（snapshot 带 sessions/activeKey）；usage/token 条；动态标题 | P0-3、P1-6/7/8 |
| 第 3 步：控得住 | plan 渲染；modes/configOptions 切换（plan mode）；slash 命令面板；权限 allow_always 记忆 + 队列化 | P1-9/11/10、§2.4-23/24 |
| 第 4 步：专业向 | diff 审阅视图 + locations 跟随；session/list 分页；close/delete；多会话标签；rawInput 查看；ACP 日志面板 | P1-12/13/14/15、§2.4-22/26/28 |
| 第 5 步：生态 | mcpServers 转发；图片/@文件引用；steering/排队；fs/terminal/elicitation；Registry | P1-16、P2 项 |

## 5. 结论

与主流客户端（Zed、JetBrains、agent-shell、Exo 等）相比，本客户端已经把 **ACP 的最小闭环跑通且质量不差**（多 agent、流式、权限、认证指引、折叠流、测试齐全），差距集中在三层：

1. **渲染深度**：Markdown / diff / plan / usage 这些「让输出可读」的能力缺失，是用户感知差距最大的一层；
2. **控制面**：modes、slash 命令、权限记忆、排队输入——「让用户管住 agent」的能力几乎空白；
3. **会话资产**：刷新不恢复、list 不分页、无 close/delete——会话作为一等资产的管理能力薄弱。

其中 P0 五项（尤其取消-权限死等与 unknown 噪音）建议立即处理，均为小改动；第 1–2 步完成后即可达到「可用作日常工具」的水位，第 3–4 步对齐主流编辑器客户端的核心体验。
