import test from 'node:test'
import assert from 'node:assert/strict'
import { createTransportPool } from '../lib/pool.js'

const fakeMachine = (id, kind = 'ssh') => ({ id, kind, hostname: `${id}.example`, user: 'u' })

/** A transport that records whether it was closed. */
const fakeTransport = (kind = 'ssh') => ({
  kind,
  closed: false,
  close() { this.closed = true },
})

test('pool: one transport per machine, reused across calls', async () => {
  const created = []
  const pool = createTransportPool({
    create: async machine => {
      const transport = fakeTransport(machine.kind)
      created.push(transport)
      return transport
    },
  })
  const machine = fakeMachine('ssh:a')
  const first = await pool.run(machine, undefined, transport => transport)
  const second = await pool.run(machine, undefined, transport => transport)
  assert.equal(first, second, 'the same transport object should be reused')
  assert.equal(created.length, 1, 'only one transport should have been created')
  assert.equal(pool.size, 1)
})

test('pool: different machines get different transports', async () => {
  const pool = createTransportPool({ create: async machine => fakeTransport(machine.kind) })
  const a = await pool.get(fakeMachine('ssh:a'))
  const b = await pool.get(fakeMachine('ssh:b'))
  assert.notEqual(a, b)
  assert.equal(pool.size, 2)
})

test('pool: a different key for the same machine is a separate entry', async () => {
  // Two bindings can point at the same host with different credentials, so the
  // key is part of the cache key. Sharing one transport would silently use the
  // first binding's identity for the second.
  const pool = createTransportPool({ create: async machine => fakeTransport(machine.kind) })
  const machine = fakeMachine('ssh:a')
  const k1 = await pool.get(machine, 'key/one')
  const k2 = await pool.get(machine, 'key/two')
  assert.notEqual(k1, k2)
  assert.equal(pool.size, 2)
})

test('pool: a link-level failure drops the transport so the next call reconnects', async () => {
  const pool = createTransportPool({ create: async machine => fakeTransport(machine.kind) })
  const machine = fakeMachine('ssh:a')
  const first = await pool.get(machine)
  await assert.rejects(
    () => pool.run(machine, undefined, () => { throw new Error('No response from server') }),
    /No response from server/,
  )
  assert.equal(first.closed, true, 'the dead transport should be closed')
  const second = await pool.get(machine)
  assert.notEqual(second, first, 'the next call must build a fresh transport')
})

test('pool: an ordinary "file is not there" keeps the transport', async () => {
  // Reconnecting after every missing conversation file would waste a handshake
  // per tick for a binding that simply has not been created yet.
  const pool = createTransportPool({ create: async machine => fakeTransport(machine.kind) })
  const machine = fakeMachine('ssh:a')
  const first = await pool.get(machine)
  await assert.rejects(
    () => pool.run(machine, undefined, () => { throw new Error('source file not found: /x.jsonl') }),
    /source file not found/,
  )
  const second = await pool.get(machine)
  assert.equal(second, first, 'the transport should still be cached')
  assert.equal(first.closed, false)
})

test('pool: local transports are never discarded on failure', async () => {
  // The local transport holds no connection, so dropping it buys nothing.
  const pool = createTransportPool({ create: async machine => fakeTransport('local') })
  const machine = fakeMachine('local', 'local')
  const first = await pool.get(machine)
  await assert.rejects(() => pool.run(machine, undefined, () => { throw new Error('boom') }), /boom/)
  assert.equal(await pool.get(machine), first)
})

test('pool: closeAll() closes every cached transport', async () => {
  const pool = createTransportPool({ create: async machine => fakeTransport(machine.kind) })
  const a = await pool.get(fakeMachine('ssh:a'))
  const b = await pool.get(fakeMachine('ssh:b'))
  pool.closeAll()
  assert.equal(a.closed, true)
  assert.equal(b.closed, true)
  assert.equal(pool.size, 0)
})

test('pool: discard() targets one machine only', async () => {
  const pool = createTransportPool({ create: async machine => fakeTransport(machine.kind) })
  const a = await pool.get(fakeMachine('ssh:a'))
  const b = await pool.get(fakeMachine('ssh:b'))
  pool.discard(fakeMachine('ssh:a'))
  assert.equal(a.closed, true)
  assert.equal(b.closed, false)
  assert.equal(pool.size, 1)
})

test('pool: a transport that closed itself is replaced, not reused', async () => {
  // ssh2 emits close on keepalive failure; the object stays in the map but is
  // unusable. Serving it would fail every later call.
  const pool = createTransportPool({ create: async machine => fakeTransport(machine.kind) })
  const machine = fakeMachine('ssh:a')
  const first = await pool.get(machine)
  first.closed = true
  const second = await pool.get(machine)
  assert.notEqual(second, first)
})

test('createTransportPool() requires a create() function', () => {
  assert.throws(() => createTransportPool({}), /requires a create\(\) function/)
})
