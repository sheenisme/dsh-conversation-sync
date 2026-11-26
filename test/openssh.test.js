import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { OpenSshTransport, classifySshFailure, shellQuote } from '../lib/openssh.js'

/**
 * The system-ssh transport is exercised through a stand-in `ssh` on PATH that
 * runs the remote command locally. That keeps these tests hermetic — no daemon,
 * no keys, no network — while still going through the real argument building,
 * stdin plumbing and exit-code handling, which is where bugs actually live.
 */
async function withStubSsh(body) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-openssh-'))
  const bin = path.join(root, 'bin')
  await fs.mkdir(bin, { recursive: true })
  await fs.writeFile(
    path.join(bin, 'ssh'),
    [
      '#!/bin/bash',
      'for a in "$@"; do if [ "$a" = "-V" ]; then echo "OpenSSH_10.3p1" >&2; exit 0; fi; done',
      'if [ "$1" = "-O" ]; then exit 0; fi',
      'args=("$@")',
      'script="${args[${#args[@]}-1]}"',
      'exec /bin/sh -c "$script"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  const previous = process.env.PATH
  process.env.PATH = `${bin}:${previous}`
  const remote = path.join(root, 'remote')
  await fs.mkdir(remote, { recursive: true })
  try {
    return await body({ root, remote })
  } finally {
    process.env.PATH = previous
    await fs.rm(root, { recursive: true, force: true })
  }
}

function transportFor(remote) {
  const transport = new OpenSshTransport({ host: 'stub', username: 'tester' })
  // `home()` is the one call the stub cannot answer sensibly (it would return
  // this machine's home), so it is supplied directly.
  transport._home = remote
  return transport
}

test('shellQuote: single quotes survive, injection cannot escape', () => {
  assert.equal(shellQuote('/tmp/a'), "'/tmp/a'")
  assert.equal(shellQuote("a'b"), `'a'"'"'b'`)
  assert.equal(shellQuote('$(rm -rf /)'), "'$(rm -rf /)'")
})

test('classifySshFailure: names the cause instead of echoing ssh', () => {
  assert.equal(classifySshFailure('Permission denied (publickey).', 255), 'EAUTH')
  assert.equal(classifySshFailure('Host key verification failed.', 255), 'EHOSTKEY')
  assert.equal(classifySshFailure('ssh: Could not resolve hostname nope: nodename nor servname provided', 255), 'ENOTFOUND')
  assert.equal(classifySshFailure('ssh: connect to host x port 22: Connection refused', 255), 'ECONNREFUSED')
  assert.equal(classifySshFailure('Connection timed out during banner exchange', 255), 'ETIMEDOUT')
  assert.equal(classifySshFailure('something else', 255), 'ESSH')
  assert.equal(classifySshFailure('anything', 7), 'ESSH:7')
})

test('OpenSshTransport: write, stat, read from an offset, append, list', async () => {
  await withStubSsh(async ({ remote }) => {
    const transport = transportFor(remote)
    const file = path.join(remote, 'a', 'b', 'log.jsonl')
    await transport.write(file, 'line1\nline2\n')
    const stat = await transport.stat(file)
    assert.equal(stat.size, 12)
    // Remote `stat` reports whole seconds, so compare at that resolution.
    assert.equal(Math.floor(stat.mtimeMs / 1000), Math.floor((await fs.stat(file)).mtime.getTime() / 1000))

    assert.equal((await transport.read(file)).toString(), 'line1\nline2\n')
    assert.equal((await transport.read(file, 6, 5)).toString(), 'line2')

    await transport.append(file, 'line3\n')
    assert.equal((await transport.read(file, 12)).toString(), 'line3\n')
    assert.equal((await transport.stat(file)).size, 18)

    assert.deepEqual(await transport.list(path.join(remote, 'a')), [{ name: 'b', isDirectory: true }])
    transport.close()
  })
})

test('OpenSshTransport: an absent path is undefined, not an exception', async () => {
  await withStubSsh(async ({ remote }) => {
    const transport = transportFor(remote)
    assert.equal(await transport.stat(path.join(remote, 'nope')), undefined)
    assert.equal(await transport.list(path.join(remote, 'nope')), undefined)
    // A missing file reads as empty: callers treat that as "nothing new yet".
    assert.equal((await transport.read(path.join(remote, 'nope'))).length, 0)
    transport.close()
  })
})

test('OpenSshTransport: a file where a directory belongs is explained', async () => {
  await withStubSsh(async ({ remote }) => {
    const transport = transportFor(remote)
    const file = path.join(remote, 'plain')
    await fs.writeFile(file, 'x')
    await assert.rejects(() => transport.mkdir(file), /a file is in the way/)
    transport.close()
  })
})

test('OpenSshTransport: copyToBackup makes the parent directory', async () => {
  await withStubSsh(async ({ remote }) => {
    const transport = transportFor(remote)
    const file = path.join(remote, 'src.jsonl')
    await transport.write(file, 'data\n')
    const backup = path.join(remote, 'backups', 'deep', 'src.bak')
    await transport.copyToBackup(file, backup)
    assert.equal((await transport.read(backup)).toString(), 'data\n')
    transport.close()
  })
})

test('OpenSshTransport: a closed transport refuses to run commands', async () => {
  await withStubSsh(async ({ remote }) => {
    const transport = transportFor(remote)
    transport.close()
    await assert.rejects(() => transport.home(), /closed/)
  })
})

test('OpenSshTransport: a connection failure surfaces the ssh error, not a hang', { timeout: 30000 }, async () => {
  // Port 1 on loopback refuses immediately: this exercises the real `ssh`
  // binary end to end without needing a server.
  const transport = new OpenSshTransport({ host: '127.0.0.1', port: 1, username: 'nobody' })
  await assert.rejects(() => transport.home(), error => {
    assert.equal(error.code, 'ECONNREFUSED')
    assert.match(error.message, /Connection refused/)
    return true
  })
  transport.close()
})

test('OpenSshTransport: an unreachable host fails once, not once per command', async () => {
  // A scan calls home() and then several roots. Re-dialling a host that already
  // refused wastes a timeout each time and multiplies the same error.
  const transport = new OpenSshTransport({ host: '127.0.0.1', port: 1, username: 'nobody' })
  await assert.rejects(() => transport.home(), /Connection refused/)
  const started = Date.now()
  await assert.rejects(() => transport.stat('/anything'), /Connection refused/)
  await assert.rejects(() => transport.list('/anything'), /Connection refused/)
  // The remembered failure returns immediately rather than reconnecting.
  assert.ok(Date.now() - started < 1000, 'the second and third calls must not reconnect')
  transport.close()
})
