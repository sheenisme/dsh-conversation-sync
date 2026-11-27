import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { keyRefFor } from '../lib/transports.js'

const run = promisify(execFile)
const script = path.join(import.meta.dirname, '..', 'scripts', 'fix-credentials.mjs')
const node = process.execPath

// A store an earlier build poisoned by naming a credential after a machine id.
const POISONED = `version: 1
refs:
  conversation-sync/ssh-key/ssh:BAAI-Ascend: /home/me/.ssh/id_ed25519
  conversation-sync/ssh-key/ssh:prod-app: /home/me/.ssh/prod_ed25519
  DEEPSEEK_API_KEY: sk-keep-me
records:
  client-connection/browser-session:
    kind: session
    payload:
      version: 1
      secret: keep-me-too
`

async function store(text) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cred-'))
  await fs.writeFile(path.join(home, '.credentials.yaml'), text, { mode: 0o600 })
  return home
}

const call = async (home, ...flags) => {
  const { stdout } = await run(node, [script, ...flags], { env: { ...process.env, DSH_HOME: home } })
  return stdout
}

test('fix-credentials: a dry run reports and changes nothing', async () => {
  const home = await store(POISONED)
  try {
    const out = await call(home)
    assert.match(out, /2 invalid credential reference/)
    assert.match(out, /Dry run/)
    const after = await fs.readFile(path.join(home, '.credentials.yaml'), 'utf8')
    assert.equal(after, POISONED)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('fix-credentials --write renames the bad keys and keeps every value', async () => {
  const home = await store(POISONED)
  try {
    const out = await call(home, '--write')
    assert.match(out, /rewritten/)
    const after = await fs.readFile(path.join(home, '.credentials.yaml'), 'utf8')
    // Nothing the plugin wrote can be read by the store any more.
    assert.doesNotMatch(after, /conversation-sync\/ssh-key/)
    // Every value survives, and the untouched sections are byte-identical.
    assert.match(after, /\/home\/me\/\.ssh\/id_ed25519/)
    assert.match(after, /\/home\/me\/\.ssh\/prod_ed25519/)
    assert.match(after, /DEEPSEEK_API_KEY: sk-keep-me/)
    assert.match(after, /secret: keep-me-too/)
    // The renamed key is the one the plugin will actually look up.
    assert.match(after, new RegExp(`${keyRefFor('ssh:BAAI-Ascend')}: /home/me/\\.ssh/id_ed25519`))
    assert.match(after, new RegExp(`${keyRefFor('ssh:prod-app')}: /home/me/\\.ssh/prod_ed25519`))
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('fix-credentials --write keeps a backup of the original', async () => {
  const home = await store(POISONED)
  try {
    await call(home, '--write')
    const files = await fs.readdir(home)
    const backup = files.find(name => name.startsWith('.credentials.yaml.bak-'))
    assert.ok(backup, `no backup among ${files.join(', ')}`)
    assert.equal(await fs.readFile(path.join(home, backup), 'utf8'), POISONED)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('fix-credentials: a clean store is left alone', async () => {
  const clean = 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-x\n'
  const home = await store(clean)
  try {
    const out = await call(home, '--write')
    assert.match(out, /is clean/)
    assert.equal(await fs.readFile(path.join(home, '.credentials.yaml'), 'utf8'), clean)
    const files = await fs.readdir(home)
    assert.equal(files.filter(name => name.includes('.bak-')).length, 0)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('fix-credentials: a missing store is not an error', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cred-none-'))
  try {
    const out = await call(home)
    assert.match(out, /no credential store/)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})
