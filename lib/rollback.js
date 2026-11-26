// Automatic rollback and failure diagnostics for conversation sync operations.
import { randomUUID } from 'node:crypto'
import path from 'node:path'

const BACKUP_REMINDER = 'a backup was kept; no data was deleted by the rollback'
const FALLBACK_CONDITION = 'inspect the error detail and retry once the underlying condition is fixed'
const EXTERNAL_DIRECTIONS = new Set(['out', 'both'])
const DSH_DIRECTIONS = new Set(['in', 'both'])

const truncate = (value, max) => {
  const text = String(value ?? '')
  return text.length <= max ? text : `${text.slice(0, max - 1)}...`
}

// Keep backup paths safe on both local disks and remote SFTP hosts.
function safeBindingId(value) {
  return String(value ?? 'binding').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'binding'
}

function errorParts(error) {
  const code = String(error?.code ?? '')
  const message = String(error?.message ?? (typeof error === 'string' ? error : error?.name ?? ''))
  const signal = String(error?.signal ?? '')
  return { message, haystack: `${code}\n${message}\n${signal}`.toLowerCase() }
}

/**
 * Turn any thrown value into a short reason plus concrete retry preconditions.
 * The caller/UI renders both fields as plain strings.
 */
export function diagnoseFailure(error, context = {}) {
  try {
    const { message, haystack } = errorParts(error)
    const lowerMessage = message.toLowerCase()
    const has = re => re.test(haystack)
    const file = context.path || '<path>'
    const target = context.machine?.host
      || (context.transportKind === 'ssh' ? 'the SSH host' : 'the local machine')
    const phase = context.phase ? `${context.phase} failed: ` : ''
    let reason
    let conditions = []

    if (has(/invalid zip data|export_format_version/)) {
      reason = 'DeepSeek export is not a valid export_format_version 3 archive'
      conditions = ['the DeepSeek export ZIP must be an unmodified export_format_version 3 archive']
    } else if (
      has(/sessionalreadyexistserror|sessionalreadyownederror|protected first surface head/)
      || (/\bseq\b/.test(lowerMessage) && /mismatch|conflict|head|missing/.test(lowerMessage))
    ) {
      reason = 'the target DSH session is inconsistent'
      conditions = ['the target DSH session must be intact; reopen it in DSH once, then retry']
    } else if (has(/not ready|\bstorage\b/)) {
      reason = 'plugin storage is not ready'
      conditions = ['wait for the plugin storage to finish opening, then retry']
    } else if (has(/connect etimedout|econnrefused|getaddrinfo enotfound|handshake failed|unable to connect|all configured authentication methods failed|bad owner or permissions|authentication failed|permission denied \(publickey\)/)) {
      reason = `SSH connection or authentication failed${context.machine?.label ? ` (${context.machine.label})` : ''}`
      conditions = [
        'the SSH host must be reachable from the machine running DSH',
        "verify host/user/port and that the private key matches the server's authorized_keys",
        'the key file must be readable only by its owner (chmod 600)',
        'proxy/jump host must be reachable if ProxyJump is configured',
      ]
    } else if (has(/\benoent\b|no such file/)) {
      reason = `source file/directory not found at ${file}`
      conditions = [`the source file/directory must exist at ${file}`, 'check the path and permissions']
    } else if (has(/a file is in the way|eexist|enotdir/)) {
      // The destination's parent exists but is a regular file, so no directory
      // can be created there. Very different fix from "permission denied".
      reason = `cannot use ${file}: a file is in the way of a directory`
      conditions = [
        'one of the path components above the destination must be a directory, not a file',
        'choose a different destination path, or move/remove the file that occupies a directory name',
      ]
    } else if (has(/\bmkdir\b/)) {
      // Two very different mkdirs reach here: creating the plugin's own data
      // directory, and creating the parent directory of an external
      // conversation file. Blaming the plugin data dir for a bad export path
      // sends the user to the wrong fix, so name the directory actually
      // reported and branch on whether it lives under the plugin data root.
      // Read the path from the ORIGINAL message, not the lowercased haystack:
      // `mkdir[^(]*` is greedy, so a case-folded multi-line haystack made it
      // swallow the rest of the text and capture a single stray character.
      const dir = /mkdir[^(]*?['"]([^'"]+)['"]/.exec(message)?.[1]?.trim()
      const root = context.dataRoot ? path.resolve(context.dataRoot) : undefined
      const insideRoot = !!(dir && root && (path.resolve(dir) === root || path.resolve(dir).startsWith(`${root}${path.sep}`)))
      if (insideRoot) {
        reason = `cannot create the plugin data directory${dir ? ` at ${dir}` : ''}`
        conditions = [
          `the account running DSH must be able to create ${dir || 'the plugin data directory'}`,
          'DSH_HOME (or the user home) must be writable by that account',
          'a read-only home, a full disk, or a sandbox policy blocking that path all cause this',
        ]
      } else {
        const account = context.transportKind === 'ssh' ? 'the SSH user' : 'the account running DSH'
        reason = `cannot create the directory for ${file}${dir ? ` (${dir})` : ''}`
        conditions = [
          `${account} must be able to create directories in ${dir || 'the destination parent directory'}`,
          `the destination directory of ${file} must exist or be creatable by that account`,
          'check that the path is not inside a read-only mount or a protected system directory',
        ]
      }
    } else if (has(/\beacces\b|\beperm\b|permission denied/)) {
      reason = context.path ? `permission denied on ${file}` : 'permission denied'
      conditions = context.transportKind === 'ssh'
        ? [`the SSH user must have read/write permission on ${file}`, 'check file ownership and the SSH account']
        : [`the account running DSH must have read/write permission on ${file}`, 'check file ownership and file mode']
    } else if (has(/\benospc\b|disk full|no space left/)) {
      reason = `no space left on ${target}`
      conditions = [`free disk space on ${target} and retry`]
    } else if (has(/\baborted\b|sigabrt|\btimeout\b|timed ?out/)) {
      reason = 'sync aborted or timed out'
      conditions = ['retry when the network is stable']
    } else {
      reason = message || context.phase || 'sync failed'
      conditions = [FALLBACK_CONDITION]
    }

    return {
      reason: truncate(`${phase}${reason}`, 200),
      conditions: [...new Set([...conditions, BACKUP_REMINDER])],
    }
  } catch (diagnosticError) {
    // Diagnostics must never hide the original failure.
    return {
      reason: truncate(`sync failed: ${String(diagnosticError?.message ?? diagnosticError)}`, 200),
      conditions: [FALLBACK_CONDITION, BACKUP_REMINDER],
    }
  }
}

/**
 * Snapshots what a sync may mutate, so a later failure can be rolled back.
 * Snapshots are returned to the caller for persistence; no storage is written here.
 */
export class SyncRollback {
  constructor({ logger, storage } = {}) {
    this.logger = logger
    this.storage = storage // reserved for future persistence
  }

  async begin({
    bindingId, direction, externalPath, backupRoot, localTransport,
    externalTransport, dshSessionId, dshFacade,
  } = {}) {
    const snapshot = {
      id: `rb-${randomUUID()}`,
      bindingId,
      direction,
      createdAt: Date.now(),
      external: null,
      dsh: null,
      status: 'pending',
    }

    if (EXTERNAL_DIRECTIONS.has(direction) && externalPath) {
      const transportKind = externalTransport?.kind === 'ssh' ? 'ssh' : 'local'
      const p = transportKind === 'ssh' ? path.posix : path
      const external = { path: externalPath, transportKind, existed: false }
      try {
        const stat = await externalTransport?.stat(externalPath)
        if (stat) {
          external.existed = true
          external.bytes = stat.size
          external.backupPath = p.join(
            backupRoot,
            safeBindingId(bindingId),
            `${Date.now()}-${p.basename(externalPath)}`,
          )
          await externalTransport.copyToBackup(externalPath, external.backupPath)
        }
      } catch (error) {
        // Abort before any mutation: a missing backup must never allow a write.
        throw new Error(`backup failed: ${String(error?.message ?? error)}`, { cause: error })
      }
      snapshot.external = external
    }

    if (DSH_DIRECTIONS.has(direction) && dshSessionId) {
      const fromSeq = await dshFacade?.getSeq(dshSessionId)
      snapshot.dsh = { sessionId: dshSessionId, fromSeq: Number.isFinite(fromSeq) ? fromSeq : 0 }
    }
    return snapshot
  }

  async succeed(snapshot) {
    if (snapshot) snapshot.status = 'succeeded'
    return snapshot
  }

  /** Restore only what was backed up; never delete files or edit DSH files directly. */
  async restore(snapshot, { localTransport, externalTransport, dshFacade, logger } = {}) {
    const log = logger ?? this.logger
    const report = { restored: { external: false, dsh: false }, errors: [] }
    const external = snapshot?.external
    const dsh = snapshot?.dsh

    if (external) {
      if (!external.existed) {
        report.errors.push(
          'external file did not exist before the sync; manual cleanup may be needed (no file was deleted by the rollback)',
        )
      } else if (external.backupPath) {
        try {
          // Use the same transport that created the backup.
          const transport = externalTransport ?? localTransport
          const bytes = await transport.read(external.backupPath)
          await transport.write(external.path, bytes)
          report.restored.external = true
          log?.debug?.(`[conversation-sync] rollback restored ${external.path}`)
        } catch (error) {
          report.errors.push(`external restore failed for ${external.path}: ${String(error?.message ?? error)}`)
        }
      } else {
        report.errors.push(`no backup path recorded for ${external.path}; external restore skipped`)
      }
    }

    if (dsh && dsh.appendedCount > 0) {
      if (typeof dshFacade?.truncateFrom === 'function') {
        try {
          await dshFacade.truncateFrom(dsh.sessionId, dsh.fromSeq)
          report.restored.dsh = true
          log?.debug?.(`[conversation-sync] rollback truncated session ${dsh.sessionId}`)
        } catch (error) {
          report.errors.push(`DSH restore failed for ${dsh.sessionId}: ${String(error?.message ?? error)}`)
        }
      } else {
        report.errors.push(
          `${dsh.appendedCount} DSH event(s) appended to session ${dsh.sessionId} remain; remove them manually via the DSH UI`,
        )
      }
    }

    if (snapshot) snapshot.status = report.errors.length ? 'partially-restored' : 'restored'
    return report
  }

  /** Diagnose, roll back, and record the failure. Never throws. */
  async fail(snapshot, error, context = {}, restoreArgs = {}) {
    let failure
    try {
      failure = {
        ...diagnoseFailure(error, context),
        snapshotId: snapshot?.id,
        at: Date.now(),
        error: String(error?.message ?? error),
      }
    } catch {
      failure = {
        reason: 'sync failed',
        conditions: [FALLBACK_CONDITION, BACKUP_REMINDER],
        snapshotId: snapshot?.id,
        at: Date.now(),
        error: String(error),
      }
    }
    if (snapshot) snapshot.status = 'failed'
    let report
    try {
      report = await this.restore(snapshot, restoreArgs)
    } catch (restoreError) {
      report = {
        restored: { external: false, dsh: false },
        errors: [`rollback failed: ${String(restoreError?.message ?? restoreError)}`],
      }
    }
    // restore() marks its own outcome; the sync itself stays failed.
    if (snapshot) snapshot.status = 'failed'
    return { failure, report }
  }
}
