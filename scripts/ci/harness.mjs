/**
 * Shared plumbing for booting a real DeepSeek Harness profile with the plugin
 * installed and talking to it over its own HTTP RPC surface.
 *
 * Extracted from boot-check.mjs so that each functional scenario script can run
 * against a freshly booted harness without duplicating the fragile parts: the
 * profile bootstrap, the activation check, and the auth cookie handshake.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export const assert = (condition, message) => { if (!condition) throw new Error(message) }

/** Run a child process to completion, returning its combined output. */
export function run(command, argv, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.on('error', reject)
    child.on('close', code => resolve({ code, output }))
  })
}

export async function mktemp(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

/** Create the profile and install the packed plugin into it. */
export async function prepareProfile({ dsh, tarball, home }, env) {
  // pnpm resolves a relative spec as a REGISTRY package name ("failed to
  // resolve the latest version of dsh-conversation-sync-1.0.0.tgz", 404),
  // because `add` changes into the profile directory first. An absolute path
  // is unambiguous and behaves as a local tarball.
  const spec = path.resolve(tarball)
  const bootstrap = await run(process.execPath, [
    dsh, '--profile', 'ci', '--from-default-profile', 'web', '--dump-config',
  ], { env })
  if (bootstrap.code !== 0) {
    throw new Error(`profile bootstrap failed (${bootstrap.code}):\n${bootstrap.output}`)
  }
  const install = await run(process.execPath, [dsh, 'plugin', '--profile', 'ci', 'add', spec], { env })
  if (install.code !== 0) {
    throw new Error(`plugin install failed (${install.code}):\n${install.output}`)
  }
  // A profile without the plugin in its bundle list boots fine and simply has no
  // panel, which would make every RPC 404 - fail loudly instead.
  const manifest = path.join(home, 'profiles', 'ci', 'package.json')
  const parsed = JSON.parse(await fs.readFile(manifest, 'utf8'))
  const bundles = parsed.dsh?.profile?.bundles ?? []
  if (!bundles.includes('dsh-conversation-sync')) {
    throw new Error(`plugin is not in the profile bundles: ${JSON.stringify(bundles)}`)
  }
}

/** Start `dsh web` and wait for the health line, failing on activation errors. */
export async function startHarness({ dsh, port }, env) {
  const child = spawn(process.execPath, [
    dsh, 'ci', '--host', '127.0.0.1', '--port', String(port), '--no-open',
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
export async function authenticate(url) {
  const response = await fetch(url, { redirect: 'manual' })
  const cookies = response.headers.getSetCookie?.() ?? []
  const cookie = cookies.map(value => value.split(';')[0]).find(value => value.startsWith('dsh-auth-'))
  if (!cookie) throw new Error(`no auth cookie in ${JSON.stringify(cookies)} (status ${response.status})`)
  return cookie
}

export function rpcFactory(port, cookie) {
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

/**
 * Boot a harness, run `body(rpc, context)`, and always tear everything down.
 * Returns the body's result; throws on any failure with the harness log.
 */
export async function withHarness(args, body) {
  await fs.mkdir(args.home, { recursive: true })
  const env = {
    ...process.env,
    DSH_HOME: args.home,
    // Keep any user-level DSH state out of the run.
    HOME: args.home,
  }
  await prepareProfile(args, env)
  const harness = await startHarness(args, env)
  try {
    const cookie = await authenticate(harness.url)
    return await body(rpcFactory(args.port, cookie), { harness, args, env })
  } catch (error) {
    console.error('--- harness output ---')
    console.error(harness.output())
    throw error
  } finally {
    harness.child.kill('SIGTERM')
    await sleep(500)
    if (harness.child.exitCode === null) harness.child.kill('SIGKILL')
    if (!args.keep) await fs.rm(args.home, { recursive: true, force: true }).catch(() => {})
  }
}

/** Shared CLI parsing for the CI scripts. */
export function parseCommonArgs(argv, { requireFixtures = false } = {}) {
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
  if (requireFixtures || args.fixtures) args.fixtures ??= path.join(import.meta.dirname, '..', '..', 'test', 'fixtures')
  return args
}
