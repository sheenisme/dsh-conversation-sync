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
 *   keys      SSH keys resolve credential -> IdentityFile -> ~/.ssh defaults
 *   ssh       a session on a "remote" host is discovered and imported over ssh
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

  /**
   * "Sync all" with an explicit direction must honour that direction for every
   * binding, rather than falling back to each binding's stored direction. The
   * UI's per-direction buttons call exactly this, so a regression here means the
   * user clicks Export and gets an Import.
   */
  async direction(args, rpc) {
    const { row, binding } = await importFile(rpc, args, FORMATS[0])
    const target = path.join(args.home, 'direction-out.jsonl')
    // Re-point the existing binding at a fresh file, keeping direction 'in' so a
    // stray fallback is visible: an import would write nothing to the file.
    await rpc({ action: 'pair', binding: { id: binding.id, machineId: 'local', externalPath: target, kind: 'claude', direction: 'in', dshSessionIds: [row.id] } })
    const all = await rpc({ action: 'sync', direction: 'out' })
    const result = all.results?.find(item => item.id === binding.id) ?? all.results?.[0]
    assert(result, `sync-all returned nothing for the binding: ${JSON.stringify(all)}`)
    assert(!result.error, `directional sync failed: ${JSON.stringify(result)}`)
    assert(result.direction === 'out', `sync-all ignored the requested direction: ${JSON.stringify(result)}`)
    assert((result.written ?? 0) > 0, `sync-all wrote nothing to ${target}: ${JSON.stringify(result)}`)
    const text = await fs.readFile(target, 'utf8')
    assert(text.trim().length > 0, 'the exported file is empty')
    log(`direction ok: sync-all honoured "out" for a binding stored as "in" (${result.written} message(s))`)
    return { written: result.written, direction: result.direction }
  },

  /**
   * SSH key resolution order, over the same RPC the panel uses. A host that
   * already works from a terminal must not need a hand-typed key: the plugin
   * prefers a saved credential, then the host's IdentityFile, then the
   * conventional ~/.ssh defaults.
   */
  async keys(args, rpc) {
    const sshDir = path.join(args.home, '.ssh')
    await fs.mkdir(sshDir, { recursive: true })
    await fs.writeFile(path.join(sshDir, 'config'), [
      'Host prod',
      '  HostName 10.0.0.5',
      '  User deploy',
      '  IdentityFile ~/.ssh/prod_ed25519',
      '',
      'Host bastion',
      '  HostName 10.0.0.1',
      '  User jump',
      '',
      'Host db',
      '  HostName 10.0.0.9',
      '  User dba',
      '  ProxyJump bastion',
      '',
    ].join('\n'))
    await fs.writeFile(path.join(sshDir, 'prod_ed25519'), 'NOT-A-REAL-KEY')
    await fs.writeFile(path.join(sshDir, 'id_ed25519'), 'NOT-A-REAL-KEY')

    // The profile booted before ~/.ssh/config existed, so ask for a re-read —
    // this is the same path the panel's refresh button takes.
    const { machines, keys } = await rpc({ action: 'machines', refresh: true })
    const byId = Object.fromEntries(machines.map(machine => [machine.id, machine]))
    assert(byId['ssh:prod'], `prod was not discovered: ${JSON.stringify(machines.map(m => m.id))}`)
    assert(byId['ssh:db']?.via?.includes('ssh:bastion'), 'the jump host was not linked to the target')
    assert(keys['ssh:prod']?.endsWith('prod_ed25519'), `prod should use its IdentityFile, got ${keys['ssh:prod']}`)
    assert(keys['ssh:bastion']?.endsWith('id_ed25519'), `bastion should fall back to the default key, got ${keys['ssh:bastion']}`)
    log(`keys ok: prod -> ${keys['ssh:prod']}, bastion -> ${keys['ssh:bastion']}`)
    return { prod: keys['ssh:prod'], bastion: keys['ssh:bastion'] }
  },

  /**
   * The whole remote path, without a server to depend on.
   *
   * A stand-in `ssh` on PATH runs the remote command locally with HOME pointed
   * at a fake remote home. That is enough to prove the parts that actually
   * break: the system-ssh transport is selected at all (not the missing ssh2
   * module), `home`/`list`/`read`/`stat` round-trip through the real argument
   * building and shell quoting, discovery finds rollouts under that home, and a
   * session found over "ssh" imports into DSH exactly like a local one. Every
   * other scenario talks to the local filesystem, so without this the remote
   * half would only ever be unit-tested.
   */
  /**
   * Runs before the harness boots: the stand-in `ssh` must already be on PATH,
   * because the child process inherits PATH at spawn time.
   */
  prepare: {
    async ssh(args) {
      const remoteHome = path.join(args.home, 'remote-home')
      const rollout = path.join(remoteHome, '.claude', 'projects', 'proj', 'session.jsonl')
      await fs.mkdir(path.dirname(rollout), { recursive: true })
      await fs.copyFile(path.join(args.fixtures, 'claude-basic.jsonl'), rollout)
      const binDir = path.join(args.home, 'fakebin')
      await fs.mkdir(binDir, { recursive: true })
      await fs.writeFile(path.join(binDir, 'ssh'), [
        '#!/bin/sh',
        'for a in "$@"; do if [ "$a" = "-V" ]; then echo "OpenSSH_10.0p1" >&2; exit 0; fi; done',
        'if [ "$1" = "-O" ]; then exit 0; fi',
        'last=""',
        'for a in "$@"; do last="$a"; done',
        `export HOME=${JSON.stringify(remoteHome)}`,
        'exec /bin/sh -c "$last"',
        '',
      ].join('\n'), { mode: 0o755 })
      // The harness child inherits PATH, so this is how the plugin finds the
      // stand-in instead of the real ssh.
      process.env.PATH = `${binDir}:${process.env.PATH}`
    },
  },

  async ssh(args, rpc) {
    const remoteHome = path.join(args.home, 'remote-home')
    const rollout = path.join(remoteHome, '.claude', 'projects', 'proj', 'session.jsonl')
    await fs.mkdir(path.dirname(rollout), { recursive: true })
    await fs.copyFile(path.join(args.fixtures, 'claude-basic.jsonl'), rollout)

    await fs.mkdir(path.join(args.home, '.ssh'), { recursive: true })
    await fs.writeFile(path.join(args.home, '.ssh', 'config'), [
      'Host fake-remote',
      '  HostName 127.0.0.1',
      '  User tester',
      '  IdentityFile ~/.ssh/id_ed25519',
      '',
    ].join('\n'))
    await fs.writeFile(path.join(args.home, '.ssh', 'id_ed25519'), 'NOT-A-REAL-KEY')

    const listed = await rpc({ action: 'machines', refresh: true })
    const machine = listed.machines.find(item => item.id === 'ssh:fake-remote')
    assert(machine, `fake-remote was not discovered: ${JSON.stringify(listed.machines.map(m => m.id))}`)
    assert(listed.keys['ssh:fake-remote']?.endsWith('id_ed25519'),
      `the key was not resolved: ${listed.keys['ssh:fake-remote']}`)

    const scan = await rpc({ action: 'sessions', force: true })
    const rows = scan.external['ssh:fake-remote'] ?? []
    const errors = scan.errors['ssh:fake-remote'] ?? []
    assert(!errors.some(item => /Cannot find package .ssh2./.test(item)),
      `the system ssh backend was not used: ${errors.join(' ; ')}`)
    const found = rows.find(row => /session\.jsonl$/.test(row.path))
    assert(found, `no rollout was discovered over ssh (rows ${rows.length}, errors ${JSON.stringify(errors)})`)

    const paired = await rpc({
      action: 'pair',
      binding: { machineId: 'ssh:fake-remote', externalPath: found.path, kind: 'claude', direction: 'in', dshSessionIds: [] },
    })
    const result = paired.result ?? paired
    assert(!result.error, `import over ssh failed: ${JSON.stringify(result)}`)
    assert((result.imported ?? 0) > 0, `import over ssh brought nothing in: ${JSON.stringify(paired)}`)
    const after = await rpc({ action: 'sessions', force: true })
    const row = (after.dsh ?? []).find(item => item.id === paired.binding?.dshSessionIds?.[0])
    assert(row?.count > 0, `the ssh import produced no readable DSH session: ${JSON.stringify(row)}`)
    assert(/List the files/.test(row.preview ?? ''), `the ssh import lost its text: ${row.preview}`)
    log(`ssh ok: discovered ${rows.length} rollout(s), imported ${result.imported} record(s), ${row.count} message(s)`)
    return { discovered: rows.length, imported: result.imported, messages: row.count }
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

/** A cheap content fingerprint of the fixture directory. */
async function fingerprint(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const parts = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile()) continue
    const body = await fs.readFile(path.join(dir, entry.name))
    parts.push(`${entry.name}:${body.length}:${body.toString('base64').slice(0, 24)}`)
  }
  return parts.join('|')
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
  await scenarios.prepare?.[name]?.(args)
  // Fixtures are shared input. A scenario that writes into them would corrupt
  // later runs (and silently "fix" a failing assertion), so any change is a
  // failure rather than something to notice by eye in a diff.
  const before = await fingerprint(args.fixtures)
  const result = await withHarness(args, rpc => scenario(args, rpc))
  const after = await fingerprint(args.fixtures)
  assert(before === after, `the ${name} scenario modified the fixtures in ${args.fixtures}`)
  log(`OK ${name} ${JSON.stringify(result)}`)
}

main().catch(error => {
  console.error('[scenario] FAILED:', error.message)
  process.exit(1)
})
