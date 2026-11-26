/**
 * OpenCode (opencode.ai) stores every session in one SQLite database:
 *   ${XDG_DATA_HOME:-~/.local/share}/opencode/opencode.db
 * Tables used here (from the official schema):
 *   session(id, title, directory, time_created, ...)      (older: session_v2)
 *   session_message(id, session_id, type, seq, time_created, data)
 * `type` is the role tag (user / assistant / system / ...); message content is
 * JSON in `data`. We read a *copy* of the database so a live OpenCode process
 * never contends with us for a lock, and open it read-only.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const nodeRequire = createRequire(import.meta.url)

/** Read a message `data` blob into plain text, tolerating every known shape. */
function messageText(type, data) {
  if (!data) return ''
  let value
  try { value = typeof data === 'string' ? JSON.parse(data) : data } catch { return '' }
  const parts = []
  const push = text => { if (typeof text === 'string' && text.trim()) parts.push(text) }
  // user: { text }  |  assistant: { content: [ {type:'text'|'reasoning'|'tool', ...} ] }
  if (typeof value.text === 'string') push(value.text)
  if (typeof value.prompt === 'string') push(value.prompt)
  if (Array.isArray(value.content)) {
    for (const block of value.content) {
      if (!block || typeof block !== 'object') { push(block); continue }
      if (block.type === 'text') push(block.text)
      else if (block.type === 'reasoning') push(`[thinking] ${block.text ?? ''}`)
      else if (block.type === 'tool') {
        const state = block.state ?? {}
        const input = state.input ?? block.input
        push(`[tool_call ${block.name ?? 'tool'}] ${typeof input === 'string' ? input : JSON.stringify(input ?? {})}`)
        const out = state.content ?? state.output
        if (out) push(`[tool_result ${block.name ?? 'tool'}] ${typeof out === 'string' ? out : JSON.stringify(out)}`)
      }
    }
  }
  return parts.join('\n')
}

const ROLE_MAP = { user: 'user', assistant: 'assistant', system: 'system', shell: 'tool', skill: 'system', synthetic: 'system' }

/**
 * Older OpenCode releases keep messages as `message` rows plus `part` rows,
 * newer ones as `session_message` rows. Both may exist in one database, so we
 * detect which one actually carries data instead of trusting the schema alone.
 */
function hasRows(db, table) {
  try {
    return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n) > 0
  } catch {
    return false
  }
}

/** Text of one `part` row (older layout). */
function partText(data) {
  let value
  try { value = typeof data === 'string' ? JSON.parse(data) : data } catch { return '' }
  if (!value || typeof value !== 'object') return ''
  switch (value.type) {
    case 'text': return value.text ?? ''
    case 'reasoning': return `[thinking] ${value.text ?? ''}`
    case 'tool': {
      const state = value.state ?? {}
      const input = state.input ?? value.input
      const out = state.content ?? state.output ?? state.error
      const lines = [`[tool_call ${value.tool ?? value.name ?? 'tool'}] ${typeof input === 'string' ? input : JSON.stringify(input ?? {})}`]
      if (out) lines.push(`[tool_result ${value.tool ?? value.name ?? 'tool'}] ${typeof out === 'string' ? out : JSON.stringify(out)}`)
      return lines.join('\n')
    }
    case 'file': return value.filename ? `[file ${value.filename}]` : ''
    default: return value.text ?? ''
  }
}

/** Copy the DB (plus WAL/SHM siblings) to a temp dir so we never lock it. */
async function withDatabaseCopy(file, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-opencode-'))
  const target = path.join(dir, 'opencode.db')
  try {
    await fs.copyFile(file, target)
    for (const suffix of ['-wal', '-shm']) {
      try { await fs.copyFile(file + suffix, target + suffix) } catch { /* absent */ }
    }
    return await fn(target)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

/** Pick the session table this database actually has (schema changed over time). */
function sessionTable(db) {
  const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => String(row.name)))
  for (const candidate of ['session', 'session_v2']) {
    if (names.has(candidate)) return candidate
  }
  return undefined
}

function openDb(dbFile) {
  // node:sqlite is built into Node >= 22.5; import lazily so older hosts that
  // only use the JSONL adapters never load it.
  const { DatabaseSync } = nodeRequire('node:sqlite')
  const db = new DatabaseSync(dbFile, { readOnly: true })
  return db
}

/** List OpenCode sessions with a first-user-message preview. */
export async function listOpenCodeSessions({ file, limit = 2000 } = {}) {
  if (!file) return []
  return withDatabaseCopy(file, async dbFile => {
    const db = openDb(dbFile)
    try {
      const table = sessionTable(db)
      if (!table) return []
      const modern = hasRows(db, 'session_message')
      const counter = modern
        ? '(SELECT COUNT(*) FROM session_message m WHERE m.session_id = s.id)'
        : 'COALESCE((SELECT COUNT(*) FROM message m WHERE m.session_id = s.id), 0)'
      const rows = db.prepare(
        `SELECT s.id AS id, s.title AS title, s.time_created AS created,
                ${counter} AS count
           FROM ${table} s
          ORDER BY s.time_created DESC
          LIMIT ?`,
      ).all(limit)
      const sessions = []
      for (const row of rows) {
        let preview = ''
        try {
          if (modern) {
            const first = db.prepare(
              `SELECT type, data FROM session_message WHERE session_id = ? ORDER BY seq ASC LIMIT 1`,
            ).get(row.id)
            if (first) preview = messageText(first.type, first.data).slice(0, 80)
          } else {
            const first = db.prepare(
              `SELECT p.data AS data FROM part p
                 JOIN message m ON m.id = p.message_id
                WHERE m.session_id = ? ORDER BY m.time_created ASC, p.time_created ASC LIMIT 20`,
            ).all(row.id)
            preview = first.map(part => partText(part.data)).filter(Boolean).join(' ').slice(0, 80)
          }
        } catch { /* preview is best-effort */ }
        sessions.push({
          id: String(row.id),
          kind: 'opencode',
          name: String(row.title ?? '').trim() || String(row.id),
          path: String(row.id), // the DB row id, resolved with the machine's db path
          dbPath: file,
          size: 0,
          mtimeMs: Number(row.created ?? 0),
          count: Number(row.count ?? 0),
          countTruncated: false,
          preview,
        })
      }
      return sessions
    } finally {
      try { db.close() } catch { /* already closed */ }
    }
  })
}

/**
 * Read messages starting at `fromSeq`, where `fromSeq` is the first seq not yet
 * consumed (same convention as DSH's own session reads). The returned cursor is
 * the next `fromSeq` to pass on the following poll.
 */
export async function readOpenCodeMessages({ file, sessionId, fromSeq = 0 } = {}) {
  if (!file) return { records: [], cursor: fromSeq }
  return withDatabaseCopy(file, async dbFile => {
    const db = openDb(dbFile)
    try {
      if (!hasRows(db, 'session_message')) return readOpenCodeParts(db, sessionId, fromSeq)
      const rows = db.prepare(
        `SELECT seq, type, time_created, data FROM session_message
          WHERE session_id = ? AND seq >= ? ORDER BY seq ASC`,
      ).all(sessionId, fromSeq)
      const records = []
      let cursor = fromSeq
      for (const row of rows) {
        const text = messageText(row.type, row.data)
        cursor = Math.max(cursor, Number(row.seq ?? 0) + 1)
        if (!text) continue
        const role = ROLE_MAP[row.type] ?? 'assistant'
        records.push({
          role,
          text,
          ts: Number(row.time_created ?? 0) || null,
          meta: { sessionId, seq: Number(row.seq ?? 0), kind: row.type },
        })
      }
      return { records, cursor }
    } finally {
      try { db.close() } catch { /* already closed */ }
    }
  })
}

/** Read the older `message` + `part` layout, folded into one record per message. */
function readOpenCodeParts(db, sessionId, fromSeq) {
  let messages
  try {
    messages = db.prepare(
      `SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC`,
    ).all(sessionId)
  } catch {
    return { records: [], cursor: fromSeq }
  }
  const partsOf = db.prepare(
    `SELECT data FROM part WHERE message_id = ? ORDER BY time_created ASC`,
  )
  const records = []
  let cursor = fromSeq
  messages.forEach((message, index) => {
    if (index < fromSeq) return // `fromSeq` doubles as a message index here
    cursor = index + 1
    let info = {}
    try { info = typeof message.data === 'string' ? JSON.parse(message.data) : (message.data ?? {}) } catch { info = {} }
    const text = partsOf.all(message.id).map(part => partText(part.data)).filter(Boolean).join('\n')
    if (!text) return
    const role = info.role === 'assistant' ? 'assistant' : info.role === 'user' ? 'user' : 'assistant'
    records.push({ role, text, ts: Number(message.time_created ?? 0) || null, meta: { sessionId, messageId: message.id } })
  })
  return { records, cursor }
}

/** Render a DSH-origin record as an OpenCode session_message row payload. */
export function renderOpenCodeRecord(record, syncId) {
  const type = record.role === 'assistant' ? 'assistant' : 'user'
  const data = type === 'user'
    ? { text: record.text }
    : { content: [{ type: 'text', text: record.text }] }
  return { id: `msg_${syncId}`, type, seq: 0, time_created: record.ts ?? Date.now(), data: JSON.stringify({ ...data, dshSyncId: syncId }) }
}
