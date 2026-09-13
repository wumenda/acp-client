# ACP 生态一手调研：协议全景与主流客户端对比

> 调研日期：2026-09-13。所有事实性论断均标注一手来源 URL；未能核实的内容明确标注"未验证"；无法访问的信息标注"未能获取"。
>
> 说明：ACP 官方文档站已将协议规范重组到 `/protocol/v1/*` 路径下（sitemap 实测，如 https://agentclientprotocol.com/protocol/v1/initialization ）；站点地图中还存在 `/protocol/v2/*` 草案页与公告 `announcements/acp-v2-draft`（2026-07 更新），本报告以 v1 稳定规范为准，v2 仅作前瞻提示。
> 另注：本任务要求调研的 `session/open` 方法在 v1 规范中不存在；对应语义由 `session/load`（重放历史）与 `session/resume`（不重放）两个方法承担，详见下文。

---

## 1. 协议能力全景表

以下能力点均来自 agentclientprotocol.com 的 v1 规范页与 `/protocol/v1/schema`（TypeScript 类型参考页，含每个类型的默认值与约束）。

### 1.1 传输与消息模型

| 能力点 | 协议依据页 | 一句话说明 |
| --- | --- | --- |
| JSON-RPC 2.0 消息模型 | https://agentclientprotocol.com/protocol/v1/overview | 方法（请求-响应）+ 通知（单向）两类消息，全部遵循 JSON-RPC 2.0 |
| stdio 传输（ndjson） | https://agentclientprotocol.com/protocol/v1/transports | 客户端以子进程方式启动 agent，按行分隔的 JSON-RPC over UTF-8 stdio；stderr 可用于日志；stdout 不得输出非 ACP 消息 |
| Streamable HTTP（草案） | https://agentclientprotocol.com/protocol/v1/transports | 第二种传输机制目前是"draft proposal in progress"，未定稿 |
| 自定义传输 | https://agentclientprotocol.com/protocol/v1/transports | 协议与传输无关，允许自定义传输但必须保持 JSON-RPC 消息格式与生命周期要求 |
| 协议级取消 `$/cancel_request` | https://agentclientprotocol.com/protocol/v1/schema | JSON-RPC 层通用取消通知，接收方必须以正常响应或 `-32800` 错误响应原请求 |
| 扩展机制 `_meta` / `_` 前缀方法 | https://agentclientprotocol.com/protocol/v1/extensibility | 所有类型带 `_meta` 字段可挂自定义数据；`_` 前缀方法/通知用于扩展；扩展可通过 `_meta` 在初始化时声明自定义能力；`traceparent/tracestate/baggage` 保留给 W3C trace context |
| 命名约定 | https://agentclientprotocol.com/protocol/v1/overview | JSON 属性键 camelCase，判别字段字符串值 snake_case |
| 路径与行号约定 | https://agentclientprotocol.com/protocol/v1/overview | 所有文件路径必须是绝对路径；行号 1-based |

### 1.2 初始化握手与能力协商（initialize）

| 能力点 | 协议依据页 | 一句话说明 |
| --- | --- | --- |
| `initialize` 三件事 | https://agentclientprotocol.com/protocol/v1/initialization | 协商协议版本、交换双方能力、确定认证方法（authMethods） |
| 版本协商 | https://agentclientprotocol.com/protocol/v1/initialization | 版本是单个整数（仅破坏性变更大版本）；agent 不支持则回以自己最新版本，客户端不支持则应断开连接并告知用户 |
| 客户端能力：`fs.readTextFile` / `fs.writeTextFile` | https://agentclientprotocol.com/protocol/v1/initialization | 声明客户端可向 agent 提供 `fs/read_text_file`、`fs/write_text_file` 两个方法（默认均为 false） |
| 客户端能力：`terminal` | https://agentclientprotocol.com/protocol/v1/initialization | 声明客户端支持全部 `terminal/*` 方法（默认 false） |
| 客户端能力：`auth.terminal` | https://agentclientprotocol.com/protocol/v1/initialization | 客户端能在交互式终端中复现 agent 调用命令时才可置 true，agent 才可发布 `terminal` 型认证方法 |
| 客户端能力：`elicitation` | https://agentclientprotocol.com/protocol/v1/initialization | 声明支持的 elicitation 模式（form/url），omitted/null 均表示不支持；与 MCP 不同，`{}` 不等于支持 form |
| 客户端能力：`session.configOptions.boolean` | https://agentclientprotocol.com/protocol/v1/initialization | 客户端支持布尔型会话配置选项时才可声明，agent 才可在 `configOptions` 中下发 boolean 选项 |
| 客户端能力：`clientInfo` / agent 侧 `agentInfo` | https://agentclientprotocol.com/protocol/v1/initialization | 双方应上报 name/title/version（Implementation 对象）；文档注明未来版本将变为必填 |
| agent 能力：`loadSession` | https://agentclientprotocol.com/protocol/v1/initialization | 是否支持 `session/load`（默认 false） |
| agent 能力：`promptCapabilities`（image/audio/embeddedContext） | https://agentclientprotocol.com/protocol/v1/initialization | 基线只要求支持 Text 与 ResourceLink；图片、音频、内嵌资源（Resource）需逐项声明（默认均 false） |
| agent 能力：`mcpCapabilities`（http/sse） | https://agentclientprotocol.com/protocol/v1/initialization | 支持 MCP 的 HTTP / SSE 传输需声明（stdio 为所有 agent 必须支持）；文档注明 SSE 已被 MCP 规范废弃 |
| agent 能力：`sessionCapabilities` | https://agentclientprotocol.com/protocol/v1/initialization | 基线必须支持 `session/new`、`session/prompt`、`session/cancel`、`session/update`；list/resume/close/delete/additionalDirectories 均为可选能力 |
| agent 能力：`auth.logout` | https://agentclientprotocol.com/protocol/v1/authentication | agent 支持 `logout` 方法时发布；未发布则客户端不得调用 |
| agent 能力：`additionalDirectories` | https://agentclientprotocol.com/protocol/v1/session-setup | 支持 `session/new`、`session/load`、`session/resume` 携带 `additionalDirectories` 扩大会话文件系统根集合（`cwd` 仍是相对路径基准） |

### 1.3 认证（authenticate / authMethods / logout）

| 能力点 | 协议依据页 | 一句话说明 |
| --- | --- | --- |
| `authMethods` 两种类型 | https://agentclientprotocol.com/protocol/v1/authentication | `agent` 型（默认）：agent 自己处理认证，客户端凭 methodId 调 `authenticate`；`terminal` 型：客户端在交互式终端里重新运行 agent 启动命令让用户登录，退出码 0 视为成功，之后重连并重新 initialize；terminal 型不得传给 `authenticate` |
| `auth_required` 错误 | https://agentclientprotocol.com/protocol/v1/schema | 预定义错误码之一；`session/new` 可能返回它以要求先认证 |
| `authenticate` | https://agentclientprotocol.com/protocol/v1/authentication | 传入 initialize 响应中声明的 methodId，成功后即可建会话 |
| `logout` | https://agentclientprotocol.com/protocol/v1/authentication | 结束当前认证态；对已运行会话的行为协议不作保证，客户端应准备好会话操作返回认证类错误 |
| 错误码全集（schema） | https://agentclientprotocol.com/protocol/v1/schema | JSON-RPC 标准码 + `-32800` Request cancelled + Authentication required + Resource not found 等 ACP 预留码 |

### 1.4 会话生命周期（new / load / resume / list / delete / close）

| 能力点 | 协议依据页 | 一句话说明 |
| --- | --- | --- |
| `session/new` | https://agentclientprotocol.com/protocol/v1/session-setup | 传 `cwd`（必须绝对路径）+ `mcpServers` 列表；agent 返回唯一 sessionId，并可在响应中带初始 modes 与 configOptions |
| `mcpServers` 三种传输 | https://agentclientprotocol.com/protocol/v1/session-setup | stdio（必须支持：command/args/env）、http、sse（后两者按 mcpCapabilities 声明）；客户端也可以把自己的 MCP server 塞进来，从而给模型提供客户端侧工具 |
| `session/load`（重放式恢复） | https://agentclientprotocol.com/protocol/v1/session-setup | 需要 `loadSession` 能力；agent 必须把整段会话历史以 `session/update` 通知流式重放给客户端（与 prompt 流一致），重放完才应答原请求；重放消息可带不透明的 `messageId` |
| `session/resume`（无重放恢复） | https://agentclientprotocol.com/protocol/v1/session-setup | 需要 `sessionCapabilities.resume` 能力；恢复上下文但不重放历史，适合支持续聊但不实现完整 load 的 agent |
| `session/list` | https://agentclientprotocol.com/protocol/v1/schema | 需要 `sessionCapabilities.list`；支持 `cwd` 过滤与 cursor 分页（`nextCursor`）；返回 `SessionInfo`（sessionId、cwd、可选 title、可选 ISO 8601 最后活动时间、可选 additionalDirectories） |
| `session/delete` | https://agentclientprotocol.com/protocol/v1/schema | 需要 `sessionCapabilities.delete`；从 `session/list` 中删除会话 |
| `session/close` | https://agentclientprotocol.com/protocol/v1/session-setup | 需要 `sessionCapabilities.close`；agent 必须先取消该会话进行中的工作（等同 session/cancel）再释放资源 |
| `additionalDirectories` 语义 | https://agentclientprotocol.com/protocol/v1/session-setup | load/resume 时必须重发完整列表；省略或空数组不等于"恢复上次列表"；会话有效根集合 = `[cwd, ...additionalDirectories]`，应作为工具文件操作的边界 |

### 1.5 Prompt 轮次（session/prompt / cancel / StopReason）

| 能力点 | 协议依据页 | 一句话说明 |
| --- | --- | --- |
| `session/prompt` 生命周期 | https://agentclientprotocol.com/protocol/v1/prompt-turn | 用户消息 → agent 处理 → 经 `session/update` 上报输出 → （可选）权限请求 → 工具执行与状态上报 → 循环直到返回 StopReason |
| 内容块基线与按需能力 | https://agentclientprotocol.com/protocol/v1/prompt-turn | 客户端必须按 PromptCapabilities 限制发送的内容类型；优先用 `Resource` 内嵌上下文（省一次往返），否则用 `ResourceLink` |
| StopReason 全集 | https://agentclientprotocol.com/protocol/v1/prompt-turn | `end_turn`（正常结束）、`max_tokens`、`max_turn_requests`（单轮模型请求次数上限）、`refusal`（拒绝继续，UI 需体现该轮不计入下文）、`cancelled` |
| `session/cancel` 语义 | https://agentclientprotocol.com/protocol/v1/prompt-turn | 客户端发出后应立即把未完成 tool call 标记为 cancelled、必须以 cancelled 结局应答所有挂起的权限请求；agent 应尽快停掉模型请求与工具调用，并在应答前发完剩余 update；最终必须返回 `cancelled` stop reason |
| 消息分片 `messageId` | https://agentclientprotocol.com/protocol/v1/prompt-turn | agent 可在 chunk 上带不透明且唯一的 `messageId`；相同 id 属于同一条消息，变化即新消息开始 |

### 1.6 session/update 全部 variant

来源统一为 schema 页 `SessionUpdate` 联合类型：https://agentclientprotocol.com/protocol/v1/schema （`prompt-turn` 页亦叙事性覆盖部分 variant：https://agentclientprotocol.com/protocol/v1/prompt-turn ）

| variant | 协议依据页 | 一句话说明 |
| --- | --- | --- |
| `user_message_chunk` | https://agentclientprotocol.com/protocol/v1/schema | 用户消息的流式分片（load 重放等场景） |
| `agent_message_chunk` | https://agentclientprotocol.com/protocol/v1/schema | agent 回复的流式分片（Markdown，客户端应按 Markdown 渲染） |
| `agent_thought_chunk` | https://agentclientprotocol.com/protocol/v1/schema | agent 内部思考的流式分片（思考折叠的协议依据） |
| `tool_call` | https://agentclientprotocol.com/protocol/v1/tool-calls | 新工具调用：title、kind、status、content[]、locations[]、rawInput、rawOutput |
| `tool_call_update` | https://agentclientprotocol.com/protocol/v1/tool-calls | 增量更新：除 `toolCallId` 外全部可选，只发改动字段（含替换 content/locations、更新 rawInput/rawOutput/status/title/kind） |
| `plan` | https://agentclientprotocol.com/protocol/v1/agent-plan | 执行计划：entries[]，每次更新必须发送完整列表，客户端整体替换 |
| `available_commands_update` | https://agentclientprotocol.com/protocol/v1/slash-commands | 斜杠命令列表就绪或变化；可在会话任意时刻再次发送实现动态增删 |
| `current_mode_update` | https://agentclientprotocol.com/protocol/v1/session-modes | agent 自主切换模式后通知客户端当前模式 id |
| `config_option_update` | https://agentclientprotocol.com/protocol/v1/session-config-options | agent 侧更改会话配置选项（切模式、限流换模型等）后推送完整配置状态 |
| `session_info_update` | https://agentclientprotocol.com/protocol/v1/schema | 会话元数据更新：title、最后活动时间（可置 null 清除），供客户端展示动态会话名 |
| `usage_update` | https://agentclientprotocol.com/protocol/v1/prompt-turn | 上下文用量：`used`/`size`（必填 token 数）+ 可选 `cost`（amount + ISO 4217 货币码），供 token 用量/进度展示 |

### 1.7 工具调用（tool_call 卡片全部字段）

| 能力点 | 协议依据页 | 一句话说明 |
| --- | --- | --- |
| ToolKind 九类 | https://agentclientprotocol.com/protocol/v1/tool-calls | `read`/`edit`/`delete`/`move`/`search`/`execute`/`think`/`fetch`/`other`，用于客户端选图标与展示方式 |
| ToolCallStatus 四态 | https://agentclientprotocol.com/protocol/v1/tool-calls | `pending`（未开始：输入还在流式或等审批）、`in_progress`、`completed`、`failed` |
| 内容之一：常规 ContentBlock | https://agentclientprotocol.com/protocol/v1/tool-calls | 文本/图片/资源等标准内容块 |
| 内容之二：Diff | https://agentclientprotocol.com/protocol/v1/tool-calls | `{path, oldText(新文件为 null), newText}`，文件修改以 diff 呈现 |
| 内容之三：Terminal | https://agentclientprotocol.com/protocol/v1/tool-calls | 引用 `terminal/create` 返回的 terminalId，客户端展示实时输出，release 后仍可继续展示 |
| locations（跟随 agent） | https://agentclientprotocol.com/protocol/v1/tool-calls | `{path, line?}`，支撑客户端"跟随 agent 打开/高亮文件"的特性 |
| rawInput / rawOutput | https://agentclientprotocol.com/protocol/v1/tool-calls | 工具的原始输入参数与原始输出（object），供客户端自行展开/格式化 |

### 1.8 权限请求（session/request_permission）

| 能力点 | 协议依据页 | 一句话说明 |
| --- | --- | --- |
| PermissionOptionKind 全集 | https://agentclientprotocol.com/protocol/v1/tool-calls | 四种 hint：`allow_once`、`allow_always`（记住选择）、`reject_once`、`reject_always`；另有 `cancelled` 结局（非 kind） |
| 请求与响应 | https://agentclientprotocol.com/protocol/v1/tool-calls | 请求携带 sessionId + ToolCallUpdate（工具详情）+ options[]；响应为 `selected{optionId}` 或 `cancelled` |
| 客户端自动处理 | https://agentclientprotocol.com/protocol/v1/tool-calls | 客户端可按用户设置自动 allow/reject 权限请求（"remember"类 kind 的落地方式） |
| 取消时的义务 | https://agentclientprotocol.com/protocol/v1/prompt-turn | 发出 `session/cancel` 后，客户端必须对所有挂起权限请求回应 `cancelled` 结局 |

### 1.9 会话模式（session modes）与配置选项（config options）

| 能力点 | 协议依据页 | 一句话说明 |
| --- | --- | --- |
| `SessionModeState` | https://agentclientprotocol.com/protocol/v1/session-modes | `availableModes[]`（id/name/description）+ `currentModeId`，会话建立时返回 |
| `session/set_mode` | https://agentclientprotocol.com/protocol/v1/session-modes | 客户端任意时刻（含生成中）切换模式，值必须来自 availableModes |
| agent 侧自主切换 | https://agentclientprotocol.com/protocol/v1/session-modes | 典型场景：plan/architect 模式下给模型一个"退出模式"工具，模型调用后 agent 切回 code 并发 `current_mode_update` |
| config options（新模式体系） | https://agentclientprotocol.com/protocol/v1/session-config-options | `select`（默认支持）/`boolean`（需客户端声明）两类控件；带 `category` 语义标签：`mode`/`model`/`model_config`/`thought_level`，供客户端统一 UX（图标、快捷键、摆放） |
| 排序与默认值 | https://agentclientprotocol.com/protocol/v1/session-config-options | 数组顺序即 agent 建议优先级；agent 必须为每个选项提供默认值，客户端遇到未知 type 应忽略 |
| `session/set_config_option` | https://agentclientprotocol.com/protocol/v1/session-config-options | 客户端任意时刻改值；agent 必须以完整配置状态应答 |
| 过渡兼容 | https://agentclientprotocol.com/protocol/v1/session-config-options | configOptions 取代旧的 session modes API；过渡期 agent 应同时下发两者，支持 configOptions 的客户端应忽略 modes |

### 1.10 斜杠命令（slash commands）

| 能力点 | 协议依据页 | 一句话说明 |
| --- | --- | --- |
| 命令通告 | https://agentclientprotocol.com/protocol/v1/slash-commands | 会话建立后 agent 经 `available_commands_update` 发送：name、description、可选 input（目前为非结构化文本 + 输入提示 hint） |
| 动态更新 | https://agentclientprotocol.com/protocol/v1/slash-commands | 会话中可随时重发实现命令增删改 |
| 执行方式 | https://agentclientprotocol.com/protocol/v1/slash-commands | 命令就是普通 prompt 文本的一部分（客户端把命令文本放进 prompt 数组），可与图片等内容同发 |

### 1.11 客户端侧扩展能力（fs / terminal / elicitation）

| 能力点 | 协议依据页 | 一句话说明 |
| --- | --- | --- |
| `fs/read_text_file` | https://agentclientprotocol.com/protocol/v1/file-system | 支持按行号（1-based）与最大行数读取，可读到编辑器未保存状态 |
| `fs/write_text_file` | https://agentclientprotocol.com/protocol/v1/file-system | 写入/更新文件，文件不存在时客户端必须创建 |
| `terminal/*` 五方法 | https://agentclientprotocol.com/protocol/v1/schema | `terminal/create`（command/args/cwd/env/outputByteLimit 截断上限）、`terminal/output`（含 truncated 标志与退出状态）、`terminal/wait_for_exit`、`terminal/kill`（保留 TerminalId）、`terminal/release`（释放，嵌入的 tool call 仍可展示输出） |
| `elicitation/create` | https://agentclientprotocol.com/protocol/v1/elicitation | agent 请求结构化输入：form 模式（受限 JSON Schema，禁止用于索要密钥）或 URL 模式（敏感/OAuth 类外链交互）；响应 accept/decline/cancel |
| `elicitation/complete` | https://agentclientprotocol.com/protocol/v1/elicitation | URL 模式外带交互完成后 agent 回发通知（携带原 elicitationId），客户端必须忽略未知 id |
| URL 模式安全要求 | https://agentclientprotocol.com/protocol/v1/elicitation | 展示完整 URL 并征得同意、不得预取、高亮域名、在隔离的安全上下文打开、form 模式不得回退替代 URL 模式等 |

---

## 2. 主流客户端对比表

> 客户端全景清单见官方 Clients 页（本节表格的兜底来源，下文简称"官方 Clients 页"）：https://agentclientprotocol.com/get-started/clients

| 客户端 | 仓库或官网 | 实现要点 | 特色 UX | 来源 URL |
| --- | --- | --- | --- | --- |
| **Zed** | https://github.com/zed-industries/zed | 通过 ACP 承载 External Agent 线程（Agent Panel + Threads Sidebar）；支持 ACP Registry 一键安装（`zed: acp registry`）与自定义 agent（`agent_servers` 配置 command/args/env）；Zed 配置的 MCP server 可经 ACP 转发给 agent；外部 agent 自管运行时、认证与计费，Zed 不收费 | 多 agent 共存与新线程菜单、按键绑定 `agent::NewExternalAgentThread`；可从已配置 agent **导入既有线程**进 Thread History（经 ACP 拉取会话，去重、归档、可恢复）；`dev: open acp logs` 查看协议日志。注：官方文档页未展开 diff 内联预览与权限 UI 细节，其存在性未在本次一手页面中验证 | https://zed.dev/docs/ai/external-agents （另见仓库 https://github.com/zed-industries/zed ，ACP 实现位于 crates 内，本次未逐 crate 核实） |
| **claude-code-acp（现 agentclientprotocol/claude-agent-acp）** | https://github.com/zed-industries/claude-code-acp （README 显示项目已迁至 agentclientprotocol 组织，npm 包 `@agentclientprotocol/claude-agent-acp`） | **agent 侧适配器**（Claude Agent SDK → ACP），非客户端；供任何 ACP 客户端接入 Claude | 支持上下文 @-mentions、图片、带权限请求的 tool call、Following（文件跟随）、Edit review、TODO 列表、嵌套子代理 transcript、交互式与后台终端、自定义斜杠命令、客户端 MCP server 转发；另有多个 `_meta` 扩展：goal（会话级长期目标）、session failure（结构化错误/恢复）、recommended config values、permission extension；子代理会话需双向能力协商（`clientCapabilities.subagents` 草案字段或 `_meta.jetbrains.air.capabilities.nativeSubagentSessions`） | https://github.com/zed-industries/claude-code-acp |
| **Gemini CLI（ACP 模式）** | https://github.com/google-gemini/gemini-cli | `gemini --acp` 进入 ACP 模式（JSON-RPC over stdio，CLI 为服务端）；支持方法：initialize、authenticate、newSession、loadSession、prompt、cancel、setSessionMode（切换工具审批级别，如 auto-approve）、unstable_setSessionModel；**文件系统代理**：agent 读写文件走 ACP 客户端，确保只能访问用户允许的文件 | 客户端可将自身 MCP server 在 initialize 握手时注册给 Gemini CLI，把 IDE 能力变成模型工具；调试：`gemini --acp --debug` + `GEMINI_TELEMETRY_*` 环境变量落盘 JSON 日志。注：旧资料提及 `--experimental-acp` 标志（当前官方文档为 `--acp`；旧标志未验证）；核心实现在 `packages/cli/src/acp/`（本次未逐文件核实） | https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md |
| **opencode** | https://opencode.ai （ACP 文档 https://opencode.ai/docs/acp/） | `opencode acp` 以 ACP 兼容子进程运行，stdio 上的 JSON-RPC；给出 Zed / JetBrains（acp.json）/ Avante.nvim（acp_providers）/ CodeCompanion.nvim 四种编辑器接入配置 | 与终端使用完全同权：内置工具（文件操作、终端命令）、自定义工具与斜杠命令、opencode 配置的 MCP server、`AGENTS.md` 项目规则、自定义 formatter/linter、代理与权限系统全部可用 | https://opencode.ai/docs/acp/ |
| **JetBrains AI Assistant** | https://www.jetbrains.com/help/ai-assistant/acp.html | AI Chat 中接入外部 ACP agent：Registry 安装（IDE 自动下载 agent 文件、必要时自动下载管理 Node.js/Python 运行时）或 `~/.jetbrains/acp.json` 自定义（command/args/env + `default_mcp_settings`）；无需 JetBrains AI 订阅 | 可选择性向 agent 转发用户配置的 MCP server 与 IntelliJ 内置 MCP server（可用 `idea_mcp_allowed_tools` 限流）；Registry agent 首次使用时弹认证流程；agent 有新版时列表出现蓝点可更新；`Get ACP Logs` 导出日志 + `llm.agent.extended.logging` 开关记录完整请求响应（提示含敏感信息）；**不支持 WSL**（官方明示） | https://www.jetbrains.com/help/ai-assistant/acp.html |
| **agent-shell（Emacs）** | https://github.com/xenodium/agent-shell （MELPA 包） | 原生 Emacs shell 对接任意 ACP agent（Claude Agent、Codex、Gemini CLI、Goose、Grok、Cursor CLI、Kimi、Kiro、Qwen Code、OpenCode 等十余种，每种有独立启动命令） | 剪贴板图片粘贴与截图发送（按平台依赖外部工具）；**排队输入 + steering**：agent 工作中发送的 prompt 默认排队、轮次结束提交，支持 steering 的 agent（Claude/Codex 适配器，经 `_session/steering` ACP 扩展在初始化时声明）可在当轮即时纠偏；容器内运行（devcontainer command prefix）；周边生态包：多会话工作区（agent-shell-workspace）、会话队列、权限请求 Transient 紧凑应答（agent-shell-permission-transient）、书签、transcript 搜索恢复、按项目管理的 HUD | https://github.com/xenodium/agent-shell |
| **Neovim 插件（4 个，官方 Clients 页收录）** | CodeCompanion https://github.com/olimorris/codecompanion.nvim ；agentic.nvim https://github.com/carlos-algms/agentic.nvim ；avante.nvim https://github.com/yetone/avante.nvim ；hermes.nvim https://github.com/Ruddickmg/hermes.nvim | 均以插件形式在 Neovim 内实现 ACP 客户端；CodeCompanion 以"adapter"概念接入（可将 opencode 等设为聊天 ACP adapter）；avante.nvim 以 `acp_providers` 配置接入（可传环境变量） | 各插件细节本次未逐一深入（未验证），接入配置样例可见 opencode 官方文档 | https://agentclientprotocol.com/get-started/clients ；https://opencode.ai/docs/acp/ |
| **VS Code 系扩展** | vscode-acp https://github.com/formulahendry/vscode-acp ；ACP Patchbay https://github.com/solutionsunity/acp-patchbay ；ACP Pro（含 Cursor/Windsurf/Trae 等 VS Code 兼容 IDE 的 open-vsx 版）；Multicoder；Exo for VS Code | 形态为编辑器扩展；Exo 主打"排版优先"的客户端：并行会话隔离在 Git worktree、原生 Diff 编辑器审批 | Exo 的 worktree 并行会话与原生 diff 审批是官方 Clients 页明确记载的特色 UX；其余扩展细节本次未逐一核实（未验证） | https://agentclientprotocol.com/get-started/clients |
| **桌面/Web/移动/消息桥等（节选）** | AionUi https://github.com/iOfficeAI/AionUi ；DeepChat https://github.com/ThinkInAIXYZ/deepchat ；Braide https://braide.dev/ ；Superlite https://superlite.dev/ ；Obsidian 插件（Agent Console https://github.com/donivatamazondotcom/obsidian-agent-console 、Obsidian Harness https://github.com/vlln/obsidian-harness 等）；Happy https://github.com/slopus/happy ；Runmote https://github.com/Raza-learner/Runmote ；各 Telegram/Discord/Slack/QQ/微信/飞书桥 | 覆盖桌面、浏览器、手机与 IM 渠道；多数为"多 agent + 多会话"形态 | 有代表性的卖点（均摘自官方 Clients 页一句话简介）：Braide 并行会话/worktree/人设；Superlite 并行会话 + 浏览器远程 + **推送通知**；Obsidian Agent Console 标签页多会话（可恢复、可搜索）；Obsidian Harness 每个会话落成一等 `.session` vault 文件（Session/Turn 导航器）；Runmote 二维码/8 位配对码从手机操控 PC 上的 agent；Happy 覆盖 iOS/Android/Web | https://agentclientprotocol.com/get-started/clients |

补充说明：

- **ACP Agent Registry**（客户端安装分发的公共基础设施）：策展式 agent 目录，只收录支持认证的 agent；客户端可编程拉取 registry JSON（含分发/安装元数据）；agent 通过向 https://github.com/agentclientprotocol/registry 提 PR（`agent.json` + 可选 `icon.svg`）上架。来源：https://agentclientprotocol.com/get-started/registry
- **codex-acp 适配器**：Codex CLI 的 ACP 适配器（agentclientprotocol 组织维护），agent-shell README 与多个第三方接入指南均引用（`@zed-industries/codex-acp` / agentclientprotocol 组织路径）；本次未直接抓取其 README，细节未验证。来源：https://github.com/xenodium/agent-shell
- Zed 的 ACP 客户端实现代码位于 zed 仓库 crates 目录（agent_client_protocol / acp_thread / agent_ui 等命名未逐一核实，本次仅确认仓库结构与官方文档）；来源：https://github.com/zed-industries/zed

---

## 3. 客户端侧增强实践清单

按"自研最小客户端可对标"的视角整理，每条注明来源。

1. **会话标题与元数据动态展示**：订阅 `session_info_update`（title 可置 null 清除）与 `session/list` 返回的 `SessionInfo.title`/`updatedAt`，实现动态会话名与历史列表。来源：https://agentclientprotocol.com/protocol/v1/schema
2. **会话历史持久化两条路线**：`session/load`（整段历史以 session/update 重放，重放消息带不透明 `messageId`）适合完整恢复 UI；`session/resume`（不重放）适合轻量续聊；两者分别需要 `loadSession` 与 `sessionCapabilities.resume` 能力检查。Zed 额外做了"从 agent 导入线程"（经 ACP 拉取既有会话并入本地历史，去重、跳过无 cwd 会话）。来源：https://agentclientprotocol.com/protocol/v1/session-setup ；https://zed.dev/docs/ai/external-agents
3. **token 用量展示**：消费 `usage_update`（used/size 必填，cost 可选且带 ISO 4217 货币码）渲染上下文占用进度条与累计费用。来源：https://agentclientprotocol.com/protocol/v1/prompt-turn
4. **plan/todo 渲染**：`plan` update 每次都是完整列表、客户端整体替换；条目含 priority（high/medium/low）与 status（pending/in_progress/completed），可渲染为带优先级标记的任务列表。来源：https://agentclientprotocol.com/protocol/v1/agent-plan
5. **slash 命令面板**：用 `available_commands_update` 构建命令面板/自动补全（含输入 hint），并处理会话中途的动态增删；命令执行只是把命令文本并入 prompt。来源：https://agentclientprotocol.com/protocol/v1/slash-commands
6. **@文件引用**：优先以 `ContentBlock::Resource` 内嵌文件内容（需 agent 的 `embeddedContext` 能力，省往返、可包含 agent 无权访问的来源），否则用 `ResourceLink`；官方文档明确以此支持 @-mentions 场景。来源：https://agentclientprotocol.com/protocol/v1/content ；https://agentclientprotocol.com/protocol/v1/prompt-turn
7. **图片/附件输入**：按 agent 的 `promptCapabilities.image/audio` 决定是否开放图片/音频上传；实践上 agent-shell 支持剪贴板贴图与截图发送。来源：https://agentclientprotocol.com/protocol/v1/initialization ；https://github.com/xenodium/agent-shell
8. **模式切换 UI（plan mode 等）**：渲染 `availableModes` + `currentModeId`，任意时刻可调 `session/set_mode`（含生成中）；同时监听 agent 侧 `current_mode_update`（plan 模式经"退出模式工具"自主切换是官方文档点名的模式）。新体系下应优先渲染 `configOptions`（category 为 mode/model/thought_level 等）并忽略 modes。来源：https://agentclientprotocol.com/protocol/v1/session-modes ；https://agentclientprotocol.com/protocol/v1/session-config-options
9. **diff 审阅流**：用 `ToolCallContent::Diff`（path/oldText/newText，新文件 oldText 为 null）渲染编辑审批；实践上 Exo for VS Code 以"原生 Diff 编辑器审批"为卖点、claude-code-acp 提供 Edit review。另有未定稿 RFD 探讨 diff 删除态（`rfds/diff-delete`，仅确认该 RFD 页存在于站点地图，内容未获取）。来源：https://agentclientprotocol.com/protocol/v1/tool-calls ；https://agentclientprotocol.com/get-started/clients ；https://github.com/zed-industries/claude-code-acp ；https://agentclientprotocol.com/rfds/diff-delete
10. **权限弹窗细节**：四类 option kind（allow_once/allow_always/reject_once/reject_always）决定图标与文案；支持"按用户设置自动放行/拒绝"；发出 cancel 后必须把挂起请求应答为 cancelled。来源：https://agentclientprotocol.com/protocol/v1/tool-calls ；https://agentclientprotocol.com/protocol/v1/prompt-turn
11. **权限请求队列化 UI**：agent-shell 生态的 agent-shell-permission-transient 把排队的权限请求做成紧凑 Transient 界面逐个应答。来源：https://github.com/xenodium/agent-shell
12. **输入排队与 steering**：agent 工作中收到的新 prompt 先排队、轮末提交；若 agent 声明 `_session/steering` 扩展则当轮注入纠偏（Claude/Codex 适配器已实现）。来源：https://github.com/xenodium/agent-shell
13. **跟随 agent 打开文件（follow-along）**：消费 tool call 的 `locations[]`（path + line）实时打开/高亮 agent 正在操作的文件。来源：https://agentclientprotocol.com/protocol/v1/tool-calls
14. **终端嵌入展示**：客户端声明 `terminal` 能力后，agent 创建的终端可经 `ToolCallContent::Terminal` 嵌入工具卡片实时展示输出，release 后仍可查看；`outputByteLimit` 控制截断。来源：https://agentclientprotocol.com/protocol/v1/schema ；https://agentclientprotocol.com/protocol/v1/tool-calls
15. **子代理/嵌套会话展示**：claude-code-acp 支持嵌套子代理 transcript，需客户端在能力协商中声明（草案字段 `clientCapabilities.subagents` 或 `_meta.jetbrains.air.capabilities.nativeSubagentSessions`）。来源：https://github.com/zed-industries/claude-code-acp
16. **多 agent 并发管理**：常见形态是"多 agent + 多会话 + worktree 隔离"（Exo、Braide、GitKraken Kepler、Obsidian Agent Console、agent-shell-workspace/HQ 等，均见官方 Clients 页简介）；JetBrains 侧由管理员策略控制可用 agent 集合。来源：https://agentclientprotocol.com/get-started/clients ；https://www.jetbrains.com/help/ai-assistant/acp.html
17. **agent 安装分发**：接入 ACP Registry（编程拉取 registry JSON，含安装元数据），Zed/JetBrains 已内置"从 Registry 安装 + 版本更新提示"。来源：https://agentclientprotocol.com/get-started/registry ；https://zed.dev/docs/ai/external-agents ；https://www.jetbrains.com/help/ai-assistant/acp.html
18. **通知**：桌面客户端 Superlite 提供 push notifications（官方 Clients 页简介级信息，实现细节未验证）。来源：https://agentclientprotocol.com/get-started/clients
19. **协议日志/调试面板**：Zed `dev: open acp logs`、JetBrains Get ACP Logs + extended logging 开关、ACP Inspector（桌面调试器，官方 Clients 页收录）、Gemini CLI 侧 `--debug` 与遥测落盘。来源：https://zed.dev/docs/ai/external-agents ；https://www.jetbrains.com/help/ai-assistant/acp.html ；https://agentclientprotocol.com/get-started/clients ；https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md
20. **客户端文件系统代理（安全设计）**：客户端声明 fs 能力后，agent 经 `fs/*` 读写文件且只能触及客户端允许的范围——Gemini CLI 官方文档将其明确定位为安全特性。来源：https://agentclientprotocol.com/protocol/v1/file-system ；https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md

---

## 4. 来源清单

### ACP 官方文档（agentclientprotocol.com）

1. 协议总览（消息模型/约定/扩展入口）：https://agentclientprotocol.com/protocol/v1/overview
2. 传输（stdio ndjson / Streamable HTTP 草案 / 自定义传输）：https://agentclientprotocol.com/protocol/v1/transports
3. 初始化与能力协商：https://agentclientprotocol.com/protocol/v1/initialization
4. 认证（authMethods/terminal 认证/logout）：https://agentclientprotocol.com/protocol/v1/authentication
5. 会话建立（new/load/resume/close/additionalDirectories/mcpServers）：https://agentclientprotocol.com/protocol/v1/session-setup
6. 会话列表：https://agentclientprotocol.com/protocol/v1/session-list （本次未单独抓取正文，方法细节以 schema 页为准）
7. 会话删除：https://agentclientprotocol.com/protocol/v1/session-delete （同上）
8. Prompt 轮次（生命周期/StopReason/取消/messageId/usage_update）：https://agentclientprotocol.com/protocol/v1/prompt-turn
9. 取消（协议级 `$/cancel_request`）：https://agentclientprotocol.com/protocol/v1/cancellation （页面路径取自 schema 引用，本次以 prompt-turn 与 schema 为准）
10. 工具调用（kind/status/content/permission/locations）：https://agentclientprotocol.com/protocol/v1/tool-calls
11. 执行计划（plan）：https://agentclientprotocol.com/protocol/v1/agent-plan
12. 会话模式：https://agentclientprotocol.com/protocol/v1/session-modes
13. 会话配置选项（config options）：https://agentclientprotocol.com/protocol/v1/session-config-options
14. 斜杠命令：https://agentclientprotocol.com/protocol/v1/slash-commands
15. 内容块：https://agentclientprotocol.com/protocol/v1/content
16. 文件系统：https://agentclientprotocol.com/protocol/v1/file-system
17. 终端：https://agentclientprotocol.com/protocol/v1/terminals （方法细节以 schema 页为准）
18. Elicitation：https://agentclientprotocol.com/protocol/v1/elicitation
19. 扩展机制：https://agentclientprotocol.com/protocol/v1/extensibility
20. Schema 类型参考（全部方法/类型/默认值/错误码）：https://agentclientprotocol.com/protocol/v1/schema
21. 客户端清单：https://agentclientprotocol.com/get-started/clients
22. Agent Registry：https://agentclientprotocol.com/get-started/registry ；Registry 仓库：https://github.com/agentclientprotocol/registry
23. v2 草案入口（未深入）：https://agentclientprotocol.com/protocol/v2/overview ；公告：https://agentclientprotocol.com/announcements/acp-v2-draft
24. RFD 目录（含 diff-delete、session-fork、session-compaction、end-turn-token-usage 等，本次未展开）：https://agentclientprotocol.com/rfds/updates

### 客户端/适配器一手来源

25. Zed External Agents 文档：https://zed.dev/docs/ai/external-agents
26. Zed 仓库：https://github.com/zed-industries/zed
27. claude-code-acp（agentclientprotocol/claude-agent-acp）：https://github.com/zed-industries/claude-code-acp
28. Gemini CLI ACP 模式文档：https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md
29. Gemini CLI 仓库：https://github.com/google-gemini/gemini-cli
30. opencode ACP 文档：https://opencode.ai/docs/acp/
31. JetBrains AI Assistant ACP 文档：https://www.jetbrains.com/help/ai-assistant/acp.html
32. agent-shell（Emacs）：https://github.com/xenodium/agent-shell
33. Neovim 插件：https://github.com/olimorris/codecompanion.nvim ；https://github.com/yetone/avante.nvim ；https://github.com/carlos-algms/agentic.nvim ；https://github.com/Ruddickmg/hermes.nvim
34. 其他社区客户端（均来自官方 Clients 页收录条目，详见第 2 节表格）：https://agentclientprotocol.com/get-started/clients

### 未验证 / 未能获取事项汇总

- Zed 的 diff 内联预览、权限 UI 具体形态：官方 ACP 文档页未展开，未验证。
- Zed 仓库内 ACP 相关 crate（agent_client_protocol 等）逐一核实：未能获取（仅确认仓库结构）。
- `--experimental-acp` 旧标志与 `packages/cli/src/acp/` 模块级细节（@-mention 解析、token 用量聚合、斜杠命令拦截）：来自第三方转述，未验证；以 Gemini CLI 官方 `docs/cli/acp-mode.md` 为准。
- codex-acp 适配器 README：本次未抓取，未验证。
- Neovim 四个插件各自的功能细节、VS Code 各扩展细节、桌面/移动客户端细节：仅见官方 Clients 页一句话简介，未验证。
- 各 RFD（diff-delete、session-fork、session-compaction、end-turn-token-usage 等）正文：仅确认页面存在于站点地图，内容未能获取。
- `session/list`、`session/delete`、`terminals`、`cancellation` 四页正文：本次未单独抓取，其结论均以 schema 页与相关页引用为准。
