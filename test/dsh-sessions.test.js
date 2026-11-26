import test from 'node:test'
import assert from 'node:assert/strict'
import { listDshSessions, readDshSessionMessages, dshSessionExists } from '../lib/dsh-sessions.js'

/** Minimal in-memory persistence/session facade for one or more logs. */
function facade(logs, { failStat = false, failOpen = false, title } = {}) {
  const store = new Map(Object.entries(logs))
  return {
    persistence: {
      async list() {
        return [...store.entries()].map(([id, events]) => ({
          id,
          header: { id, createdAt: 1000, cwd: '/w', ...(title ? { title } : {}) },
          eventCount: events.length,
        }))
      },
      async stat(id) {
        if (failStat) throw new Error('no such session')
        return store.has(id) ? { header: { createdAt: 1000 } } : undefined
      },
      async open(id) {
        if (failOpen) throw new Error('stored log is corrupt')
        if (!store.has(id)) throw new Error(`no such session: ${id}`)
        return {
          async read(offset = 0, length = Number.MAX_SAFE_INTEGER) {
            return { events: store.get(id).slice(offset, offset + length) }
          },
          async close() {},
        }
      },
    },
    sessions: { get: () => undefined },
  }
}

const userMessage = (seq, text) => ({ seq, time: seq, type: 'user/message', data: { id: `u${seq}`, role: 'user', content: [{ type: 'text', text }] } })
const assistantMessage = (seq, text) => ({ seq, time: seq, type: 'assistant/message', data: { message: { id: `a${seq}`, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model' } } } })

test('listDshSessions(): count is messages, not raw events', async () => {
  const events = [
    { seq: 0, time: 0, type: 'turn/start', data: {} },
    { seq: 1, time: 1, type: 'step/start', data: {} },
    userMessage(2, 'hello'),
    assistantMessage(3, 'hi there'),
    { seq: 4, time: 4, type: 'step/end', data: {} },
  ]
  const { persistence, sessions } = facade({ s1: events })
  const rows = await listDshSessions({ persistence, sessions })
  assert.equal(rows.length, 1)
  // 5 events, but only 2 of them are conversation messages.
  assert.equal(rows[0].count, 2)
  assert.equal(rows[0].title, 'hello', 'title falls back to the first user line')
  assert.equal(rows[0].preview, 'hello\nhi there')
})

test('listDshSessions(): an explicit header title wins', async () => {
  const { persistence, sessions } = facade({ s1: [userMessage(0, 'q'), assistantMessage(1, 'a')] }, { title: 'Named' })
  const rows = await listDshSessions({ persistence, sessions })
  assert.equal(rows[0].title, 'Named')
})

test('listDshSessions(): an unreadable log keeps the row and explains why', async () => {
  const { persistence, sessions } = facade({ s1: [userMessage(0, 'q')] }, { failOpen: true })
  const rows = await listDshSessions({ persistence, sessions })
  assert.equal(rows.length, 1)
  // Hiding the reason made an empty-looking row indistinguishable from an
  // empty session, which sent me chasing a bug that did not exist.
  assert.match(rows[0].readError, /corrupt/)
  assert.equal(rows[0].preview, '')
})

test('listDshSessions(): system and tool messages are not counted', async () => {
  const events = [
    { seq: 0, time: 0, type: 'system/message', data: { message: { role: 'system', content: [] } } },
    userMessage(1, 'ask'),
    { seq: 2, time: 2, type: 'tool/result', data: { message: { role: 'tool', content: [{ type: 'text', text: 'out' }] } } },
  ]
  const { persistence, sessions } = facade({ s1: events })
  const rows = await listDshSessions({ persistence, sessions })
  assert.equal(rows[0].count, 1, 'only the user message counts')
  assert.equal(rows[0].preview, 'ask')
})

test('readDshSessionMessages(): returns ordered user/assistant text from a seq', async () => {
  const events = [userMessage(0, 'first'), assistantMessage(1, 'second'), userMessage(2, 'third')]
  const { persistence, sessions } = facade({ s1: events })
  const all = await readDshSessionMessages({ persistence, sessions, sessionId: 's1' })
  assert.deepEqual(all.map(m => m.text), ['first', 'second', 'third'])
  const tail = await readDshSessionMessages({ persistence, sessions, sessionId: 's1', fromSeq: 2 })
  assert.deepEqual(tail.map(m => m.text), ['third'])
})

test('readDshSessionMessages(): a corrupt log resolves empty unless strict', async () => {
  const { persistence, sessions } = facade({ s1: [userMessage(0, 'q')] }, { failOpen: true })
  // Listings must not explode because one log is unreadable...
  assert.deepEqual(await readDshSessionMessages({ persistence, sessions, sessionId: 's1' }), [])
  // ...but an export must hear about it, or it looks like a successful no-op.
  await assert.rejects(
    () => readDshSessionMessages({ persistence, sessions, sessionId: 's1', strict: true }),
    /corrupt/,
  )
})

test('dshSessionExists(): distinguishes a real session from a stale id', async () => {
  const { persistence, sessions } = facade({ s1: [userMessage(0, 'q')] })
  assert.equal(await dshSessionExists({ persistence, sessions, sessionId: 's1' }), true)
  assert.equal(await dshSessionExists({ persistence, sessions, sessionId: 'nope' }), false)
  assert.equal(await dshSessionExists({ persistence, sessions, sessionId: '' }), false)
  const broken = facade({ s1: [] }, { failStat: true })
  assert.equal(await dshSessionExists({ ...broken, sessionId: 's1' }), false, 'a failing stat is not an existence claim')
})

test('dshSessionExists(): a live session counts without touching persistence', async () => {
  const exists = await dshSessionExists({ persistence: {}, sessions: { get: id => (id === 'live' ? { id } : undefined) }, sessionId: 'live' })
  assert.equal(exists, true)
})
