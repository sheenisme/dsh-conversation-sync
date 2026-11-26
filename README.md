# Conversation sync for DeepSeek Harness

Import conversations from Claude Code, Codex CLI, generic JSONL and DeepSeek
web exports into DSH — from local paths or any server you can reach over SSH —
and keep both sides in sync in real time.

See [docs/DETAIL.md](docs/DETAIL.md) for configuration, sync model, and the
write-back safety warning.

## Quick start

1. Install this bundle through **Plugins → Install bundle**.
2. Open the **Conversation sync** settings page (the bundle's entry on the
   Plugins page).
3. **Add source**:
   - Claude Code: path to a `~/.claude/projects/<slug>/<id>.jsonl` file.
   - Codex CLI: path to a `~/.codex/sessions/.../rollout-....jsonl` file.
   - Generic JSONL: path to any JSONL file whose lines have `role` and
     `content`/`text`.
   - DeepSeek export: path to the exported ZIP (`export_format_version: 3`).
   - For remote files, tick **Remote SSH source**, fill host/user/port and put
     the *path to your private key* into a DSH credential reference such as
     `conversation-sync/ssh-key`.
4. Choose whether to **write back** to the original file, then save. The first
   sync imports the existing conversation; subsequent changes on either side
   propagate automatically.

> **Warning — write-back is destructive by design.** It appends messages to
> the original tool's live session files. A backup copy is made before each
> write under `~/.dsh/conversation-sync/backups/`, but you should still keep
> your own backups. User accepted this risk explicitly; use it carefully.

## Where things live

- Imported sessions: a dedicated workspace per source under
  `~/.dsh/conversation-sync/workspaces/`, grouped by source type.
- Source registry, byte-offset cursors and sync watermarks: DSH storage domain
  `conversation_sync`.
- SSH private key: DSH credentials (only the key *path* is referenced).
