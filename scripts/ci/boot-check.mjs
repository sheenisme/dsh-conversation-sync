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
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..')

function parseArgs(argv) {
  const args = { port: 5399, keep: false }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    const next = () => argv[++index]
    if (arg === '--dsh') args.dsh = next()
    else if (arg === '--tarball') args.tarball = next()
    else if (arg === '--home') args.home = next()
    else if (arg === '--port') args.port = Number(next())
    else if (arg === '--fixtures') args.fixtures = next()
    else if (arg === '--keep') args.keep = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (!args.dsh) throw new Error('--dsh is required')
  if (!args.tarball) throw new Error('--tarball is required')
  args.home ??= path.join(os.tmpdir(), `dsh-cs-${process.pid}`)
  args.fixtures ??= path.join(repo, 'test', 'fixtures')
  return args
}

const log = (...parts) => console.log('[boot-check]', ...parts)

/** Run a child process to completion, returning its combined output. */
function run(command, argv, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.on('error', reject)
    child.on('close', code => resolve({ code, output }))
  })
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function mktemp(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

/** Create the profile and install the packed plugin into it. */
async function prepareProfile(args, env) {
  const bootstrap = await run(process.execPath, [
    args.dsh, '--profile', 'ci', '--from-default-profile', 'web', '--dump-config',
  ], { env })
  if (bootstrap.code !== 0) {
    throw new Error(`profile bootstrap failed (${bootstrap.code}):\n${bootstrap.output}`)
  }
  const install = await run(process.execPath, [
    args.dsh, 'plugin', '--profile', 'ci', 'add', args.tarball,
  ], { env })
  if (install.code !== 0) {
    throw new Error(`plugin install failed (${install.code}):\n${install.output}`)
  }
  // A profile without the plugin in its bundle list boots fine and simply has no
  // panel, which would make every RPC 404 - fail loudly instead.
  const manifest = path.join(args.home, 'profiles', 'ci', 'package.json')
  const parsed = JSON.parse(await fs.readFile(manifest, 'utf8'))
  const bundles = parsed.dsh?.profile?.bundles ?? []
  if (!bundles.includes('dsh-conversation-sync')) {
    throw new Error(`plugin is not in the profile bundles: ${JSON.stringify(bundles)}`)
  }
}

/** Start `dsh web` and wait for the health line, failing on activation errors. */
async function startHarness(args, env) {
  const child = spawn(process.execPath, [
    args.dsh, 'ci', '--host', '127.0.0.1', '--port', String(args.port), '--no-open',
  ], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  const onData = chunk => { output += chunk }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)

  const deadline = Date.now() + 120_000
  let url
  while (Date.now() < deadline) {
    const match = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/)
    if (match) { url = match[1]; break }
    if (child.exitCode !== null) break
    await sleep(250)
  }
  if (!url) {
    child.kill('SIGKILL')
    throw new Error(`harness did not report a URL (exit ${child.exitCode}):\n${output}`)
  }
  // The process boots even when a bundle fails to activate, so a URL alone does
  // not prove the plugin loaded.
  const broken = output.match(/dsh: warning: \d+ entry did not activate[\s\S]*/)
  if (broken) {
    child.kill('SIGKILL')
    throw new Error(`plugin did not activate:\n${broken[0]}`)
  }
  return { child, url, output: () => output }
}

/** Establish the cookie the RPC endpoint requires. */
async function authenticate(url) {
  const response = await fetch(url, { redirect: 'manual' })
  const cookies = response.headers.getSetCookie?.() ?? []
  const cookie = cookies.map(value => value.split(';')[0]).find(value => value.startsWith('dsh-auth-'))
  if (!cookie) throw new Error(`no auth cookie in ${JSON.stringify(cookies)} (status ${response.status})`)
  return cookie
}

function rpcFactory(port, cookie) {
  return async function rpc(body) {
    const response = await fetch(`http://127.0.0.1:${port}/api/conversation-sync/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`rpc ${body.action} -> ${response.status}: ${text}`)
    let parsed
    try { parsed = JSON.parse(text) } catch { throw new Error(`rpc ${body.action} returned non-JSON: ${text}`) }
    if (parsed?.error) throw new Error(`rpc ${body.action} failed: ${JSON.stringify(parsed.error)}`)
    return parsed
  }
}

const assert = (condition, message) => { if (!condition) throw new Error(message) }

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

  // Bidirectional: export the imported session back out to a fresh file. This
  // exercises readDshSessionMessages + renderExternalLine end to end.
  const exported = path.join(args.home, 'export-out.jsonl')
  const outPair = await rpc({
    action: 'pair',
    binding: { machineId: 'local', externalPath: exported, kind: 'claude', direction: 'out', dshSessionIds: [target.id] },
  })
  const written = outPair.written ?? outPair.result?.written ?? 0
  assert(written > 0, `export wrote nothing: ${JSON.stringify(outPair)}`)
  const outText = await fs.readFile(exported, 'utf8')
  assert(outText.includes('dsh:'), `exported lines are not tagged: ${outText.slice(0, 200)}`)
  assert(/"role":"user"/.test(outText), `exported lines lost their role: ${outText.slice(0, 200)}`)
  log(`exported ${written} message(s) back out`)

  // A missing source must fail with an actionable reason plus the conditions
  // the user has to fix, and it must report that rather than throw.
  const bad = await rpc({
    action: 'pair',
    binding: { machineId: 'local', externalPath: path.join(args.home, 'no-such-file.jsonl'), kind: 'claude', direction: 'in', dshSessionIds: [] },
  })
  const failed = bad.result?.error ? bad.result : bad
  assert(failed.error, `a missing source did not report an error: ${JSON.stringify(bad)}`)
  assert(failed.failure?.conditions?.length > 0, `failure has no recovery conditions: ${JSON.stringify(bad)}`)
  log(`missing source reported: ${failed.failure.reason}`)
  if (bad.binding?.id ?? bad.result?.id) await rpc({ action: 'unbind', id: bad.binding?.id ?? bad.result.id })

  // Bindings are listed with their direction so the panel can render them.
  const bindings = await rpc({ action: 'bindings' })
  assert(Array.isArray(bindings.bindings), 'bindings RPC did not return a list')
  assert(bindings.bindings.length >= 1, 'the new binding is missing')

  // Clean up so a second run in the same home starts from scratch.
  const importBinding = bindings.bindings.find(b => b.kind === 'claude' && b.direction === 'in' && b.externalPath.endsWith('claude-basic.jsonl'))
  const unbind = await rpc({ action: 'unbind', id: (importBinding ?? bindings.bindings[0]).id })
  assert(!unbind.error, `unbind failed: ${JSON.stringify(unbind)}`)
  return { imported, sessions: rows.length }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  await fs.mkdir(args.home, { recursive: true })
  const env = {
    ...process.env,
    DSH_HOME: args.home,
    // Keep any user-level DSH state out of the run.
    HOME: args.home,
  }
  log(`dsh ${args.dsh}`)
  log(`home ${args.home}`)

  await prepareProfile(args, env)
  const harness = await startHarness(args, env)
  let failure
  try {
    const cookie = await authenticate(harness.url)
    const rpc = rpcFactory(args.port, cookie)
    const result = await scenario(args, rpc)
    log(`OK ${JSON.stringify(result)}`)
  } catch (error) {
    failure = error
    console.error('[boot-check] FAILED:', error.message)
    console.error('--- harness output ---')
    console.error(harness.output())
  } finally {
    harness.child.kill('SIGTERM')
    await sleep(500)
    if (harness.child.exitCode === null) harness.child.kill('SIGKILL')
    if (!args.keep) await fs.rm(args.home, { recursive: true, force: true }).catch(() => {})
  }
  process.exit(failure ? 1 : 0)
}

main().catch(error => {
  console.error('[boot-check] fatal:', error)
  process.exit(1)
})
