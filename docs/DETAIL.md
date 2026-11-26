# Conversation sync — detail

## Supported sources

| Kind | Typical path | Notes |
| --- | --- | --- |
| `claude` | `~/.claude/projects/<slug>/<sessionId>.jsonl` | One file = one session; `user`/`assistant` messages, tool results, thinking blocks. Sidechain/subagent turns are imported as normal turns. `api-request-blob` duplicates are ignored. |
| `codex` | `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<threadId>.jsonl` | Order by the top-level `ordinal`; reasoning, tool calls/outputs and agent messages are imported. |
| `jsonl` | any path | Each line needs `role` (`user`/`assistant`/`tool`/`system`) plus `content` or `text`. Timestamps may be ISO strings or epoch numbers. |
| `deepseekExport` | DeepSeek web export ZIP | Requires `manifest.json` with `export_format_version: 3`; reads `chat_session_index.json` and `chat_sessions/<id>.json`; creates one DSH session per chat. |

Remote sources use SSH/SFTP with private-key authentication. Store the **path**
to the private key as a DSH credential (for example via the built-in credential
settings), then enter its reference (e.g. `conversation-sync/ssh-key`) in the
source form. The key contents never appear in plugin configuration.

## Sync model

**External → DSH.** The Host polls every 2 seconds (`pollMs` is reserved for a
per-source interval). For JSONL sources a byte-offset cursor reads only new
lines; partial trailing lines are buffered until complete. Files that shrink or
rotate restart from offset 0. Records are deduplicated by their own identity,
and by a `dshSyncId` marker on lines this plugin wrote. New records are appended
as DSH v4 events using only known event types (`turn/start`, `step/start`,
`system/message`, `user/message`, `assistant/message`, `step/end`, `turn/end`),
with contiguous sequence numbers and monotonic timestamps. Imported sessions
are materialized through `sessionPersistence.create()` and attached to a
per-source workspace under `~/.dsh/conversation-sync/workspaces/`.

**DSH → external.** When a DSH session that belongs to a source receives a new
`user/message` or `assistant/message`, the plugin marks that source dirty. At
the next tick it copies the original file to a timestamped backup under
`~/.dsh/conversation-sync/backups/` and appends the new messages in the
original tool's JSONL format, tagged with `dshSyncId` so they are never imported
back. A per-session sequence watermark prevents duplicates. The DeepSeek export
ZIP source is import-only (the archive is treated as immutable).

**Loops.** `dshSyncId` tags on external lines plus the DSH sequence watermark
prevent infinite echo between the two sides.

## Write-back warning

Write-back **directly edits the original tool's live session files**. Claude
Code and Codex CLI may hold their own state; appended lines follow their JSONL
schema, but neither tool is aware of DSH and a future tool update could change
the format. A backup is made before every write, but **data loss is possible**.
You explicitly accepted this risk when enabling write-back; keep your own
backups and disable write-back for sources you cannot afford to lose.

## Storage and lifecycle

- Source registry, cursors, session mapping and sync watermarks live in the DSH
  storage domain `conversation_sync` (JSON backend, version 1).
- The SSH transport keeps one SFTP connection per source and reconnects on
  failure. The private key is read from the credential's referenced path at
  connection time.
- All timers and connections are disposed when the plugin is disabled or the
  profile shuts down.
- HTTP routes (`/api/conversation-sync/rpc`) are owner-only, as all DSH web
  routes are.
