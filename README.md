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
   credential (the key contents never enter plugin config).
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

## Supported sources

| Kind | Typical location |
| --- | --- |
| Claude Code | `~/.claude/projects/<slug>/<sessionId>.jsonl` |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` |
| Generic JSONL | any JSONL file with `role` + `content`/`text` per line |
| DeepSeek export | web export ZIP with `manifest.json` `export_format_version: 3` (import-only) |

See [docs/DETAIL.md](docs/DETAIL.md) for the sync model, event shapes and
storage details.
