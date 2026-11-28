# 各家工具的会话格式

每个记录对话的工具都有自己的行格式。本插件读取其中六种，并在安全的前提下，把内容按它原来的形状写回。

一句话概括：我们写出的行，必须是**工具**能接受的行，而不只是**我们**能解析的行。这正是 [`lib/native.js`](../lib/native.js) 存在的理由；CI 里的 `native` 场景会导出一个会话再导入回来，用消息条数证明往返无损。

- [文件都在哪里](#文件都在哪里)
- [每种格式都要回答的四个问题](#每种格式都要回答的四个问题)
- [Claude Code](#claude-code)
- [Codex CLI](#codex-cli)
- [WorkBuddy / CodeBuddy](#workbuddy--codebuddy)
- [TRAE](#trae)
- [Antigravity](#antigravity)
- [OpenCode](#opencode)
- [通用 JSONL 与 DeepSeek 导出](#通用-jsonl-与-deepseek-导出)
- [一次往返能保证什么](#一次往返能保证什么)
- [新增一种格式](#新增一种格式)

## 文件都在哪里

| 工具 | 位置 | 形态 |
| --- | --- | --- |
| Claude Code | `~/.claude/projects/<slug>/<session>.jsonl` | 每行一个 JSON 对象 |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | 每行一个 JSON 对象 |
| Codex CLI（归档） | `~/.codex/archived_sessions` | 同上 |
| WorkBuddy / CodeBuddy | `~/.workbuddy/projects`、`~/.workbuddy-ai/projects`、`~/.codebuddy/projects` | 每行一个 JSON 对象 |
| TRAE | `~/.trae/cli`、`~/.trae-cn/cli` | Codex 形状的 rollout |
| Antigravity | `~/.gemini/antigravity{,-cli,-ide}/brain/<uuid>/.system_generated/logs/transcript.jsonl` | 每行一个 JSON 对象 |
| OpenCode | `~/.local/share/opencode/opencode.db`（SQLite） | 表，不是行 |
| DeepSeek 导出 | 你保存 ZIP 的任意位置 | ZIP 包着 JSON |

路径在**文件所在的那台机器**上解析：SSH 主机用的是**它**的家目录，规则与本地完全一致。

## 每种格式都要回答的四个问题

读取时要判断四件事，写出时要原样还原：

1. **谁在说话** —— 是 `role` 字段，还是 `source`/`type` 组合，还是由行类型本身决定。
2. **正文在哪里** —— `content` 块、纯字符串，还是嵌套的 `message.content`。
3. **工具调用是什么** —— 内嵌在助手消息里的块，还是靠 id 关联的独立行。
4. **什么是噪音** —— 注入的前言、重放的历史、压缩标记、框架步骤日志。这里漏判不会崩溃，但会得到一个错的标题或一个重复的问题，所以每种格式都需要自己的过滤规则。

## Claude Code

**读取。** `type` 是 `user` 或 `assistant`，`message.role` 重复一次。内容是一个块数组：`text`、`thinking`、`tool_use`、`tool_result`、`image`。

- 助手行的 `tool_use` 块**内嵌在** `message.content` 里，带 `id`、`name`、`input`。
- 工具结果作为一行返回，其 `type` 是 `user`，内容是带 `tool_use_id` 的 `tool_result` 块。并行调用时**一行里可能有多个块**，所以解析器返回数组。
- `parentUuid` 把各行串成链，会话第一行为 `null`。侧链（`isSidechain`）是子代理的碎话，会被保留但不当作主回合。
- 带 `dshSyncId` 的行是我们自己写回的，直接跳过，所以导出过的文件不会被当成新内容再次导入。

**写出。** 每个交换写一行，并串成链：

```
{"parentUuid":null,"isSidechain":false,"type":"user",
 "message":{"role":"user","content":[{"type":"text","text":"…"}]},
 "uuid":"…","timestamp":"…Z","cwd":"/work","sessionId":"…",
 "dshSyncId":"…","dshTitle":"…"}
```

助手行额外带 `message.model` 和 `stop_reason`（调用过工具是 `tool_use`，否则 `end_turn`），以及 `tool_use` 块。它的结果输出为一行 `type:"user"`、内含 `tool_result` 块 —— 与 CLI 自己的写法一致。`cwd` 是必需的，缺了它 CLI 打不开这个文件。

## Codex CLI

**读取。** 每行都是 `{timestamp, ordinal, type, payload}`，第一行是 `session_meta`。对话内容在 `response_item` 行里：

- `message` —— `{role, content:[{type:'input_text'|'output_text', text}]}`。`role:"developer"` 装的是系统提示，不是用户回合。
- `reasoning` —— 可读部分在 `summary`；`encrypted_content` 是不透明数据，只忽略、不当正文存储。
- `function_call` / `custom_tool_call` —— `call_id`、`name`、`arguments`（或 `input`）。
- `function_call_output` / `custom_tool_call_output` —— 同一个 `call_id`，正文在 `output`。

调用与输出是两行，靠 `call_id` 关联；`id` 是消息 id，绝不能拿来当关联键。`event_msg`（`task_started`、`thread_settings_applied`、`item_completed`）是界面事件，不是对话。被压缩过的 rollout 只剩 `session_meta`、一行加密的 `compaction` 和 `thread_settings_applied` —— 三行，没有对话。

**写出。** rollout 需要头部，且 `ordinal` 在追加时要继续递增：

```
{"timestamp":"…","ordinal":1,"type":"session_meta","payload":{"session_id":"…","cwd":"…","originator":"dsh-conversation-sync", …}}
{"timestamp":"…","ordinal":2,"type":"response_item","payload":{"type":"message","id":"…","role":"user","content":[{"type":"input_text","text":"…"}]}}
{"timestamp":"…","ordinal":3,"type":"response_item","payload":{"type":"function_call","id":"…","call_id":"…","name":"…","arguments":"…"}}
```

追加前先读出已有的最大 `ordinal`（`maxOrdinal`），从它上面继续编号；第二次导出到同一文件绝不会再写一个 `session_meta`，因为两个头部会让 Codex 把文件当成两个会话。

## WorkBuddy / CodeBuddy

**读取。** 每行一个扁平对象，靠类型区分：

- `{type:'message', id, role:'user'|'assistant', content:[{type:'input_text'|'output_text', text}], timestamp}` —— `timestamp` 是**毫秒**。
- `{type:'reasoning', rawContent}` —— 思考过程，不是回复。
- `{type:'function_call', callId, name, arguments}` 与 `{type:'function_call_result', callId, status, output}` —— 靠 `callId` 关联，**不是** `id`：`id` 是模型消息，并行调用会共用。
- 带 `skipRun`、`isMeta`、`isCompactInternal`、`isCompacted` 标记的行是内部产物，跳过。

**写出。** `message` 行，加上 `function_call` / `function_call_result` 行，带数字 `timestamp` 和对应的 `callId`。不会凭空补出思考内容。

## TRAE

**读取。** TRAE 的 CLI 写的是 Codex 形状的 rollout，但有两处不同：

- 真正的用户输入在 `{type:'event_msg', payload:{type:'user_message', message}}` 里。同为这些字的 `role:"user"` response item 是请求回声，读取时保留 `event_msg` 那份、丢掉重复 —— 包括两者落在两次读取里的情况。
- `{type:'history_mutation', payload:{operation:'replace'}}` 是重放的历史。导入它会让整个会话重复一遍，所以跳过。

其余行交给 Codex 解析器。

**写出。** TRAE 使用 Codex 的写出器。TRAE 的 IDE 把会话存在加密数据库里（文件头 `efc957ea …`，不是 SQLite），这部分不读取；`~/.trae-cn` 下的 `memory/*.jsonl` 是关键词摘要，不是对话。

## Antigravity

**读取。** 它是步骤日志，不是消息列表：`{step_index, source, type, status, created_at, content, thinking, model, tool_calls, tokens}`。

| source / type | 含义 | 是否保留 |
| --- | --- | --- |
| `USER_EXPLICIT` / `USER_INPUT` | 用户回合 | 保留 |
| `MODEL` / `PLANNER_RESPONSE` | 模型回复，`tool_calls` 挂在上面 | 保留 |
| `MODEL` / `GENERIC` | 框架步骤日志 | 丢弃 |
| `SYSTEM` / `SYSTEM_MESSAGE` | 运行时提示 | 丢弃 |
| 任意 / `CHECKPOINT` | 压缩标记 | 丢弃 |

用户正文被包在 `<USER_REQUEST>…</USER_REQUEST>` 里，后面还跟着 `<ADDITIONAL_METADATA>` 块；两者都会被剥掉，这样标题和预览显示的是人真正打的字。`created_at` 是 RFC3339。

**写出。** `step_index` 递增，`source`/`type` 用同样的组合，用户正文重新包上，工具调用作为模型步骤上的 `tool_calls`，工具输出作为 `SYSTEM` 步骤。

## OpenCode

OpenCode 把会话存在 SQLite 里而不是 JSONL，且市面上有两种 schema：`session` + `session_message`，以及更旧的 `session_v2` + `message` + `part`。插件把数据库（连同 `-wal`/`-shm`）复制到临时目录后只读打开，正在运行的 OpenCode 不会与它争用。

OpenCode **只能导入**。从插件往活的 SQLite 里写有损坏风险，所以导出到 OpenCode 会直接拒绝并说明原因，而不是硬写。

## 通用 JSONL 与 DeepSeek 导出

**通用 JSONL** 是兜底：`role`（或 `type`）加 `content`/`text`，时间戳接受数字或 ISO 字符串。当某个工具不在上表里、而它的行又足够简单时选它。

**DeepSeek 导出** 是 ZIP，用 `fflate` 读取，`export_format_version` 必须是 `3`。它同样只能导入，因为 ZIP 是一份快照，不是工具会重新打开的存储。

## 一次往返能保证什么

CI 中的 `native` 场景对 Claude、Codex、WorkBuddy、Antigravity 断言：

1. 导出至少两行，且每行都带 `dshSyncId`。
2. 去掉源标记后把文件读回来，得到的**消息条数与导出前一致**。
3. 工具调用与结果成对存活 —— Codex 与 WorkBuddy 靠 `call_id`，Claude 靠 `tool_use_id`，Antigravity 靠 `tool_calls`。

它**不**承诺：文件逐字节相同。我们写出的行用的是对话自身的时间戳、我们自己的 id，原行里未知的字段也不会被搬运。同步关心的是对话，不是文件的元数据。

两条刻意的拒绝，用来保护你的数据：

- 绝不凭空造会话。三行的压缩 rollout 会导入为一条错误（`no importable messages`），而不是一个空壳。
- 绝不把工具结果变成用户消息。它始终是 `tool_result` 块、`function_call_output` 行，或 `SYSTEM` 步骤。

## 新增一种格式

1. 在 [`lib/adapters.js`](../lib/adapters.js) 里加解析器，并注册到 `JSONL_ADAPTERS`。
2. 在 [`lib/native.js`](../lib/native.js) 里加原生写出器，并在 `renderSessionLines` 里分派。
3. 在 `test/fixtures/` 下加样本文件，并在 `test/fixtures.test.js` 与 `test/native.test.js` 里加用例。
4. 如果工具把文件放在新位置，就把它加到 `lib/discovery.js` 的根目录列表。
5. 扩展 `scripts/ci/scenario.mjs` 里的 `FORMATS`，让真实 harness 也验证它。
