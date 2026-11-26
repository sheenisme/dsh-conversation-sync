# dsh-conversation-sync

[English README](README.md) · [详细文档](docs/DETAIL.md)

把你在各种工具里的会话导入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，
并与它们**双向**保持同步 —— 本机文件或 SSH 远端都可以。

**两大显著特点：**

1. **真正的双向同步。** 任意一侧有新消息，都会自动传播到另一侧。每一对会话的方向由你决定：导入、导出，或双向。
2. **Remote-SSH 机器是一等公民。** 会话不必在本机。插件读取 `~/.ssh/config`，把本机、每一台 SSH 主机、以及每一台**跳板机**都当作可同步的来源。

## 界面一览

面板入口在**设置 → 会话同步**（设置左栏有独立入口），也可从**插件 → 会话同步**打开。它是双栏选择器：

- **左栏：** 当前 DSH 安装中的全部会话。
- **右栏：** 所选机器上发现的会话，顶部按钮切换机器。
- 左右各选一个会话，再选方向：`← 导入到 DSH`、`导出到远端 →`、`⇄ 双向同步`。
- 会话只存在于一侧时，先导入或导出；配对之后就会持续保持同步。
- 页面底部列出所有配对，每个都有按方向的同步按钮和最近状态。

## 安装

```bash
dsh plugin --profile <profile> add dsh-conversation-sync
```

也可以在界面里用 **插件 → 安装插件包**，选择本目录或仓库地址。插件自带
`cordis.patch.yml`，不需要手动改动 profile 清单。

## 快速开始

1. 打开**设置 → 会话同步**。
2. 机器一行列出本机，以及 `~/.ssh/config` 里的每一台主机（跳板机也在内）。
   SSH 私钥会按固定顺序自动查找：面板里为这台机器保存的路径 → `~/.ssh/config` 里该主机的
   `IdentityFile` → 默认的 `~/.ssh/id_ed25519` / `id_ecdsa` / `id_rsa`。所以终端里能连的主机
   通常一次都不用配。需要覆盖时再点**设置私钥路径** —— 只保存路径，私钥内容不会进入插件配置。
   带口令的密钥请填同名的 `.pub` 文件，认证会交给 `ssh-agent`，口令无需保存。
3. 在右侧选一台机器，它上面的会话会被自动发现。
4. 左右各选一个会话、选方向，即成一条活动配对。导入的会话会挂到按机器分组的专用工作区里。

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
| DeepSeek 导出 | 网页导出 ZIP（`export_format_version: 3`） |

OpenCode 与 DeepSeek 导出**只能导入** —— OpenCode 的会话存在活动中的 SQLite 数据库里，
导出 ZIP 是快照而非工具能继续的会话。面板会说明原因，而不是静默拒绝。

各格式的解析细节、历史怪癖与过滤规则见
[docs/DETAIL.md](docs/DETAIL.md#supported-sources)（英文）。

## 同步失败时

每次写入外部文件之前都会先备份，出错则从备份还原。报告会给出失败原因，以及重试前
必须满足的具体条件 —— SSH 私钥权限、主机可达性、路径可写、磁盘空间等。不需要你自己猜。

> **警告 —— 导出会改动真实文件。** 导出会把消息追加到原工具的活动会话文件里。每次写入前都
> 会备份、失败会还原，但仍有可能造成数据丢失。请自行备份，对不能丢失的来源请关闭导出方向。

## 开发

```bash
npm test        # 单元测试，node:test，无需网络也无需 DSH
```

126 个单元测试覆盖纯模块 —— 各格式适配器、事件构造、`.ssh/config` 解析、会话扫描、
回退诊断、主机密钥、SQLite 读取、跳板链规划、连接池与系统 ssh 传输层，并通过桩模块加载器覆盖浏览器端代码。
CI 还会把打好的插件装进五个真实 DSH 版本，并驱动真实的 RPC 接口。

每个 CI 任务证明什么、如何在本地跑 harness，见
[docs/DETAIL.md](docs/DETAIL.md#testing)（英文）。

## 许可证

[MIT](LICENSE) © 2026 sheenisme

## 致谢

这个插件建立在别人的工作之上，特别感谢：

- **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)**（MIT）——
  宿主本身。其官方 `dsh-deepseek-chat-import` 插件与会话格式包，是事件形状、
  `tool/call` → `tool/result` 生命周期、以及插件如何注册 Web 路由的参照。
- **[dsh-remote](https://github.com/sheenisme/dsh-remote)**（MIT）—— SSH 层的学习对象。
  连接池、原始密钥 blob 的主机指纹、避免触发 `MaxAuthTries` 的 `PreferredKeyAgent`
  排序、以及带可操作提示的失败分类，都来自对它的研读。
- **[dsh-chat-import](https://github.com/Nwflower/dsh-chat-import)**（MIT）—— 更早也更
  广谱的导入器，是 DSH 导入插件如何通过 `sessionPersistence` 落地会话的参照。
- **[dsh-plugin-cc](https://github.com/cpj-dev/dsh-plugin-cc)**（MIT）—— 插件包结构的清晰
  范例（`cordis.patch.yml`、client 模块、locale 注册），以及如何在 DSH 插件周围组织测试。
