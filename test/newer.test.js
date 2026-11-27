import test from 'node:test'
import assert from 'node:assert/strict'
import { compareSides, resolveDirection } from '../lib/newer.js'

// "Which side is newer" is the guard against a sync quietly pushing stale text
// over a file the user edited a minute ago, so the boundaries are worth pinning
// down precisely.

const NOW = 1_800_000_000_000

test('compareSides(): a newer source file means import', () => {
  // No sync yet, so both sides count as moved and the later stamp decides.
  const result = compareSides({ externalMtimeMs: NOW + 60_000, dshLastTime: NOW, direction: 'both' })
  assert.equal(result.newer, 'external')
  assert.equal(result.direction, 'in')
  assert.match(result.reason, /source is newer/)
})

test('compareSides(): a newer DSH session means export', () => {
  const result = compareSides({ externalMtimeMs: NOW, dshLastTime: NOW + 60_000, direction: 'both' })
  assert.equal(result.newer, 'dsh')
  assert.equal(result.direction, 'out')
  assert.match(result.reason, /DSH is newer/)
})

test('compareSides(): a difference inside the slack window counts as in step', () => {
  // Filesystem timestamps are coarse and the two sides are written a moment
  // apart; a 1s difference is not a real edit and must not flip the direction.
  const result = compareSides({ externalMtimeMs: NOW + 400, dshLastTime: NOW, direction: 'both' })
  assert.equal(result.newer, 'equal')
  assert.equal(result.direction, 'both')
})

test('compareSides(): one side moving inside the slack window is still "in step"', () => {
  // A file written 300ms after the sync stamp is the sync itself finishing, not
  // a user edit.
  const result = compareSides({
    externalMtimeMs: NOW + 300,
    dshLastTime: NOW - 1000,
    lastSyncAt: NOW,
    direction: 'both',
  })
  assert.equal(result.newer, 'equal')
})

test('compareSides(): a missing source file means export, not import', () => {
  const result = compareSides({ externalMtimeMs: undefined, dshLastTime: NOW, direction: 'both' })
  assert.equal(result.newer, 'dsh')
  assert.equal(result.direction, 'out')
  assert.match(result.reason, /does not exist/)
})

test('compareSides(): a freshly copied old file is not "newer"', () => {
  // The bug this pins: a rollout from a year ago was copied to a new machine,
  // so its mtime is now while its content is ancient. Comparing mtime against
  // the newest DSH event time said "the machine is newer" forever, and every
  // automatic sync re-imported it. Anchoring on the last sync fixes that: the
  // file landed BEFORE the sync, so it has not moved since.
  const synced = NOW
  const result = compareSides({
    externalMtimeMs: NOW - 5_000, // copied a moment before the sync
    dshLastTime: NOW - 365 * 24 * 3600_000, // an old conversation, just imported
    lastSyncAt: synced,
    direction: 'both',
  })
  assert.equal(result.newer, 'equal')
  assert.equal(result.direction, 'both')
  assert.match(result.reason, /since the last sync/)
})

test('compareSides(): a source edited after the last sync is newer', () => {
  const result = compareSides({
    externalMtimeMs: NOW + 60_000,
    dshLastTime: NOW - 1000,
    lastSyncAt: NOW,
    direction: 'both',
  })
  assert.equal(result.newer, 'external')
  assert.equal(result.direction, 'in')
  assert.match(result.reason, /since the last sync/)
})

test('compareSides(): a DSH session written after the last sync is newer', () => {
  const result = compareSides({
    externalMtimeMs: NOW - 1000,
    dshLastTime: NOW + 60_000,
    lastSyncAt: NOW,
    direction: 'both',
  })
  assert.equal(result.newer, 'dsh')
  assert.equal(result.direction, 'out')
})

test('compareSides(): when both moved, the later stamp wins', () => {
  const result = compareSides({
    externalMtimeMs: NOW + 60_000,
    dshLastTime: NOW + 30_000,
    lastSyncAt: NOW,
    direction: 'both',
  })
  assert.equal(result.newer, 'external')
  assert.equal(result.direction, 'in')
  assert.match(result.reason, /both changed/)
})

test('compareSides(): an import stamped with an old conversation time still counts as a DSH write', () => {
  // Importing a rollout writes events carrying the ORIGINAL conversation time.
  // Without accounting for the sync itself, DSH would look untouched and the
  // next comparison would import the same file again.
  const result = compareSides({
    externalMtimeMs: NOW - 1000,
    dshLastTime: NOW - 365 * 24 * 3600_000,
    lastSyncAt: NOW - 500,
    direction: 'both',
  })
  assert.equal(result.newer, 'equal', 'the sync itself must count as DSH having been written')
})

test('compareSides(): an empty DSH session means import', () => {
  const result = compareSides({ externalMtimeMs: NOW, dshLastTime: undefined, direction: 'both' })
  assert.equal(result.newer, 'external')
  assert.equal(result.direction, 'in')
})

test('compareSides(): an empty session after a sync means the source still has it', () => {
  const result = compareSides({
    externalMtimeMs: NOW - 5000,
    dshLastTime: undefined,
    lastSyncAt: NOW,
    direction: 'both',
  })
  // Nothing moved since the sync, so there is nothing to do.
  assert.equal(result.newer, 'equal')
})

test('compareSides(): an empty source file is not "newer", however recent its mtime', () => {
  // This is the safety scenario's failure: a target created empty a moment ago
  // has the newest mtime of all, so a timestamp-only comparison declared it the
  // winner and then imported nothing.
  const result = compareSides({
    externalMtimeMs: NOW + 60_000,
    externalSize: 0,
    dshLastTime: NOW - 329 * 24 * 3600_000,
    lastSyncAt: NOW,
    direction: 'both',
  })
  assert.equal(result.newer, 'dsh')
  assert.equal(result.direction, 'out')
  assert.match(result.reason, /empty/)
})

test('compareSides(): a source that does not exist yet cannot be imported', () => {
  const result = compareSides({ externalMtimeMs: 0, dshLastTime: 0, direction: 'in' })
  // Nothing to read on the machine side, so export is the only move that can
  // do anything - even when the binding is pinned to import.
  assert.equal(result.newer, 'dsh')
  assert.equal(result.direction, 'out')
})

test('compareSides(): a never-synced binding with an empty session imports', () => {
  const result = compareSides({ externalMtimeMs: NOW, dshLastTime: 0, direction: 'in' })
  assert.equal(result.newer, 'external')
  assert.equal(result.direction, 'in')
})

test('resolveDirection(): auto takes the comparison', () => {
  const comparison = { newer: 'external', direction: 'in' }
  assert.equal(resolveDirection('auto', comparison), 'in')
  assert.equal(resolveDirection('auto', { newer: 'dsh', direction: 'out' }), 'out')
  // Nothing moved, so auto does nothing: rewriting a file that is already
  // correct is wasted work and makes "did it change?" unanswerable.
  assert.equal(resolveDirection('auto', { newer: 'equal', direction: 'both' }), 'none')
  assert.equal(resolveDirection('auto', { newer: 'unknown', direction: 'both' }), 'none')
})

test('resolveDirection(): both follows the newer side when the sides disagree', () => {
  assert.equal(resolveDirection('both', { newer: 'external', direction: 'in' }), 'in')
  assert.equal(resolveDirection('both', { newer: 'dsh', direction: 'out' }), 'out')
  // When they agree, both legs are safe.
  assert.equal(resolveDirection('both', { newer: 'equal', direction: 'both' }), 'both')
  assert.equal(resolveDirection('both', { newer: 'unknown', direction: 'both' }), 'both')
})

test('resolveDirection(): an explicit one-sided choice is respected', () => {
  // Pinning "import only" must not silently start exporting because the DSH
  // side happens to be newer.
  assert.equal(resolveDirection('in', { newer: 'dsh', direction: 'out' }), 'in')
  assert.equal(resolveDirection('out', { newer: 'external', direction: 'in' }), 'out')
})

test('compareSides(): reason strings stay human-readable', () => {
  const minutes = compareSides({ externalMtimeMs: NOW + 5 * 60_000, dshLastTime: NOW })
  assert.match(minutes.reason, /5min/)
  const hours = compareSides({ externalMtimeMs: NOW, dshLastTime: NOW + 3 * 3600_000 })
  assert.match(hours.reason, /3h/)
  const days = compareSides({ externalMtimeMs: NOW, dshLastTime: NOW + 5 * 24 * 3600_000 })
  assert.match(days.reason, /5d/)
})
