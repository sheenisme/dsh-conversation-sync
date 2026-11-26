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
| `workbuddy` | `~/.workbuddy/projects/**`, `~/.workbuddy-ai/projects/**`, `~/.codebuddy/projects/**` | Rows are `message` (content blocks `input_text`/`output_text`), `reasoning`, `function_call` and `function_call_result`. Calls join their results by **`callId`** (not the row `id`). Rows flagged `skipRun`/`isMeta`/`isCompactInternal`/`isCompacted` are skipped. |
| `trae` | `~/.trae/cli/**`, `~/.trae-cn/cli/**` | Codex-shaped rollouts plus `event_msg`/`user_message`. Each user turn is written **twice** (real event + request echo); the echo is dropped on read, including when the two land in different reads. `history_mutation` with `operation: replace` replays prior history and is skipped. |
| `antigravity` | `~/.gemini/antigravity{,-cli,-ide}/brain/<uuid>/.system_generated/logs/transcript.jsonl` | `USER_EXPLICIT`/`USER_INPUT` and `MODEL`/`PLANNER_RESPONSE` rows are the conversation; `MODEL`/`GENERIC` is harness step logging, `SYSTEM`/`SYSTEM_MESSAGE` and `CHECKPOINT` are noise — all skipped. User text is unwrapped from `<USER_REQUEST>` and `<ADDITIONAL_METADATA>`. |
| `opencode` | `~/.local/share/opencode/opencode.db` (also `$XDG_DATA_HOME`) | SQLite. Both the modern (`session`/`session_message`) and legacy (`session_v2`/`message`/`part`) schemas are read; the table is chosen by presence. The database is copied (with `-wal`/`-shm`) to a temp directory and opened read-only so a running OpenCode never contends. **Import-only** — writing into a live SQLite from a plugin is unsafe. |
| `jsonl` | any path | Each line needs `role` (`user`/`assistant`/`tool`/`system`) plus `content` or `text`. Timestamps may be ISO strings or epoch numbers. |
| `deepseekExport` | DeepSeek web export ZIP | Requires `manifest.json` with `export_format_version: 3`; reads `chat_session_index.json` and `chat_sessions/<id>.json`; one DSH session per chat. **Import-only** — the archive is immutable. |

Discovery (`lib/discovery.js`) scans each machine at
`~/.claude/projects` (depth 3), `~/.codex/sessions` (depth 4),
`~/.workbuddy/projects` and `~/.workbuddy-ai/projects` and
`~/.codebuddy/projects` (depth 3), `~/.trae/cli` and `~/.trae-cn/cli`
(depth 4), the three Antigravity `brain` bases (depth 4), and
`~/.dsh-conversation-sync/exports` (depth 2), capped at 5000 entries. The
OpenCode database is probed separately (it is a file, not a tree) and only on
the local machine. A tool root that does not exist is normal and silently
skipped; a real read failure is reported per machine. Each
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

The v4 format is strict, and two of its rules are easy to get wrong in a way
that only shows up when the log is read back:

- a `tool/result` must be a first-class **`role: 'tool'`** message whose
  `toolCallId` equals `source.callId`, with plain text content. The older shape
  (`role: 'user'` wrapping a `{type: 'tool-result'}` block) is rejected with
  *"requires a tool-role message"*.
- every `tool/call` must first be **advertised** as a `{type: 'tool-call'}` block
  inside the preceding `assistant/message`, with the same `id`/`name`/`arguments`.
  Without it the log fails to parse with *"has no advertised tool lifecycle"*
  and the whole session reads as corrupt.

Multiple assistant records in one turn (for example, reasoning then an answer,
or an answer after a tool result) each get their own `step/start`…`step/end`
pair inside a single turn; collapsing them into one step drops every message
after the first.

**DSH → external (`out`).** New `user/message` and `assistant/message` events on
a bound DSH session are read by DSH sequence number, rendered in the original
tool's JSONL format tagged with `dshSyncId:dshSessionId:seq`, and appended to
the external file via the machine's transport. A per-session sequence watermark
prevents duplicates. DeepSeek export ZIP and OpenCode are import-only;
exporting to either is rejected with a clear error rather than a silent no-op.
An unknown DSH session id fails with *"DSH session … does not exist; re-select it
on the left"* — it used to return `written: 0` as if the export had succeeded.

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
- Authentication uses a private-key file, or `ssh-agent` when the configured
  path ends in `.pub`. The agent path is what makes passphrase-protected keys
  usable: ssh2 cannot decrypt them without the passphrase, and storing a
  passphrase in plugin config would be worse than loading the key once.
- Host keys are checked, and remembered. `known_hosts.json` lives in the plugin
  data directory and records the fingerprint of every server the plugin has
  connected to. The default `hostKeyMode` is `accept-new`: a server seen for the
  first time is trusted and recorded (trust on first use), and a *changed* key is
  refused — which is exactly the case that matters, because a changed host key on
  a machine you already sync with means either a rebuild or an interception. Set
  it to `verify` to refuse unknown servers too, or `off` to skip the check. This
  is deliberately not silent: the refusal is reported through the normal failure
  diagnostics with what to do about it.
- Connections are pooled per machine: discovery runs every 30 seconds and each
  sync poll needs the same host, so without a pool every tick opened a fresh TCP
  connection, key exchange and authentication for every hop. A pooled
  connection is dropped only when the call fails at the link level (a dead SFTP
  channel, a dropped socket); ordinary errors such as "that file is not there"
  keep it open, because reconnecting would waste a handshake per tick. The pool
  is closed when the plugin unloads, so a reload cannot leak sockets.
- The SSH transport keeps one SFTP connection per machine (chained through jump
  hosts when needed) and reconnects on failure.
- Directory creation walks the path one component at a time rather than using
  `fs.mkdir(..., {recursive: true})`. On Linux, recursive mkdir can loop forever
  when the filesystem answers ENOENT for a parent that exists (`/proc` does), and
  that hung a whole sync with no error; the component walk turns it into a normal
  reported failure. Every local filesystem call also has a 30s ceiling, so a
  wedged mount cannot stall the poll loop indefinitely.
- HTTP route `/api/conversation-sync/rpc` (POST) exposes `status`, `machines`,
  `sessions`, `bindings`, `setKey`, `pair`, `unbind`, `sync`. It is owner-only,
  as all DSH web routes are.

## Testing

`npm test` runs 95 unit tests (`node:test`, no network). Each tool format has a
fixture in `test/fixtures/` that is pushed through the real pipeline —
`readJsonlDelta` → `buildEvents` → `messagesFromEvents` — so the assertions are
about imported conversation content, not internal shapes. `test/dsh-sessions.test.js`
pins the listing contract (a row's `count` is messages, never raw events) and the
`strict` read that an export needs.

`scripts/ci/` holds the harness-level checks, which are what catch format bugs
that unit fixtures cannot:

| Script | Purpose |
| --- | --- |
| `install-dsh.mjs` | installs one DSH version so it can actually run under plain Node — it reads `@deepseek-ai/dsh-app-boot`'s peer ranges from the registry, because npm does not install the peers of a transitive package |
| `harness.mjs` | shared profile bootstrap, health-line wait, activation check and auth-cookie handshake |
| `boot-check.mjs` | "does this DSH version support the plugin": install, boot, import, read back |
| `scenario.mjs` | `import`, `export`, `formats`, `failure`, `reimport` — the user journey over the real RPC surface |

`.github/workflows/ci.yml` runs the unit suite on two Node versions, `boot-check`
against the five most recent DSH releases, and the five scenarios against the two
most recent ones. A version counts as supported only when `boot-check` exits 0,
which requires both that no bundle failed to activate and that a conversation
really landed in a DSH session.
