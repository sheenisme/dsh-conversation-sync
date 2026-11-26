#!/usr/bin/env node
/**
 * Functional scenarios that exercise the real user journey against a booted
 * DeepSeek Harness, over the same HTTP RPC surface the panel uses.
 *
 * Each scenario is independent and boots its own throwaway profile, so one
 * failure does not hide the others and a stale home cannot mask a bug.
 *
 * Usage:
 *   node scripts/ci/scenario.mjs --scenario <name> --dsh <bin.js> \
 *     --tarball <tgz> --home <dir> [--port 5399] [--fixtures <dir>] [--keep]
 *
 * Scenarios:
 *   import    a real Claude Code rollout becomes a DSH session with its text
 *   export    a DSH session is written back out as tool records
 *   formats   every supported tool format imports through the same path
 *   failure   a broken source fails with a reason and recovery conditions
 *   reimport  syncing twice does not duplicate already-imported content
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { assert, parseCommonArgs, withHarness } from './harness.mjs'

const log = (...parts) => console.log('[scenario]', ...parts)

/** Every format the plugin claims to read, with the text it must produce. */
const FORMATS = [
  { kind: 'claude', file: 'claude-basic.jsonl', expect: 'List the files in the current directory.' },
  { kind: 'codex', file: 'codex-basic.jsonl', expect: 'Show the git status.' },
  { kind: 'workbuddy', file: 'workbuddy-basic.jsonl', expect: 'Add a license header.' },
  { kind: 'trae', file: 'trae-basic.jsonl', expect: 'Refactor the parser.' },
  { kind: 'antigravity', file: 'antigravity-basic.jsonl', expect: 'Explain the build script.' },
]

/** Import one file and return the DSH row that received it. */
async function importFile(rpc, args, { kind, file }, extra = {}) {
  const externalPath = path.join(args.fixtures, file)
  await fs.access(externalPath)
  const paired = await rpc({
    action: 'pair',
    binding: { machineId: 'local', externalPath, kind, direction: 'in', dshSessionIds: [], ...extra },
  })
  const result = paired.result ?? paired
  assert(!result.error, `${kind} import failed: ${JSON.stringify(result)}`)
  const imported = result.imported ?? 0
  assert(imported > 0, `${kind} imported no records: ${JSON.stringify(paired)}`)
  const listing = await rpc({ action: 'sessions', force: true })
  const rows = listing.dsh ?? []
  const row = rows.find(item => (item.count ?? 0) > 0 && item.id === paired.binding?.dshSessionIds?.[0])
    ?? rows.find(item => (item.count ?? 0) > 0)
  assert(row, `${kind} produced no readable DSH session: ${JSON.stringify(rows.slice(0, 2))}`)
  return { row, binding: paired.binding, imported }
}

const scenarios = {
  async import(args, rpc) {
    const { row, imported } = await importFile(rpc, args, FORMATS[0])
    assert(/List the files/.test(row.preview ?? ''), `preview lost the user text: ${row.preview}`)
    log(`import ok: ${imported} record(s), ${row.count} message(s)`)
    return { imported, messages: row.count }
  },

  async export(args, rpc) {
    const { row } = await importFile(rpc, args, FORMATS[0])
    const target = path.join(args.home, 'exported.jsonl')
    const paired = await rpc({
      action: 'pair',
      binding: { machineId: 'local', externalPath: target, kind: 'claude', direction: 'out', dshSessionIds: [row.id] },
    })
    const result = paired.result ?? paired
    assert(!result.error, `export failed: ${JSON.stringify(result)}`)
    assert((result.written ?? 0) > 0, `export wrote nothing: ${JSON.stringify(result)}`)
    const text = await fs.readFile(target, 'utf8')
    const lines = text.split('\n').filter(Boolean).map(line => JSON.parse(line))
    assert(lines.length > 0, 'exported file is empty')
    // The exported rows must be re-readable by the same adapter that reads the
    // tool's own files, otherwise a round trip would lose the conversation.
    assert(lines.some(line => /dsh:/.test(JSON.stringify(line))), 'exported rows are not tagged with their source')
    assert(lines.some(line => line.role === 'user' || line.message?.role === 'user'), 'exported rows lost their roles')
    log(`export ok: ${result.written} message(s), ${lines.length} row(s)`)
    return { written: result.written, rows: lines.length }
  },

  async formats(args, rpc) {
    const results = {}
    for (const format of FORMATS) {
      const { row, imported } = await importFile(rpc, args, format)
      const preview = JSON.stringify(row.preview ?? '')
      assert(preview.includes(format.expect), `${format.kind}: expected ${JSON.stringify(format.expect)} in preview, got ${preview}`)
      results[format.kind] = { imported, messages: row.count }
      log(`${format.kind} ok: ${imported} record(s)`)
    }
    return results
  },

  async failure(args, rpc) {
    const missing = path.join(args.home, 'definitely-missing.jsonl')
    const paired = await rpc({
      action: 'pair',
      binding: { machineId: 'local', externalPath: missing, kind: 'claude', direction: 'in', dshSessionIds: [] },
    })
    const result = paired.result ?? paired
    // Failing must be REPORTED, not thrown, and must tell the user what to fix.
    assert(result.error, `a missing source did not report an error: ${JSON.stringify(paired)}`)
    assert(result.failure?.reason, `failure has no reason: ${JSON.stringify(result)}`)
    assert(Array.isArray(result.failure.conditions) && result.failure.conditions.length > 0,
      `failure has no recovery conditions: ${JSON.stringify(result.failure)}`)
    log(`failure ok: ${result.failure.reason}`)

    // A stale session id must not look like a successful no-op export: it used
    // to return written: 0 and no error, which hides a missing source.
    const stale = await rpc({
      action: 'pair',
      binding: { machineId: 'local', externalPath: path.join(args.home, 'stale-out.jsonl'), kind: 'claude', direction: 'out', dshSessionIds: ['does-not-exist'] },
    })
    const staleResult = stale.result ?? stale
    assert(staleResult.error, `a stale DSH session id reported success: ${JSON.stringify(stale)}`)
    log(`stale session id reported: ${staleResult.error}`)

    // The other half of the failure surface: a real session, unwritable target.
    // The blocker is a FILE where a directory must go: portable across macOS and
    // Linux, and deterministic (no permissions or /proc quirks involved). Using
    // /proc here was a mistake - on Linux the recursive mkdir Node performs for
    // such a path can loop forever, which is what hung this scenario in CI.
    const { row } = await importFile(rpc, args, FORMATS[0])
    const blocker = path.join(args.home, 'a-file-not-a-directory')
    await fs.writeFile(blocker, 'this is deliberately a file\n')
    const blocked = path.join(blocker, 'out.jsonl')
    const write = await rpc({
      action: 'pair',
      binding: { machineId: 'local', externalPath: blocked, kind: 'claude', direction: 'out', dshSessionIds: [row.id] },
    })
    const writeResult = write.result ?? write
    assert(writeResult.error, `an unwritable path reported no error: ${JSON.stringify(write)}`)
    log(`unwritable destination reported: ${writeResult.error}`)
    return { reason: result.failure.reason, stale: staleResult.error }
  },

  async reimport(args, rpc) {
    const format = FORMATS[0]
    const { row, binding } = await importFile(rpc, args, format)
    const before = row.count
    // Syncing again with no new data must be a no-op, not a duplicate import.
    const again = await rpc({ action: 'sync', id: binding.id })
    const result = again.results?.[0] ?? again
    assert(!result.error, `second sync failed: ${JSON.stringify(result)}`)
    assert((result.imported ?? 0) === 0, `second sync re-imported ${result.imported} record(s)`)
    const listing = await rpc({ action: 'sessions', force: true })
    const updated = (listing.dsh ?? []).find(item => item.id === row.id)
    assert(updated, 'the imported session disappeared')
    assert(updated.count === before, `message count changed on a no-op sync: ${before} -> ${updated.count}`)
    log(`reimport ok: still ${updated.count} message(s)`)
    return { messages: updated.count, reimported: result.imported ?? 0 }
  },
}

async function main() {
  const argv = process.argv.slice(2)
  const index = argv.indexOf('--scenario')
  if (index < 0 || !argv[index + 1]) throw new Error('--scenario is required')
  const name = argv[index + 1]
  const args = parseCommonArgs(argv.filter((_, i) => i !== index && i !== index + 1), { requireFixtures: true })
  const scenario = scenarios[name]
  if (!scenario) throw new Error(`unknown scenario: ${name} (have ${Object.keys(scenarios).join(', ')})`)
  log(`scenario ${name}`)
  const result = await withHarness(args, rpc => scenario(args, rpc))
  log(`OK ${name} ${JSON.stringify(result)}`)
}

main().catch(error => {
  console.error('[scenario] FAILED:', error.message)
  process.exit(1)
})
