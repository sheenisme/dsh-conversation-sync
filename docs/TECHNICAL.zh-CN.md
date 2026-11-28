# 会话同步 —— 技术说明

> 英文原文：[TECHNICAL.md](TECHNICAL.md)。

## 两个核心特性

- **双向同步。** 一个绑定把机器侧的外部会话（一个 JSONL 文件、一个 DeepSeek 导出 ZIP、……）
  与一个或多个 DSH 会话以及一个 `direction` 关联起来：`in`（外部 → DSH）、`out`（DSH → 外部）
  或 `both`。宿主轮询每个绑定，只按启用的方向搬运新记录，并给写入的内容打标记，
  以免把它回传。
- **Remote-SSH 作为平级机器。** 宿主在启动时（以及每 30 秒）读取本地
  `~/.ssh/config`。本机始终是机器 `local`；每一个 SSH `Host` 段都成为一台机器
  （`ssh:<pattern>`）；**每个 ProxyJump 目标也各自成为一台机器**
  （`isJump: true`）。经由跳板机到达的机器带有一条 `via[]`
  链，SSH 传输层通过 `forwardOut()` 把连接串起来——每一跳都用自己的私钥认证。
  仅含通配符的主机和 `Include` 指令会被跳过并给出警告（不展开配置语义就无法把它们
  解析成具体主机）。

## 支持的来源

| 类型 | 典型位置 | 说明 |
| --- | --- | --- |
| `claude` | `~/.claude/projects/<slug>/<sessionId>.jsonl` | 一个文件 = 一个会话；`user`/`assistant` 消息、工具调用/结果、思考块。`api-request-blob` 重复项和 sidechain/subagent 轮次会被跳过。工具调用变成真正的 `tool/call` → `tool/result` 事件，通过 `callId` 配对。 |
| `codex` | `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<threadId>.jsonl` | 按顶层 `ordinal` 排序；导入推理、function/`custom_tool_call` 及其输出、agent 消息。 |
| `workbuddy` | `~/.workbuddy/projects/**`, `~/.workbuddy-ai/projects/**`, `~/.codebuddy/projects/**` | 行类型有 `message`（内容块 `input_text`/`output_text`）、`reasoning`、`function_call` 和 `function_call_result`。调用通过 **`callId`**（而不是行 `id`）与结果关联。带有 `skipRun`/`isMeta`/`isCompactInternal`/`isCompacted` 标记的行会被跳过。 |
| `trae` | `~/.trae/cli/**`, `~/.trae-cn/cli/**` | Codex 形态的 rollout 加上 `event_msg`/`user_message`。每个用户轮次都会**写两遍**（真实事件 + 请求回显）；读取时回显会被丢弃，即使两者落在不同的读取批次里。`history_mutation` 中 `operation: replace` 会重放先前历史，因此会被跳过。 |
| `antigravity` | `~/.gemini/antigravity{,-cli,-ide}/brain/<uuid>/.system_generated/logs/transcript.jsonl` | `USER_EXPLICIT`/`USER_INPUT` 与 `MODEL`/`PLANNER_RESPONSE` 行是对话内容；`MODEL`/`GENERIC` 是 harness 的步骤日志，`SYSTEM`/`SYSTEM_MESSAGE` 和 `CHECKPOINT` 是噪声——全部跳过。用户文本会从 `<USER_REQUEST>` 和 `<ADDITIONAL_METADATA>` 中解包出来。 |
| `opencode` | `~/.local/share/opencode/opencode.db` (also `$XDG_DATA_HOME`) | SQLite。现代（`session`/`session_message`）和旧版（`session_v2`/`message`/`part`）两种 schema 都会读取，按表是否存在来选择。数据库会连同 `-wal`/`-shm` 一起复制到临时目录并以只读方式打开，因此运行中的 OpenCode 永远不会被争用。**只导入**——从插件写入活跃的 SQLite 并不安全。 |
| `jsonl` | 任意路径 | 每行需要 `role`（`user`/`assistant`/`tool`/`system`）以及 `content` 或 `text`。时间戳可以是 ISO 字符串或 epoch 数字。 |
| `deepseekExport` | DeepSeek 网页导出 ZIP | 需要 `manifest.json` 中包含 `export_format_version: 3`；读取 `chat_session_index.json` 和 `chat_sessions/<id>.json`；每个会话对应一个 DSH 会话。**只导入**——压缩包是不可变的。 |

发现模块（`lib/discovery.js`）在每台机器上扫描
`~/.claude/projects`（深度 3）、`~/.codex/sessions`（深度 4）、
`~/.workbuddy/projects` 和 `~/.workbuddy-ai/projects` 以及
`~/.codebuddy/projects`（深度 3）、`~/.trae/cli` 和 `~/.trae-cn/cli`
（深度 4）、三个 Antigravity `brain` 根目录（深度 4），以及
`~/.dsh-conversation-sync/exports`（深度 2），上限 5000 个条目。
OpenCode 数据库单独探测（它是文件而不是目录树），且只在本机探测。工具根目录
不存在是正常的，会静默跳过；真正的读取失败则按机器分别报告。每个发现的会话
都带有 id、类型、名称、预览、消息数和字节大小，并显示在界面右侧栏中对应机器上。

对 SSH 机器，私钥按固定顺序解析，因此一台在终端里已经能连通的主机通常完全
不需要配置：

1. 为该机器保存为 DSH 凭据的**路径**
   （`conversation-sync/ssh-key/<machineId>`，通过界面上的
   `Set key path` 按钮设置）；
2. 主机自身在 `~/.ssh/config` 里的 `IdentityFile`；
3. 常规的 `~/.ssh/id_ed25519`、`id_ecdsa`、`id_rsa`，取第一个存在的。

只保存路径；密钥内容从不进入插件配置，文件在连接时才读取。`via[]` 链中的每一跳
都按同样的规则解析自己的密钥。当三者都不适用时，错误会点名机器并列出这些选项，
而不是报告缺少凭据引用。如果路径存在但无法读取，错误会点名密钥文件——以前错误的路径
会显示为 `cannot resolve home: ENOENT … /home/me/.ssh/…`，指向的是远端 home 目录
而不是本地密钥。

## 同步模型

**外部 → DSH（`in`）。** 对 JSONL 来源，字节偏移游标只读取新增字节；末尾不完整的行会
缓冲到完整为止。缩小或轮转过的文件会从偏移 0 重新开始。记录按自身身份以及本插件写入
行上的 `dshSyncId` 标记去重。新记录以 DSH v4 事件追加，只使用已知的事件类型
（`turn/start`、`step/start`、`system/message`、`user/message`、`assistant/message`、
`tool/call`、`tool/result`、`step/end`、`turn/end`、`session/title`），序列号连续、
时间戳单调递增。导入的会话通过 `sessionPersistence.create()` 物化，并挂到唯一的
`会话同步` 工作区 `~/.dsh/conversation-sync/workspaces/sync`。是一个工作区，而不是
每台机器一个：`dsh-workspace` 的 `attachSession()` 只有在会话的 `cwd` 恰好解析为
工作区路径时才不会抛错，而 `candidateMatches` 也按同样的相等性过滤，所以按机器分目录
就必须各自成为一个工作区。机器改为通过会话标题前缀来区分
（`BAAI-Ascend · <title>`；本地会话保留裸标题）。活跃会话通过 `Session.append()` 追加，
这样 agent 循环才能看到它们。

v4 格式很严格，其中两条规则很容易出错，而且只有在回读日志时才会显现：

- `tool/result` 必须是一等公民的 **`role: 'tool'`** 消息，其 `toolCallId` 等于
  `source.callId`，内容为纯文本。旧的形状（`role: 'user'` 包一个 `{type: 'tool-result'}`
  块）会被拒绝，报 *"requires a tool-role message"*。
- 每个 `tool/call` 都必须先在前面的 `assistant/message` 中作为 `{type: 'tool-call'}`
  块**声明**，且 `id`/`name`/`arguments` 相同。否则日志解析失败，报 *"has no advertised tool lifecycle"*，
  整个会话会被读成损坏的。

一轮中的多条 assistant 记录（例如先推理后回答，或工具结果之后的回答）在同一个轮次内
各自拥有自己的 `step/start`…`step/end` 对；把它们合并成一个 step 会丢掉第一条之后的
所有消息。

**DSH → 外部（`out`）。** 已绑定 DSH 会话上的新事件按 DSH 序列号读取——不只是消息：
`tool/call` 与 `tool/result` 也会读出来（见 `lib/dsh-sessions.js` 的
`readDshSessionExchanges`），这样一对工具调用能完整跨过去。随后每种工具从
`lib/native.js` 得到它自己的原生行格式，带上 `dshSyncId` 标记，通过该机器的传输层追加
到外部文件。每会话的序列水位线可防止重复。

为什么要单独一套写出器，而不是复用适配器的渲染器：一行扁平的
`{"role":"user","content":"…"}` **我们的**解析器读得懂，但那个工具读不懂。Claude Code
需要 `parentUuid` 链、`cwd`、带模型名的助手消息以及 `tool_use`/`tool_result` 块；Codex
需要一个 `session_meta` 头部，以及追加时保持递增的 `ordinal`。CI 的 `native` 场景会导出
一个会话再导入回来并断言消息条数不变，所以连真实工具都会拒绝的形状会让构建失败。
逐工具的字段规则见 [FORMATS.zh-CN.md](FORMATS.zh-CN.md)。DeepSeek 导出 ZIP
和 OpenCode 都是只导入的；向其中任何一个导出都会被明确报错拒绝，而不是静默地什么都不做。
未知的 DSH 会话 id 会失败并提示 *"DSH session … does not exist; re-select it on the left"*
——以前它会返回 `written: 0`，就好像导出成功了一样。

**`both`** 在一个绑定中同时运行两个方向。`dshSyncId` 标记加上 DSH 序列水位线可防止无限回传。

**自动同步。** 一个全局 2 秒轮询 tick 会运行每个已启用且 `pollMs` 间隔已到的绑定；
`session/event` 会把受影响的绑定标为脏，以便立即处理。另一个 30 秒 tick 负责刷新机器发现。
插件停用时会释放轮询与发现的定时器，以及所有 SFTP 连接。

## 自动回滚 / 失败诊断

在任何外部写入之前，`SyncRollback.begin()` 会把外部文件复制到
`~/.dsh/conversation-sync/backups/` 下带时间戳的备份中，并记录 DSH 序列水位线。
如果任何步骤失败，`SyncRollback.fail()` 会：

1. 从该备份还原外部文件（针对 `out`/`both` 方向），
2. 给出可读的 `reason` 以及用户在重试前必须满足的 `conditions` 列表
   （例如修复 SSH 密钥权限、检查主机可达性、让路径可写、腾出磁盘空间、
   提供有效的 DeepSeek 导出、修复 DSH 会话），
3. 把失败、备份路径和清理提示存入绑定状态，并在界面中原地渲染出来。

DSH 侧**绝不**通过直接操作文件来修改。如果失败前事件已经追加进了 DSH，报告会指示用户
通过 DSH 界面删除它们（第三方插件不得截断其他组件的会话日志）。

> **警告——回写会修改活跃文件。** 导出会把行追加到原工具活跃的会话文件里。每次写入前
> 都会备份，失败时会还原，但仍可能发生数据丢失。对不能承受丢失的来源，请自行备份，
> 并关闭 `out`/`both` 方向。

## 存储与生命周期

- 绑定、游标、DSH 序列水位线、上次同步状态和失败报告存放在 DSH 存储域
  `conversation_sync`（JSON 后端，版本 1）中，表为 `bindings` 和 `states`。
- 机器列表、发现的会话和密钥路径引用保存在内存中，并由发现 tick 刷新；密钥路径是
  持久化的 DSH 凭据。
- SSH 走系统 `ssh` 二进制，而不是捆绑的 SSH 库。这不是偏好问题：`ssh2` 带有原生构建脚本，
  除非 *profile* 通过 `allowBuilds` 显式选择加入（而插件无法提出这个要求），否则 pnpm
  拒绝安装带未批准构建脚本的依赖。把它声明为可选 peer 意味着干净安装后根本没有 SSH，
  每台远程机器都会以 `Cannot find package 'ssh2'` 失败。改用 `ssh` 去掉了原生依赖，
  并继承用户真实的 `~/.ssh/config`：`ProxyJump`、`IdentityFile`、`Include`、`Match` 块、
  agent 转发和 `known_hosts` 的行为都与用户在终端里完全一致。如果 `ssh` 不可用，
  旧的 `ssh2` 路径仍作为后备保留。
- 认证分三步解析密钥：为本机器保存的路径，然后是主机自身在 `~/.ssh/config` 中的
  `IdentityFile`，再到常规的 `~/.ssh/id_ed25519` / `id_ecdsa` / `id_rsa`。已保存但不再
  存在的路径会回退到后面的步骤并记录警告，而不是让机器失败，因为密钥被移走以前意味着
  「完全没有会话」且没有任何提示。`.pub` 路径表示「使用 agent」。
- 连不上的机器只报告一次。传输层会记住连接级失败（认证、拒绝、DNS、主机密钥、超时），
  该传输层上的后续命令都会立即失败，因为发现流程会先取远端 home 目录、再取每个工具根目录：
  没有这个机制，一台宕掉的主机要付出四次完整连接尝试，并产生四份相同的错误。用真实的、
  含不可达主机的 `~/.ssh/config` 实测，每台机器的扫描时间从 70-112s 降到约 5s。
- 一次扫描用一个 `find` 向每个根目录索取整棵树，并用一个 `wc`/`stat`/`head` 取每个文件的
  大小、行数和开头字节。这在隧道上很重要：第一版每次往返只列出一个目录，并按 256 KB
  分块读取最多 8 MB 来数行，对于一台有 55 个 rollout 的主机，这相当于大约 1900 次往返——
  扫描永远跑不完。现在同一台主机约 20 秒就能完成。
- 主机密钥由 `ssh` 自身通过用户的 `known_hosts` 检查，此外还会记录到插件数据目录的
  `known_hosts.json` 中，供 `ssh2` 后备路径使用。默认 `hostKeyMode` 是 `accept-new`：
  首次见到的服务器会被信任并记录（trust on first use），而*发生变化的*密钥会被拒绝——
  这正是关键的情形，因为一台你已经在同步的机器上的主机密钥变化，意味着机器被重建或遭到
  中间人攻击。设为 `verify` 可连未知服务器一并拒绝，设为 `off` 则跳过检查。这里刻意不静默：
  拒绝会通过常规的失败诊断报告出来，并说明该怎么处理。
- 每个绑定跟踪两个游标，而且它们是不同的数字。`dshSeqs` 记录 DSH 会话已经写到哪里
  （导入游标）；`outSeqs` 记录其中有多少已经被复制到外部文件（导出游标）。共用一张
  map 曾是一个真实的 bug：导入一段对话会把共享游标推到末尾，于是之后第一次导出会认为
  没有新内容，写出一个空文件。
- 连接按机器池化：发现每 30 秒运行一次，每次同步轮询也需要同一台主机，所以没有连接池时
  每个 tick 都会为每一跳新建 TCP 连接、密钥交换和认证。池化连接只有在调用于链路层失败时
  （SFTP 通道死掉、socket 断开）才丢弃；像「那个文件不存在」这样的普通错误会保持连接，
  因为重连会每个 tick 浪费一次握手。插件卸载时会关闭连接池，因此重新加载不会泄漏 socket。
- system-ssh 传输层为每台机器保持一条多路复用的主连接
  （`ControlMaster`/`ControlPersist`），而不是每次调用一条 SFTP 通道，因此扫描多个根目录
  只需一次握手，而不是每条命令一次。
- 创建目录时逐级遍历路径，而不是使用 `fs.mkdir(..., {recursive: true})`。在 Linux 上，
  当文件系统对一个已存在的父目录返回 ENOENT 时（`/proc` 就会这样），递归 mkdir 可能
  无限循环，导致整个同步挂起且没有错误；逐级遍历会把它变成正常的报告失败。每个本地
  文件系统调用也有 30 秒上限，因此卡死的挂载不会无限期拖住轮询循环。
- HTTP 路由 `/api/conversation-sync/rpc`（POST）暴露 `status`、`machines`、`sessions`、
  `bindings`、`setKey`、`pair`、`unbind`、`sync`。和所有 DSH Web 路由一样，它仅限所有者
  访问。在存储打开之前它返回 `503 not ready`；面板把它当作加载状态，因为把它渲染成
  「没有会话」会让面板刚打开的头几秒看起来是空的。

## 为什么凭据名称是生成的，而不是派生的

保存的 SSH 密钥路径位于 DSH 凭据库中，通过一个引用名称寻址。该库强制
`REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/`，并在加载时校验整个 YAML 文件——
不符合该语法的名称会在启动时变成 `TypeError`，而不是警告。

机器 id 并不是合法的标识符：`ssh:BAAI-Ascend` 带有冒号和连字符。早期版本通过拼接来
构造引用，`conversation-sync/ssh-key/${machine.id}`，于是保存密钥路径会把
`conversation-sync/ssh-key/ssh:BAAI-Ascend` 写进 `~/.dsh/.credentials.yaml`，
导致 DSH 再也无法启动。插件自己也修不了：它根本没机会运行。

现在引用是生成的：

```js
keyRefFor('ssh:BAAI-Ascend') // conversation_sync_ssh_key_ssh_BAAI_Ascend_1e701114
```

语法之外的每个字符都会变成 `_`，原始 id 的截断 SHA-1 可防止两个归一化后相同的 id
（`ssh:A-B` 与 `ssh:A_B`）共用同一份凭据。`isValidKeyRef()` 守卫每一次读写，因此
不符合语法的名称会被当作「没有保存任何内容」，而不是抛错。

`keys` CI 场景断言的是 YAML 文件而不是 RPC 回复，因为只有到下一次进程启动才被拒绝的
名称，单元测试是看不见的。1.0.5 及更早的构建会写出这样的名称；这些版本从未发布到 npm，
因此任何已发布版本都不可能产生这样的名称。

## Testing

`npm test` 运行 225 个单元测试（`node:test`，不需要网络也不需要 DSH）。每种工具格式在
`test/fixtures/` 里都有一个 fixture，会被推过真实的流水线——
`readJsonlDelta` → `buildEvents` → `messagesFromEvents`——因此断言针对的是导入后的对话
内容，而不是内部结构。`test/dsh-sessions.test.js` 固定了列表契约（一行的 `count` 是消息数，
绝不是原始事件数）以及导出所需的 `strict` 读取。`test/openssh.test.js` 通过在 PATH 上放置
一个替身 `ssh` 来驱动 system-ssh 传输层，于是命令构造、shell 引号处理、退出码映射以及
「只失败一次，而不是每个根目录失败一次」的缓存都能在没有服务器的情况下被覆盖。
`test/client.test.js` 通过桩模块加载器加载 `client.js`，让浏览器那一半也可测：当某个 service
被使用却不在 `inject` 中时（这是一个真实的 bug——没有 `sessions`，侧边栏永远不知道刚导入
的会话）、当 `settings.section` 条目未注册时、或当某个 `en`/`zh` 键发生漂移时，测试都会失败。
`test/native.test.js` 覆盖 `lib/native.js` 里的写出器：它断言每种工具要求的信封（Claude Code
需要 `parentUuid` 链和 `cwd`，Codex 需要 `session_meta` 与递增的 `ordinal`）、追加时继续
编号而不是重复使用，以及工具结果绝不会变成用户消息。CI 的 `native` 场景把闭环补上：导出一个
会话再导入回来，于是连真实工具都会拒绝的形状会让构建失败。

`scripts/ci/` 存放 harness 级别的检查，正是它们能抓住单元测试 fixture 抓不到的格式 bug：

| 脚本 | 用途 |
| --- | --- |
| `install-dsh.mjs` | 安装一个 DSH 版本，使其能在纯 Node 下真正运行——它从 registry 读取 `@deepseek-ai/dsh-app-boot` 的 peer 范围，因为 npm 不会安装传递依赖的 peer |
| `harness.mjs` | 共享的 profile 引导、健康行等待、激活检查与 auth-cookie 握手 |
| `boot-check.mjs` | 「这个 DSH 版本是否支持插件」：安装、启动、导入、回读 |
| `scenario.mjs` | `import`、`export`、`native`、`formats`、`failure`、`empty`、`reimport`、`direction`、`keys`、`ssh`、`safety`、`placements`、`bindings`——在真实 RPC 接口上走完用户旅程 |

`.github/workflows/ci.yml` 运行三个 job：

| 任务 | 证明了什么 |
| --- | --- |
| `unit` | 纯模块行为正常，覆盖最旧的支持版本 Node (24.9.0) 和最新的 24.x |
| `compatibility` | 插件在**最近五个 DSH 版本**上都能激活并导入对话 |
| `functional` | 在两个最新版本上走用户旅程：导入、导出、全部五种工具格式、失败报告、不重复重新导入、显式同步方向被遵守、SSH 密钥解析顺序，以及通过 SSH 传输层完成一次完整的发现与导入 |

只有 `boot-check` 退出 0，一个版本才算受支持，这要求既没有 bundle 激活失败，也确实有
对话落进了 DSH 会话。版本列表在运行时由 `scripts/ci/recent-versions.mjs` 解析，而不是
写死在 workflow 里，因此矩阵不会悄悄腐烂；上游真正损坏的版本会连同原因列在该脚本的
`BROKEN` map 中，并表现为 CI 警告而不是红灯 job。

在本地对任意已安装的 DSH 运行 harness：

```bash
node scripts/ci/install-dsh.mjs --version 0.2.2-rc.5 --dir /tmp/dsh
node scripts/ci/boot-check.mjs --dsh /tmp/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js \
  --tarball "$(npm pack --silent)" --home /tmp/dsh-home
```

harness 需要 `pnpm` 在 `PATH` 上（`dsh plugin add` 会调用它），并且需要绝对的 tarball 路径——
`dsh plugin add` 会先切换到 profile 目录，因此相对路径会被当作 registry 包名来解析。

### 发布

`.github/workflows/publish.yml` 在 `v*` tag 上运行，除非 tag 等于 `package.json` 的版本且
tarball 包含插件运行时需要的文件，否则拒绝发布，然后用 **npm Trusted Publishing (OIDC)**
发布——没有长期有效的 token。npm 会验证 workflow 的 OIDC 身份，并为该版本附上
provenance 声明。

这需要一次性手动设置：该包的 npm 设置页面需要一条 *Trusted Publisher* 记录，指向本仓库和
这个 workflow 文件。没有它，发布步骤会在认证时失败。

带有「Bypass 2FA」的细粒度 token 已被刻意弃用。npm 正在弃用用于直接发布的 2FA 绕过
token，而没有该标志的 token 认证正常，随后会以 `EOTP` 加上一个 CI 里没人能打开的浏览器
URL 告终——第一次打 tag 的发布正是如此。

### 只有 harness 才能发现的问题

这个插件里有几个缺陷对单元测试不可见，因为它们存在于 RPC 接口与模块之间的接线处，
而不是某个模块内部：

- `tool/result` 按已废弃的 V3 形状写出——每个含工具调用的对话都导入失败；
- `tool/call` 没有在前面的 `assistant/message` 中声明——会话日志随后回读为损坏；
- `syncAll` 丢掉了它的方向参数——点击导出却执行了导入；
- 导出游标与导入游标共用一张 map——第一次导出写出空文件却报告成功；
- 没有记录的导入物化出了一个只有标题的会话——已压缩的 rollout 看起来导入成功，
  却什么也不显示。

`empty` 场景固定了最后一个问题：它导入一个真实的已压缩 Codex rollout，断言导入被拒绝
并给出原因、没有创建会话，且列表里没有留下死绑定。

`direction` 场景专为 `syncAll` 和游标缺陷而存在。它把一个存储为 `in` 的绑定用显式 `out`
同步，并断言文件收到了内容；只有在这个层面上该 bug 才可观察。

`bindings` 场景覆盖绑定契约，这些都是单元测试触及不到的：新绑定是手动的
（`autoSync === false`）且被勾选，列表会报告哪一侧更新，取消勾选会把该绑定从批量运行中
移除（证据是它的 `lastSyncAt`，因为配对本身就执行了第一次同步），重新勾选会把它放回去并
写入一个非空文件，而方向 `auto` 在没有任何变化时什么都不做，但一旦来源被追加就会导入。

## 标题是对话的一部分

DSH 的会话头部没有标题字段：`dsh-session-title` 折叠的是日志中最后一条 `session/title`
事件（`events.findLast(item => item.type ===
'session/title')`），因此改过两次名的会话显示的是第二个名字，而只读头部会看到过期的名字。
所以 `listDshSessions()` 读取最新的标题事件，`readDshSessionTitle()` 为导出路径返回相同的值。

另一个方向上，标题作为 `dshTitle` 字段随导出的行一起走。`titleFromLine()` 在解析任何 JSON
之前先检查这个标记——一次扫描会从完全不知道 DSH 标题的工具里读取成千上万行——而
`readJsonlDelta()` 会把它找到的第一个标题附到返回的每条记录上，因此即使会话是新建的，
导入也能恢复名称。

「标题属于对话」这条原则引出两条规则：

* 没有随行标题的导入会以第一条用户消息命名，绝不以文件路径命名。绑定的 `name` 默认是
  外部路径，直接把它传下去会让每个导入的会话都以文件名命名——第一个端到端断言抓到了它
  （`the session is still named after its path`）。
* 一行的 `name`（工具自己的 id）保留作绑定键，但只作为小字次要信息显示。读者看到的是
  标题，因为 UUID 和 rollout 时间戳无法区分两段对话。

## 三行也可以是对话

Codex 会把几种 rollout 写进 `~/.codex/sessions`。它们靠 `session_meta.payload.thread_source`
区分：

- `user` —— 一个人发起的对话。
- `guardian_review` —— 对另一个线程的自动评审。
- `subagent` —— 由另一个会话派生的 worker。

在开发所用的机器上，40 个可读 rollout 中有 18 个是 `user`；其余都是自动生成的。只有勾选
**automated threads** 时面板才会列出这些自动线程，因为「我自己的会话去哪了」是一个被
报告过的问题，而答案是「它们在那里，只是和 22 个评审混在一起」。

被摘要过的线程恰好只剩三行：`session_meta`、一个负载为
`{"type":"compaction","encrypted_content":"…"}` 的 `response_item`，以及
`event_msg/thread_settings_applied`。压缩正文是加密的，所以没有东西可导入。
`scanLines()` 对这些行报告 `importable: false`，面板把它们渲染成灰暗且不可选，
机器标题会打印出它们的数量。在此之前，它们看起来和普通行一样，选中一个后只会在点击之后
报 `sync failed: … has no importable messages`。

`compacted` **不是**「我们看见了压缩标记」，而是 `importable === false`。用标记作判据
看起来精确，实际上是错的：Codex 的 `session_meta` 一行就有约 19 KB，8 KB 的头部窗口
结束在**这一行内部**，永远到不了那条 compaction 负载。于是开关是关的，压缩存根却还留在
屏幕上。空才是诚实的信号——含有真实消息的线程永远不会是空的——标记只作旁证。
`test/discovery.test.js` 用 40 KB 的 `session_meta` 把这个情形固定了下来。

构建过程中发现两个坑，如今都已写进测试：

1. **大小不是证据。** 第一版根据「读了多少字节」判断 `importable`：窗口在文件末尾之前
   结束，就认为「里面一定还有对话」，于是大文件被当作对话、小文件不被当作对话。拿真实
   数据一量，这条规则恰好是反的——30 个 Claude 会话里有 15 个被隐藏（其中四个是小文件但
   含有完整一轮问答，十三个在 150 KB 左右），而所有超过 624 KB 的文件仅凭体积就被列出。
   现在扫描会问该工具自己的适配器：读到的字节里有没有消息或工具调用；如果答案是没有，
   就读一个尾部窗口再放弃。一个文件是对话，是因为它**装着**什么，而不是因为它有多大。
2. **坐在用户位置上的人不是用户。** Codex 会把 `<environment_context>`、
   `# AGENTS.md instructions`、`<external_ide_context>` 以及它自己的多 agent 简介作为
   `role: "user"` 消息注入。从这些消息取标题时，每一行都读成
   `<environment_context> <cwd>/Users/…`。`isInjectedText()` 会跳过它们；标题应该是人真正
   打出的第一句话。

归档的线程会移到 `~/.codex/archived_sessions`，不再位于 `sessions/` 下。该目录也会被扫描——
否则归档一段对话会让它从列表里消失，即使文件完好无损。

## 闲置的面板不应该有成本

面板打开时会轮询，而每一次轮询过去都会为每个绑定向宿主询问「哪一侧更新」。每次比较都是一次
跨该绑定传输的 `stat`，在 SSH 上就是一次网络往返——于是留在后台标签页里的面板会每五秒钟
拨一次每台远端机器，永远如此，只为了回答一个没人正在看的问题。改动有三处：

- 用 `document.hidden` 控制定时器。隐藏的标签页不做任何事，重新可见时立刻刷新一次，用户
  回来时面板不会是过期的。
- 比较结果缓存两秒，并按 Promise 去重，所以两个同时在飞的轮询共享一次 `stat` 而不是叠加。
  同步成功或失败都会清掉对应条目，因为此时两侧都刚刚变动，缓存答案按定义就是错的。
- 每次 `load()` 取一个世代号。一次慢轮询如果用户在按下按钮之后才返回，就会把它那份更旧的
  快照写到更新的快照之上——面板可能刚被用户勾选就显示成未勾选。现在过期响应会被丢弃，
  而不是被应用。

## 面板依赖哪些「必须成立」的细节

有三处细节很容易写错，因为它们都是静默失败：

- **RPC 路径是根绝对路径。** 路由挂在 `/api/conversation-sync/rpc`。相对的 `api/…` 在
  外壳挂载于 `/` 时能用，一旦应用被部署在某个路径前缀下就会 404。
- **样式表活在 effect 里。** `<style>` 节点只追加一次，并在插件卸载时移除。只追加不提供
  清理函数，会让 CSS 在禁用或重载之后残留，而模块级的「已应用」标记会让再次应用永远无效。
- **slot 标签是函数，不是字符串。** 侧边栏和设置导航调用 `t('settings.nav')`；宿主在语言
  修订变化时重新读取标签。硬编码的标签会让英文用户看到中文，而且永远不更新。

`locale/*.json` 里的 `meta.detail` 是第四处：宿主会读取该路径，如果文件不存在就报
`plugin-manager/detail-unavailable`，而**不会**回退到 README。它必须指向一个真的会被打包
的文件——这里是 `docs/TECHNICAL.md` 与 `docs/TECHNICAL.zh-CN.md`。
`test/manifest.test.js` 固定住宿主按名字读取的那几个 manifest 细节（`exports`、bundle patch、
`engines.dsh`、可选 peer）。

## 状态条用于暴露过期的宿主

`{action:'status'}` 报告 `version`、`startedAt` 以及最近 20 条活动记录。这不是装饰：
每次页面重载都会重新提供客户端 bundle，而宿主进程要等应用重启才会换掉旧代码，所以更新后
面板可能调用宿主从未听说过的 action（`unknown action: setBindingAll` 正是这种情况）。
显示正在运行的版本让这种不匹配变得可见而不是神秘，而且现在每次配对、同步和删除都会记录
一行，于是一次点击的结果能在重载后保留。

## 两种双向方向，以及为什么两者都存在

`both` 和 `auto` 回答的是不同的问题，这就是面板提供两者而不是一个「双向」开关的原因：

- **`both` —— 每一侧都补齐。** 两个方向总是都运行。每个方向各自维护游标
  （导入用 `state.dshSeqs`，导出用 `state.outSeqs`），只追加另一侧还没有的内容。
  运行两次不会增加任何东西，所以不需要也不希望做比较。
- **`auto` —— 较新的副本胜出。** 只运行一个方向，由 `compareSides()` 选择；两侧一致时
  结果为 `none`，什么都不会写入。

这里曾有一个真实的 bug，直到某个场景把它抓住：`state.outSeqs[sessionId]` 记录的是
**最后导出的 seq**，而 `readDshSessionMessages({fromSeq})` 把 `fromSeq` 当作**包含端点**的
起点。因此每次重复同步都会重新导出那一条消息，`both` 绑定每运行一次，文件就多出一行重复。
现在游标以排他方式存储（`seq + 1`），并且 `safety` 场景断言第二次运行 `both` 时导入 0、
写入 0。

## 为什么侧边栏条目需要一个 `key`

`sidebar.panellist` 条目以 `id` 为键，但它打开的页面位于 `main` 插槽中，而后者以 `key`
为键。点击条目会调用 `ctx.layout.selectPanel(id)`，并且 `LayoutController.selectPanel` 会抛出

    layout.selectPanel: main panel "<id>" is not registered

除非 `ctx.slots.entries('main').some(entry => entry.options.key === id)`。
因此用 `id` 注册 `main` 会产生一个看起来已安装、却什么都打不开的条目——控制台没有错误，
也没有可见变化。两个值必须完全相同，`test/client.test.js` 断言的正是这一点。

图标是单独绘制的：侧边栏渲染
`renderFactorySlot('sidebar.panel.icon', {id, size, active}, {only: id})`，因此插件只需注册
panellist 条目（连同其组件），让侧边栏自己去取图标字形。

## 哪一侧更新

`lib/newer.js` 根据比较结果决定方向，而比较以 `lastSyncAt` 加上上次成功同步时记录的时间戳
（文件的 mtime 和大小，以及最新的 DSH 事件时间）为基准，而不是直接比较两个时间戳。

原因是这两个数字含义不同。DSH 事件的 `time` 是对话自身的时间戳，因此导入一年前的
rollout 会写入一年前的时间戳；文件的 `mtime` 是它落到这块磁盘上的时间，所以复制一下就能
让古老的内容看起来很新。直接比较会把刚复制过来的旧文件永远判成胜者，下一次自动同步在
每次轮询时都会重新导入它——这正是实际发生的事：某个对话有 329 天历史的 fixture 被报告为
"the source changed 329d after DSH did"，因为它的 mtime 很新。

改问*这一侧自上次同步后有没有变化？*是对称的，也没有这种失效模式。两个后果已被测试固定：

- 空的或不存在的来源文件永远不会被判为「较新」——里面没有东西可读，所以同步会执行导出
  （`the source file is empty` / `the source file does not exist yet`）；
- 没有任何变化的 `auto` 会解析为 `none`，并且 `syncBinding` 返回
  `{imported: 0, written: 0, direction: 'none', skipped: true}`，不触碰任何一侧。
  重写一个本来就正确的文件会让「它变了吗？」变得无法回答。

## 事前检查、备份与校验

每次同步、两个方向都有三道保障，而且三道都由 `safety` 场景覆盖，因为单元测试看不到其中
任何一道：

1. `lib/rollback.js` 中的 `preflight()` 是只读的，在任何写入之前运行。它检查插件数据目录
   （`data-root`）、来源是否可读（`source-read`）、目标 DSH 会话是否存在（`dsh-session`）
   以及方向是否已知。拒绝时返回与真实失败相同的 `{reason, conditions}` 结构，外加
   `preflight: true` 和失败的检查 id，这样面板能指出*哪个*前置条件出了问题，而不是笼统地
   说「同步失败」。
2. `SyncRollback.begin()` 复制外部文件**以及** DSH 会话的整个目录，然后把两者都读回校验。
   字节数与原文件不一致的备份会在第一次写入前中止同步——不能用来还原的备份比没有备份更糟，
   因为它看起来像安全保障。
3. `SyncRollback.verify()` 在写入后重新读取两侧。导出的文件必须以刚写入的字节结尾，导入的
   会话必须包含可读的消息。其他任何情况都会以 `phase: 'verify'` 抛出，并由调用方回滚。

DSH 侧在文件层面还原，因为 `SessionPersistence` 没有暴露删除或截断操作。因此
`lib/dsh-store.js` 会复制会话目录（`backupSessionDir`）、把它复制回去（`restoreSessionDir`），
或在同步创建了会话时删除它（`removeSessionDir`）。会话日志是多帧 zstd，所以这里每个读取器
都按 `28 b5 2f fd` 魔数分割帧——解压整个文件只会得到头部帧。

`lib/dsh-migrate.js` 用同样的帧处理来迁移旧版本导入到按机器分的工作区中的会话：它复制
目录，重写第一帧中的 `cwd`（每个事件帧保持字节不变），删除原目录，然后由调用方把会话挂到
唯一的 `会话同步` 工作区。仅仅搬动文件还不够——只有当工作区的记录列出了某个会话，它才会
出现在该工作区里，这就是为什么迁移后的会话可能躺在磁盘上却在界面里不可见。

两个追加 bug 由单元测试而非场景固定，因为两者都能在事件流中看到：`persistence.stat().eventCount`
对同一进程中创建的会话报告 `0`，因此 `appendSession` 从日志中推导当前长度
（`inspectDshLog`），而下一个轮次号来自 `data.turn`（而不是 envelope），所以追加永远不会从
turn 1 重新开始——后端会以 `append seq mismatch` 和
`turn/start does not open the expected turn` 拒绝这两种情况。
