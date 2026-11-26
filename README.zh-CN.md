# dsh-conversation-sync

[English README](README.md) · [详细文档](docs/DETAIL.md)

**两大显著特点：**

1. **真正的双向会话同步** —— 任意一侧（原工具或 DSH）有新消息，都会自动传播到另一侧。每一对会话都可以自己选方向：导入、导出、双向同步。
2. **Remote-SSH 机器是一等公民** —— 会话不必在本机。插件自动读取本机 `~/.ssh/config`：本机算一个来源，**每一个 SSH 主机**都算一个，**跳板机（ProxyJump）也算一个机器**，哪怕它只是转发用途。

支持从 **Claude Code**、**Codex CLI**、通用 **JSONL** 和 **DeepSeek 网页导出** 导入会话，来源可以是本机文件，也可以是任意可达的 SSH 服务器，并与 DSH 保持同步。

## 界面一览

设置页（**插件 → Conversation sync / 会话同步**）是双栏会话选择器：

- **左栏：** 当前 DSH 安装中的全部会话。
- **右栏：** 所选机器上发现的会话（本机，或 `~/.ssh/config` 里的某个 SSH 主机 / 跳板机）。顶部的按钮切换机器。
- 左右各选一个会话，再选方向：`← 导入到 DSH`、`导出到远端 →`、`⇄ 双向同步`。
- 如果会话只存在于一侧，先导入或导出；配对完成后自动保持同步。
- 页面底部列出已建立的绑定，每个绑定都有按方向的同步按钮和最近同步状态。

## 安装

在 **插件 → 安装插件包** 中用本目录（或仓库地址）安装。无需改动 profile 清单——插件自带 `cordis.patch.yml`。

## 快速开始

1. 打开 **会话同步** 设置页。
2. **Machines / 机器** 一行列出本机，加上 `~/.ssh/config` 里的每一台主机（跳板机包含在内）。对 SSH 机器，先用 `设置私钥路径` 指定**私钥文件路径**一次；路径作为 DSH 凭据保存，私钥内容绝不进入插件配置。带口令的密钥则填同名的 `.pub` 文件：插件会走 `ssh-agent` 认证，口令不需要保存。
3. 在右侧选择一台机器，它上面的会话（Claude Code、Codex CLI、DeepSeek 导出 ZIP）会被自动发现。
4. 左右各选一个会话，选方向，即成为一条活动绑定。导入的会话会挂到按机器分组的专用工作区下。

## 失败处理 —— 自动回退

同步失败时，插件会：

1. 在**写入之前**先**备份**外部文件（失败才能回滚）；
2. 出错后从备份**还原**外部文件；
3. 给出**人能读懂的原因**加上**重试前必须满足的具体条件**（SSH 私钥权限、主机可达性、路径可写、磁盘空间、DeepSeek 导出包是否合法、DSH 会话是否完整……）。

诊断与重试条件在界面内联显示，并保存在绑定状态里。DSH 侧绝不手改文件——如果事件已经写入 DSH，提示会告诉你通过 DSH 界面删除。

> **警告 —— 导出会改动真实文件。** 导出会把消息追加到原工具的活动会话文件。每次写入前都会备份，失败会还原，但仍有可能造成数据丢失。请自行备份，对不能丢失的来源请关闭导出方向。

## 主机密钥

插件连接每一台服务器时，都会和插件数据目录里的 `known_hosts.json` 比对指纹。
第一次见到的服务器会被信任并记录下来（TOFU）；**指纹变了**的服务器会被拒绝 ——
这正是真正要紧的情形（重装系统，或者被中间人）。把 `hostKeyMode` 设为 `verify`
可以连没见过的服务器也拒绝，设为 `off` 则完全不校验。

## 支持的来源

| 类型 | 典型位置 |
| --- | --- |
| Claude Code | `~/.claude/projects/<slug>/<sessionId>.jsonl` |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` |
| WorkBuddy / CodeBuddy | `~/.workbuddy/projects/**`、`~/.workbuddy-ai/projects/**`、`~/.codebuddy/projects/**` |
| TRAE | `~/.trae/cli/**`、`~/.trae-cn/cli/**` |
| Antigravity | `~/.gemini/antigravity{,-cli,-ide}/brain/<uuid>/.system_generated/logs/transcript.jsonl` |
| OpenCode | `~/.local/share/opencode/opencode.db`（SQLite） |
| 通用 JSONL | 每行含 `role` 与 `content`/`text` 的任意 JSONL 文件 |
| DeepSeek 导出 | 网页导出 ZIP，`manifest.json` 中 `export_format_version: 3`（仅导入） |

OpenCode 与 DeepSeek 导出**只能导入**：OpenCode 的会话存在活动中的 SQLite
数据库里（插件往里写不安全），DeepSeek 导出 ZIP 是快照而不是工具能继续的会话。
这两个来源请选方向 `in`，面板在选 `out` 时会直接拒绝并说明原因。

TRAE 会把每个用户回合写两遍——一次是真正的 `event_msg`，一次是请求回显——回显
在读取时被丢弃，所以问题不会重复出现。Antigravity 的 transcript 里混着真正的
对话、harness 步骤日志（`MODEL/GENERIC`）和系统通知，后两者被过滤掉，用户文本
外层的 `<USER_REQUEST>` 包裹也会被剥掉。

同步模型、事件形状与存储细节见 [docs/DETAIL.md](docs/DETAIL.md)。

## 测试与 CI

```bash
npm test                      # 95 个单元测试，node:test，无需网络或 DSH
```

单元测试覆盖的都是纯函数部分——各工具的适配器（每种格式一份 fixture）、DSH
事件的构造与校验、`.ssh/config` 解析、会话扫描、回退与失败诊断、主机密钥处理、
OpenCode 的 SQLite 读取、SSH 传输的跳板链规划，以及按机器复用的连接池
（复用规则、什么算连接已死、卸载时如何关闭）。

单元测试证明不了插件在真实 harness 里能用，所以
[`.github/workflows/ci.yml`](.github/workflows/ci.yml) 还会把打好的插件装进真实的
DSH 版本里启动起来：

| 任务 | 证明什么 |
| --- | --- |
| `unit` | 纯模块行为正确，覆盖最老的受支持 Node 与最新的 24.x |
| `compatibility` | 插件在**最近五个 DSH 版本**上都能激活并成功导入会话 |
| `functional` | 最新两个版本上的完整流程：导入、导出、五种工具格式、失败上报、重复同步不重复导入，以及显式指定的同步方向确实生效 |

两个 harness 任务用 `scripts/ci/install-dsh.mjs` 装指定版本的 DSH（连 npm 不会
自动装的 runtime peers 一起装上），再用 `scripts/ci/boot-check.mjs` /
`scripts/ci/scenario.mjs` 建临时 profile、启动 `dsh web`、等健康输出、在有 bundle
没激活时直接失败、用面板同款 cookie 认证，然后打真实的 RPC 接口。

本地对任意已安装的 DSH 也可以跑：

```bash
node scripts/ci/install-dsh.mjs --version 0.2.2-rc.5 --dir /tmp/dsh
node scripts/ci/boot-check.mjs --dsh /tmp/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js \
  --tarball "$(npm pack --silent)" --home /tmp/dsh-home
```
