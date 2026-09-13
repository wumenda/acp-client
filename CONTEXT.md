# acp-client

一个本地 ACP（Agent Client Protocol）客户端：以本地 Node server + 浏览器 UI 的形态，通过 stdio JSON-RPC 接入多个实现 ACP 的 agent harness（当前目标：deepseek-harness `dsh --profile acp` 与 opencode `opencode acp`），可自由配置 agent 接入。

## Language

### 接入

**Agent**：
一个被客户端接入的 harness 实例，由一份 Agent 定义描述、以一个 Agent 进程运行。
_Avoid_: server、backend、provider

**Agent 定义**：
`agents.json` 中的一条配置 `{ name, command, args, env, autoStart }`，描述如何启动一个 Agent；`autoStart: true` 时 server 启动即拉起。真相源是配置文件，不是 UI。
_Avoid_: profile（与 dsh 自身的 `--profile` 启动概念冲突）

**内置模板**：
随客户端预置的 Agent 定义（dsh、opencode 各一份），启动命令来自对两个仓库的实测，用户可覆盖 command/args/env。

**认证指引**：
客户端对需要认证的 agent（如 opencode 的 `opencode-login`）的 v1 处理方式：不内嵌终端，展示「请在系统终端运行 `<command>`」的操作卡片，完成后由用户触发重试；`auth_required` 错误同样落到该卡片。

**Agent 进程**：
由 Agent 定义的 command 启动的长驻子进程，与客户端之间是一条 stdio JSON-RPC（ACP）连接；一个进程可承载多个 Session。
_Avoid_: 连接（连接指协议通道本身）

**适配层**：
每个 harness 一个模块，负责抹平两目标在 ACP SDK 版本（1.4.0 vs 0.21.0）、认证方式、权限选项语义、推送类型上的差异，向 UI 暴露统一视图。
_Avoid_: driver、bridge、compat

### 会话

**Session**：
一次 ACP 会话（协议的 `session/new`），绑定一个 cwd，归属某个 Agent 进程；生命周期与持久化由 agent 侧拥有，客户端只保存元数据缓存。
_Avoid_: conversation、chat（chat 仅指 UI 中的会话视图）

**权限请求**：
Agent 在工具执行前发起的 `session/requestPermission` 回调，客户端必须渲染并回传用户选择；选项列表以 agent 下发的为准，客户端不做语义合并。

**会话缓存**：
客户端本地保存的 Session 元数据（id/title/cwd/最近活跃），从 `session/list` 同步，可随时丢弃重建；transcript 的唯一事实源永远在 agent 侧。
_Avoid_: 聊天记录镜像、历史同步

### ACP Registry

**ACP Registry**（P2-21）：
Zed + JetBrains 联合维护的公共 agent 目录。索引端点 `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`，结构 `{ version, agents: [...] }`，上游每小时重建；客户端以 1 小时 TTL stale-while-revalidate + 磁盘缓存（`registry-cache.json`）消费。

**分发形态**：
registry entry 的 `distribution` 三选一 —— `binary`（六平台 map，每平台 `{ archive, sha256, cmd, args?, env? }`，archive 支持 zip/tar.gz/tar.bz2/裸二进制）、`npx`、`uvx`（均 `{ package, args? }`，免下载，运行时依赖用户机器）。平台映射：`win32+x64→windows-x86_64`、`win32+arm64→windows-aarch64`、`darwin/{arm64,x64}`、`linux/{arm64,x64}`；不支持的组合条目 `supported:false`（UI 置灰不阻断列表）。

**安装清单**：
`registry-installs.json`（configDir 下），与用户 `agents.json` 分离、不改写之。binary 安装走 下载→sha256 校验→系统 `tar` 解压（`installed/<id>/`，重装先清空即升级）→ 固化完整 AgentDef 落清单；npx/uvx 安装只写清单（command=`npx`/`uvx`）。启动时 `loadAgentDefs` 按内置→用户→安装项顺序合并（同名跳过 + warn）。安装即 `AgentStore.addAgent`，卸载先 stop 再 `removeAgent`；重启后由清单合并恢复。

**安装进度**：
`registry.progress` 事件 stage 单向推进 `downloading → verifying → extracting → registering → done | error`；目录数据走独立 `registry.snapshot` 事件（与主 snapshot 分离，WS 打开且有缓存时补发）。
