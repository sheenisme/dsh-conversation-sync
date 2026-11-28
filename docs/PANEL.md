# The panel, screen by screen

This is the long-form guide to the Conversation sync page. The
[README](../README.md) has the short version.

## Where it lives

The panel opens from **Settings → Conversation sync**, from the **sidebar icon**,
or from **Plugins → Conversation sync**. Both of the first two entries are on by
default and each has its own switch on the page
(`Show this page in: ☑ left sidebar ☑ Settings`), so you can keep only the one
you use.

## The two trees

- **Left — DSH:** workspace, then its sessions. The workspace is the top level
  because a session does not record which profile opened it: the session header
  has no such field and the sessions directory is shared by every profile, so
  grouping by profile would be a guess. Workspace is also exactly how DSH's own
  sidebar groups sessions.
- **Right — machines:** machine, then tool, then its sessions. Each machine shows
  its SSH key state inline (and lets you set it), plus any discovery error, so an
  unreachable host explains itself instead of showing an empty list.

Selecting one session on **each** side is what enables the buttons — that pair is
the unit of work: the left session is what gets written or grown, the right one
is the source or destination. A row reading **New session** on the left covers
importing a conversation DSH has never seen.

Each row in either tree shows its state at a glance: **selected** (accent
outline), **already bound** (green tint and a dot), and **bound more than once**
(a `×N` badge). A bound session does **not** disappear — binding one session to
several sources is allowed on purpose, because that is how two conversations get
merged into one.

Every bound row also carries the **binding id** of the pair it belongs to, so
"which one is this linked to?" is answered on the row itself instead of by
opening the table. Selecting a session on one side expands and highlights its
counterpart on the other side automatically, even if that group was collapsed.

Two switches in the header decide what the right tree lists, both remembered for
the session:

- **Archived sessions** — on by default. Codex keeps finished work in
  `archived_sessions/`; those are real conversations, so they are shown unless
  you switch them off.
- **Compacted sessions** — off by default. A thread Codex has summarised keeps
  only an encrypted payload, so there is nothing to import; hiding it by default
  keeps the list to what can actually be paired.

The right tree also carries a **New session on this machine** row inside every
tool group. Sitting inside the group is what fixes the machine and the tool, so
an impossible pair cannot be picked; the host then suggests a path inside that
tool's own rollout directory (`~/.claude/projects/dsh-conversation-sync/…` and so
on) so the next scan finds the file. A destination that does not exist yet can
only receive an export — there is nothing to import from it.

## The four buttons

The arrows point at where the text goes, so a button never has to be decoded:

| Button | What it does |
| --- | --- |
| **← Import into DSH** | Append the machine session into the selected DSH session. The machine file is not touched. |
| **Export to machine →** | Append the DSH session into the selected machine file. DSH is not touched. |
| **Each side catches up** ⇄ | Both legs, always: each side receives what the other has and it does not. Running it twice adds nothing — this is the merge choice. |
| **Newer copy wins** ⤵ | Compare first, then write only the newer copy over the older one; does nothing when the two are in step. |

The group is framed and captioned because those four buttons act on the two
selections above and on nothing else; they stay disabled until both exist.

## The bindings table

The header carries a **select-all** switch (one round trip, so a fast double
click cannot leave the table half-updated), a count of `checked/total`, and
**Sync checked** — the batch button for everything that is ticked. Each row has:

- a short **binding id** (`bnd-1a2b3c4d`), so two bindings on the same session
  can be told apart and quoted when something goes wrong;
- a **checkbox** — only checked bindings are synced, by a bulk run or by
  **Sync checked**;
- a **direction** — `Each side catches up` (the default for a new binding), the
  newer-wins comparison, or a pinned single leg;
- the **newer side** at that moment, with the reason on hover;
- **Sync now** (this row only) and **Remove**.

There is deliberately **no automatic background sync**: every sync here writes
into another tool's live files, so it happens when you ask for it.

## The strip at the top

Above the trees sits a quiet status strip: a coloured dot (green ready, blue
working, red after a failure), the running plugin **version**, when this host
started, and the last few lines of activity — every pairing, sync and removal
writes one. The version matters more than it looks: the browser half reloads on
refresh while the host keeps its old code until the app restarts, so a version
older than the package you installed is the reason a new action answers
`unknown action`.

## Titles and previews

A rollout is named by its tool, not by its content: a Claude file is a UUID and a
Codex file is a rollout timestamp, so a list of them is a list of letters. Each
row therefore shows the conversation's **title** — the first thing that was
said — with the internal id kept underneath in small type, because that id is
what a binding is keyed on. A title longer than the row is cut at a clause
boundary and ends in `…`, never mid-word.

Hovering a row opens a card with the title, the tool, the message count, the
machine and the time, plus the first few lines of **both sides** of the
conversation. That is what makes two similar sessions distinguishable before one
of them is bound.

Titles travel with the conversation in both directions. DSH folds the latest
`session/title` event, so a rename made in DSH is what gets exported; the title
rides along on the exported lines as `dshTitle`, and an import restores it —
including when the session is created for the first time.

## Not every file is a conversation

Codex writes three kinds of rollout into the same directory:

| `thread_source` | what it is | shown |
| --- | --- | --- |
| `user` | a conversation you started | yes |
| `guardian_review` | an automated review of another thread | only with **automated threads** ticked |
| `subagent` | a worker thread delegated by another session | only with **automated threads** ticked |

When Codex summarises a thread it replaces the body with an **encrypted**
`compaction` payload and leaves three lines behind: metadata, that blob, and
settings. Those files are hidden by default (the **compacted sessions** switch
reveals them), and even then they cannot be selected — so pairing can no longer
fail with "no importable messages" after the fact. The machine header reports both counts, which is why
the number of rows you can click can be smaller than the number of files on disk.

Titles are also read from *deep* inside a file when necessary: Codex writes the
environment, `AGENTS.md` and its own briefs into `role: "user"` messages before
you type anything (a measured median of **153 KB** into a real rollout), and one
Claude session's first genuine prompt sat at byte **1,095,161** behind a
megabyte of tool output. The scan probes deeper offsets only for the files that
still have no title, and text a tool put in the user seat
(`<environment_context>`, `<system-reminder>`, `# AGENTS.md instructions`,
`You are Codex…`, …) is never used as a name.

## Which side is newer?

Before anything is written, both sides are compared and the direction is derived
from the comparison. The comparison is anchored on the **last sync**, not on a
direct comparison of the two timestamps, because those two numbers mean
different things: a DSH event's `time` is the conversation's own timestamp
(importing a year-old rollout writes year-old stamps), while a file's `mtime` is
when it landed on that disk (a copy makes ancient content look brand new).
Comparing them directly calls a freshly copied old file "newer" forever.

Asking instead *did this side change since we last synced?* is symmetric and
correct: a side that has not moved cannot hold anything the other is missing. The
recorded stamps are the file's mtime and size, and the newest DSH event time at
the moment the sync succeeded. An empty or missing source file is never "newer" —
there is nothing to read from it — so the sync exports instead.
