/**
 * Discovery of external conversation files across a filesystem transport.
 * The transport is the same small facade used by the adapters (local fs or
 * SSH/SFTP): stat/list/read/home. All remote paths use POSIX separators.
 */

import path from 'node:path'
import { mapLimit } from './pool.js'

const CHUNK = 256 * 1024
const MAX_COUNT_BYTES = 8 * 1024 * 1024
const MAX_ENTRIES = 5000
/** Files inspected at once. Each one is a round trip on a remote machine. */
const FILE_CONCURRENCY = 8

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
async function describe(transport, file, kind, head) {
  let buffer
  if (head) {
    // Already fetched by transport.inspect(), which folds the first bytes into
    // the same round trip as the stat.
    buffer = head
  } else {
    try {
      buffer = await transport.read(file, 0, CHUNK)
    } catch {
      buffer = Buffer.alloc(0)
    }
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
/**
 * Whether an error came from the connection itself rather than from the remote
 * path being read. Used to keep "cannot resolve home" for genuine home
 * problems instead of masking an auth or routing failure.
 */
function isTransportError(error) {
  if (!error) return false
  if (error.keyPath) return true
  const code = String(error.code ?? '')
  return code.startsWith('ESSH') || TRANSPORT_CODES.has(code)
}

const TRANSPORT_CODES = new Set(['EAUTH', 'EHOSTKEY', 'ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'ECLOSED'])

/**
 * Name, preview, size and line count for one file, in as few round trips as the
 * transport allows.
 *
 * A remote transport answers all of it with one command; the local one just
 * reads. Counting lines by reading a file in chunks is fine on a local disk and
 * catastrophic over SSH, so the two paths are kept apart here rather than in
 * the transport.
 */
async function inspectFile(transport, file, kind) {
  if (typeof transport.inspect === 'function') {
    const info = await transport.inspect(file)
    if (!info) return undefined
    const { name, preview } = await describe(transport, file, kind, info.head)
    return { size: info.size, mtimeMs: info.mtimeMs, count: info.count, countTruncated: false, name, preview }
  }
  const stat = await transport.stat(file)
  if (!stat) return undefined
  const { name, preview } = await describe(transport, file, kind)
  const { count, truncated } = await countLines(transport, file)
  return { size: stat.size, mtimeMs: stat.mtimeMs, count, countTruncated: truncated, name, preview }
}

export async function scanMachine(machine, { transport, home } = {}) {
  const machineId = machine?.id || 'local'
  const sessions = []
  const errors = []
  let root = home
  if (!root) {
    try {
      root = await transport.home()
    } catch (error) {
      // Do not claim "cannot resolve home" for a failure that is really about
      // reaching the machine at all (bad key path, auth, DNS): that message
      // sent a user hunting for a home-directory problem when the actual cause
      // was a typo in the private-key path. Keep the transport's own reason.
      if (isTransportError(error)) {
        errors.push(String(error?.message ?? error))
      } else {
        errors.push(`cannot resolve home: ${error?.message || error}`)
      }
      // Without a home there is nowhere to look: returning now avoids probing
      // ".claude/projects" relative to the process CWD, which reported the same
      // connection failure once per tool and buried the real cause in noise.
      return { machineId, sessions, errors }
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

  const listFor = async (dir, depth, suffix) => {
    // A remote transport answers the whole tree in one command; the local one
    // walks the directories, where a round trip costs nothing.
    if (typeof transport.findFiles === 'function') {
      return await transport.findFiles(dir, depth, suffix)
    }
    return await walk(transport, dir, depth, (_entry, fullPath) => fullPath.endsWith(suffix))
  }

  for (const spec of roots) {
    let files
    try {
      files = await listFor(spec.dir, spec.depth, spec.suffix)
    } catch (error) {
      // A tool that simply is not installed is normal, not an error.
      if (String(error?.code ?? '') !== 'ENOENT' && !/ENOENT/.test(String(error?.message))) {
        errors.push(`${spec.dir}: ${error?.message || error}`)
      }
      continue
    }
    // A missing root is reported as "absent", not as an empty directory.
    if (!Array.isArray(files) || files.length === 0) continue
    // A remote file costs one round trip, so inspecting them one at a time made
    // a machine with 55 rollouts take a minute. A handful in flight is bounded
    // work for the server and turns that into a few seconds.
    const fresh = files.filter(file => !seen.has(file.path))
    for (const file of fresh) seen.add(file.path)
    const infos = await mapLimit(fresh, FILE_CONCURRENCY, async file => {
      try {
        return { file, info: await inspectFile(transport, file.path, spec.kind) }
      } catch (error) {
        errors.push(`${file.path}: ${error?.message || error}`)
        return undefined
      }
    })
    for (const entry of infos) {
      if (!entry?.info) continue
      const { file, info } = entry
      sessions.push({
        id: file.path,
        kind: spec.kind,
        name: info.name,
        path: file.path,
        machineId,
        size: info.size,
        mtimeMs: info.mtimeMs,
        count: info.count,
        countTruncated: info.countTruncated,
        preview: info.preview,
      })
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
      files = await listFor(base, 4, 'transcript.jsonl')
    } catch { continue } // a missing antigravity variant is normal
    if (!Array.isArray(files) || files.length === 0) continue
    const freshAnti = files.filter(file => !seen.has(file.path))
    for (const file of freshAnti) seen.add(file.path)
    const antiInfos = await mapLimit(freshAnti, FILE_CONCURRENCY, async file => {
      try {
        return { file, info: await inspectFile(transport, file.path, 'antigravity') }
      } catch (error) {
        errors.push(`${file.path}: ${error?.message || error}`)
        return undefined
      }
    })
    for (const entry of antiInfos) {
      if (!entry?.info) continue
      const { file, info } = entry
      sessions.push({
        id: file.path, kind: 'antigravity', name: info.name, path: file.path, machineId,
        size: info.size, mtimeMs: info.mtimeMs, count: info.count,
        countTruncated: info.countTruncated, preview: info.preview,
      })
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
      // The DB is local-only for now: listing it needs node:sqlite and a copy of
      // the file. Skipping it on a remote host is expected, not a failure to
      // report — it would show as an error on every remote scan.
      if (transport.kind !== 'local') continue
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
