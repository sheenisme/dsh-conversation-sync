# dsh-conversation-sync

[中文 README](README.zh-CN.md) · [Detailed docs](docs/DETAIL.md)

**Two headline features:**

1. **Real bidirectional conversation sync** — new messages on either side (the
   original tool or DSH) automatically propagate to the other. Pick the
   direction yourself for each pair of sessions: import, export, or sync both
   ways.
2. **Remote-SSH machines as first-class citizens** — sessions do not have to
   live on the local machine. The plugin reads your local `~/.ssh/config`
   automatically: the local machine counts as one source, **every** SSH host
   counts as one, and **jump hosts (ProxyJump) count as machines too** — even
   when they are only used as a relay.

Import conversations from **Claude Code**, **Codex CLI**, generic **JSONL** and
**DeepSeek web exports**, from local files or from any reachable SSH server,
and keep them in sync with DSH.

## UI at a glance

The settings page (**Plugins → Conversation sync**) is a two-column session
picker:

- **Left:** every DSH session in this installation.
- **Right:** sessions discovered on the selected machine (local, or one of the
  SSH hosts / jump hosts from `~/.ssh/config`). Switch machines with the buttons
  on top.
- Select one session on each side and choose a direction:
  `← Import to DSH`, `Export to remote →`, or `⇄ Sync both ways`.
- If a session exists on only one side, import or export it first — after
  pairing, it is kept in sync automatically.
- Active bindings are listed at the bottom with per-binding directional sync
  buttons and their last-sync status.

## Install

Install the bundle through **Plugins → Install bundle** using this directory
(or the repository URL). No writes to the profile manifest are needed — the
bundle ships its own `cordis.patch.yml`.

## Quick start

1. Open the **Conversation sync** settings page.
2. The **Machines** row lists the local machine plus every host from
   `~/.ssh/config` (jump hosts included). For an SSH machine, set the
   **private-key PATH** once via `Set key path`; the path is stored as a DSH
   credential (the key contents never enter plugin config). If the key has a
   passphrase, point it at the matching `.pub` file instead: the plugin then
   authenticates through `ssh-agent`, so the passphrase never has to be stored.
3. Pick a machine on the right; its sessions (Claude Code, Codex CLI, DeepSeek
   export ZIPs) are discovered automatically.
4. Select sessions on the left/right, choose a direction, and the pair becomes
   an active binding. Imported sessions are attached to a dedicated workspace
   grouped by machine.

## Failure handling — automatic rollback

If a sync fails, the plugin:

1. **backs up** the external file *before* writing (so the failure can be
   undone),
2. **restores** the external file from that backup on error, and
3. reports a **human-readable reason plus the concrete preconditions** to
   satisfy before retrying (SSH key permissions, host reachability, writable
   paths, free disk space, valid DeepSeek export, intact DSH session, …).

Diagnostics and retry conditions are shown inline in the UI and kept in the
binding state. The DSH side is never edited by hand — if events were already
appended to DSH, the message tells you to remove them via the DSH UI.

> **Warning — write-back edits live files.** Exporting appends messages to the
> original tool's session files. A backup is taken before every write and
> restored on failure, but data loss is still possible. Keep your own backups
> and disable write-back for sources you cannot afford to lose.

## Host keys

Every server the plugin connects to is checked against `known_hosts.json` in the
plugin data directory. A new server is trusted on first use and recorded; a
server whose key **changed** is refused, because that is the case that matters
(rebuild, or interception). Set `hostKeyMode` to `verify` to refuse unknown
servers as well, or `off` to disable the check.

## Supported sources

| Kind | Typical location |
| --- | --- |
| Claude Code | `~/.claude/projects/<slug>/<sessionId>.jsonl` |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` |
| WorkBuddy / CodeBuddy | `~/.workbuddy/projects/**`, `~/.workbuddy-ai/projects/**`, `~/.codebuddy/projects/**` |
| TRAE | `~/.trae/cli/**`, `~/.trae-cn/cli/**` |
| Antigravity | `~/.gemini/antigravity{,-cli,-ide}/brain/<uuid>/.system_generated/logs/transcript.jsonl` |
| OpenCode | `~/.local/share/opencode/opencode.db` (SQLite) |
| Generic JSONL | any JSONL file with `role` + `content`/`text` per line |
| DeepSeek export | web export ZIP with `manifest.json` `export_format_version: 3` (import-only) |

OpenCode and the DeepSeek export are **import-only**: OpenCode keeps sessions in
a live SQLite database (writing into it from a plugin is unsafe) and a DeepSeek
export ZIP is a snapshot, not a conversation the tool can resume. Choose
direction `in` for those two; the panel refuses `out` with an explanation.

TRAE writes each user turn twice — once as a real `event_msg` and once as a
request echo — so the echo is dropped on read instead of showing the question
twice. Antigravity transcripts mix real conversation with harness step logs
(`MODEL/GENERIC`) and system notices; those are filtered, and the
`<USER_REQUEST>` wrapper is stripped from user text.

See [docs/DETAIL.md](docs/DETAIL.md) for the sync model, event shapes and
storage details.

## Tests and CI

```bash
npm test                      # 95 unit tests, node:test, no network or DSH needed
```

The unit suite covers the parts that are pure functions — the tool adapters
(with a fixture per format), DSH event building and validation, `.ssh/config`
parsing, session discovery, rollback and failure diagnostics, host-key handling,
OpenCode's SQLite reads, the SSH transport's jump-chain planning, and the
per-machine connection pool (reuse, what counts as a dead connection, teardown).

Unit tests cannot prove the plugin works *inside* a harness, so
[`.github/workflows/ci.yml`](.github/workflows/ci.yml) also installs the packed
plugin into real DSH releases and boots them:

| Job | What it proves |
| --- | --- |
| `unit` | the pure modules behave, on the oldest supported Node and the latest 24.x |
| `compatibility` | the plugin activates and imports a conversation on each of the **five most recent DSH releases** |
| `functional` | the user journey on the two newest releases: import, export, all five tool formats, failure reporting, no duplicate re-import, and that an explicit sync direction is honoured |

Both harness jobs run `scripts/ci/install-dsh.mjs` (installs a specific DSH
version with the runtime peers npm does not provide) and then
`scripts/ci/boot-check.mjs` / `scripts/ci/scenario.mjs`, which bootstrap a
throwaway profile, start `dsh web`, wait for its health line, fail when a bundle
did not activate, authenticate with the cookie the panel uses, and drive the
real RPC endpoint.

Run them locally against any installed DSH:

```bash
node scripts/ci/install-dsh.mjs --version 0.2.2-rc.5 --dir /tmp/dsh
node scripts/ci/boot-check.mjs --dsh /tmp/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js \
  --tarball "$(npm pack --silent)" --home /tmp/dsh-home
```
