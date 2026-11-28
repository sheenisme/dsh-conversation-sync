# Conversation formats, tool by tool

Every tool that records a conversation invents its own line shape. This plugin
reads six of them, and — where it is safe to write — writes each one back in the
same shape it came from.

The short version: a line we produce has to be a line the **tool** accepts, not
merely a line **we** can parse. That is what
[`lib/native.js`](../lib/native.js) is for, and the `native` CI scenario
exports a session and imports it back to prove the count survives.

- [Where the files live](#where-the-files-live)
- [The four questions each format answers](#the-four-questions-each-format-answers)
- [Claude Code](#claude-code)
- [Codex CLI](#codex-cli)
- [WorkBuddy / CodeBuddy](#workbuddy--codebuddy)
- [TRAE](#trae)
- [Antigravity](#antigravity)
- [OpenCode](#opencode)
- [Generic JSONL and DeepSeek export](#generic-jsonl-and-deepseek-export)
- [What a round trip guarantees](#what-a-round-trip-guarantees)
- [Adding a format](#adding-a-format)

## Where the files live

| Tool | Location | Shape |
| --- | --- | --- |
| Claude Code | `~/.claude/projects/<slug>/<session>.jsonl` | one JSON object per line |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | one JSON object per line |
| Codex CLI (archived) | `~/.codex/archived_sessions` | same as above |
| WorkBuddy / CodeBuddy | `~/.workbuddy/projects`, `~/.workbuddy-ai/projects`, `~/.codebuddy/projects` | one JSON object per line |
| TRAE | `~/.trae/cli`, `~/.trae-cn/cli` | Codex-shaped rollout |
| Antigravity | `~/.gemini/antigravity{,-cli,-ide}/brain/<uuid>/.system_generated/logs/transcript.jsonl` | one JSON object per line |
| OpenCode | `~/.local/share/opencode/opencode.db` (SQLite) | tables, not lines |
| DeepSeek export | anywhere you saved the ZIP | ZIP of JSON |

Paths are resolved on the machine the file lives on, so an SSH host is scanned
with the same rules against *its* home directory, not this one.

## The four questions each format answers

For every format the reader has to work out four things, and the writer has to
reproduce them:

1. **Who spoke** — a `role` field, or a `source`/`type` pair, or the line type
   itself.
2. **Where the text is** — `content` blocks, a plain string, or a nested
   `message.content`.
3. **What a tool call is** — inline blocks on the assistant message, or separate
   rows joined by an id.
4. **What is noise** — injected preambles, replayed history, compaction markers,
   harness step logs. A silence here is a wrong title or a duplicated question,
   not a crash, which is why each format needs its own filter.

## Claude Code

**Read.** `type` is `user` or `assistant`; `message.role` repeats it. Content is
an array of blocks: `text`, `thinking`, `tool_use`, `tool_result`, `image`.

- An assistant line holds `tool_use` blocks **inside** `message.content`. Each
  has `id`, `name` and `input`.
- A tool result comes back as a line whose `type` is `user` and whose content is
  a `tool_result` block carrying `tool_use_id`. One line may hold **several**
  blocks when tools ran in parallel, so the parser returns an array.
- `parentUuid` chains the lines; the first line of a session has `null`. Side
  chains (`isSidechain`) are sub-agent chatter and are kept but not treated as
  the main turn.
- A line matching `dshSyncId` is our own write-back and is skipped, so a file we
  exported is never re-imported as new content.

**Write.** One line per exchange, chained:

```
{"parentUuid":null,"isSidechain":false,"type":"user",
 "message":{"role":"user","content":[{"type":"text","text":"…"}]},
 "uuid":"…","timestamp":"…Z","cwd":"/work","sessionId":"…",
 "dshSyncId":"…","dshTitle":"…"}
```

An assistant line adds `message.model` and `stop_reason` (`tool_use` when it
called something, `end_turn` otherwise) plus the `tool_use` blocks. Its results
go out as a `type:"user"` line holding a `tool_result` block — exactly how the
CLI records them. `cwd` is required: without it the CLI cannot reopen the file.

## Codex CLI

**Read.** Every line is `{timestamp, ordinal, type, payload}`. The first line is
`session_meta`. Conversation payloads are `response_item` rows:

- `message` — `{role, content:[{type:'input_text'|'output_text', text}]}`.
  `role:"developer"` carries the system prompt and is not a user turn.
- `reasoning` — `summary` is the readable part; `encrypted_content` is opaque
  and is ignored rather than stored as text.
- `function_call` / `custom_tool_call` — `call_id`, `name`, `arguments` (or
  `input`).
- `function_call_output` / `custom_tool_call_output` — same `call_id`, `output`.

Calls and outputs are separate rows joined by `call_id`; `id` is the message id
and must not be used as the join key. `event_msg` rows (`task_started`,
`thread_settings_applied`, `item_completed`) are UI events, not conversation.
A rollout that was compacted keeps only `session_meta`, an encrypted
`compaction` row and `thread_settings_applied` — three lines, no conversation.

**Write.** A rollout needs its header, and `ordinal` must keep increasing across
appends:

```
{"timestamp":"…","ordinal":1,"type":"session_meta","payload":{"session_id":"…","cwd":"…","originator":"dsh-conversation-sync", …}}
{"timestamp":"…","ordinal":2,"type":"response_item","payload":{"type":"message","id":"…","role":"user","content":[{"type":"input_text","text":"…"}]}}
{"timestamp":"…","ordinal":3,"type":"response_item","payload":{"type":"function_call","id":"…","call_id":"…","name":"…","arguments":"…"}}
```

Appending reads the highest existing `ordinal` first (`maxOrdinal`) and continues
above it; a second export into the same file never adds a second `session_meta`,
because two headers make Codex treat the file as two sessions.

## WorkBuddy / CodeBuddy

**Read.** One flat object per line, and the type is the discriminator:

- `{type:'message', id, role:'user'|'assistant', content:[{type:'input_text'|'output_text', text}], timestamp}` —
  `timestamp` is **milliseconds**.
- `{type:'reasoning', rawContent}` — thinking, not a reply.
- `{type:'function_call', callId, name, arguments}` and
  `{type:'function_call_result', callId, status, output}` — joined by `callId`,
  **not** `id`: `id` is the model message and is shared by parallel calls.
- Rows flagged `skipRun`, `isMeta`, `isCompactInternal` or `isCompacted` are
  internal artifacts and are skipped.

**Write.** `message` rows plus `function_call` / `function_call_result` rows with
a numeric `timestamp` and a matching `callId`. Reasoning is not invented.

## TRAE

**Read.** TRAE's CLI writes Codex-shaped rollouts, with two twists:

- Real user input arrives as `{type:'event_msg', payload:{type:'user_message', message}}`.
  A `role:"user"` response item with the same words is the request echo, so the
  reader keeps the `event_msg` copy and drops the duplicate — including when the
  two land in different reads.
- `{type:'history_mutation', payload:{operation:'replace'}}` is replayed history.
  Importing it duplicates the whole session, so it is skipped.

Everything else falls through to the Codex parser.

**Write.** TRAE uses the Codex writer. TRAE's IDE stores its conversations in an
encrypted database (`efc957ea …`, not SQLite); those are not read, and the
`memory/*.jsonl` files under `~/.trae-cn` are keyword summaries rather than
conversations.

## Antigravity

**Read.** A step log, not a message list: `{step_index, source, type, status,
created_at, content, thinking, model, tool_calls, tokens}`.

| source / type | Meaning | Kept |
| --- | --- | --- |
| `USER_EXPLICIT` / `USER_INPUT` | the user's turn | yes |
| `MODEL` / `PLANNER_RESPONSE` | the model's reply, `tool_calls` on it | yes |
| `MODEL` / `GENERIC` | harness step log | no |
| `SYSTEM` / `SYSTEM_MESSAGE` | runtime notice | no |
| anything / `CHECKPOINT` | compaction marker | no |

User text is wrapped in `<USER_REQUEST>…</USER_REQUEST>` with an
`<ADDITIONAL_METADATA>` block appended; both are stripped so the title and
preview show what the person actually typed. `created_at` is RFC3339.

**Write.** Ascending `step_index`, the same `source`/`type` pairs, user text
re-wrapped, tool calls as `tool_calls` on the model step and tool output as a
`SYSTEM` step.

## OpenCode

OpenCode keeps its sessions in SQLite, not JSONL, and there are two schemas in
the wild: `session` + `session_message`, and the older `session_v2` + `message` +
`part`. The plugin copies the database (with its `-wal`/`-shm`) to a temporary
directory and opens it read-only, so a running OpenCode never contends with us.

OpenCode is **import only**. Writing into a live SQLite file from a plugin risks
corrupting it, so an export to an OpenCode source is refused with that reason
rather than attempted.

## Generic JSONL and DeepSeek export

**Generic JSONL** is the fallback: `role` (or `type`) plus `content`/`text`,
timestamps accepted as a number or an ISO string. It is what you pick when a
tool is not in the table above and its lines are simple.

**DeepSeek export** is a ZIP read through `fflate`; `export_format_version` must
be `3`. It is also import only, because the ZIP is a snapshot, not a store the
tool reopens.

## What a round trip guarantees

The `native` scenario in CI asserts, for Claude, Codex, WorkBuddy and
Antigravity:

1. The export produces at least two lines and every line carries `dshSyncId`.
2. Reading that file back with the source tag removed yields the **same message
   count** as the session that was exported.
3. Tool calls and results survive as a pair — joined by `call_id` in Codex and
   WorkBuddy, by `tool_use_id` in Claude, as `tool_calls` in Antigravity.

What it does **not** claim: byte-identical files. Timestamps of our lines are
the conversation's own times, ids are ours, and unknown fields of the original
lines are not carried through. Sync is about the conversation, not the file's
metadata.

Two deliberate refusals protect your data:

- A session is never invented from nothing. A 3-line compacted rollout imports
  as an error (`no importable messages`), not as an empty shell.
- A tool result is never turned into a user message. It stays a `tool_result`
  block, a `function_call_output` row, or a `SYSTEM` step.

## Adding a format

1. Add a parser to [`lib/adapters.js`](../lib/adapters.js) and register it in
   `JSONL_ADAPTERS`.
2. Add a native writer to [`lib/native.js`](../lib/native.js) and route it in
   `renderSessionLines`.
3. Add a fixture under `test/fixtures/` and a case to `test/fixtures.test.js`
   and `test/native.test.js`.
4. Add the root to `lib/discovery.js` if the tool stores files somewhere new.
5. Extend `FORMATS` in `scripts/ci/scenario.mjs` so the real harness proves it.
