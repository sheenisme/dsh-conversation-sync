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

For an SSH machine the private key is resolved in a fixed order, so a host that
already works from a terminal usually needs no configuration at all:

1. the **path** saved for that machine as a DSH credential
   (`conversation-sync/ssh-key/<machineId>`, set through the UI's
   `Set key path` button);
2. the host's own `IdentityFile` from `~/.ssh/config`;
3. the conventional `~/.ssh/id_ed25519`, `id_ecdsa`, `id_rsa`, first one that
   exists.

Only the path is stored; key contents never enter plugin configuration, and the
file is read at connection time. Every hop in a `via[]` chain resolves its own
key by the same rules. When none of the three applies, the error names the
machine and lists those options rather than reporting a missing credential
reference. If a path exists but cannot be read, the error names the key file —
a wrong path used to surface as `cannot resolve home: ENOENT … /home/me/.ssh/…`,
which pointed at the remote home directory instead of the local key.

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
- SSH runs through the system `ssh` binary, not a bundled SSH library. This is
  not a preference: `ssh2` ships a native build script, and pnpm refuses to
  install a dependency with unapproved build scripts unless the *profile* opts
  in through `allowBuilds` — which a plugin cannot ask for. Declaring it as an
  optional peer meant a clean install had no SSH at all, and every remote machine
  failed with `Cannot find package 'ssh2'`. Driving `ssh` removes the native
  dependency and inherits the user's real `~/.ssh/config`: `ProxyJump`,
  `IdentityFile`, `Include`, `Match` blocks, agent forwarding and `known_hosts`
  all behave exactly as they do in the user's terminal. If `ssh` is unavailable
  the older `ssh2` path is still there as a fallback.
- Authentication resolves a key in three steps: the path saved for this machine,
  then the host's own `IdentityFile` from `~/.ssh/config`, then the conventional
  `~/.ssh/id_ed25519` / `id_ecdsa` / `id_rsa`. A saved path that no longer exists
  falls back to the later steps and logs a warning instead of failing the machine,
  because a moved key used to mean "no sessions at all" with no hint why. A
  `.pub` path means "use the agent".
- A machine that cannot be reached is reported once. The transport remembers a
  connection-level failure (auth, refused, DNS, host key, timeout) and every
  later command on that transport fails immediately, because discovery asks for
  the remote home and then each tool root: without it, one dead host cost four
  full connect attempts and produced four copies of the same error. Measured
  against a real `~/.ssh/config` with unreachable hosts, per-machine scan time fell
  from 70-112s to about 5s.
- A scan asks each root for its whole tree in one `find`, and each file for its
  size, line count and first bytes in one `wc`/`stat`/`head`. This matters over a
  tunnel: the first version listed one directory per round trip and counted lines
  by reading up to 8 MB in 256 KB chunks, which came to roughly 1900 round trips
  for a host with 55 rollouts — the scan never finished. The same host now
  completes in about 20 seconds.
- Host keys are checked by `ssh` itself through the user's `known_hosts`, and
  additionally recorded in `known_hosts.json` in the plugin data directory for
  the `ssh2` fallback path. The default `hostKeyMode` is `accept-new`: a server seen
  for the first time is trusted and recorded (trust on first use), and a *changed*
  key is refused — which is exactly the case that matters, because a changed host
  key on a machine you already sync with means either a rebuild or an
  interception. Set it to `verify` to refuse unknown servers too, or `off` to skip
  the check. This is deliberately not silent: the refusal is reported through the
  normal failure diagnostics with what to do about it.
- Two cursors are tracked per binding, and they are different numbers. `dshSeqs`
  records how far the DSH session has been written (the import cursor); `outSeqs`
  records how much of it has already been copied into the external file (the
  export cursor). Sharing one map was a real bug: importing a conversation pushed
  the shared cursor to the end, so the first export afterwards believed there was
  nothing new and wrote an empty file.
- Connections are pooled per machine: discovery runs every 30 seconds and each
  sync poll needs the same host, so without a pool every tick opened a fresh TCP
  connection, key exchange and authentication for every hop. A pooled
  connection is dropped only when the call fails at the link level (a dead SFTP
  channel, a dropped socket); ordinary errors such as "that file is not there"
  keep it open, because reconnecting would waste a handshake per tick. The pool
  is closed when the plugin unloads, so a reload cannot leak sockets.
- The system-ssh transport keeps one multiplexed master connection per machine
  (`ControlMaster`/`ControlPersist`) instead of one SFTP channel per call, so a
  scan of many roots costs one handshake rather than one per command.
- Directory creation walks the path one component at a time rather than using
  `fs.mkdir(..., {recursive: true})`. On Linux, recursive mkdir can loop forever
  when the filesystem answers ENOENT for a parent that exists (`/proc` does), and
  that hung a whole sync with no error; the component walk turns it into a normal
  reported failure. Every local filesystem call also has a 30s ceiling, so a
  wedged mount cannot stall the poll loop indefinitely.
- HTTP route `/api/conversation-sync/rpc` (POST) exposes `status`, `machines`,
  `sessions`, `bindings`, `setKey`, `pair`, `unbind`, `sync`. It is owner-only,
  as all DSH web routes are.

## Why credential names are generated, not derived

A saved SSH key path lives in DSH's credential store, addressed by a reference
name. That store enforces `REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/` and
validates the entire YAML file when it loads — a name outside the grammar is a
`TypeError` at startup, not a warning.

Machine ids are not identifiers: `ssh:BAAI-Ascend` carries a colon and a dash.
An earlier build built the reference by concatenation,
`conversation-sync/ssh-key/${machine.id}`, so saving a key path wrote
`conversation-sync/ssh-key/ssh:BAAI-Ascend` into `~/.dsh/.credentials.yaml` and
DSH could not start again. The plugin could not repair it either: it never got
to run.

The reference is now generated:

```js
keyRefFor('ssh:BAAI-Ascend') // conversation_sync_ssh_key_ssh_BAAI_Ascend_1e701114
```

Every character outside the grammar becomes `_`, and a truncated SHA-1 of the
original id keeps two ids that normalise alike (`ssh:A-B` vs `ssh:A_B`) from
sharing one credential. `isValidKeyRef()` guards every read and write, so an
out-of-grammar name is treated as "nothing saved" rather than thrown.

For stores already poisoned by an older build, `scripts/fix-credentials.mjs`
runs outside DSH, renames only the invalid keys in the `refs:` section, keeps
every value, and writes a `.bak-` copy. `test/fix-credentials.test.js` and the
`keys` CI scenario both pin this; the scenario asserts on the YAML file, because
a unit test cannot catch a name that only fails on the next process launch.

## Testing

`npm test` runs 136 unit tests (`node:test`, no network and no DSH needed). Each tool format has a
fixture in `test/fixtures/` that is pushed through the real pipeline —
`readJsonlDelta` → `buildEvents` → `messagesFromEvents` — so the assertions are
about imported conversation content, not internal shapes. `test/dsh-sessions.test.js`
pins the listing contract (a row's `count` is messages, never raw events) and the
`strict` read that an export needs. `test/openssh.test.js` drives the system-ssh
transport through a stand-in `ssh` on PATH, so the command building, shell
quoting, exit-code mapping and the "fail once, not once per root" cache are
covered without a server. `test/client.test.js` loads `client.js`
through a stub module loader so the browser half is testable too: it fails when a
service is used but missing from `inject` (that was a real bug — without
`sessions` the sidebar never learned about a freshly imported session), when the
`settings.section` entry is not registered, or when an `en`/`zh` key drifts.

`scripts/ci/` holds the harness-level checks, which are what catch format bugs
that unit fixtures cannot:

| Script | Purpose |
| --- | --- |
| `install-dsh.mjs` | installs one DSH version so it can actually run under plain Node — it reads `@deepseek-ai/dsh-app-boot`'s peer ranges from the registry, because npm does not install the peers of a transitive package |
| `harness.mjs` | shared profile bootstrap, health-line wait, activation check and auth-cookie handshake |
| `boot-check.mjs` | "does this DSH version support the plugin": install, boot, import, read back |
| `scenario.mjs` | `import`, `export`, `formats`, `failure`, `reimport`, `direction`, `keys`, `ssh` — the user journey over the real RPC surface |

`.github/workflows/ci.yml` runs three jobs:

| Job | What it proves |
| --- | --- |
| `unit` | the pure modules behave, on the oldest supported Node (24.9.0) and the latest 24.x |
| `compatibility` | the plugin activates and imports a conversation on each of the **five most recent DSH releases** |
| `functional` | the user journey on the two newest releases: import, export, all five tool formats, failure reporting, no duplicate re-import, that an explicit sync direction is honoured, the SSH key resolution order, and a full discover-and-import over the SSH transport |

A version counts as supported only when `boot-check` exits 0, which requires both
that no bundle failed to activate and that a conversation really landed in a DSH
session. The version list is resolved at run time by
`scripts/ci/recent-versions.mjs` rather than pinned in the workflow, so the
matrix cannot silently rot; a release that is genuinely broken upstream is
listed in that script's `BROKEN` map with a reason and surfaces as a CI warning
instead of a red job.

Running the harness locally against any installed DSH:

```bash
node scripts/ci/install-dsh.mjs --version 0.2.2-rc.5 --dir /tmp/dsh
node scripts/ci/boot-check.mjs --dsh /tmp/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js \
  --tarball "$(npm pack --silent)" --home /tmp/dsh-home
```

The harness needs `pnpm` on `PATH` (`dsh plugin add` shells out to it) and takes
an absolute tarball path — `dsh plugin add` changes directory into the profile
first, so a relative path is resolved as a registry package name.

### What only a harness can catch

Four defects in this plugin were invisible to the unit suite because they live in
the wiring between the RPC surface and the modules, not inside any one module:

- `tool/result` written in the retired V3 shape — every conversation containing a
  tool call failed to import;
- a `tool/call` that was not advertised on the preceding `assistant/message` —
  the session log then read back as corrupt;
- `syncAll` dropping its direction argument — clicking Export ran an Import;
- the export cursor sharing a map with the import cursor — the first export
  wrote an empty file and reported success.

The `direction` scenario exists specifically because of the last two. It syncs a
binding stored as `in` with an explicit `out` and asserts the file received
content; that is the only level at which the bug is observable.
