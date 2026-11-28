import test from 'node:test'
import assert from 'node:assert/strict'
import { listDshSessions, readDshSessionMessages, readDshSessionTitle, dshSessionExists, inspectDshLog, countDshEvents } from '../lib/dsh-sessions.js'

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

test('inspectDshLog(): the next turn comes from data.turn, not the envelope', async () => {
  // A real log stores the turn inside `data`. Reading it off the envelope made
  // every append restart at turn 1, which the backend refuses with
  // "turn/start does not open the expected turn".
  const log = [
    { seq: 0, time: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, time: 1, type: 'step/start', data: { turn: 1, step: 1 } },
    { seq: 2, time: 2, type: 'turn/end', data: { turn: 1 } },
    { seq: 3, time: 3, type: 'turn/start', data: { turn: 2 } },
    { seq: 4, time: 3, type: 'step/start', data: { turn: 2, step: 1 } },
    { seq: 5, time: 4, type: 'turn/end', data: { turn: 2 } },
  ]
  const { persistence, sessions } = facade({ s1: log })
  const info = await inspectDshLog({ persistence, sessions, sessionId: 's1' })
  assert.equal(info.eventCount, 6)
  assert.equal(info.nextTurn, 3, 'the append must continue after the highest stored turn')
})

test('inspectDshLog(): an empty or turn-less log starts at turn 1', async () => {
  const { persistence, sessions } = facade({ empty: [], noturn: [{ seq: 0, type: 'session/title', data: {} }] })
  assert.deepEqual(
    await inspectDshLog({ persistence, sessions, sessionId: 'empty' }),
    { eventCount: 0, nextTurn: 1, lastTime: undefined },
  )
  assert.equal((await inspectDshLog({ persistence, sessions, sessionId: 'noturn' })).nextTurn, 1)
})

test('inspectDshLog(): a live session is read without opening a handle', async () => {
  const live = { log: [{ seq: 0, type: 'turn/start', data: { turn: 7 } }] }
  const info = await inspectDshLog({ persistence: {}, sessions: { get: () => live }, sessionId: 'x' })
  // No `time` on this event, so there is no usable stamp to compare sides with.
  assert.deepEqual(info, { eventCount: 1, nextTurn: 8, lastTime: undefined })
})

test('inspectDshLog(): reports the newest event time, which is how "newer side" is decided', async () => {
  const log = [
    { seq: 0, time: 1000, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, time: 4000, type: 'user/message', data: {} },
    { seq: 2, time: 2500, type: 'assistant/message', data: {} },
  ]
  const { persistence, sessions } = facade({ t: log })
  const info = await inspectDshLog({ persistence, sessions, sessionId: 't' })
  assert.equal(info.lastTime, 4000, 'the newest stamp wins, not the last event read')
})

test('countDshEvents(): reads the whole log, page by page', async () => {
  const log = Array.from({ length: 2500 }, (_, index) => ({ seq: index, type: 'user/message', data: {} }))
  const { persistence, sessions } = facade({ big: log })
  assert.equal(await countDshEvents({ persistence, sessions, sessionId: 'big' }), 2500)
})

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

test('listDshSessions(): the latest title event wins over an older one', async () => {
  // DSH folds the LAST session/title event, so a session renamed twice shows
  // the second name. Reading the first would show a stale title in the panel.
  const log = [
    userMessage(0, 'hello'),
    { seq: 1, time: 2, type: 'session/title', data: { title: 'First name' } },
    { seq: 2, time: 3, type: 'session/title', data: { title: 'Second name' } },
  ]
  const { persistence, sessions } = facade({ s1: log })
  const rows = await listDshSessions({ persistence, sessions })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].title, 'Second name')
})

test('readDshSessionTitle(): returns the folded title, or undefined', async () => {
  const titled = facade({
    s1: [
      { seq: 0, time: 1, type: 'session/title', data: { title: 'Named once' } },
      userMessage(1, 'hello'),
    ],
  })
  assert.equal(await readDshSessionTitle({ ...titled, sessionId: 's1' }), 'Named once')

  const untitled = facade({ s2: [userMessage(0, 'hello')] })
  assert.equal(await readDshSessionTitle({ ...untitled, sessionId: 's2' }), undefined)

  // A missing or unreadable session must never break an export.
  const broken = facade({}, { failOpen: true })
  assert.equal(await readDshSessionTitle({ ...broken, sessionId: 'nope' }), undefined)
})

test('readDshSessionTitle(): a live session is read from memory, not the log', async () => {
  const live = {
    log: [
      { seq: 0, type: 'session/title', data: { title: 'Old' } },
      { seq: 1, type: 'session/title', data: { title: 'Live name' } },
    ],
  }
  const { persistence } = facade({})
  const sessions = { get: id => (id === 'live' ? live : undefined) }
  assert.equal(await readDshSessionTitle({ persistence, sessions, sessionId: 'live' }), 'Live name')
})
