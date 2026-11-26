import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { listOpenCodeSessions, readOpenCodeMessages, renderOpenCodeRecord } from '../lib/opencode.js'

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite')

/** Build a minimal OpenCode database matching the documented schema. */
async function fixture(rows) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-oc-'))
  const file = path.join(dir, 'opencode.db')
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE session_v2 (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_created INTEGER);
    CREATE TABLE session_message (
      id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
      time_created INTEGER, data TEXT
    );
  `)
  const session = db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?, ?)')
  const message = db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)')
  for (const row of rows) {
    session.run(row.id, row.title ?? null, row.directory ?? null, row.created ?? 1)
    ;(row.messages ?? []).forEach((m, index) => {
      message.run(`${row.id}-${index}`, row.id, m.type, index, m.time ?? index, JSON.stringify(m.data))
    })
  }
  db.close()
  return { file, dir }
}

test('listOpenCodeSessions(): titles, counts and user preview', async () => {
  const { file, dir } = await fixture([
    { id: 'ses_a', title: 'Refactor auth', created: 200, messages: [
      { type: 'user', data: { text: 'please refactor the auth module' } },
      { type: 'assistant', data: { content: [{ type: 'text', text: 'sure' }] } },
    ] },
    { id: 'ses_b', title: '', created: 100, messages: [{ type: 'user', data: { text: 'hi' } }] },
  ])
  try {
    const sessions = await listOpenCodeSessions({ file })
    assert.equal(sessions.length, 2)
    assert.equal(sessions[0].id, 'ses_a')
    assert.equal(sessions[0].name, 'Refactor auth')
    assert.equal(sessions[0].count, 2)
    assert.equal(sessions[0].preview, 'please refactor the auth module')
    assert.equal(sessions[0].kind, 'opencode')
    // untitled sessions fall back to their id instead of an empty label
    assert.equal(sessions[1].name, 'ses_b')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('readOpenCodeMessages(): cursor advances and roles are normalized', async () => {
  const { file, dir } = await fixture([
    { id: 'ses_a', title: 't', messages: [
      { type: 'user', data: { text: 'one' } },
      { type: 'assistant', data: { content: [
        { type: 'text', text: 'two' },
        { type: 'reasoning', text: 'thinking hard' },
        { type: 'tool', name: 'Bash', state: { input: { command: 'ls' }, content: 'a.txt' } },
      ] } },
    ] },
  ])
  try {
    const first = await readOpenCodeMessages({ file, sessionId: 'ses_a' })
    assert.equal(first.records.length, 2)
    assert.equal(first.records[0].role, 'user')
    assert.equal(first.records[0].text, 'one')
    const assistant = first.records[1]
    assert.equal(assistant.role, 'assistant')
    assert.match(assistant.text, /two/)
    assert.match(assistant.text, /\[thinking\] thinking hard/)
    assert.match(assistant.text, /\[tool_call Bash\]/)
    assert.match(assistant.text, /a\.txt/)

    // resuming from the returned cursor yields nothing new
    const again = await readOpenCodeMessages({ file, sessionId: 'ses_a', fromSeq: first.cursor })
    assert.equal(again.records.length, 0)
    assert.equal(again.cursor, first.cursor)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('readOpenCodeMessages(): a live WAL database is read via a copy', async () => {
  const { file, dir } = await fixture([{ id: 'ses_a', title: 't', messages: [{ type: 'user', data: { text: 'wal' } }] }])
  try {
    // a real -wal sibling must not break the copy path
    await fs.writeFile(`${file}-wal`, Buffer.alloc(0))
    const out = await readOpenCodeMessages({ file, sessionId: 'ses_a' })
    assert.equal(out.records[0].text, 'wal')
    // the source database is untouched (still one message row)
    const db = new DatabaseSync(file, { readOnly: true })
    const count = db.prepare('SELECT COUNT(*) AS n FROM session_message').get()
    db.close()
    assert.equal(Number(count.n), 1)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('readOpenCodeMessages(): unknown session yields an empty delta', async () => {
  const { file, dir } = await fixture([])
  try {
    const out = await readOpenCodeMessages({ file, sessionId: 'missing' })
    assert.deepEqual(out.records, [])
    assert.equal(out.cursor, 0)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('renderOpenCodeRecord(): user and assistant payload shapes', () => {
  const user = renderOpenCodeRecord({ role: 'user', text: 'hey', ts: 5 }, 'sync-1')
  assert.equal(user.type, 'user')
  assert.equal(JSON.parse(user.data).text, 'hey')
  assert.equal(JSON.parse(user.data).dshSyncId, 'sync-1')

  const assistant = renderOpenCodeRecord({ role: 'assistant', text: 'yo', ts: 6 }, 'sync-2')
  assert.equal(assistant.type, 'assistant')
  assert.equal(JSON.parse(assistant.data).content[0].text, 'yo')
  assert.equal(assistant.id, 'msg_sync-2')
})

test('legacy layout (message + part) is readable', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-oc-legacy-'))
  const file = path.join(dir, 'opencode.db')
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_created INTEGER);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
  `)
  db.prepare('INSERT INTO session VALUES (?,?,?,?)').run('ses_old', 'Old session', '/tmp', 10)
  db.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run('msg_1', 'ses_old', 100, 100, JSON.stringify({ role: 'user' }))
  db.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run('msg_2', 'ses_old', 200, 200, JSON.stringify({ role: 'assistant' }))
  db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run('p1', 'msg_1', 'ses_old', 100, 100, JSON.stringify({ type: 'text', text: 'legacy question' }))
  db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run('p2', 'msg_2', 'ses_old', 200, 200, JSON.stringify({ type: 'text', text: 'legacy answer' }))
  db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run('p3', 'msg_2', 'ses_old', 201, 201, JSON.stringify({ type: 'tool', tool: 'Bash', state: { input: { command: 'ls' }, content: 'x' } }))
  db.close()
  try {
    const sessions = await listOpenCodeSessions({ file })
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0].name, 'Old session')
    assert.equal(sessions[0].count, 2)
    assert.match(sessions[0].preview, /legacy question/)

    const out = await readOpenCodeMessages({ file, sessionId: 'ses_old' })
    assert.equal(out.records.length, 2)
    assert.equal(out.records[0].role, 'user')
    assert.equal(out.records[0].text, 'legacy question')
    assert.equal(out.records[1].role, 'assistant')
    assert.match(out.records[1].text, /legacy answer/)
    assert.match(out.records[1].text, /\[tool_call Bash\]/)
    assert.equal(out.cursor, 2)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
