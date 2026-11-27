// File-level backup and restore of DSH session logs.
//
// The persistence service has no delete or truncate API, so an appended event
// cannot be undone through it. What CAN be done safely is to copy the session's
// whole on-disk directory before the append and copy it back if the sync fails
// verification. A DSH session lives at:
//
//   <DSH_HOME>/sessions/<workspace-slug>/<session-id>/
//
// The slug is derived from the workspace path, so a session that moved between
// workspaces appears under a different slug. Locating by session id alone keeps
// the restore correct in that case.
import fs from 'node:fs/promises'
import path from 'node:path'

/** Every on-disk directory holding this session id, newest mtime first. */
export async function findSessionDirs(dshHome, sessionId) {
  const root = path.join(dshHome, 'sessions')
  let slugs = []
  try {
    slugs = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const found = []
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue
    const dir = path.join(root, slug.name, sessionId)
    try {
      const stat = await fs.stat(dir)
      if (stat.isDirectory()) found.push({ dir, mtimeMs: stat.mtimeMs })
    } catch {
      // Not every workspace slug holds this session.
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).map(entry => entry.dir)
}

/**
 * Copy a session's directory aside. Returns undefined when the session has not
 * been materialized yet - a session created and appended to in this same run
 * only reaches disk on flush, so "no directory" is a normal answer, not an
 * error, and the caller treats the session as newly created.
 */
export async function backupSessionDir({ dshHome, sessionId, backupRoot, label }) {
  const dirs = await findSessionDirs(dshHome, sessionId)
  if (!dirs.length) return undefined
  const target = path.join(backupRoot, 'dsh', `${label}-${sessionId}-${Date.now()}`)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.cp(dirs[0], target, { recursive: true, preserveTimestamps: true })
  return { backupPath: target, sourceDir: dirs[0], existed: true }
}

/** Copy a backed-up session directory back over the live one. */
export async function restoreSessionDir({ dshHome, sessionId, backupPath }) {
  const dirs = await findSessionDirs(dshHome, sessionId)
  const target = dirs[0] ?? path.join(dshHome, 'sessions', '__restored__', sessionId)
  if (dirs[0]) await fs.rm(dirs[0], { recursive: true, force: true })
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.cp(backupPath, target, { recursive: true, preserveTimestamps: true })
  return target
}

/** Remove a session directory entirely - only for a session this sync created. */
export async function removeSessionDir({ dshHome, sessionId }) {
  const dirs = await findSessionDirs(dshHome, sessionId)
  for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true })
  return dirs
}
