#!/usr/bin/env node
/**
 * Print the most recent DeepSeek Harness releases as a GitHub Actions matrix.
 *
 * The point is that "the five most recent DSH versions" stays TRUE over time:
 * a hardcoded list silently rots into "five versions from whenever someone last
 * edited the workflow". This asks the registry instead, and reports the Node
 * version each release actually needs.
 *
 * Versions that are known broken upstream are skipped, but never silently: the
 * skip is printed to stderr and recorded in the generated matrix so a reviewer
 * sees exactly which release was left out and why.
 *
 * Usage:
 *   node scripts/ci/recent-versions.mjs [--count 5] [--registry <url>] [--cache <dir>]
 * Prints JSON: {"include":[{"dsh":"...","node":"..."}], "skipped":[...]}
 */
import { spawn } from 'node:child_process'

/**
 * Releases that cannot run at all, with the reason. Keep this list tiny and
 * always justified: a version that merely fails OUR plugin belongs in the
 * compatibility matrix as a failure, not here.
 */
const BROKEN = {
  '0.2.3-alpha.1':
    'its dsh-app-boot imports EntryValidationError from @deepseek-ai/cordis-plugin-loader, '
    + 'but the peer range it declares (~1.1.0) has no such export, so the CLI cannot start',
}

function parseArgs(argv) {
  const args = { count: 5 }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--count') args.count = Number(argv[++index])
    else if (arg === '--registry') args.registry = argv[++index]
    else if (arg === '--cache') args.cache = argv[++index]
    else throw new Error(`unknown argument: ${arg}`)
  }
  return args
}

function run(command, argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.on('error', reject)
    child.on('close', code => resolve({ code, output }))
  })
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const registry = [
    ...(args.registry ? [`--registry=${args.registry}`] : []),
    // npm's default cache can be unusable (root-owned files from an older npm);
    // letting the caller point it somewhere writable keeps local runs working.
    ...(args.cache ? [`--cache=${args.cache}`] : []),
  ]

  const list = await run('npm', ['view', '@deepseek-ai/dsh', 'versions', '--json', ...registry])
  if (list.code !== 0) throw new Error(`npm view versions failed: ${list.output.trim()}`)
  const versions = JSON.parse(list.output)

  const include = []
  const skipped = []
  for (const version of [...versions].reverse()) {
    if (include.length >= args.count) break
    const reason = BROKEN[version]
    if (reason) {
      console.error(`[recent-versions] skipping ${version}: ${reason}`)
      skipped.push({ dsh: version, reason })
      continue
    }
    const engines = await run('npm', ['view', `@deepseek-ai/dsh@${version}`, 'engines.node', '--json', ...registry])
    const range = engines.output.trim()
    if (engines.code !== 0) throw new Error(`npm view engines for ${version} failed: ${range}`)
    // The engines range is a semver range like ">=24.9.0" or
    // "^24.22.3 || >=26.13.1"; setup-node needs one concrete version, so take
    // the lower bound of the first clause.
    const lower = String(JSON.parse(range || '"*"')).replace(/^[\^~>=<\s]+/, '').split(' ')[0].split('|')[0].trim()
    const node = /^\d+\.\d+\.\d+$/.test(lower) ? lower : 'lts/*'
    include.push({ dsh: version, node })
    console.error(`[recent-versions] ${version} -> node ${node}`)
  }

  if (include.length === 0) throw new Error('the registry returned no usable versions')
  // Oldest first so the matrix reads chronologically in the Actions UI.
  include.reverse()
  console.log(JSON.stringify({ include, skipped }))
}

main().catch(error => {
  console.error('[recent-versions] fatal:', error.message)
  process.exit(1)
})
