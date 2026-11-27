#!/usr/bin/env node
/**
 * Re-register dsh-conversation-sync as a bundle of the desktop profile.
 *
 * The desktop app silently dropped `dsh-conversation-sync` from
 * `dsh.profile.bundles` in ~/.dsh/profiles/desktop/package.json — most likely
 * while the installed 1.0.5/1.0.6 was a version npm did not have, so the next
 * profile install could not resolve it and pruned the entry. The package is
 * still on disk and still in `dependencies`, but a package that is not in
 * `bundles` is never loaded: no panel, no Settings entry, no RPC route.
 *
 * This script makes ONE change — it appends the bundle id. It deliberately does
 * not touch the dependency range (^1.0.2 already accepts the deployed 1.0.7) and
 * does not touch pnpm-lock.yaml, so no install is triggered.
 *
 *   node fix-bundle-registration.mjs            # show what would change
 *   node fix-bundle-registration.mjs --write    # apply
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const BUNDLE = 'dsh-conversation-sync'
const write = process.argv.includes('--write')
const file = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'profiles', 'desktop', 'package.json')

const raw = fs.readFileSync(file, 'utf8')
const data = JSON.parse(raw)
const bundles = data?.dsh?.profile?.bundles
if (!Array.isArray(bundles)) {
  console.error(`${file}: no dsh.profile.bundles array; nothing to do`)
  process.exit(1)
}

const hasDep = Boolean(data.dependencies?.[BUNDLE])
const registered = bundles.includes(BUNDLE)

console.log(`file       ${file}`)
console.log(`dependency ${hasDep ? data.dependencies[BUNDLE] : 'MISSING'}`)
console.log(`bundles    ${bundles.length} entries, ${BUNDLE} ${registered ? 'present' : 'MISSING'}`)

if (!hasDep) {
  console.error(`\n${BUNDLE} is not in dependencies either — install it first:`)
  console.error(`  dsh plugin --profile desktop add ${BUNDLE}@latest`)
  process.exit(1)
}

if (registered) {
  console.log('\nAlready registered; nothing to change.')
  process.exit(0)
}

if (!write) {
  console.log(`\nWould append "${BUNDLE}" to dsh.profile.bundles.`)
  console.log('Re-run with --write to apply.')
  process.exit(0)
}

const backup = `${file}.bak-${Date.now()}`
fs.copyFileSync(file, backup)
bundles.push(BUNDLE)
fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n')
console.log(`\nAppended "${BUNDLE}" to dsh.profile.bundles.`)
console.log(`Previous file saved as ${backup}`)
console.log('Restart DeepSeek Harness. The panel should appear under Plugins and as its own Settings entry.')
