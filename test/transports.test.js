import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { planJumpChain, LocalTransport, SshTransport, transportForMachine } from '../lib/transports.js'

const hop = (name, port = 22) => ({ host: name, port, username: name, privateKeyPath: `/keys/${name}` })

test('planJumpChain: single hop forwards to the target', () => {
  const plan = planJumpChain([hop('bastion', 2222)], { host: 'prod', port: 22 })
  assert.equal(plan.length, 1)
  assert.equal(plan[0].hop.host, 'bastion')
  assert.equal(plan[0].nextHost, 'prod')
  assert.equal(plan[0].nextPort, 22)
})

test('planJumpChain: two hops chain hop1 -> hop2 -> target', () => {
  const plan = planJumpChain([hop('outer', 2200), hop('inner', 2201)], { host: 'db', port: 5432 })
  assert.deepEqual(plan.map(step => step.nextHost), ['inner', 'db'])
  assert.deepEqual(plan.map(step => step.nextPort), [2201, 5432])
})

test('planJumpChain: empty or missing chain is a plain connection', () => {
  assert.deepEqual(planJumpChain([], { host: 'x' }), [])
  assert.deepEqual(planJumpChain(undefined, { host: 'x' }), [])
})

test('planJumpChain: a runaway chain is capped, not followed forever', () => {
  const many = Array.from({ length: 40 }, (_, index) => hop(`h${index}`))
  assert.equal(planJumpChain(many, { host: 'target' }).length, 8)
})

test('planJumpChain: hostname fallback for config-style hosts', () => {
  const plan = planJumpChain([{ host: 'alias' }], { hostname: 'real.example.com', port: 22 })
  assert.equal(plan[0].nextHost, 'real.example.com')
})

test('LocalTransport: the basic facade behaves like a filesystem', async () => {
  const os = await import('node:os')
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-tr-'))
  const transport = new LocalTransport()
  try {
    const file = path.join(dir, 'nested', 'a.jsonl')
    await transport.write(file, 'line1\n')
    assert.deepEqual(await transport.stat(file), { size: 6, mtimeMs: (await fs.stat(file)).mtimeMs })
    await transport.append(file, 'line2\n')
    assert.equal((await transport.stat(file)).size, 12)
    assert.equal((await transport.read(file, 6)).toString(), 'line2\n')
    assert.equal(await transport.home(), os.homedir())
    assert.equal(await transport.stat(path.join(dir, 'nope')), undefined)
    // reading past the end is empty, not an error
    assert.equal((await transport.read(file, 999)).length, 0)
    // list reports directories as such
    const entries = await transport.list(path.join(dir, 'nested'))
    assert.equal(entries[0].name, 'a.jsonl')
    assert.equal(entries[0].isDirectory, false)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('transportForMachine: local machine never needs a credential', async () => {
  const credentials = { resolve: async () => { throw new Error('should not be called') } }
  const transport = await transportForMachine({ id: 'local', kind: 'local' }, [], credentials)
  assert.equal(transport.kind, 'local')
})

test('transportForMachine: a saved credential wins over every fallback', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cred-'))
  try {
    const saved = path.join(dir, 'saved-key')
    await fs.writeFile(saved, 'PRIVATE')
    const credentials = { resolve: async () => ({ value: saved }) }
    const transport = await transportForMachine(
      { id: 'ssh:box', kind: 'ssh', host: 'box', user: 'u', identityFile: '/keys/from-config' },
      [{ id: 'ssh:box', kind: 'ssh', host: 'box' }],
      credentials,
    )
    assert.equal(transport.privateKeyPath, saved)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('transportForMachine: a stale saved path falls back instead of blocking the machine', async () => {
  // A saved credential pointing at a key that has since moved used to make the
  // machine produce zero sessions with only "cannot read ... key" to explain it.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-stale-'))
  try {
    const good = path.join(dir, 'id_ed25519')
    await fs.writeFile(good, 'PRIVATE')
    const warnings = []
    const transport = await transportForMachine(
      { id: 'ssh:box', kind: 'ssh', host: 'box', user: 'u' },
      [{ id: 'ssh:box', kind: 'ssh', host: 'box' }],
      { resolve: async () => ({ value: path.join(dir, 'moved-away.pem') }) },
      { warn: message => warnings.push(message) },
      undefined,
      { defaultKeyDir: dir },
    )
    assert.equal(transport.privateKeyPath, good)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /does not exist/)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('transportForMachine: without a credential the IdentityFile from ~/.ssh/config is used', async () => {
  // The user asked for a default key path: a host that already works from a
  // terminal must not need a hand-typed key in the panel.
  const credentials = { resolve: async () => undefined }
  const transport = await transportForMachine(
    { id: 'ssh:box', kind: 'ssh', host: 'box', user: 'u', identityFile: '/keys/from-config' },
    [{ id: 'ssh:box', kind: 'ssh', host: 'box' }],
    credentials,
    undefined,
    undefined,
    { defaultKeyDir: '/nonexistent' },
  )
  assert.equal(transport.privateKeyPath, '/keys/from-config')
})

test('transportForMachine: without a credential the conventional ~/.ssh key is used', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-keys-'))
  try {
    const key = path.join(dir, 'id_ed25519')
    await fs.writeFile(key, 'PRIVATE')
    const transport = await transportForMachine(
      { id: 'ssh:box', kind: 'ssh', host: 'box', user: 'u' },
      [{ id: 'ssh:box', kind: 'ssh', host: 'box' }],
      { resolve: async () => undefined },
      undefined,
      undefined,
      { defaultKeyDir: dir },
    )
    assert.equal(transport.privateKeyPath, key)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('transportForMachine: no key anywhere explains what to do, not which ref is missing', async () => {
  await assert.rejects(
    transportForMachine(
      { id: 'ssh:box', kind: 'ssh', host: 'box', user: 'u', label: 'box' },
      [{ id: 'ssh:box', kind: 'ssh', host: 'box' }],
      { resolve: async () => undefined },
      undefined,
      undefined,
      { defaultKeyDir: '/nonexistent' },
    ),
    error => /no SSH private key for 'box'/.test(error.message)
      && /IdentityFile/.test(error.message)
      && /id_ed25519/.test(error.message),
  )
})

test('transportForMachine: a jump host also falls back to its own IdentityFile', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-hopkey-'))
  try {
    const targetKey = path.join(dir, 'target')
    await fs.writeFile(targetKey, 'PRIVATE')
    const machines = [
      { id: 'ssh:bastion', kind: 'ssh', hostname: 'bastion', user: 'b', identityFile: '/keys/bastion' },
      { id: 'ssh:target', kind: 'ssh', hostname: 'target', user: 't', via: ['ssh:bastion'] },
    ]
    const transport = await transportForMachine(machines[1], machines, {
      resolve: async ref => (ref.endsWith('ssh:target') ? { value: targetKey } : undefined),
    })
    assert.equal(transport.via[0].privateKeyPath, '/keys/bastion')
    assert.equal(transport.privateKeyPath, targetKey)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('SshTransport: a missing key file names the key path, not the remote home', async () => {
  // Regression: the old code let a bare ENOENT escape, which discovery wrapped
  // as "cannot resolve home: ENOENT … open '/home/me/.ssh/key.pem'" — it sent a
  // user hunting for a home-directory problem when the cause was a typo.
  const transport = new SshTransport({ host: 'box', username: 'u', privateKeyPath: '/definitely/missing/key.pem' })
  await assert.rejects(transport.home(), error => {
    assert.match(error.message, /cannot read the SSH private key '\/definitely\/missing\/key.pem'/)
    assert.match(error.message, /no such file/)
    assert.equal(error.keyPath, '/definitely/missing/key.pem')
    return true
  })
})

test('transportForMachine: each hop resolves its own key and the chain order is kept', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-chain-'))
  try {
    // Every credential resolves to a real file, otherwise the stale-path
    // fallback would (correctly) take over.
    const write = async name => { const file = path.join(dir, name); await fs.writeFile(file, 'PRIVATE'); return file }
    const keys = {
      'ssh:outer': await write('outer'),
      'ssh:inner': await write('inner'),
      'ssh:target': await write('target'),
    }
    const asked = []
    const credentials = {
      resolve: async ref => {
        asked.push(ref)
        const id = ref.split('/').pop()
        return keys[id] ? { value: keys[id] } : undefined
      },
    }
    const machines = [
      { id: 'ssh:outer', kind: 'ssh', hostname: 'outer.example', user: 'o', port: 2200 },
      { id: 'ssh:inner', kind: 'ssh', host: 'inner.example', user: 'i' },
      { id: 'ssh:target', kind: 'ssh', host: 'target.example', user: 't', via: ['ssh:outer', 'ssh:inner'] },
    ]
    const transport = await transportForMachine(machines[2], machines, credentials)
    assert.equal(transport.via.length, 2)
    assert.deepEqual(transport.via.map(step => step.host), ['outer.example', 'inner.example'])
    assert.deepEqual(transport.via.map(step => step.privateKeyPath), [keys['ssh:outer'], keys['ssh:inner']])
    assert.equal(transport.privateKeyPath, keys['ssh:target'])
    // the target's key is never reused for a hop
    assert.equal(new Set(asked).size, 3)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('LocalTransport.mkdir(): a file in the way is an error, not a hang', async () => {
  // Regression: `fs.mkdir(dir, {recursive:true})` walks up the path on ENOENT and
  // retries. On some paths (Linux /proc reports ENOENT for a parent that exists)
  // that loop never terminates and spins the CPU forever, which hung a CI job for
  // five minutes with no error at all. Walking the components turns it into an
  // ordinary failure the caller can report.
  const transport = new LocalTransport()
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-mkdir-'))
  try {
    const blocker = path.join(root, 'blocker')
    await fs.writeFile(blocker, 'a file\n')
    await assert.rejects(
      () => transport.mkdir(path.join(blocker, 'nested', 'dir')),
      /a file is in the way|cannot create the directory/i,
    )
    // An existing directory chain is still fine (idempotent, like recursive mkdir).
    const deep = path.join(root, 'a', 'b', 'c')
    await transport.mkdir(deep)
    await transport.mkdir(deep)
    assert.equal((await fs.stat(deep)).isDirectory(), true)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('LocalTransport.mkdir(): a path that reports ENOENT forever is reported, not retried forever', async () => {
  // The exact wedge: a filesystem that answers ENOENT for a parent that exists.
  // The old code looped here; the new code reports the ENOENT for that component.
  if (process.platform !== 'linux') return
  const transport = new LocalTransport()
  const started = Date.now()
  await assert.rejects(
    () => transport.mkdir('/proc/definitely-not-writable/x'),
    error => error.code === 'ENOENT',
  )
  assert.ok(Date.now() - started < 5000, 'mkdir took too long; is it looping again?')
})

test('SshTransport._keyMaterial(): .pub uses ssh-agent, a private key is read from disk', async () => {
  // A passphrase-protected key cannot be read by ssh2 without the passphrase, so
  // the documented setup is to load it into the agent and point the plugin at the
  // .pub file. Reading the .pub as if it were a private key would fail with a
  // confusing parse error instead.
  const { SshTransport } = await import('../lib/transports.js')
  const instance = new SshTransport({ host: 'h', username: 'u' })

  const previous = process.env.SSH_AUTH_SOCK
  try {
    process.env.SSH_AUTH_SOCK = '/tmp/fake-agent.sock'
    const viaAgent = await instance._keyMaterial('/home/dev/.ssh/id_ed25519.pub')
    assert.equal(viaAgent.agent, '/tmp/fake-agent.sock')
    assert.equal(viaAgent.privateKey, undefined, 'the .pub file must not be read as key material')

    delete process.env.SSH_AUTH_SOCK
    await assert.rejects(
      () => instance._keyMaterial('/home/dev/.ssh/id_ed25519.pub'),
      /must be in ssh-agent, but SSH_AUTH_SOCK is not set/,
    )

    // A real private key file is still read from disk.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-key-'))
    const keyFile = path.join(dir, 'id_ed25519')
    await fs.writeFile(keyFile, 'KEY-BYTES')
    const material = await instance._keyMaterial(keyFile)
    assert.equal(material.privateKey?.toString(), 'KEY-BYTES')
    assert.equal(material.agent, undefined)
    await fs.rm(dir, { recursive: true, force: true })
  } finally {
    if (previous === undefined) delete process.env.SSH_AUTH_SOCK
    else process.env.SSH_AUTH_SOCK = previous
  }
})
