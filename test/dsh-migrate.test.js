import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { workspaceSlug, readHeader, rewriteCwd, migrateIntoSyncWorkspace } from '../lib/dsh-migrate.js'
import { findSessionDirs, backupSessionDir, restoreSessionDir, removeSessionDir } from '../lib/dsh-store.js'

// A DSH session log is multi-frame zstd: frame 1 is the header, every later
// frame holds events. These helpers write exactly that shape so the tests
// exercise the real file format rather than a single-frame stand-in.
function framesOf(header, events = []) {
  const parts = [zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`))]
  for (const event of events) parts.push(zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`)))
  return Buffer.concat(parts)
}

async function makeSession(dir, id, cwd, events = []) {
  const target = path.join(dir, id)
  await fs.mkdir(target, { recursive: true })
  await fs.writeFile(
    path.join(target, 'session.v4.jsonl.zstd'),
    framesOf({ type: 'session', version: 4, id, createdAt: 1, cwd, isSeeded: false }, events),
  )
  return target
}

async function tempHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cs-migrate-'))
}

test('workspaceSlug(): matches the directory names DSH actually creates', () => {
  assert.equal(
    workspaceSlug('/Users/me/.dsh/conversation-sync/workspaces/local'),
    '--Users-me-.dsh-conversation-sync-workspaces-local--',
  )
  assert.equal(workspaceSlug('/a/b'), '--a-b--')
})

test('readHeader(): reads frame one only, keeping the later frames', async () => {
  const home = await tempHome()
  const dir = path.join(home, 'sessions', '--slug--')
  await makeSession(dir, 'conversation-x', '/work', [{ type: 'user/message', seq: 1 }, { type: 'turn/end', seq: 2 }])
  const { header, frames } = await readHeader(path.join(dir, 'conversation-x', 'session.v4.jsonl.zstd'))
  assert.equal(header.cwd, '/work')
  assert.equal(frames.length, 3, 'one header frame plus two event frames')
  await fs.rm(home, { recursive: true, force: true })
})

test('rewriteCwd(): changes the header and leaves every event frame byte-identical', async () => {
  const home = await tempHome()
  const dir = path.join(home, 'sessions', '--slug--')
  await makeSession(dir, 'conversation-x', '/old', [{ type: 'user/message', seq: 1 }])
  const log = path.join(dir, 'conversation-x', 'session.v4.jsonl.zstd')
  const before = await fs.readFile(log)

  assert.equal(await rewriteCwd(log, '/new'), true)
  const after = await fs.readFile(log)
  const { header } = await readHeader(log)
  assert.equal(header.cwd, '/new')

  // The trailing event frame must survive verbatim; only the header changed.
  const magic = Buffer.from('28b52ffd', 'hex')
  const tail = buffer => buffer.subarray(buffer.indexOf(magic, 4))
  assert.deepEqual(tail(after), tail(before))
  // Rewriting again to the same path is a no-op.
  assert.equal(await rewriteCwd(log, '/new'), false)
  await fs.rm(home, { recursive: true, force: true })
})

test('migrateIntoSyncWorkspace(): moves this plugin\'s sessions and nothing else', async () => {
  const home = await tempHome()
  const ownedRoot = path.join(home, 'conversation-sync', 'workspaces')
  const syncDir = path.join(ownedRoot, 'sync')
  const oldLocal = path.join(ownedRoot, 'local')
  const foreignWs = path.join(home, 'another-plugin', 'ws')
  await fs.mkdir(syncDir, { recursive: true })

  const oldDir = path.join(home, 'sessions', workspaceSlug(oldLocal))
  const foreignDir = path.join(home, 'sessions', workspaceSlug(foreignWs))
  await makeSession(oldDir, 'conversation-mine', oldLocal)
  await makeSession(foreignDir, 'conversation-theirs', foreignWs)

  const report = await migrateIntoSyncWorkspace({ dshHome: home, ownedRoot, syncDir })
  assert.deepEqual(report.moved.map(entry => entry.sessionId), ['conversation-mine'])
  assert.equal(report.errors.length, 0)

  const moved = await readHeader(path.join(home, 'sessions', workspaceSlug(syncDir), 'conversation-mine', 'session.v4.jsonl.zstd'))
  assert.equal(moved.header.cwd, syncDir, 'the header cwd must equal the new workspace path')
  assert.equal(await exists(path.join(oldDir, 'conversation-mine')), false, 'the old directory is removed')
  assert.equal(await exists(path.join(foreignDir, 'conversation-theirs')), true, 'another plugin\'s session is untouched')

  // Idempotent: a second run finds nothing left to move.
  const again = await migrateIntoSyncWorkspace({ dshHome: home, ownedRoot, syncDir })
  assert.equal(again.moved.length, 0)
  await fs.rm(home, { recursive: true, force: true })
})

test('migrateIntoSyncWorkspace(): a session already in the sync workspace is left alone', async () => {
  const home = await tempHome()
  const ownedRoot = path.join(home, 'conversation-sync', 'workspaces')
  const syncDir = path.join(ownedRoot, 'sync')
  await fs.mkdir(syncDir, { recursive: true })
  const syncDirOnDisk = path.join(home, 'sessions', workspaceSlug(syncDir))
  await makeSession(syncDirOnDisk, 'conversation-here', syncDir)

  const report = await migrateIntoSyncWorkspace({ dshHome: home, ownedRoot, syncDir })
  assert.equal(report.moved.length, 0)
  assert.equal(await exists(path.join(syncDirOnDisk, 'conversation-here')), true)
  await fs.rm(home, { recursive: true, force: true })
})

test('findSessionDirs(): locates a session under whichever workspace slug holds it', async () => {
  const home = await tempHome()
  await makeSession(path.join(home, 'sessions', '--a--'), 'conversation-x', '/a')
  await makeSession(path.join(home, 'sessions', '--b--'), 'conversation-x', '/b')
  const dirs = await findSessionDirs(home, 'conversation-x')
  assert.equal(dirs.length, 2)
  assert.deepEqual(await findSessionDirs(home, 'conversation-missing'), [])
  await fs.rm(home, { recursive: true, force: true })
})

test('backupSessionDir()/restoreSessionDir(): a file-level undo of an append', async () => {
  const home = await tempHome()
  const backupRoot = path.join(home, 'backups')
  const dir = path.join(home, 'sessions', '--slug--')
  await makeSession(dir, 'conversation-x', '/work')
  const log = path.join(dir, 'conversation-x', 'session.v4.jsonl.zstd')
  const original = await fs.readFile(log)

  const backup = await backupSessionDir({ dshHome: home, sessionId: 'conversation-x', backupRoot, label: 'bnd' })
  assert.ok(backup?.backupPath)
  assert.equal(backup.existed, true)

  // Simulate an append that later has to be undone.
  await fs.writeFile(log, Buffer.concat([original, zlib.zstdCompressSync(Buffer.from('{"type":"turn/end"}\n'))]))
  assert.ok((await fs.stat(log)).size > original.length)

  await restoreSessionDir({ dshHome: home, sessionId: 'conversation-x', backupPath: backup.backupPath })
  assert.deepEqual(await fs.readFile(log), original, 'the log is byte-identical to before the append')
  await fs.rm(home, { recursive: true, force: true })
})

test('backupSessionDir(): a session not yet on disk is not an error', async () => {
  const home = await tempHome()
  const backup = await backupSessionDir({
    dshHome: home, sessionId: 'conversation-new', backupRoot: path.join(home, 'backups'), label: 'bnd',
  })
  assert.equal(backup, undefined)
  await fs.rm(home, { recursive: true, force: true })
})

test('removeSessionDir(): deletes every copy of a session this sync created', async () => {
  const home = await tempHome()
  await makeSession(path.join(home, 'sessions', '--a--'), 'conversation-x', '/a')
  await makeSession(path.join(home, 'sessions', '--b--'), 'conversation-x', '/b')
  const removed = await removeSessionDir({ dshHome: home, sessionId: 'conversation-x' })
  assert.equal(removed.length, 2)
  assert.deepEqual(await findSessionDirs(home, 'conversation-x'), [])
  await fs.rm(home, { recursive: true, force: true })
})

async function exists(target) {
  try {
    await fs.stat(target)
    return true
  } catch {
    return false
  }
}
