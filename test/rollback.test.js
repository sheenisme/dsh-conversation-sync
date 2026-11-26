import test from 'node:test'
import assert from 'node:assert/strict'
import { SyncRollback, diagnoseFailure } from '../lib/rollback.js'
import { memoryTransport } from './helpers.js'

test('diagnoseFailure(): maps common errors to reason + retry conditions', () => {
  assert.match(diagnoseFailure(Object.assign(new Error('getaddrinfo ENOTFOUND host'), { code: 'ENOTFOUND' })).reason, /SSH connection or authentication failed/)
  assert.match(diagnoseFailure(Object.assign(new Error('EACCES'), { code: 'EACCES' })).reason, /permission denied/)
  assert.match(diagnoseFailure(Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })).reason, /no space left/)
  assert.match(diagnoseFailure(new Error('invalid zip data (code 13)')).reason, /not a valid export_format_version 3/)
  const s = diagnoseFailure(new Error('SessionAlreadyOwnedError'))
  assert.match(s.reason, /inconsistent/)
  assert.ok(s.conditions.some(c => /reopen it in DSH/.test(c)))
  assert.ok(diagnoseFailure(new Error('weird')).conditions.some(c => /backup was kept/.test(c)))
})

test('SyncRollback.begin(): backs up external file before write (out direction)', async () => {
  const t = memoryTransport({ '/remote/s.jsonl': 'original\n' })
  const rb = new SyncRollback()
  const snap = await rb.begin({
    bindingId: 'b/1', direction: 'out', externalPath: '/remote/s.jsonl',
    backupRoot: '/backups', externalTransport: t,
  })
  assert.equal(snap.external.existed, true)
  assert.equal(snap.external.bytes, 'original\n'.length)
  assert.match(snap.external.backupPath, /^\/backups\/b_1\//)
  assert.equal(t._store.get(snap.external.backupPath).toString(), 'original\n')
})

test('SyncRollback.begin(): no backup attempted for import (in direction)', async () => {
  const t = memoryTransport({ '/local/s.jsonl': 'x' })
  const rb = new SyncRollback()
  const snap = await rb.begin({
    bindingId: 'b2', direction: 'in', externalPath: '/local/s.jsonl',
    backupRoot: '/backups', externalTransport: t,
  })
  assert.equal(snap.external, null)
})

test('SyncRollback.fail(): restores external bytes and reports failure', async () => {
  const t = memoryTransport({ '/remote/s.jsonl': 'original\n' })
  const rb = new SyncRollback()
  const snap = await rb.begin({
    bindingId: 'b3', direction: 'out', externalPath: '/remote/s.jsonl',
    backupRoot: '/backups', externalTransport: t,
  })
  await t.write('/remote/s.jsonl', 'corrupted\n') // simulate failed partial write
  const { failure, report } = await rb.fail(snap, new Error('network dropped'), { path: '/remote/s.jsonl' }, { externalTransport: t })
  assert.equal(report.restored.external, true)
  assert.equal(t._store.get('/remote/s.jsonl').toString(), 'original\n')
  assert.match(failure.reason, /network dropped/)
  assert.ok(failure.conditions.length > 0)
  assert.ok(failure.conditions.some(c => /backup was kept/.test(c)))
})

test('SyncRollback.fail(): backup failure aborts begin before any write', async () => {
  const t = memoryTransport({ '/remote/s.jsonl': 'x' })
  t.copyToBackup = async () => { throw new Error('EACCES') }
  const rb = new SyncRollback()
  await assert.rejects(
    rb.begin({ bindingId: 'b4', direction: 'out', externalPath: '/remote/s.jsonl', backupRoot: '/backups', externalTransport: t }),
    /backup failed/,
  )
})

test('SyncRollback.fail(): DSH restore requires truncateFrom, else manual-cleanup report', async () => {
  const rb = new SyncRollback()
  const snap = {
    id: 'rb-x', direction: 'in', status: 'pending',
    dsh: { sessionId: 's1', fromSeq: 7, appendedCount: 3 },
  }
  const { report } = await rb.fail(snap, new Error('boom'), {}, {
    dshFacade: { getSeq: async () => 7 },
  })
  assert.equal(report.restored.dsh, false)
  assert.ok(report.errors.some(e => /remove them manually via the DSH UI/.test(e)))
})

test('diagnoseFailure: a mkdir failure names the plugin data directory, not the conversation file', () => {
  const error = Object.assign(new Error("EPERM: operation not permitted, mkdir '/Users/x/.dsh/conversation-sync'"), { code: 'EPERM' })
  const { reason, conditions } = diagnoseFailure(error, {
    path: '/home/u/session.jsonl', transportKind: 'local', dataRoot: '/Users/x/.dsh/conversation-sync',
  })
  assert.match(reason, /plugin data directory/)
  assert.ok(!/session\.jsonl/.test(reason), 'reason must not blame the conversation file')
  assert.ok(conditions.some(c => /DSH_HOME/.test(c)), 'conditions must mention DSH_HOME')
})

// The same EPERM-on-mkdir text also appears when a plugin cannot create the
// parent of an external conversation file. Blaming the plugin data directory
// there sends the user to the wrong fix, so the branch must distinguish them.
test('diagnoseFailure: a mkdir failure outside the data root blames the destination', () => {
  const error = Object.assign(new Error("EPERM: operation not permitted, mkdir '/proc/nope'"), { code: 'EPERM' })
  const { reason, conditions } = diagnoseFailure(error, {
    path: '/proc/nope/out.jsonl', transportKind: 'local', dataRoot: '/Users/x/.dsh/conversation-sync',
  })
  assert.match(reason, /cannot create the directory for \/proc\/nope\/out\.jsonl/)
  assert.ok(!/plugin data directory/.test(reason), 'must not blame the plugin data dir for an external path')
  assert.ok(conditions.some(c => /\/proc\/nope/.test(c)), 'conditions must name the real directory')
  assert.ok(conditions.every(c => !/DSH_HOME/.test(c)), 'an external path is not fixed by DSH_HOME')
})

test('diagnoseFailure: local permission denial does not tell the user to check an SSH account', () => {
  const error = Object.assign(new Error('EACCES: permission denied, open \'/home/u/s.jsonl\''), { code: 'EACCES' })
  const local = diagnoseFailure(error, { path: '/home/u/s.jsonl', transportKind: 'local' })
  assert.ok(local.conditions.every(c => !/SSH user/.test(c)))
  const ssh = diagnoseFailure(error, { path: '/home/u/s.jsonl', transportKind: 'ssh' })
  assert.ok(ssh.conditions.some(c => /SSH user/.test(c)))
})
