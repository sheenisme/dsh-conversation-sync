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

The panel opens from **Settings → Conversation sync**, from the **sidebar icon**,
or from **Plugins → Conversation sync**. Both entries are on by default and each
has its own switch on the page (`Show this page in: ☑ left sidebar ☑ Settings`),
so you can keep only the one you use.

Two collapsible trees, side by side:

- **Left — DSH:** workspace, then its sessions. The workspace is the top level
  because a session does not record which profile opened it: the session header
  has no such field and the sessions directory is shared by every profile, so
  grouping by profile would be a guess. Workspace is also exactly how DSH's own
  sidebar groups sessions.
- **Right — machines:** machine, then tool, then its sessions. Each machine
  shows its SSH key state inline (and lets you set it), plus any discovery
  error, so an unreachable host explains itself instead of showing an empty list.

Selecting one session on **each** side is what enables the buttons — that pair
is the unit of work: the left session is what gets written or grown, the right
one is the source or destination. A row reading **New session** on the left
covers importing a conversation DSH has never seen.

Then choose how the pair behaves. The arrows point at where the text goes, so a
button never has to be decoded:

| Button | What it does |
| --- | --- |
| **← Import into DSH** | Append the machine session into the selected DSH session. The machine file is not touched. |
| **Export to machine →** | Append the DSH session into the selected machine file. DSH is not touched. |
| **Both ways ⇄** | Both legs, unless one side is clearly newer — then only that side is written. |
| **Newer side wins ⤵** | Compare, then write only the newer side into the older. Nothing happens when they are in step. |

The group is framed and captioned because those four buttons act on the two
selections above and on nothing else; they stay disabled until both exist.

Each row in either tree shows its state at a glance: **selected** (accent
outline), **already bound** (green tint and a dot), and **bound more than once**
(a `×N` badge). A bound session does **not** disappear — binding one session to
several sources is allowed on purpose, because that is how two conversations get
merged into one.

Bindings are listed at the bottom. The header carries a **select-all** switch
(one round trip, so a fast double click cannot leave the table half-updated), a
count of `checked/total`, and **Sync checked** — the batch button for everything
that is ticked. Each row has:

- a **checkbox** — only checked bindings are synced, by a bulk run, by
  **Sync checked**, or by the automatic poll;
- a **direction** — `Auto` (the default for a new binding) or a pinned one;
- a **mode** — **Manual** (the default) or Automatic;
- the **newer side** at that moment, with the reason on hover;
- **Sync now** (this row only) and **Remove**.

### Which side is newer?

Before anything is written, both sides are compared and the direction is derived
from the comparison. The comparison is anchored on the **last sync**, not on a
direct comparison of the two timestamps, because those two numbers mean
different things: a DSH event's `time` is the conversation's own timestamp
(importing a year-old rollout writes year-old stamps), while a file's `mtime` is
when it landed on that disk (a copy makes ancient content look brand new).
Comparing them directly calls a freshly copied old file "newer" forever, and the
next automatic sync then re-imports it on every poll.

Asking instead *did this side change since we last synced?* is symmetric and
correct: a side that has not moved cannot hold anything the other is missing. The
recorded stamps are the file's mtime and size, and the newest DSH event time at
the moment the sync succeeded. An empty or missing source file is never "newer" —
there is nothing to read from it — so the sync exports instead.

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
   active binding. Every import lands in one `会话同步` workspace, and a
   remote session's title is prefixed with its machine (`BAAI-Ascend · ...`),
   because DSH requires a session's working directory to equal its workspace
   path — a per-machine folder would have to be its own workspace.

   Sessions imported by an older build that *did* make one workspace per machine
   are moved into `会话同步` on the next start, header included, so the storage
   ends up as one folder either way.

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

## Before and after every sync

Both directions go through the same three steps, so a sync either lands
completely or not at all:

1. **Pre-flight (read-only).** The plugin's data directory must be writable, the
   source must be readable, the target DSH session must exist, and the direction
   must be known. If any check fails the sync is refused *before* anything is
   touched, and the reason names the check that failed.
2. **Backup.** The external file is copied into
   `~/.dsh/conversation-sync/backups/<binding>/`, and the DSH session's whole
   on-disk directory is copied aside. Both copies are read back before the first
   write — a backup that cannot be read is not a backup, so the sync aborts.
3. **Verify, then roll back on failure.** After writing, both sides are read
   again: the exported file must really end with the bytes that were written, and
   an imported session must really contain readable messages. A mismatch is a
   failure, and the previous state is restored from the backups.

The DSH side is restored at file level (the session directory is copied back, or
removed entirely when the sync created it), because `SessionPersistence` has no
delete or truncate API — editing a live log through it would risk corruption.

## When a sync fails

Every external write is preceded by a backup, which is restored if anything goes
wrong. The report tells you the reason and the concrete preconditions to satisfy
before retrying — SSH key permissions, host reachability, writable paths, disk
space, and so on. Nothing is left for you to guess.

> **Warning — exporting modifies live files.** Export appends messages to the
> original tool's session files. Backups are taken before every write and
> restored on failure, but data loss is still possible. Keep your own backups
> and leave the export direction off for sources you cannot afford to lose.

## Releasing

A `v*` tag publishes automatically (`.github/workflows/publish.yml`) via npm
Trusted Publishing — no token in the repo. It only works after a one-time
*Trusted Publisher* entry is added on the package's npm settings page for this
repository and workflow file.

## Development

```bash
npm test        # unit tests, node:test, no network and no DSH needed
```

171 unit tests cover the pure modules — adapters, event building, `.ssh/config`
parsing, discovery, rollback diagnostics and file-level session restore, host
keys, SQLite reads, jump-chain planning, the connection pool, the system-ssh
transport, the one-folder migration, and the browser half through a stub module
loader. CI additionally installs the packed plugin into five real DSH releases
and drives the actual RPC surface through eleven scenarios.

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
