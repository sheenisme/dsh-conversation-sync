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
 *   empty     a source with no conversation is refused, not imported as a shell
 *   reimport  syncing twice does not duplicate already-imported content
 *   keys      SSH keys resolve credential -> IdentityFile -> ~/.ssh defaults
 *   ssh       a session on a "remote" host is discovered and imported over ssh
 *   safety    pre-flight refusal, pre-sync backup, append continuation, "both"
 *   placements the two entry switches default on and toggle independently
 *   bindings  manual by default, the checkbox gates syncing, newer side wins
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
   * An import that would produce nothing must be REFUSED, not silently turned
   * into an empty session. Codex writes a 3-line rollout after compaction
   * (`session_meta` + an encrypted `compaction` + `thread_settings_applied`);
   * importing one used to create a DSH session holding only a title, which looks
   * like a successful import and shows nothing at all.
   */
  async empty(args, rpc) {
    const source = path.join(args.home, 'compacted-rollout.jsonl')
    await fs.writeFile(source, [
      JSON.stringify({ type: 'session_meta', payload: { id: 'compacted', cwd: '/tmp' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'compaction', encrypted_content: 'gAAAAA' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'thread_settings_applied' } }),
    ].join('\n') + '\n')

    const before = await rpc({ action: 'sessions', force: true })
    const paired = await rpc({
      action: 'pair',
      binding: { machineId: 'local', externalPath: source, kind: 'codex', direction: 'in', dshSessionIds: [] },
    })
    const result = paired.result ?? paired
    assert(result.error, `an empty rollout imported without an error: ${JSON.stringify(paired)}`)
    assert(/no importable messages/.test(result.error), `the error does not explain the cause: ${result.error}`)

    // It must also leave nothing behind: no empty session, no dead binding.
    const after = await rpc({ action: 'sessions', force: true })
    assert((after.dsh?.length ?? 0) === (before.dsh?.length ?? 0),
      `an empty import created a session: ${JSON.stringify(after.dsh?.slice(0, 2))}`)
    const bindings = await rpc({ action: 'bindings' })
    const dead = (bindings.bindings ?? []).filter(item => item.externalPath === source)
    assert(dead.length === 0, `a failed first import left a binding behind: ${JSON.stringify(dead)}`)

    // A real source still imports, and every machine's sessions share ONE
    // workspace (DSH requires cwd === workspace path, so per-machine folders
    // would each have to be a separate workspace).
    const first = await importFile(rpc, args, FORMATS[0])
    const second = await importFile(rpc, args, FORMATS[1])
    const workspaces = await rpc({ action: 'sessions', force: true })
    const titles = new Set([first.row.title, second.row.title])
    assert(titles.size === 2, `the two imports collapsed into one session: ${[...titles]}`)
    log(`empty ok: refused with "${result.error.slice(0, 60)}…"; 2 imports, ${workspaces.dsh.length} row(s)`)
    return { reason: result.error }
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

    // Saving a key used to write `conversation-sync/ssh-key/ssh:prod` into the
    // credential store. The store brand-checks names and validates the whole
    // file when it loads, so that write did not fail here — it failed the NEXT
    // launch of DSH, with the plugin unable to run and therefore unable to
    // repair anything. Assert on the file itself, not just on the call.
    const saved = await rpc({ action: 'setKey', machineId: 'ssh:prod', path: path.join(sshDir, 'prod_ed25519') })
    assert(saved.ok, `setKey failed: ${JSON.stringify(saved)}`)
    assert(/^[A-Za-z_][A-Za-z0-9_]*$/.test(saved.ref), `invalid credential name written: ${saved.ref}`)
    const store = await fs.readFile(path.join(args.home, '.credentials.yaml'), 'utf8')
    assert(!store.includes('conversation-sync/ssh-key'), 'the store still holds the invalid reference scheme')
    // Only `refs:` holds references. `records:` is addressed as `<scope>/<id>`,
    // where a slash is legal — checking those would reject valid entries.
    let section = ''
    for (const line of store.split('\n')) {
      const top = /^([A-Za-z_][A-Za-z0-9_]*):\s*$/.exec(line)
      if (top) { section = top[1]; continue }
      if (section !== 'refs') continue
      const entry = /^ {2}(\S.*?):(?:\s|$)/.exec(line)
      if (!entry) continue
      assert(/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry[1]), `the credential store holds an invalid reference: ${entry[1]}`)
    }
    const afterSave = await rpc({ action: 'machines' })
    assert(afterSave.keys['ssh:prod'] === path.join(sshDir, 'prod_ed25519'), 'the saved key is not reported back')

    log(`keys ok: prod -> ${keys['ssh:prod']}, bastion -> ${keys['ssh:bastion']}, saved as ${saved.ref}`)
    return { prod: keys['ssh:prod'], bastion: keys['ssh:bastion'], ref: saved.ref }
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

  /**
   * Pre-flight + backup + verification + rollback, in both directions.
   *
   * These are the guarantees the user asked for, and each one is invisible in a
   * unit test: the checks run inside a live sync against a real session store.
   */
  async safety(args, rpc) {
    const { row, binding } = await importFile(rpc, args, FORMATS[0])

    // 1. A sync whose source is gone must be REFUSED before anything is touched,
    //    and the refusal must name the check that failed.
    const missing = path.join(args.home, 'vanished.jsonl')
    const refused = await rpc({
      action: 'pair',
      binding: { machineId: 'local', externalPath: missing, kind: 'claude', direction: 'in', dshSessionIds: [] },
    })
    const refusedResult = refused.result ?? refused
    assert(refusedResult.error, `a missing source was not refused: ${JSON.stringify(refused)}`)
    assert(refusedResult.failure?.preflight === true, `the refusal did not come from the pre-flight: ${JSON.stringify(refusedResult.failure)}`)
    assert(refusedResult.failure?.check === 'source-read', `unexpected failing check: ${refusedResult.failure?.check}`)
    assert((refusedResult.failure?.checks ?? []).some(item => item.id === 'data-root' && item.ok),
      'the pre-flight did not report the checks it ran')
    log(`preflight ok: refused at check "${refusedResult.failure.check}"`)

    // 2. An export that cannot be written must leave the target byte-identical,
    //    and must have taken a backup first.
    const target = path.join(args.home, 'protected.jsonl')
    const original = '{"keep":"me"}\n'
    await fs.writeFile(target, original)
    await fs.chmod(target, 0o444)
    const blocked = await rpc({
      action: 'pair',
      binding: { machineId: 'local', externalPath: target, kind: 'claude', direction: 'out', dshSessionIds: [row.id] },
    })
    const blockedResult = blocked.result ?? blocked
    const afterText = await fs.readFile(target, 'utf8')
    await fs.chmod(target, 0o644)
    assert(blockedResult.error, `an unwritable target reported success: ${JSON.stringify(blocked)}`)
    assert(afterText === original, `the failed export modified the target: ${JSON.stringify(afterText)}`)
    assert((blockedResult.failure?.backupPaths ?? []).length > 0,
      `a failed sync kept no backup: ${JSON.stringify(blockedResult.failure)}`)
    for (const backupPath of blockedResult.failure.backupPaths) {
      await fs.access(backupPath)
    }
    log(`backup ok: ${blockedResult.failure.backupPaths.length} backup(s) before the write`)

    // 3. Appending to an existing session must continue its turns, not restart
    //    them at 1 - the backend refuses that with "turn/start does not open the
    //    expected turn". Two different sources into one session proves it.
    const second = await rpc({
      action: 'pair',
      binding: {
        machineId: 'local', externalPath: path.join(args.fixtures, FORMATS[1].file),
        kind: FORMATS[1].kind, direction: 'in', dshSessionIds: [row.id],
      },
    })
    const secondResult = second.result ?? second
    assert(!secondResult.error, `appending to an existing session failed: ${JSON.stringify(secondResult)}`)
    assert((secondResult.imported ?? 0) > 0, `the append imported nothing: ${JSON.stringify(second)}`)
    const listing = await rpc({ action: 'sessions', force: true })
    const grown = (listing.dsh ?? []).find(item => item.id === row.id)
    assert(grown, 'the appended session disappeared')
    assert(grown.count > row.count, `the session did not grow: ${row.count} -> ${grown.count}`)
    log(`append ok: ${row.count} -> ${grown.count} message(s) in one session`)

    // 4. Both directions in one call, so the import and the export share a
    //    backup and a verification.
    const bothTarget = path.join(args.home, 'both.jsonl')
    await fs.writeFile(bothTarget, '')
    const both = await rpc({
      action: 'pair',
      binding: {
        machineId: 'local', externalPath: bothTarget,
        kind: 'claude', direction: 'both', dshSessionIds: [row.id],
      },
    })
    const bothResult = both.result ?? both
    assert(!bothResult.error, `a "both" sync failed: ${JSON.stringify(bothResult)}`)
    assert((bothResult.written ?? 0) > 0, `a "both" sync wrote nothing: ${JSON.stringify(bothResult)}`)
    const exported = await fs.readFile(bothTarget, 'utf8')
    assert(exported.trim().length > 0, 'the "both" export is empty')
    log(`both ok: ${bothResult.imported ?? 0} imported, ${bothResult.written} written`)

    // 5. "Both" means each side catches up, so running it again must be a
    //    no-op rather than a loop: the export just written carries dshSyncId
    //    markers, and importing them back must not duplicate anything.
    const again = await rpc({ action: 'sync', id: bothResult.id })
    const againResult = again.results?.[0] ?? again
    assert(!againResult.error, `a repeated "both" sync failed: ${JSON.stringify(againResult)}`)
    assert((againResult.imported ?? 0) === 0,
      `a repeated "both" sync duplicated ${againResult.imported} record(s): ${JSON.stringify(againResult)}`)
    assert((againResult.written ?? 0) === 0,
      `a repeated "both" sync rewrote ${againResult.written} message(s): ${JSON.stringify(againResult)}`)
    log('both ok: the second pass appended nothing on either side')

    return {
      preflight: refusedResult.failure.check,
      backups: blockedResult.failure.backupPaths.length,
      messages: grown.count,
      written: bothResult.written,
    }
  },

  /**
   * The two placement switches. Both entries must default to ON, and turning
   * one off must leave the other alone - in the host's stored preferences, which
   * is what the panel reads before it registers anything.
   */
  async placements(args, rpc) {
    const initial = await rpc({ action: 'preferences' })
    assert(initial.preferences?.sidebarEntry !== false, `the sidebar entry is off by default: ${JSON.stringify(initial)}`)
    assert(initial.preferences?.settingsEntry !== false, `the Settings entry is off by default: ${JSON.stringify(initial)}`)

    const off = await rpc({ action: 'setPreferences', sidebarEntry: false })
    assert(off.preferences?.sidebarEntry === false, `setPreferences did not persist: ${JSON.stringify(off)}`)
    assert(off.preferences?.settingsEntry === true, `turning off the sidebar also turned off Settings: ${JSON.stringify(off)}`)

    const reread = await rpc({ action: 'preferences' })
    assert(reread.preferences?.sidebarEntry === false, 'the preference did not survive a re-read')
    assert(reread.preferences?.settingsEntry === true, 'the other preference changed on its own')

    // It must survive a restart, not just a round trip.
    const stored = JSON.parse(await fs.readFile(path.join(args.home, 'conversation-sync', 'preferences.json'), 'utf8'))
    assert(stored.sidebarEntry === false, `the preferences file does not hold the change: ${JSON.stringify(stored)}`)

    const back = await rpc({ action: 'setPreferences', sidebarEntry: true, settingsEntry: true })
    assert(back.preferences?.sidebarEntry === true && back.preferences?.settingsEntry === true,
      `restoring both switches failed: ${JSON.stringify(back)}`)
    log(`placements ok: defaults on, sidebar toggled off and back`)
    return { defaults: initial.preferences, stored }
  },

  async bindings(args, rpc) {
    const format = FORMATS[0]
    const { row, binding } = await importFile(rpc, args, format)

    // A fresh binding is manual and checked: it must not sync on its own, but it
    // must be ready to sync by hand.
    const listed = await rpc({ action: 'bindings' })
    const stored = (listed.bindings ?? []).find(item => item.id === binding.id)
    assert(stored, `the binding disappeared: ${JSON.stringify(listed.bindings)}`)
    assert(stored.autoSync === false, `a new binding is automatic by default: ${JSON.stringify(stored)}`)
    assert(stored.checked !== false, `a new binding starts unchecked: ${JSON.stringify(stored)}`)

    // The info bar needs a version and an activity trail: without them a stale
    // host (client reloaded, host not restarted) is invisible, and a click has
    // no visible outcome.
    const status = await rpc({ action: 'status' })
    assert(status.version && status.version !== 'unknown',
      `the status must report the running plugin version: ${JSON.stringify(status)}`)
    assert(Array.isArray(status.activity), `the status must carry an activity list: ${JSON.stringify(status)}`)
    const pairNote = (status.activity ?? []).find(entry => /imported|wrote|skipped/i.test(entry.text))
    assert(pairNote, `pairing must leave a line in the activity trail: ${JSON.stringify(status.activity)}`)
    assert(listed.comparisons?.[binding.id], 'the listing must say which side is newer')

    // Unchecking must stop a bulk run from touching it. Pairing itself performs
    // the first sync (that is what makes a binding useful immediately), so the
    // witness is the binding's own lastSyncAt: a gated binding keeps the stamp
    // it had, an included one gets a new one.
    const target = path.join(args.home, 'gated.jsonl')
    const paired = await rpc({
      action: 'pair',
      binding: { machineId: 'local', externalPath: target, kind: 'claude', direction: 'out', dshSessionIds: [row.id] },
    })
    const outBinding = paired.binding ?? paired.result?.binding
    const outId = outBinding?.id ?? paired.result?.id
    assert(outId, `pairing an export did not return a binding: ${JSON.stringify(paired)}`)

    const stampOf = async id => {
      const listing = await rpc({ action: 'bindings' })
      return (listing.states ?? []).find(item => item.bindingId === id)?.lastSyncAt
    }
    await new Promise(resolve => setTimeout(resolve, 1100))
    await rpc({ action: 'setBinding', id: outId, checked: false })
    const stampBefore = await stampOf(outId)
    const skipped = await rpc({ action: 'sync' })
    assert(!(skipped.results ?? []).some(entry => entry.id === outId),
      `an unchecked binding was synced by a bulk run: ${JSON.stringify(skipped.results)}`)
    const stampAfter = await stampOf(outId)
    assert(stampAfter === stampBefore, `an unchecked binding synced anyway (${stampBefore} -> ${stampAfter})`)

    // Checked again, the bulk run must include it.
    await rpc({ action: 'setBinding', id: outId, checked: true })
    const ran = await rpc({ action: 'sync' })
    const entry = (ran.results ?? []).find(item => item.id === outId)
    assert(entry, `a checked binding was skipped by a bulk run: ${JSON.stringify(ran.results)}`)
    const text = await fs.readFile(target, 'utf8')
    assert(text.trim().length > 0, 'the checked binding reported a sync but wrote nothing')

    // Direction "auto" must follow the comparison. The export above has just
    // finished, so nothing has moved since: the honest answer is to do nothing
    // rather than rewrite a file that is already correct.
    await rpc({ action: 'setBinding', id: outId, direction: 'auto' })
    const auto = await rpc({ action: 'sync', id: outId })
    const autoResult = auto.results?.[0] ?? auto
    assert(!autoResult.error, `an auto sync failed: ${JSON.stringify(autoResult)}`)
    assert(autoResult.comparison?.newer, `an auto sync did not report a comparison: ${JSON.stringify(autoResult)}`)
    assert(autoResult.direction === 'none' && autoResult.skipped,
      `a repeat auto sync did work when nothing had changed: ${JSON.stringify(autoResult)}`)

    // Then the source is edited, so auto must pick import on its own.
    await fs.appendFile(target, JSON.stringify({
      type: 'user', timestamp: new Date().toISOString(),
      message: { role: 'user', content: [{ type: 'text', text: 'edited on the machine' }] },
    }) + '\n')
    const auto2 = await rpc({ action: 'sync', id: outId })
    const auto2Result = auto2.results?.[0] ?? auto2
    assert(auto2Result.direction === 'in',
      `auto did not import after the source was edited: ${JSON.stringify(auto2Result)}`)
    const autoResult2 = auto2Result

    // Select-all is one round trip and must be reversible.
    const allOff = await rpc({ action: 'setBindingAll', checked: false })
    assert((allOff.bindings ?? []).every(item => item.checked === false),
      `select-all-off left a binding checked: ${JSON.stringify(allOff.bindings)}`)
    const allOn = await rpc({ action: 'setBindingAll', checked: true })
    assert((allOn.bindings ?? []).every(item => item.checked !== false),
      `select-all-on left a binding unchecked: ${JSON.stringify(allOn.bindings)}`)

    // A session may be bound more than once: that is how two conversations get
    // merged, so a second binding to the same DSH session must be allowed.
    const mergeTarget = path.join(args.home, 'merged.jsonl')
    const merged = await rpc({
      action: 'pair',
      binding: {
        machineId: 'local', externalPath: path.join(args.fixtures, FORMATS[1].file),
        kind: FORMATS[1].kind, direction: 'in', dshSessionIds: [row.id],
      },
    })
    const mergedResult = merged.result ?? merged
    assert(!mergedResult.error, `a second binding to one session was refused: ${JSON.stringify(mergedResult)}`)
    const all = await rpc({ action: 'bindings' })
    const onSameSession = (all.bindings ?? []).filter(item => item.dshSessionIds?.includes(row.id))
    assert(onSameSession.length >= 2,
      `the same DSH session should carry several bindings (merge), got ${onSameSession.length}`)
    log(`merge ok: ${onSameSession.length} bindings on one DSH session`)

    // A brand-new destination: the host must suggest a path inside the tool's
    // own rollout directory, and a "both" sync on it must export rather than
    // fail trying to import from a file that does not exist yet.
    const suggested = await rpc({ action: 'suggestPath', machineId: 'local', kind: 'claude' })
    assert(suggested.path, `suggestPath returned no path: ${JSON.stringify(suggested)}`)
    assert(suggested.path.endsWith('.jsonl'), `the suggested path is not a rollout file: ${suggested.path}`)
    assert(suggested.path.includes('.claude'), `the suggested path is outside the tool's own layout: ${suggested.path}`)
    const fresh = await rpc({
      action: 'pair',
      binding: {
        machineId: 'local', externalPath: suggested.path, kind: 'claude',
        direction: 'both', dshSessionIds: [row.id],
      },
    })
    const freshResult = fresh.result ?? fresh
    assert(!freshResult.error, `pairing a brand-new destination failed: ${JSON.stringify(freshResult)}`)
    assert((freshResult.written ?? 0) > 0, `a brand-new destination received nothing: ${JSON.stringify(freshResult)}`)
    await fs.access(suggested.path)
    log(`bindings ok: new destination written to ${path.basename(suggested.path)}`)

    log(`bindings ok: manual default, checkbox gated, repeat auto was a no-op, edited source imported`)
    return {
      autoSync: stored.autoSync,
      checked: stored.checked,
      repeatAuto: autoResult.direction,
      newPath: path.basename(suggested.path),
      mergeBindings: onSameSession.length,
      editedAuto: autoResult2.direction,
      newer: autoResult2.comparison.newer,
    }
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
