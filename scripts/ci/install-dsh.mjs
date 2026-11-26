#!/usr/bin/env node
/**
 * Install one DeepSeek Harness version so it can actually RUN from a plain
 * Node.js toolchain (no desktop app, no Electron).
 *
 * `npm install @deepseek-ai/dsh@<v>` alone is not runnable: the boot entry
 * (`dsh-app-boot`) declares the harness's real runtime packages as PEER
 * dependencies, and npm does not install the peers of a transitively installed
 * package. The first attempt therefore died with
 *   ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/cordis-plugin-group'
 *     imported from .../dsh-app-boot/lib/index.js
 *
 * The peer ranges are version-specific (some are pinned to the exact DSH
 * version, some float within a major), so they are read from the registry for
 * the requested version instead of being hardcoded. That is what lets one
 * workflow cover several releases.
 *
 * Usage:
 *   node scripts/ci/install-dsh.mjs --version 0.2.2-rc.5 --dir /tmp/dsh-0.2.2-rc.5
 *     [--cache <npm-cache-dir>] [--registry <url>]
 *
 * Prints the resolved `--dsh` path on success (last line).
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    const next = () => argv[++index]
    if (arg === '--version') args.version = next()
    else if (arg === '--dir') args.dir = next()
    else if (arg === '--cache') args.cache = next()
    else if (arg === '--registry') args.registry = next()
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (!args.version) throw new Error('--version is required')
  if (!args.dir) throw new Error('--dir is required')
  return args
}

const log = (...parts) => console.log('[install-dsh]', ...parts)

function run(command, argv, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { stdio: ['ignore', 'pipe', 'pipe'], ...options })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.on('error', reject)
    child.on('close', code => resolve({ code, output }))
  })
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const npmArgs = extra => [
    ...extra,
    '--no-audit',
    '--no-fund',
    '--loglevel=error',
    ...(args.cache ? [`--cache=${args.cache}`] : []),
    ...(args.registry ? [`--registry=${args.registry}`] : []),
  ]
  // `npm view` writes to the cache too, so it needs the same overrides: on a
  // machine with a root-owned default cache it fails with EPERM before it ever
  // reaches the network.
  const viewArgs = [
    ...(args.registry ? [`--registry=${args.registry}`] : []),
    ...(args.cache ? [`--cache=${args.cache}`] : []),
  ]

  // `npm view` takes the package and the field as SEPARATE arguments; joining
  // them ("pkg@1.0.0 dependencies") makes npm treat the whole string as a spec
  // and silently resolve nothing.
  const view = async (spec, field) => {
    const result = await run('npm', ['view', spec, field, '--json', ...viewArgs])
    if (result.code !== 0) throw new Error(`npm view ${spec} failed: ${result.output.trim()}`)
    const text = result.output.trim()
    if (!text || text === 'undefined') return {}
    return JSON.parse(text)
  }

  const pinned = `@deepseek-ai/dsh@${args.version}`
  log(`resolving ${pinned}`)
  const dependencies = await view(pinned, 'dependencies')
  const appBoot = dependencies['@deepseek-ai/dsh-app-boot']
  if (!appBoot) throw new Error(`${pinned} does not depend on @deepseek-ai/dsh-app-boot`)

  // The peers of the boot entry are the packages that must exist at runtime.
  const peers = await view(`@deepseek-ai/dsh-app-boot@${appBoot}`, 'peerDependencies')
  log(`boot peers: ${Object.keys(peers ?? {}).join(', ') || 'none'}`)

  // npm prunes anything missing from package.json, so EVERY dependency is
  // declared up front in one install rather than incrementally.
  const manifest = {
    name: 'dsh-ci-harness',
    private: true,
    type: 'module',
    // Lets `import` of ESM-only harness packages work from plain Node.
    dependencies: { ...peers, ...dependencies, '@deepseek-ai/dsh': args.version },
  }
  await fs.mkdir(args.dir, { recursive: true })
  const manifestPath = path.join(args.dir, 'package.json')
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  log(`${Object.keys(manifest.dependencies).length} dependencies -> ${args.dir}`)

  const install = await run('npm', ['install', ...npmArgs([])], { cwd: args.dir })
  if (install.code !== 0) {
    console.error(install.output.trim().split('\n').slice(-40).join('\n'))
    throw new Error(`npm install failed in ${args.dir}`)
  }

  const bin = path.join(args.dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  await fs.access(bin)

  // An install that cannot start must fail HERE, not as a confusing error in
  // the boot check. This catches a real upstream packaging bug: some releases
  // ship an app-boot that imports an export their own peer range does not allow
  // (0.2.3-alpha.1 wants `EntryValidationError` from a loader `~1.1.0` that does
  // not have it), which surfaces only as a SyntaxError at startup.
  const version = await run(process.execPath, [bin, '--version'])
  if (version.code !== 0) {
    const detail = version.output.trim().split('\n').slice(0, 12).join('\n')
    throw new Error(
      `dsh ${args.version} installed but its CLI does not start (exit ${version.code}). `
      + `This version is likely broken upstream; pick another release.\n${detail}`,
    )
  }
  log(`installed dsh ${version.output.trim() || '(no --version output)'}`)
  // Last line is machine-readable for the caller.
  console.log(bin)
}

main().catch(error => {
  console.error('[install-dsh] fatal:', error.message)
  process.exit(1)
})
