/**
 * Discovery of external conversation files across a filesystem transport.
 * The transport is the same small facade used by the adapters (local fs or
 * SSH/SFTP): stat/list/read/home. All remote paths use POSIX separators.
 */

import path from 'node:path'

const CHUNK = 256 * 1024
const MAX_COUNT_BYTES = 8 * 1024 * 1024
const MAX_ENTRIES = 5000

/** Join POSIX-style path segments (remote home paths are always POSIX). */
function join(...parts) {
  return path.posix.join(...parts)
}

/**
 * Recursively list files under `dir` matching `predicate(entry, fullPath)`.
 * Up to `maxDepth` levels are descended; directories are never followed via
 * symlinks because the transport only reports isDirectory for real dirs.
 * The total number of collected files is capped at 5000.
 * @returns {Promise<Array<{path:string,name:string,isDirectory:boolean,depth:number}>>}
 */
export async function walk(transport, dir, maxDepth, predicate) {
  const results = []
  const visited = new Set()

  async function descend(current, depth) {
    if (depth > maxDepth || results.length >= MAX_ENTRIES) return
    // Let list errors propagate: scanMachine catches them per root.
    const entries = await transport.list(current)
    if (!Array.isArray(entries)) return
    for (const entry of entries) {
      if (results.length >= MAX_ENTRIES) return
      if (!entry || typeof entry.name !== 'string' || entry.name.startsWith('.')) continue
      const fullPath = join(current, entry.name)
      if (entry.isSymbolicLink) continue // never follow symlinks
      if (entry.isDirectory) {
        // Guard against cycles even if a transport reports a symlink as a dir.
        if (visited.has(fullPath)) continue
        visited.add(fullPath)
        await descend(fullPath, depth + 1)
      } else if (predicate(entry, fullPath)) {
        results.push({ path: fullPath, name: entry.name, isDirectory: false, depth })
      }
    }
  }

  await descend(dir, 0)
  return results
}

/** Strip a trailing newline and tolerate malformed JSON lines. */
function parseLine(line) {
  try {
    return JSON.parse(line.replace(/\r$/, ''))
  } catch {
    return undefined
  }
}

/** Flatten nested JSONL text fields into a single string. */
function textOf(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join(' ')
  if (value && typeof value === 'object' && typeof value.text === 'string') return value.text
  return ''
}

/** Return the first user text in a Claude / Codex / WorkBuddy / TRAE /
 *  Antigravity / generic JSONL record. */
function userText(record, kind) {
  if (kind === 'antigravity') {
    const source = String(record.source ?? '')
    const type = String(record.type ?? '')
    const isUser = /USER/i.test(source) || type === 'USER_INPUT'
    if (!isUser) return ''
    return String(record.content ?? '')
      .replace(/^[\s\S]*?<USER_REQUEST>/, '')
      .replace(/<\/USER_REQUEST>[\s\S]*$/, '')
      .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '')
      .trim()
  }
  if (!record || typeof record !== 'object') return ''
  const message = record.message ?? record
  const payload = record.payload ?? message.payload
  const roles = [message.role, payload?.role, record.role, record.type]
  if (!roles.includes('user')) return ''
  const candidates = [message.text, message.content, record.text, record.content, payload?.content, payload?.input, payload?.message]
  for (const candidate of candidates) {
    const text = textOf(candidate).trim()
    if (text) return text
  }
  return ''
}

/** Extract name/preview from the first 256KB of a source file, defensively. */
async function describe(transport, file, kind) {
  let buffer
  try {
    buffer = await transport.read(file, 0, CHUNK)
  } catch {
    buffer = Buffer.alloc(0)
  }
  const text = buffer.toString('utf8')
  const lines = text.split('\n')
  const stem = path.posix.basename(file).replace(/\.[^.]+$/, '')
  let name = stem
  let preview = ''
  let codexSessionId

  for (const line of lines.slice(0, 40)) {
    if (!line.trim()) continue
    const record = parseLine(line)
    if (!record) continue
    if (kind === 'codex' && record.type === 'session_meta' && record.payload?.session_id) {
      codexSessionId = record.payload.session_id
    }
    if (kind === 'claude') {
      const id = record.sessionId || record.session_id
      if (!name.startsWith('__fallback__') && id) name = String(id)
    }
    if (kind === 'trae' && record.type === 'session_meta' && record.payload?.session_id) {
      name = String(record.payload.session_id)
    }
    if (kind === 'workbuddy') {
      const id = record.sessionId || record.session_id
      if (id) name = String(id)
    }
    if (!preview) preview = userText(record, kind)
  }

  if (kind === 'codex' && codexSessionId) name = String(codexSessionId)
  if (name === stem && stem) name = stem
  return { name, preview: preview.slice(0, 80) }
}

/** Count newline-terminated lines in 256KB chunks, up to 8MB. */
async function countLines(transport, file) {
  let offset = 0
  let count = 0
  while (offset < MAX_COUNT_BYTES) {
    const chunk = await transport.read(file, offset, CHUNK)
    if (!chunk?.length) break
    for (let i = 0; i < chunk.length; i++) if (chunk[i] === 0x0a) count++
    offset += chunk.length
    if (chunk.length < CHUNK) break
  }
  return { count, truncated: offset >= MAX_COUNT_BYTES }
}

/**
 * Build the session descriptor for a single discovered file.
 * @param {object} machine - machine record from discoverMachines()
 * @param {{transport: object, home?: string}} options
 * @returns {Promise<{machineId:string, sessions:Array, errors:string[]}>}
 */
export async function scanMachine(machine, { transport, home } = {}) {
  const machineId = machine?.id || 'local'
  const sessions = []
  const errors = []
  let root = home
  if (!root) {
    try {
      root = await transport.home()
    } catch (error) {
      errors.push(`cannot resolve home: ${error?.message || error}`)
      root = ''
    }
  }

  const roots = [
    { dir: join(root, '.claude', 'projects'), depth: 3, suffix: '.jsonl', kind: 'claude' },
    { dir: join(root, '.codex', 'sessions'), depth: 4, suffix: '.jsonl', kind: 'codex' },
    { dir: join(root, '.workbuddy', 'projects'), depth: 3, suffix: '.jsonl', kind: 'workbuddy' },
    { dir: join(root, '.workbuddy-ai', 'projects'), depth: 3, suffix: '.jsonl', kind: 'workbuddy' },
    { dir: join(root, '.codebuddy', 'projects'), depth: 3, suffix: '.jsonl', kind: 'workbuddy' },
    // TRAE CLI keeps Codex-style rollouts here; TRAE's IDE keeps an encrypted
    // ModularData DB instead, which is deliberately not parsed.
    { dir: join(root, '.trae', 'cli'), depth: 4, suffix: '.jsonl', kind: 'trae' },
    { dir: join(root, '.trae-cn', 'cli'), depth: 4, suffix: '.jsonl', kind: 'trae' },
    { dir: join(root, '.dsh-conversation-sync', 'exports'), depth: 2, suffix: '.zip', kind: 'deepseekExport' },
  ]
  const seen = new Set()

  for (const spec of roots) {
    let files
    try {
      files = await walk(transport, spec.dir, spec.depth, (_entry, fullPath) => fullPath.endsWith(spec.suffix))
    } catch (error) {
      // A tool that simply is not installed is normal, not an error.
      if (String(error?.code ?? '') !== 'ENOENT' && !/ENOENT/.test(String(error?.message))) {
        errors.push(`${spec.dir}: ${error?.message || error}`)
      }
      continue
    }
    for (const file of files) {
      if (seen.has(file.path)) continue
      seen.add(file.path)
      try {
        const stat = await transport.stat(file.path)
        if (!stat) continue
        const { name, preview } = await describe(transport, file.path, spec.kind)
        const { count, truncated } = await countLines(transport, file.path)
        sessions.push({
          id: file.path,
          kind: spec.kind,
          name,
          path: file.path,
          machineId,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          count,
          countTruncated: truncated,
          preview,
        })
      } catch (error) {
        errors.push(`${file.path}: ${error?.message || error}`)
      }
    }
  }

  // Antigravity: transcript.jsonl lives deep under brain/<id>/.system_generated/logs
  const antigravityBases = [
    join(root, '.gemini', 'antigravity-cli', 'brain'),
    join(root, '.gemini', 'antigravity-ide', 'brain'),
    join(root, '.gemini', 'antigravity', 'brain'),
  ]
  for (const base of antigravityBases) {
    let files
    try {
      files = await walk(transport, base, 4, (_entry, fullPath) => fullPath.endsWith('transcript.jsonl'))
    } catch { continue } // a missing antigravity variant is normal
    for (const file of files) {
      if (seen.has(file.path)) continue
      seen.add(file.path)
      try {
        const stat = await transport.stat(file.path)
        if (!stat) continue
        const { count, truncated } = await countLines(transport, file.path)
        const { name, preview } = await describe(transport, file.path, 'antigravity')
        sessions.push({
          id: file.path, kind: 'antigravity', name, path: file.path, machineId,
          size: stat.size, mtimeMs: stat.mtimeMs, count, countTruncated: truncated, preview,
        })
      } catch (error) {
        errors.push(`${file.path}: ${error?.message || error}`)
      }
    }
  }

  // OpenCode: one SQLite database holding many sessions.
  const opencodeCandidates = [
    join(root, '.local', 'share', 'opencode', 'opencode.db'),
    join(root, '.config', 'opencode', 'opencode.db'),
  ]
  if (process.env.XDG_DATA_HOME) opencodeCandidates.unshift(join(process.env.XDG_DATA_HOME, 'opencode', 'opencode.db'))
  for (const dbPath of opencodeCandidates) {
    try {
      const stat = await transport.stat(dbPath)
      if (!stat) continue
      // The DB is local-only for now: listing it needs node:sqlite and a copy.
      if (transport.kind !== 'local') {
        errors.push(`${dbPath}: OpenCode databases are only scanned on the local machine`)
        continue
      }
      const { listOpenCodeSessions } = await import('./opencode.js')
      const rows = await listOpenCodeSessions({ file: dbPath })
      for (const row of rows) {
        if (seen.has(`${dbPath}#${row.id}`)) continue
        seen.add(`${dbPath}#${row.id}`)
        sessions.push({ ...row, machineId, mtimeMs: row.mtimeMs || stat.mtimeMs })
      }
      break // first existing database wins
    } catch (error) {
      errors.push(`${dbPath}: ${error?.message || error}`)
    }
  }

  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return { machineId, sessions, errors }
}
