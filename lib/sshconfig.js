/**
 * Minimal OpenSSH config reader used by the conversation-sync source picker.
 * It understands only the flat subset needed to enumerate hosts: `Host`
 * stanzas, `ProxyJump` chains and a few per-host fields. `Match` blocks are
 * skipped, `Include` is never followed. This is a discovery aid, not an ssh
 * replacement; malformed lines never throw, they are reported as warnings.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const HOST_FIELDS = new Set(['hostname', 'user', 'port', 'identityfile', 'proxyjump'])
const WARNINGS = Symbol('sshConfigWarnings')

/** Split `a b "c d"` into tokens; null means an unterminated quote/escape. */
function splitTokens(value) {
  const tokens = []
  let token = ''
  let quoted = false
  let escaped = false
  let started = false
  for (const char of value) {
    if (escaped) { token += char; escaped = false; started = true; continue }
    if (char === '\\') { escaped = true; started = true; continue }
    if (char === '"') { quoted = !quoted; started = true; continue }
    if (!quoted && /\s/.test(char)) {
      if (started) tokens.push(token)
      token = ''
      started = false
      continue
    }
    token += char
    started = true
  }
  if (escaped || quoted) return null
  if (started) tokens.push(token)
  return tokens
}

/**
 * Parse SSH config text into stanzas in file order.
 * @returns {Array<{patterns:string[], hostname?, user?, port?, identityFile?, proxyJump?, raw:string}>}
 */
export function parseSshConfig(text) {
  const stanzas = []
  const warnings = []
  Object.defineProperty(stanzas, WARNINGS, { value: warnings })
  let current = undefined
  let inMatch = false

  for (const sourceLine of String(text ?? '').split(/\r?\n/)) {
    const line = sourceLine.trim()
    if (!line || line.startsWith('#')) continue

    const separator = line.search(/[\s=]/)
    const keyword = (separator < 0 ? line : line.slice(0, separator)).toLowerCase()
    const rest = separator < 0 ? '' : line.slice(separator).trim()

    if (keyword === 'include') {
      warnings.push(`Include directive ignored: ${line}`)
      continue
    }
    if (keyword === 'host') {
      const patterns = splitTokens(rest)
      if (!patterns?.length) {
        warnings.push(`Ignored malformed Host line: ${line}`)
        continue
      }
      current = { patterns, raw: line }
      stanzas.push(current)
      inMatch = false
      continue
    }
    if (keyword === 'match') {
      // A Match block overrides following keywords: skip it, but keep parsing
      // any later Host stanza.
      current = undefined
      inMatch = true
      continue
    }
    if (inMatch || !current) continue
    if (!HOST_FIELDS.has(keyword)) continue

    const tokens = splitTokens(rest)
    if (!tokens) {
      warnings.push(`Ignored malformed ${keyword} line: ${line}`)
      continue
    }
    const value = tokens.join(' ')
    if (!value) continue
    if (keyword === 'port') {
      const port = Number(value)
      if (Number.isInteger(port) && port > 0 && port < 65536) current.port = port
      else warnings.push(`Ignored invalid Port value: ${value}`)
      continue
    }
    if (keyword === 'identityfile') current.identityFile = value
    else if (keyword === 'proxyjump') current.proxyJump = value
    else current[keyword] = value
    current.raw += `\n${line}`
  }
  return stanzas
}

/** Expand a leading `~` against the given home directory. */
function expandHome(value, home) {
  if (typeof value !== 'string') return value
  if (value === '~') return home
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(home, value.slice(2))
  return value
}

/** Parse `user@host:port` into the pieces a machine record needs. */
function parseJumpTarget(target) {
  let value = String(target).trim()
  let port
  const portMatch = value.match(/^(.*):(\d+)$/)
  if (portMatch) {
    value = portMatch[1]
    port = Number(portMatch[2])
  }
  let user
  const at = value.lastIndexOf('@')
  if (at > 0) {
    user = value.slice(0, at)
    value = value.slice(at + 1)
  }
  return { id: value, user, port }
}

/** Merge defined fields only, so missing keywords do not erase known data. */
function mergeMachine(existing, update) {
  for (const [key, value] of Object.entries(update)) {
    if (value !== undefined) existing[key] = value
  }
}

/**
 * Discover local + SSH machines from `~/.ssh/config`.
 * @returns {Promise<{machines: Array, warnings: string[]}>}
 */
export async function discoverMachines({ home = os.homedir() } = {}) {
  const machines = [{ id: 'local', label: 'Local machine', kind: 'local' }]
  const byId = new Map(machines.map(machine => [machine.id, machine]))

  let text
  try {
    text = await fs.readFile(path.join(home, '.ssh', 'config'), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { machines, warnings: [] }
    return { machines, warnings: [`cannot read SSH config: ${error?.message || error}`] }
  }

  const stanzas = parseSshConfig(text)
  const warnings = [...stanzas[WARNINGS]]

  /** Register a jump host as a first-class machine, merging on id. */
  const registerJump = (parsed, proxyJump) => {
    if (!parsed.id) return undefined
    const id = `ssh:${parsed.id}`
    const existing = byId.get(id)
    if (existing) {
      existing.isJump = true
      mergeMachine(existing, { user: parsed.user, port: parsed.port, proxyJump })
      return existing
    }
    const machine = {
      id,
      label: parsed.id,
      kind: 'ssh',
      host: parsed.id,
      hostname: parsed.id,
      user: parsed.user,
      identityFile: undefined,
      proxyJump,
      via: [],
      isJump: true,
    }
    if (parsed.port) machine.port = parsed.port
    machines.push(machine)
    byId.set(id, machine)
    return machine
  }

  for (const stanza of stanzas) {
    const via = []
    if (stanza.proxyJump) {
      for (const target of stanza.proxyJump.split(',')) {
        const jump = registerJump(parseJumpTarget(target), stanza.proxyJump)
        if (jump && !via.includes(jump.id)) via.push(jump.id)
      }
    }

    const pattern = stanza.patterns[0]
    if (/[*?]/.test(pattern)) {
      warnings.push(`Skipped wildcard-only SSH host '${pattern}'`)
      continue // jump targets from this stanza are still registered above
    }

    const id = `ssh:${pattern}`
    const machine = {
      id,
      label: pattern,
      kind: 'ssh',
      host: pattern,
      hostname: stanza.hostname || pattern,
      user: stanza.user,
      identityFile: expandHome(stanza.identityFile, home),
      proxyJump: stanza.proxyJump,
      via,
    }
    if (stanza.port) machine.port = stanza.port
    const existing = byId.get(id)
    if (existing) mergeMachine(existing, machine)
    else {
      machines.push(machine)
      byId.set(id, machine)
    }
  }

  return { machines, warnings }
}
