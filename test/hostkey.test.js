import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHostKeyGuard } from '../lib/hostkey.js'

const KEY_A = Buffer.from('ssh-ed25519 AAAA-first-host-key')
const KEY_B = Buffer.from('ssh-ed25519 AAAA-different-host-key')

async function tmpGuard(mode, opts = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-hk-'))
  const file = path.join(dir, 'known_hosts.json')
  const guard = createHostKeyGuard({ file, mode, ...opts })
  return { guard, file, dir }
}

/** Call an ssh2 hostVerifier, supporting both callback and synchronous return. */
function check(verifier, key) {
  return new Promise(resolve => {
    let done = false
    const settle = value => { if (!done) { done = true; resolve(value) } }
    const ret = verifier(key, settle)
    if (ret !== undefined) settle(ret)
    setTimeout(() => settle(false), 1000) // never hang the suite
  })
}

test('accept-new: trusts and records an unknown host on first connect', async () => {
  const { guard, file } = await tmpGuard('accept-new')
  const verifier = await guard.verifier('example.com', 22)
  const first = await check(verifier, KEY_A)
  assert.equal(first, true)
  await guard.settled()
  // persisted fingerprint
  const stored = JSON.parse(await fs.readFile(file, 'utf8'))
  assert.ok(stored['example.com:22'])
  assert.equal(stored['example.com:22'].fingerprint, guard.fingerprint(KEY_A))
})

test('accept-new: same key still verifies on reconnect', async () => {
  const { guard } = await tmpGuard('accept-new')
  const v1 = await guard.verifier('example.com', 22)
  await check(v1, KEY_A)
  const v2 = await guard.verifier('example.com', 22)
  assert.equal(await check(v2, KEY_A), true)
})

test('changed key is rejected (possible MITM)', async () => {
  const { guard } = await tmpGuard('accept-new')
  const v1 = await guard.verifier('example.com', 22)
  await check(v1, KEY_A)
  const v2 = await guard.verifier('example.com', 22)
  const result = await check(v2, KEY_B)
  assert.equal(result, false)
})

test('verify mode rejects unknown hosts outright', async () => {
  const { guard } = await tmpGuard('verify')
  const verifier = await guard.verifier('unknown.example', 22)
  const result = await check(verifier, KEY_A)
  assert.equal(result, false)
})

test('off mode accepts anything', async () => {
  const { guard } = await tmpGuard('off')
  const verifier = await guard.verifier('anything', 22)
  assert.equal(await check(verifier, KEY_B), true)
})

test('ports are distinct entries', async () => {
  const { guard, file } = await tmpGuard('accept-new')
  const v22 = await guard.verifier('host', 22)
  const v2222 = await guard.verifier('host', 2222)
  await check(v22, KEY_A)
  await check(v2222, KEY_B)
  await guard.settled()
  const stored = JSON.parse(await fs.readFile(file, 'utf8'))
  assert.notEqual(stored['host:22'].fingerprint, stored['host:2222'].fingerprint)
})

test('forget removes a recorded host', async () => {
  const { guard, file } = await tmpGuard('accept-new')
  const v = await guard.verifier('host', 22)
  await check(v, KEY_A)
  await guard.forget('host', 22)
  const stored = JSON.parse(await fs.readFile(file, 'utf8'))
  assert.equal(stored['host:22'], undefined)
})

test('corrupt known_hosts file is tolerated', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-hk-'))
  const file = path.join(dir, 'known_hosts.json')
  await fs.writeFile(file, '{not json')
  const guard = createHostKeyGuard({ file, mode: 'accept-new' })
  const v = await guard.verifier('host', 22)
  assert.equal(await check(v, KEY_A), true)
})
