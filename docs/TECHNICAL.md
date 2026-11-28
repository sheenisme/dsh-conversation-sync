# Conversation sync — technical details

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
through `sessionPersistence.create()` and attached to the single `会话同步`
workspace at `~/.dsh/conversation-sync/workspaces/sync`. One workspace, not one
per machine: `dsh-workspace`'s `attachSession()` throws unless the session's
`cwd` resolves to exactly the workspace path, and `candidateMatches` filters by
that same equality, so a per-machine directory would have to be a separate
workspace. Machines are distinguished by the session title prefix instead
(`BAAI-Ascend · <title>`; local sessions keep the bare title). Live sessions are appended via
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

**DSH → external (`out`).** New events on a bound DSH session are read by DSH
sequence number — not just messages: `tool/call` and `tool/result` are read too,
so a tool pair survives the crossing (see `readDshSessionExchanges` in
`lib/dsh-sessions.js`). Each tool then gets its own native line shape from
`lib/native.js`, tagged with `dshSyncId`, and the result is appended through the
machine's transport. A per-session sequence watermark prevents duplicates.

Why a separate writer instead of the adapter's renderer: a flattened
`{"role":"user","content":"…"}` line is readable by *our* parser but not by the
tool. Claude Code needs a `parentUuid` chain, a `cwd`, a model-bearing assistant
message and `tool_use`/`tool_result` blocks; Codex needs one `session_meta`
header and monotonically increasing `ordinal` values across appends. The
`native` CI scenario exports a session and imports it back, asserting the message
count is unchanged, so a shape the real tool would reject fails the build. Field
rules per tool are in [FORMATS.md](FORMATS.md). DeepSeek export ZIP and OpenCode are import-only;
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
  as all DSH web routes are. Until storage has opened it answers `503 not ready`;
  the panel treats that as a loading state, because rendering it as "no sessions"
  made the panel look empty for the first seconds after it opened.

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

The `keys` CI scenario asserts on the YAML file rather than on the RPC reply,
because a name that is only rejected on the next process launch is invisible to
a unit test. Builds up to 1.0.5 wrote such a name; those versions were never
published to npm, so no released build can have produced one.

## Testing

`npm test` runs 225 unit tests (`node:test`, no network and no DSH needed). Each tool format has a
fixture in `test/fixtures/` that is pushed through the real pipeline —
`readJsonlDelta` → `buildEvents` → `messagesFromEvents` — so the assertions are
about imported conversation content, not internal shapes. `test/dsh-sessions.test.js`
pins the listing contract (a row's `count` is messages, never raw events) and the
`strict` read that an export needs. `test/native.test.js` covers the writers in
`lib/native.js`: it asserts the ENVELOPE each tool requires (a `parentUuid` chain
and `cwd` for Claude Code, `session_meta` plus ascending `ordinal` for Codex),
that appending continues the numbering instead of reusing it, and that a tool
result never turns into a user message. The `native` CI scenario closes the loop
by exporting a session and importing it back, so a shape the real tool would
reject fails the build. `test/openssh.test.js` drives the system-ssh
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
| `scenario.mjs` | `import`, `export`, `native`, `formats`, `failure`, `empty`, `reimport`, `direction`, `keys`, `ssh`, `safety`, `placements`, `bindings` — the user journey over the real RPC surface |

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

### Releasing

`.github/workflows/publish.yml` runs on a `v*` tag, refuses to publish unless the
tag equals `package.json`'s version and the tarball contains the files the plugin
needs at runtime, then publishes with **npm Trusted Publishing (OIDC)** — no
long-lived token. npm verifies the workflow's OIDC identity and attaches a
provenance statement to the release.

That requires one manual setup step, once: the package's npm settings page needs
a *Trusted Publisher* entry naming this repository and this workflow file. Without
it the publish step fails authentication.

A granular token with "Bypass 2FA" is deliberately not the mechanism any more.
npm is deprecating 2FA-bypassing tokens for direct publishing, and a token
without that flag authenticates fine and then dies with `EOTP` plus a browser URL
nobody can open from CI — which is exactly what the first tagged release did.

### What only a harness can catch

Several defects in this plugin were invisible to the unit suite because they live
in the wiring between the RPC surface and the modules, not inside any one module:

- `tool/result` written in the retired V3 shape — every conversation containing a
  tool call failed to import;
- a `tool/call` that was not advertised on the preceding `assistant/message` —
  the session log then read back as corrupt;
- `syncAll` dropping its direction argument — clicking Export ran an Import;
- the export cursor sharing a map with the import cursor — the first export
  wrote an empty file and reported success;
- an import with no records materializing a session that held only a title — a
  compacted rollout looked like a successful import and displayed nothing.

The `empty` scenario pins the last one: it imports a real compacted Codex rollout
and asserts the import is refused with a reason, that no session was created, and
that no dead binding was left in the list.

The `direction` scenario exists specifically for the `syncAll` and cursor
defects. It syncs a binding stored as `in` with an explicit `out` and asserts the
file received content; that is the only level at which the bug is observable.

The `bindings` scenario covers the binding contract, none of which a unit test
can reach: a new binding is manual (`autoSync === false`) and checked, the
listing reports which side is newer, unchecking removes the binding from a bulk
run (the witness is its `lastSyncAt`, since pairing performs the first sync
itself), re-checking puts it back and writes a non-empty file, and direction
`auto` does nothing when nothing changed but imports as soon as the source is
appended to.

## A title is part of the conversation

DSH has no title field in the session header: `dsh-session-title` folds the LAST
`session/title` event in the log (`events.findLast(item => item.type ===
'session/title')`), so a session renamed twice shows its second name and a
header-only read shows a stale one. `listDshSessions()` therefore reads the
latest title event, and `readDshSessionTitle()` returns the same value for the
export path.

For the other direction the title rides on the exported lines as a `dshTitle`
field. `titleFromLine()` checks for the marker before parsing any JSON — a scan
reads thousands of lines from tools that know nothing about DSH titles — and
`readJsonlDelta()` attaches the first title it finds to every record it returns,
so an import can restore the name even when the session is created fresh.

Two rules follow from "the title belongs to the conversation":

* An import with no carried title names itself after the first user message,
  never after the file path. A binding's `name` defaults to the external path,
  so passing that through named every imported session after a filename — the
  first end-to-end assertion caught it (`the session is still named after its
  path`).
* A row's `name` (the tool's own id) is kept as the binding key but is shown
  only as small secondary text. What a reader sees is the title, because a UUID
  and a rollout timestamp cannot tell two conversations apart.

## Three lines can still be a conversation

Codex writes several kinds of rollout into `~/.codex/sessions`. They are told
apart by `session_meta.payload.thread_source`:

- `user` — a conversation a person started.
- `guardian_review` — an automated review of another thread.
- `subagent` — a worker delegated by another session.

On the machine this was built against, 18 of 40 readable rollouts were `user`;
the rest were automated. The panel lists the automated ones only when
**automated threads** is ticked, because "where are my own sessions" was a
reported problem and the answer was "they are there, mixed in with 22 reviews".

A summarised thread is left as exactly three lines: `session_meta`, a
`response_item` whose payload is `{"type":"compaction","encrypted_content":"…"}`,
and `event_msg/thread_settings_applied`. The compaction body is encrypted, so
there is nothing to import. `scanLines()` reports `importable: false` for those,
the panel renders them dimmed and unselectable, and the machine header prints how
many there are. Before this, they looked like ordinary rows and choosing one
produced `sync failed: … has no importable messages` only after the click.

`compacted` is **not** "we saw a compaction marker"; it is
`importable === false`. Keying it on the marker looked precise and was wrong: a
Codex `session_meta` line is ~19 KB, so the 8 KB head window ends *inside* that
single line and never reaches the compaction payload. The switch was therefore
off while compacted stubs stayed on screen. Emptiness is the honest signal — a
thread with real messages is never empty — and the marker is only corroboration.
`test/discovery.test.js` encodes exactly that case with a 40 KB `session_meta`.

Two traps found while building this, both now encoded in tests:

1. **Size is not evidence.** The first version decided `importable` from how
   many bytes it had read: a window that ended before the end of the file was
   taken to mean "there must be more conversation in there", so a big file
   counted as a conversation and a small one did not. Measured against real
   data that rule was exactly inverted — 15 of 30 Claude sessions were hidden
   (four small ones with a full exchange, thirteen around 150 KB) while every
   file over 624 KB was listed on the strength of its size alone. The scan now
   asks the tool's own adapter whether the bytes it read contain a message or a
   tool call, and if that says no it reads one tail window before giving up. A
   file is a conversation because of what it contains, never because of how
   many bytes it has.
2. **The user seat is not the user.** Codex injects `<environment_context>`,
   `# AGENTS.md instructions`, `<external_ide_context>` and its own multi-agent
   briefs as `role: "user"` messages. Titles taken from those read
   `<environment_context> <cwd>/Users/…` for every row. `isInjectedText()` skips
   them; the title is the first thing a person actually typed.

Archived threads move to `~/.codex/archived_sessions` and are no longer under
`sessions/`. That directory is scanned too — otherwise archiving a conversation
made it disappear from the list even though the file is intact.

## An idle panel should cost nothing

The panel polls while it is open, and every poll used to ask the host for a
newer-side comparison per binding. Each comparison is a `stat` over the
binding's transport, which on SSH is a network round trip — so a panel left open
in a background tab kept dialling every remote machine every five seconds,
forever, to answer a question nobody was looking at. Three changes:

- `document.hidden` gates the interval. A hidden tab does no work, and becoming
  visible triggers one immediate refresh so the panel is never stale when the
  user comes back.
- Comparison results are cached for two seconds and de-duplicated by promise, so
  two polls in flight share one `stat` instead of stacking. A completed or
  failed sync drops the entry, because both sides just moved and the cached
  answer is wrong by construction.
- Every `load()` takes a generation number. A slow poll that resolves after the
  user pressed a button would otherwise write its older snapshot over the fresher
  one — the panel could show a binding as unchecked immediately after the user
  checked it. A stale response is now dropped instead of applied.

## What the panel relies on being true

Three details are easy to get wrong because they fail quietly:

- **The RPC path is root-absolute.** The route is served at
  `/api/conversation-sync/rpc`. A relative `api/…` works while the shell is
  mounted at `/` and 404s the moment the app is hosted under a path prefix.
- **The stylesheet lives inside an effect.** The `<style>` node is appended once
  and removed when the plugin unloads. Appending without a disposer leaves the
  CSS behind after a disable or reload, and a module-level "already applied" flag
  makes it impossible to apply again.
- **Slot labels are functions, not strings.** The sidebar and the settings nav
  call `t('settings.nav')`; the host re-reads the label whenever the locale
  revision changes. A hardcoded label shows Chinese to an English user and never
  updates.

`meta.detail` in `locale/*.json` is a fourth: the host reads that path and, if
the file is missing, reports `plugin-manager/detail-unavailable` **instead of**
falling back to the README. It must name a file that ships — here
`docs/TECHNICAL.md` and `docs/TECHNICAL.zh-CN.md`. `test/manifest.test.js` pins
the manifest details that the host reads by name (`exports`, the bundle patch,
`engines.dsh`, optional peers).

## The status strip exists to expose a stale host

`{action:'status'}` reports `version`, `startedAt` and the last 20 activity
entries. That is not decoration: the client bundle is re-served on every page
reload while the host process keeps running its old code until the app restarts,
so after an update the panel can call an action the host has never heard of
(`unknown action: setBindingAll` was exactly this). Showing the running version
makes the mismatch visible instead of mysterious, and every pairing, sync and
removal now records a line, so a click has an outcome that survives a reload.

## Two two-sided directions, and why both exist

`both` and `auto` answer different questions, which is why the panel offers both
rather than one "bidirectional" switch:

- **`both` — each side catches up.** Both legs always run. Each leg keeps its own
  cursor (`state.dshSeqs` for the import, `state.outSeqs` for the export) and only
  appends what the other side does not already have. Running it twice adds
  nothing, so no comparison is needed or wanted.
- **`auto` — the newer copy wins.** Only one leg runs, chosen by
  `compareSides()`; when the two sides are in step the result is `none` and
  nothing is written at all.

A real bug lived here until a scenario caught it: `state.outSeqs[sessionId]` was
recorded as the **last exported seq**, while `readDshSessionMessages({fromSeq})`
treats `fromSeq` as an **inclusive** start. Every repeat sync therefore re-exported
that one message, and a `both` binding grew its file by one duplicate line each
time it ran. The cursor is now stored exclusive (`seq + 1`), and the `safety`
scenario asserts that a second `both` pass imports 0 and writes 0.

## Why the sidebar entry needs a `key`

A `sidebar.panellist` entry is keyed by `id`, but the page it opens lives in the
`main` slot, which is keyed by `key`. Clicking the entry calls
`ctx.layout.selectPanel(id)`, and `LayoutController.selectPanel` throws

    layout.selectPanel: main panel "<id>" is not registered

unless `ctx.slots.entries('main').some(entry => entry.options.key === id)`.
Registering `main` with `id` therefore produces an entry that looks installed
and opens nothing at all — no error in the console, no visible change. The two
values must be identical, and `test/client.test.js` asserts exactly that.

The icon is drawn separately: the sidebar renders
`renderFactorySlot('sidebar.panel.icon', {id, size, active}, {only: id})`, so a
plugin only registers the panellist entry (with its component) and lets the
sidebar ask for the glyph.

## Which side is newer

`lib/newer.js` decides the direction from a comparison, and the comparison is
anchored on `lastSyncAt` plus the stamps recorded at the last successful sync
(the file's mtime and size, and the newest DSH event time), not on a direct
comparison of the two timestamps.

The reason is that the two numbers mean different things. A DSH event's `time`
is the conversation's own timestamp, so importing a year-old rollout writes
year-old stamps; a file's `mtime` is when it landed on that disk, so a copy makes
ancient content look new. Comparing them directly declares a freshly copied old
file the winner forever, and the next automatic sync re-imports it on every poll
— which is exactly what happened: a fixture whose conversation was 329 days old
was reported as "the source changed 329d after DSH did" because its mtime was
recent.

Asking *did this side change since the last sync?* is symmetric and has no such
failure mode. Two consequences are pinned by tests:

- an empty or missing source file is never "newer" — there is nothing to read
  from it, so the sync exports (`the source file is empty` /
  `the source file does not exist yet`);
- `auto` with nothing changed resolves to `none`, and `syncBinding` returns
  `{imported: 0, written: 0, direction: 'none', skipped: true}` without touching
  either side. Rewriting a file that is already correct makes "did it change?"
  unanswerable.

## Pre-flight, backup and verification

Three guarantees run around every sync, in both directions, and all three are
exercised by the `safety` scenario because none of them is visible to a unit
test:

1. `preflight()` in `lib/rollback.js` is read-only and runs before anything is
   written. It checks the plugin data directory (`data-root`), that the source is
   readable (`source-read`), that the target DSH session exists (`dsh-session`)
   and that the direction is known. A refusal returns the same
   `{reason, conditions}` shape as a real failure plus `preflight: true` and the
   id of the check that failed, so the panel can say *which* precondition is
   wrong instead of "sync failed".
2. `SyncRollback.begin()` copies the external file **and** the DSH session's
   whole directory, then reads both back. A backup whose byte count disagrees
   with the original aborts the sync before the first write — a backup you cannot
   restore from is worse than no backup, because it looks like safety.
3. `SyncRollback.verify()` re-reads both sides after the write. The exported file
   must end with exactly the bytes that were written, and an imported session
   must contain readable messages. Anything else raises with `phase: 'verify'`
   and the caller rolls back.

The DSH side is restored at file level because `SessionPersistence` exposes no
delete or truncate operation. `lib/dsh-store.js` therefore copies the session
directory (`backupSessionDir`), copies it back (`restoreSessionDir`), or removes
it when the sync created the session (`removeSessionDir`). Session logs are
multi-frame zstd, so every reader here splits frames on the `28 b5 2f fd` magic —
decompressing the whole file returns only the header frame.

`lib/dsh-migrate.js` uses the same frame handling to move sessions that older
builds imported into per-machine workspaces: it copies the directory, rewrites
the `cwd` in frame one (leaving every event frame byte-identical), removes the
original, and the caller attaches the session to the single `会话同步`
workspace. Moving the files alone is not enough — a session appears in a
workspace only if that workspace's record lists it, which is how a migrated
session can sit on disk and be invisible in the UI.

Two append bugs are pinned by unit tests rather than by a scenario, because both
are visible in the event stream: `persistence.stat().eventCount` reports `0` for
a session created in the same process, so `appendSession` derives the current
length from the log (`inspectDshLog`), and the next turn number comes from
`data.turn` (not the envelope) so an append never restarts at turn 1 — the
backend rejects both with `append seq mismatch` and `turn/start does not open the
expected turn`.
