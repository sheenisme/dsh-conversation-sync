// Move sessions imported by older versions into the single sync workspace.
//
// Early versions created one workspace per machine, so imported sessions sit
// under `~/.dsh/sessions/<slug-of-old-path>/`. DSH files a session by the slug
// of its workspace path, and a session can only be attached to a workspace whose
// path equals the session header's `cwd` — so moving a session means rewriting
// the `cwd` in its header and moving its directory to the new slug.
//
// Only sessions under THIS plugin's own workspace directories are touched. A
// session imported by anything else never matches that prefix.
import fs from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'

const ZSTD_MAGIC = Buffer.from('28b52ffd', 'hex')

/**
 * DSH's directory name for a workspace path: every separator becomes `-` and the
 * whole thing is wrapped in `--`. Verified against real directories on disk
 * (`/Users/me/.dsh/conversation-sync/workspaces/local` →
 * `--Users-me-.dsh-conversation-sync-workspaces-local--`).
 */
export function workspaceSlug(workspacePath) {
  return `--${String(workspacePath).replace(/\//g, '-').replace(/^-/, '')}--`
}

/** Split a multi-frame zstd file into its frames (whole-file decompress returns only the first). */
function splitFrames(buffer) {
  const frames = []
  let start = 0
  while (start < buffer.length) {
    const next = buffer.indexOf(ZSTD_MAGIC, start + 4)
    if (next === -1) {
      frames.push(buffer.subarray(start))
      break
    }
    frames.push(buffer.subarray(start, next))
    start = next
  }
  return frames
}

/** Read just the first frame — the session header — without touching the rest. */
export async function readHeader(logPath) {
  const buffer = await fs.readFile(logPath)
  const frames = splitFrames(buffer)
  if (!frames.length) return { header: undefined, frames, buffer }
  const text = zlib.zstdDecompressSync(frames[0]).toString('utf8')
  const line = text.split('\n').find(Boolean)
  return { header: line ? JSON.parse(line) : undefined, frames, buffer }
}

/** Rewrite the header's cwd and keep every later frame byte-identical. */
export async function rewriteCwd(logPath, cwd) {
  const { header, frames } = await readHeader(logPath)
  if (!header) throw new Error(`${logPath} has no session header`)
  if (header.cwd === cwd) return false
  const next = `${JSON.stringify({ ...header, cwd })}\n`
  const rebuilt = Buffer.concat([zlib.zstdCompressSync(Buffer.from(next, 'utf8')), ...frames.slice(1)])
  // Write beside the original and rename, so an interrupted migration leaves
  // either the old file or the new one - never a half-written log.
  const temporary = `${logPath}.migrating`
  await fs.writeFile(temporary, rebuilt)
  await fs.rename(temporary, logPath)
  return true
}

/** Session directories under any workspace path this plugin owns, except `keepDir`. */
async function legacySessionDirs(dshHome, ownedRoot, keepDir) {
  const sessionsRoot = path.join(dshHome, 'sessions')
  let slugs = []
  try {
    slugs = await fs.readdir(sessionsRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const ownedSlugs = new Set()
  const keepSlug = workspaceSlug(keepDir)
  // Any slug that decodes back under ownedRoot is ours. The slug is lossy
  // (separators become '-'), so compare on the encoded form of the prefix.
  const prefix = workspaceSlug(ownedRoot).replace(/--$/, '')
  for (const entry of slugs) {
    if (!entry.isDirectory()) continue
    const slug = entry.name
    if (slug === keepSlug) continue
    if (!slug.startsWith(prefix)) continue
    ownedSlugs.add(slug)
  }
  const found = []
  for (const slug of ownedSlugs) {
    const dir = path.join(sessionsRoot, slug)
    let entries = []
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      found.push({ sessionId: entry.name, fromDir: path.join(dir, entry.name), fromSlug: slug })
    }
  }
  return found
}

/** Locate a session's log inside its directory (the name carries the format version). */
async function logOf(sessionDir) {
  let entries = []
  try {
    entries = await fs.readdir(sessionDir)
  } catch {
    return undefined
  }
  const name = entries.find(entry => /^session\.v\d+\.jsonl(\.zstd)?$/.test(entry))
  return name ? path.join(sessionDir, name) : undefined
}

/**
 * Move every session this plugin imported into `syncDir`'s workspace.
 *
 * Returns {moved[], skipped[], errors[]}. A per-session error never aborts the
 * run: a migration that half-fails must still leave every other session usable.
 */
export async function migrateIntoSyncWorkspace({ dshHome, ownedRoot, syncDir, logger } = {}) {
  const report = { moved: [], skipped: [], errors: [] }
  if (!dshHome || !ownedRoot || !syncDir) return report
  const targetSlug = workspaceSlug(syncDir)
  const targetRoot = path.join(dshHome, 'sessions', targetSlug)

  const legacy = await legacySessionDirs(dshHome, ownedRoot, syncDir)
  for (const item of legacy) {
    const log = await logOf(item.fromDir)
    if (!log) {
      report.skipped.push({ ...item, reason: 'no session log in the directory' })
      continue
    }
    try {
      const { header } = await readHeader(log)
      if (!header) {
        report.skipped.push({ ...item, reason: 'log has no header' })
        continue
      }
      const alreadyThere = path.join(targetRoot, item.sessionId)
      if (await exists(alreadyThere)) {
        report.skipped.push({ ...item, reason: 'already present in the sync workspace' })
        continue
      }
      await fs.mkdir(targetRoot, { recursive: true })
      // Copy first, rewrite the copy, then remove the original: an interruption
      // leaves the session readable in at least one place.
      await fs.cp(item.fromDir, alreadyThere, { recursive: true, preserveTimestamps: true })
      const copiedLog = await logOf(alreadyThere)
      if (!copiedLog) throw new Error('the copied directory has no session log')
      await rewriteCwd(copiedLog, syncDir)
      await fs.rm(item.fromDir, { recursive: true, force: true })
      report.moved.push({ ...item, to: alreadyThere })
      logger?.debug?.(`[conversation-sync] moved session ${item.sessionId} into the sync workspace`)
    } catch (error) {
      report.errors.push({ ...item, error: String(error?.message ?? error) })
    }
  }
  return report
}

async function exists(target) {
  try {
    await fs.stat(target)
    return true
  } catch {
    return false
  }
}
