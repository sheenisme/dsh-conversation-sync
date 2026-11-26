# dsh-conversation-sync

[中文 README](README.zh-CN.md) · [Detailed docs](docs/DETAIL.md)

Import conversations into [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
from the tools you already use — and keep them in sync **both ways**, locally or
over SSH.

**Two headline features:**

1. **Real bidirectional sync.** New messages on either side propagate to the
   other automatically. You choose the direction per pair of sessions: import,
   export, or both.
2. **Remote-SSH machines are first-class.** Sessions do not have to live on this
   machine. The plugin reads `~/.ssh/config` and treats the local machine, every
   SSH host, and every **jump host** as a source you can sync with.

## UI at a glance

The panel opens from **Settings → Conversation sync** (its own sidebar entry) or
from **Plugins → Conversation sync**. It is a two-column picker:

- **Left:** every DSH session in this installation.
- **Right:** sessions found on the selected machine. Switch machines with the
  buttons on top.
- Select one session on each side, then choose a direction:
  `← Import to DSH`, `Export to remote →`, or `⇄ Sync both ways`.
- If a session exists on only one side, import or export it first; after that
  it stays in sync.
- Pairings are listed at the bottom with per-binding sync buttons and status.

## Install

```bash
dsh plugin --profile <name> add dsh-conversation-sync
```

Or from the UI: **Plugins → Install bundle**, using this directory or the
repository URL. The bundle ships its own `cordis.patch.yml`, so nothing in your
profile manifest has to be edited by hand.

## Quick start

1. Open the **Conversation sync** settings page.
2. The machines row lists the local machine plus every host from
   `~/.ssh/config`, jump hosts included. For an SSH machine, set the
   **private-key path** once — it is stored as a DSH credential, never as plugin
   config. If the key has a passphrase, point it at the matching `.pub` file and
   authentication goes through `ssh-agent` instead.
3. Pick a machine on the right; its sessions are discovered automatically.
4. Select a session on each side, choose a direction, and the pair becomes an
   active binding. Imported sessions land in a workspace grouped by machine.

## Supported sources

| Kind | Typical location |
| --- | --- |
| Claude Code | `~/.claude/projects/<slug>/<sessionId>.jsonl` |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` |
| WorkBuddy / CodeBuddy | `~/.workbuddy/projects/**`, `~/.workbuddy-ai/projects/**`, `~/.codebuddy/projects/**` |
| TRAE | `~/.trae/cli/**`, `~/.trae-cn/cli/**` |
| Antigravity | `~/.gemini/antigravity{,-cli,-ide}/brain/<uuid>/.system_generated/logs/transcript.jsonl` |
| OpenCode | `~/.local/share/opencode/opencode.db` (SQLite) |
| Generic JSONL | any JSONL file with `role` and `content`/`text` per line |
| DeepSeek export | web export ZIP (`export_format_version: 3`) |

OpenCode and the DeepSeek export are **import-only** — OpenCode keeps sessions in
a live SQLite database, and an export ZIP is a snapshot rather than a
conversation the tool can resume. The panel explains this instead of silently
refusing.

Per-format parsing details, quirks and filtering rules are in
[docs/DETAIL.md](docs/DETAIL.md#supported-sources).

## When a sync fails

Every external write is preceded by a backup, which is restored if anything goes
wrong. The report tells you the reason and the concrete preconditions to satisfy
before retrying — SSH key permissions, host reachability, writable paths, disk
space, and so on. Nothing is left for you to guess.

> **Warning — exporting modifies live files.** Export appends messages to the
> original tool's session files. Backups are taken before every write and
> restored on failure, but data loss is still possible. Keep your own backups
> and leave the export direction off for sources you cannot afford to lose.

## Development

```bash
npm test        # unit tests, node:test, no network and no DSH needed
```

119 unit tests cover the pure modules — adapters, event building, `.ssh/config`
parsing, discovery, rollback diagnostics, host keys, SQLite reads, jump-chain
planning, the connection pool, the system-ssh transport, and the browser half
through a stub module loader. CI additionally installs the packed plugin into five real DSH releases
and drives the actual RPC surface.

See [docs/DETAIL.md](docs/DETAIL.md#testing) for what each CI job proves and how
to run the harness locally.

## License

[MIT](LICENSE) © 2026 sheenisme

## Acknowledgements

This plugin stands on work done by others. In particular:

- **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** (MIT) —
  the host itself. Its official `dsh-deepseek-chat-import` plugin and the session
  format packages were the reference for event shapes, the `tool/call` →
  `tool/result` lifecycle, and how a plugin registers a web route.
- **[dsh-remote](https://github.com/sheenisme/dsh-remote)** (MIT) — the model for
  the SSH layer. Connection pooling, host-key fingerprinting of the raw key blob,
  the `PreferredKeyAgent` ordering that avoids tripping `MaxAuthTries`, and
  failure classification with actionable hints all came from studying it.
- **[dsh-chat-import](https://github.com/Nwflower/dsh-chat-import)** (MIT) — an
  earlier and much broader importer, and the reference for how a DSH import
  plugin materializes sessions through `sessionPersistence`.
- **[dsh-plugin-cc](https://github.com/cpj-dev/dsh-plugin-cc)** (MIT) — a clean
  example of a bundle's shape (`cordis.patch.yml`, client module, locale
  registration) and of how to structure tests around a DSH plugin.
