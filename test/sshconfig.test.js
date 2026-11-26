import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSshConfig, discoverMachines } from '../lib/sshconfig.js'
import { memoryTransport } from './helpers.js'

test('parseSshConfig: stanzas, quoted tokens, port validation, warnings', () => {
  const text = `
Include ~/.ssh/conf.d/*
Host bastion
  HostName bastion.example.com
  User ubuntu
  Port 2222
  IdentityFile ~/.ssh/id_ed25519
Host "web one" web2
  HostName 10.0.0.5
  ProxyJump ubuntu@bastion:2222
Host broken
  Port 99999
Match Host foo
  User ignored
`
  const stanzas = parseSshConfig(text)
  assert.equal(stanzas.length, 3)
  assert.equal(stanzas[0].patterns[0], 'bastion')
  assert.equal(stanzas[0].hostname, 'bastion.example.com')
  assert.equal(stanzas[0].user, 'ubuntu')
  assert.equal(stanzas[0].port, 2222)
  assert.equal(stanzas[0].identityFile, '~/.ssh/id_ed25519')
  assert.deepEqual(stanzas[1].patterns, ['web one', 'web2'])
  assert.equal(stanzas[1].proxyJump, 'ubuntu@bastion:2222')
  // invalid port omitted; Match block did not attach User to 'broken'
  assert.equal(stanzas[2].port, undefined)
  assert.equal(stanzas[2].user, undefined)
  const warnings = stanzas[Symbol.for('sshConfigWarnings')] ?? stanzas[Object.getOwnPropertySymbols(stanzas)[0]]
  assert.ok(warnings.some(w => /Include directive ignored/.test(w)))
  assert.ok(warnings.some(w => /Ignored invalid Port value/.test(w)))
})

test('discoverMachines: local first, jump hosts are machines, wildcard skipped', async () => {
  const transport = memoryTransport({}, { home: '/home/tester' })
  // discoverMachines reads ~/.ssh/config via fs (not transport) — write a temp home.
  const os = await import('node:os')
  const path = await import('node:path')
  const fs = await import('node:fs/promises')
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-ssh-'))
  await fs.mkdir(path.join(tmp, '.ssh'))
  await fs.writeFile(path.join(tmp, '.ssh', 'config'), `
Host bastion
  HostName bastion.example.com
  User ubuntu
Host prod
  HostName 10.0.0.9
  ProxyJump ubuntu@bastion
Host *.internal
  User nobody
`)
  try {
    const { machines, warnings } = await discoverMachines({ home: tmp })
    const ids = machines.map(m => m.id)
    assert.deepEqual(ids.slice(0, 1), ['local'])
    assert.ok(ids.includes('ssh:bastion'), 'bastion is a machine')
    assert.ok(ids.includes('ssh:prod'), 'prod is a machine')
    const prod = machines.find(m => m.id === 'ssh:prod')
    assert.deepEqual(prod.via, ['ssh:bastion'])
    const bastion = machines.find(m => m.id === 'ssh:bastion')
    assert.equal(bastion.isJump, true)
    assert.ok(warnings.some(w => /wildcard/.test(w)))
    assert.ok(!ids.some(id => id.includes('internal')), 'wildcard host not registered')
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
})

test('discoverMachines: no config yields just local', async () => {
  const os = await import('node:os')
  const path = await import('node:path')
  const fs = await import('node:fs/promises')
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-ssh-'))
  try {
    const { machines, warnings } = await discoverMachines({ home: tmp })
    assert.deepEqual(machines.map(m => m.id), ['local'])
    assert.deepEqual(warnings, [])
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
})
