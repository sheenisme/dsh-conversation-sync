# Conversation sync — detail

## Two headline features

- **Bidirectional sync.** A binding associates a machine-side external session
  (a JSONL file, a DeepSeek export ZIP, ...) with one or more DSH sessions and a
  `direction`: `in` (external → DSH), `out` (DSH → external), or `both`. The host
  polls each binding, moves only new records in the enabled direction(s), and
  tags what it writes so it never echoes it back.
- **Remote-SSH as a first-class machine.** The host reads the local
  `~/.ssh/config` at startup (and every 30 s). The local machine is always
  machine `local`; every SSH `Host` stanza becomes a machine
  (`ssh:<pattern>`); **each ProxyJump target becomes its own machine too**
  (`isJump: true`). A machine reached through a jump host carries a `via[]`
  chain, and the SSH transport chains connections via `forwardOut()` — each hop
  authenticates with its own private key. Wildcard-only hosts and `Include`
  directives are skipped with a warning (they cannot be resolved to a concrete
  host without expanding config semantics).

## Supported sources

| Kind | Typical path | Notes |
| --- | --- | --- |
| `claude` | `~/.claude/projects/<slug>/<sessionId>.jsonl` | One file = one session; `user`/`assistant` messages, tool calls/results, thinking blocks. `api-request-blob` duplicates and sidechain/subagent turns are skipped. Tool calls become real `tool/call` → `tool/result` events paired by `callId`. |
| `codex` | `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<threadId>.jsonl` | Ordered by top-level `ordinal`; reasoning, function/`custom_tool_call` + outputs, agent messages imported. |
| `jsonl` | any path | Each line needs `role` (`user`/`assistant`/`tool`/`system`) plus `content` or `text`. Timestamps may be ISO strings or epoch numbers. |
| `deepseekExport` | DeepSeek web export ZIP | Requires `manifest.json` with `export_format_version: 3`; reads `chat_session_index.json` and `chat_sessions/<id>.json`; one DSH session per chat. **Import-only** — the archive is immutable. |

Discovery (`lib/discovery.js`) scans each machine at
`~/.claude/projects` (depth 3), `~/.codex/sessions` (depth 4) and
`~/.dsh-conversation-sync/exports` (depth 2), capped at 5000 entries. Each
discovered session carries an id, kind, name, preview, message count and byte
size, and is shown on the right-hand column of the UI for the selected machine.

For an SSH machine, store the **path** to the private key as a DSH credential
(`conversation-sync/ssh-key/<machineId>`) via the UI's `Set key path` button.
The key contents never appear in plugin configuration; the transport reads the
file at connection time. A key is needed for every hop in a `via[]` chain.

## Sync model

**External → DSH (`in`).** For JSONL sources a byte-offset cursor reads only new
bytes; partial trailing lines are buffered until complete. Files that shrink or
rotate restart from offset 0. Records are deduplicated by their own identity
and by a `dshSyncId` marker on lines this plugin wrote. New records are appended
as DSH v4 events using only known event types (`turn/start`, `step/start`,
`system/message`, `user/message`, `assistant/message`, `tool/call`,
`tool/result`, `step/end`, `turn/end`, `session/title`), with contiguous
sequence numbers and monotonic timestamps. Imported sessions are materialized
through `sessionPersistence.create()` and attached to a per-machine workspace
under `~/.dsh/conversation-sync/workspaces/`. Live sessions are appended via
`Session.append()` so the agent loop sees them.

**DSH → external (`out`).** New `user/message` and `assistant/message` events on
a bound DSH session are read by DSH sequence number, rendered in the original
tool's JSONL format tagged with `dshSyncId:dshSessionId:seq`, and appended to
the external file via the machine's transport. A per-session sequence watermark
prevents duplicates. DeepSeek export ZIP is import-only; exporting to it is
rejected with a clear error.

**`both`** runs both directions in one binding. `dshSyncId` tags plus DSH
sequence watermarks prevent infinite echo.

**Automatic sync.** A global 2 s poll tick runs every enabled binding whose
`pollMs` interval has elapsed; `session/event` marks affected bindings dirty
for immediate processing. A separate 30 s tick refreshes machine discovery.
Polling and discovery timers, plus all SFTP connections, are disposed when the
plugin is disabled.

## Automatic rollback / failure diagnosis

Before any external write, `SyncRollback.begin()` copies the external file to a
timestamped backup under `~/.dsh/conversation-sync/backups/` and records the
DSH sequence watermark. If any step fails, `SyncRollback.fail()`:

1. restores the external file from that backup (for `out`/`both` directions),
2. reports a human-readable `reason` and a list of `conditions` the user must
   satisfy before retrying (e.g. fix SSH key permissions, check host
   reachability, make the path writable, free disk space, supply a valid
   DeepSeek export, repair the DSH session),
3. stores the failure, backup path and cleanup hint in the binding state and
   renders them inline in the UI.

The DSH side is **never** edited by direct file manipulation. If events were
already appended to DSH before a failure, the report instructs the user to
remove them via the DSH UI (third-party plugins may not truncate another
component's session log).

> **Warning — write-back edits live files.** Exports append lines to the
> original tool's active session files. Backups are taken before every write
> and restored on failure, but data loss is still possible. Keep your own
> backups and disable the `out`/`both` direction for sources you cannot afford
> to lose.

## Storage and lifecycle

- Bindings, cursors, DSH sequence watermarks, last-sync status and failure
  reports live in the DSH storage domain `conversation_sync` (JSON backend,
  version 1), tables `bindings` and `states`.
- Machine list, discovered sessions and key-path references are held in memory
  and refreshed by the discovery tick; key paths are durable DSH credentials.
- The SSH transport keeps one SFTP connection per machine (chained through jump
  hosts when needed) and reconnects on failure.
- HTTP route `/api/conversation-sync/rpc` (POST) exposes `status`, `machines`,
  `sessions`, `bindings`, `setKey`, `pair`, `unbind`, `sync`. It is owner-only,
  as all DSH web routes are.
