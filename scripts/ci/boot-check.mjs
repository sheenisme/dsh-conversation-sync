#!/usr/bin/env node
/**
 * Boot the plugin inside a real DeepSeek Harness profile and exercise it over
 * its own HTTP RPC surface.
 *
 * This is the check that actually proves compatibility: unit tests only cover
 * pure modules, while this installs the packed plugin into a fresh profile of a
 * specific DSH version, starts `dsh web`, waits for the health line, and then
 * imports a real conversation through the RPC endpoint the panel uses.
 *
 * A version is "supported" when this exits 0: the plugin activated (no
 * "did not activate" warning) and a conversation really landed in a DSH
 * session.
 *
 * Usage:
 *   node scripts/ci/boot-check.mjs --dsh <path/to/dsh/lib/bin.js> \
 *     --tarball <dsh-conversation-sync-*.tgz> --home <dir> [--port 5399] \
 *     [--fixtures <dir>] [--keep]
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { assert, parseCommonArgs, withHarness } from './harness.mjs'

const log = (...parts) => console.log('[boot-check]', ...parts)

/** Exercise the import path end to end through the panel's own RPC calls. */
async function scenario(args, rpc) {
  const status = await rpc({ action: 'status' })
  assert(status.ready === true, `status not ready: ${JSON.stringify(status)}`)

  const machines = await rpc({ action: 'machines' })
  assert(Array.isArray(machines.machines) && machines.machines.length > 0, 'no machines reported')
  assert(machines.machines.some(m => m.id === 'local'), 'local machine missing from the machine list')

  const listing = await rpc({ action: 'sessions' })
  assert(Array.isArray(listing.dsh), 'sessions RPC did not return a dsh list')
  assert(listing.external && typeof listing.external === 'object', 'sessions RPC did not return external lists')

  // Import a real Claude Code rollout, the way a user would pair it.
  const external = path.join(args.fixtures, 'claude-basic.jsonl')
  await fs.access(external)
  const paired = await rpc({
    action: 'pair',
    binding: { machineId: 'local', externalPath: external, kind: 'claude', direction: 'in', dshSessionIds: [] },
  })
  assert(paired.binding || paired.result || paired, `pair returned nothing useful: ${JSON.stringify(paired)}`)
  const imported = paired.imported ?? paired.result?.imported ?? 0
  assert(imported > 0, `pair imported no records: ${JSON.stringify(paired)}`)

  // The imported conversation must be visible to DSH as a session with content.
  // The listing is cached for a few seconds; force a rescan so the freshly
  // imported session is really present rather than merely not yet reported.
  const after = await rpc({ action: 'sessions', force: true })
  const rows = after.dsh ?? []
  assert(rows.length > 0, 'no DSH session after import')
  const target = rows.find(row => (row.count ?? 0) > 0)
  assert(target, `imported DSH session has no messages: ${JSON.stringify(rows.slice(0, 3))}`)
  const preview = JSON.stringify(target.preview ?? '')
  assert(/List the files|I will run ls|README/.test(preview), `unexpected DSH preview: ${preview}`)
  log(`imported ${imported} record(s) into DSH session "${target.title ?? target.id}"`)

  // Bindings are listed with their direction so the panel can render them.
  const bindings = await rpc({ action: 'bindings' })
  assert(Array.isArray(bindings.bindings), 'bindings RPC did not return a list')
  assert(bindings.bindings.length >= 1, 'the new binding is missing')

  // Clean up so a second run in the same home starts from scratch.
  const unbind = await rpc({ action: 'unbind', id: bindings.bindings[0].id })
  assert(!unbind.error, `unbind failed: ${JSON.stringify(unbind)}`)
  return { imported, sessions: rows.length }
}

async function main() {
  const args = parseCommonArgs(process.argv.slice(2), { requireFixtures: true })
  log(`dsh ${args.dsh}`)
  log(`home ${args.home}`)
  const result = await withHarness(args, (rpc) => scenario(args, rpc))
  log(`OK ${JSON.stringify(result)}`)
}

main().catch(error => {
  console.error('[boot-check] FAILED:', error.message)
  process.exit(1)
})
