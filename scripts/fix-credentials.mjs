#!/usr/bin/env node
// Repair a credential store that an earlier version of this plugin poisoned.
//
// Background: machine ids contain `:` and `-`, so building a credential
// reference as `conversation-sync/ssh-key/ssh:BAAI-Ascend` produced a name the
// credentials provider refuses. The provider validates the WHOLE file when it
// loads, so once that line exists DSH cannot start at all — and the plugin
// cannot repair it, because the plugin never runs. Hence this script: it edits
// the YAML directly, from outside the application.
//
//   node scripts/fix-credentials.mjs            # report what would change
//   node scripts/fix-credentials.mjs --write     # actually rewrite the file
//
// The value is preserved verbatim; only the key is renamed.

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const LEGACY_PREFIX = 'conversation-sync/ssh-key/'

/**
 * The name this plugin writes now. Kept byte-for-byte identical to keyRefFor()
 * in lib/transports.js — if the two drift, a repaired store holds a key the
 * plugin never looks up, and the user has to type the path again for no reason.
 */
function renamedRef(legacy) {
  const machineId = legacy.slice(LEGACY_PREFIX.length)
  const slug = machineId.replace(/[^A-Za-z0-9]/g, '_').replace(/^_+/, '') || 'machine'
  const digest = createHash('sha1').update(machineId).digest('hex').slice(0, 8)
  return `conversation_sync_ssh_key_${slug}_${digest}`
}

function dshHome() {
  const fromEnv = process.env.DSH_HOME?.trim()
  return fromEnv || path.join(os.homedir(), '.dsh')
}

const args = new Set(process.argv.slice(2))
const write = args.has('--write')
const file = path.join(dshHome(), '.credentials.yaml')

let text
try {
  text = await fs.readFile(file, 'utf8')
} catch (error) {
  if (error.code === 'ENOENT') {
    console.log(`no credential store at ${file} — nothing to repair`)
    process.exit(0)
  }
  throw error
}

// Only the `refs:` section holds credential references. Records are addressed
// as `<scope>/<id>` and are allowed to contain a slash, so they are left alone.
const lines = text.split('\n')
let section = ''
const findings = []
const output = []

for (const line of lines) {
  const top = /^([A-Za-z_][A-Za-z0-9_]*):\s*$/.exec(line)
  if (top) section = top[1]

  const entry = /^(\s+)(\S.*?):(\s|$)/.exec(line)
  if (entry && section === 'refs') {
    const name = entry[2]
    if (!REF_PATTERN.test(name)) {
      const replacement = name.startsWith(LEGACY_PREFIX) ? renamedRef(name) : undefined
      findings.push({ name, replacement })
      if (replacement && REF_PATTERN.test(replacement)) {
        output.push(line.replace(name, replacement))
        continue
      }
    }
  }
  output.push(line)
}

if (findings.length === 0) {
  console.log(`${file} is clean — every credential reference matches ${REF_PATTERN}`)
  process.exit(0)
}

console.log(`${file} has ${findings.length} invalid credential reference(s):`)
for (const { name, replacement } of findings) {
  console.log(replacement ? `  ${name}\n    -> ${replacement}` : `  ${name}\n    -> cannot guess a safe name; edit this line by hand`)
}

if (!write) {
  console.log('\nDry run. Re-run with --write to rewrite the file (a backup is kept).')
  process.exit(0)
}

const backup = `${file}.bak-${Date.now()}`
await fs.copyFile(file, backup)
await fs.writeFile(file, output.join('\n'), { mode: 0o600 })
console.log(`\nrewritten; previous file saved as ${backup}`)
console.log('restart DeepSeek Harness, then re-enter the key path in the plugin panel if a machine reports one is missing.')
