import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import Schema from '@deepseek-ai/schemastery'
import { LocalTransport, transportForMachine, previewKeyPath, keyRefFor, isValidKeyRef } from './lib/transports.js'
import { createTransportPool, mapLimit } from './lib/pool.js'
import { readJsonlDelta, renderExternalLine, parseDeepSeekExport } from './lib/adapters.js'
import { buildEvents, toLiveInput } from './lib/events.js'
import { discoverMachines } from './lib/sshconfig.js'
import { createHostKeyGuard } from './lib/hostkey.js'
import { scanMachine } from './lib/discovery.js'
import { listDshSessions, readDshSessionMessages, dshSessionExists, countDshEvents, inspectDshLog } from './lib/dsh-sessions.js'
import { compareSides, resolveDirection } from './lib/newer.js'
import { SyncRollback, diagnoseFailure, preflight } from './lib/rollback.js'
import { migrateIntoSyncWorkspace } from './lib/dsh-migrate.js'

export const name = 'dsh-conversation-sync'
export const inject = ['timer', 'connection', 'credentials', 'sessionPersistence', 'sessionProjectionCache', 'workspaceRegistry', 'sessions', 'storageDomain']

const NS = 'conversation-sync'
// Honour DSH_HOME so an isolated home (CI, a sandbox, a second profile) keeps
// plugin data inside itself instead of writing to the real ~/.dsh.
const DSH_HOME = process.env.DSH_HOME && process.env.DSH_HOME.trim() ? process.env.DSH_HOME.trim() : path.join(os.homedir(), '.dsh')
const ROOT = path.join(DSH_HOME, 'conversation-sync')
const WORKSPACE_ROOT = path.join(ROOT, 'workspaces')
const BACKUP_ROOT = path.join(ROOT, 'backups')
const KINDS = ['claude', 'codex', 'workbuddy', 'trae', 'antigravity', 'opencode', 'jsonl', 'deepseekExport']
// OpenCode lives in SQLite; writing into a live database from a plugin is not
// safe, so it is import-only for now.
const IMPORT_ONLY_KINDS = new Set(['deepseekExport', 'opencode'])
// 'auto' means "decide from which side is newer"; 'both' means "keep both legs
// in step", which still defers to the comparison when the sides disagree.
const DIRECTIONS = ['in', 'out', 'both', 'auto']
const MESSAGE_TYPES = new Set(['user/message', 'assistant/message'])
const SCAN_TTL_MS = 15_000
const SCAN_INTERVAL_MS = 30_000
const POLL_INTERVAL_MS = 2_000

const bindingSchema = z.object({
  id: z.string(),
  name: z.string(),
  machineId: z.string(),
  externalPath: z.string(),
  externalSessionId: z.string().optional(),
  dbPath: z.string().optional(),
  kind: z.enum(KINDS),
  dshSessionIds: z.array(z.string()).default([]),
  direction: z.enum(DIRECTIONS).default('both'),
  keyRef: z.string().optional(),
  pollMs: z.number().min(500).default(2000),
  // Manual by default: a binding that starts syncing on its own the moment it
  // is created surprises people, and a wrong direction can overwrite the newer
  // copy. `checked` is the per-row gate the panel shows; only checked bindings
  // ever sync, whether by hand or by the poller.
  autoSync: z.boolean().default(false),
  checked: z.boolean().default(true),
  enabled: z.boolean().default(true),
})

const failureSchema = z.object({
  reason: z.string(),
  conditions: z.array(z.string()),
  at: z.number(),
  error: z.string().optional(),
  snapshotId: z.string().optional(),
  backupPaths: z.array(z.string()).default([]),
  restored: z.object({ external: z.boolean(), dsh: z.boolean() }).optional(),
  cleanup: z.array(z.string()).default([]),
})

const stateSchema = z.object({
  bindingId: z.string(),
  cursor: z.object({ offset: z.number(), pending: z.string() }).optional(),
  // Where DSH appends next (import cursor). Separate from outSeqs on purpose:
  // sharing one map meant an import advanced the export cursor, so the first
  // export after an import found "nothing new" and wrote an empty file.
  dshSeqs: z.record(z.number()).default({}),
  // Where the external file was last written to (export cursor).
  outSeqs: z.record(z.number()).default({}),
  externalSize: z.number().optional(),
  externalMtimeMs: z.number().optional(),
  // The newest DSH event time as of the last completed sync. Recorded so the
  // next comparison can ask "did DSH change?" exactly, instead of comparing a
  // conversation's own timestamp against the wall clock.
  dshTimeAtSync: z.number().optional(),
  lastSyncAt: z.number().optional(),
  lastError: z.string().optional(),
  lastFailure: failureSchema.optional(),
  workspaceId: z.string().optional(),
  importedIds: z.array(z.string()).default([]),
})

const domain = {
  name: 'conversation_sync',
  version: 1,
  tables: {
    bindings: { valueSchema: bindingSchema },
    states: { valueSchema: stateSchema },
  },
}

function safeId(value) {
  return String(value).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'unknown'
}

// UI placement preferences. Deliberately a plain JSON file rather than another
// storage table: the domain schema is versioned, and adding a table would make
// every existing install run a migration for two booleans.
const PREFERENCES_FILE = path.join(ROOT, 'preferences.json')
const DEFAULT_PREFERENCES = { sidebarEntry: true, settingsEntry: true }

async function readPreferences() {
  try {
    const text = await fs.readFile(PREFERENCES_FILE, 'utf8')
    const parsed = JSON.parse(text)
    return {
      sidebarEntry: parsed?.sidebarEntry !== false,
      settingsEntry: parsed?.settingsEntry !== false,
    }
  } catch {
    // A missing or corrupt preferences file must not break the panel.
    return { ...DEFAULT_PREFERENCES }
  }
}

async function writePreferences(next) {
  await fs.mkdir(ROOT, { recursive: true })
  const temporary = `${PREFERENCES_FILE}.${process.pid}.tmp`
  await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  await fs.rename(temporary, PREFERENCES_FILE)
  return next
}

/** Plugin config: DSH merges these from the profile patch / config editor. */
export const Config = Schema.object({
  hostKeyMode: Schema.union(['accept-new', 'verify', 'off'])
    .default('accept-new')
    .description('SSH host-key policy: accept-new records a fingerprint on first connect, verify rejects unknown hosts, off disables checking.'),
  pollIntervalMs: Schema.natural().min(1000).max(600000).default(2000)
    .description('How often enabled bindings poll their source files for changes.'),
  autoSync: Schema.boolean().default(true)
    .description('Sync bindings that opt into autoSync whenever a change is detected.'),
})

function dirOf(machine, filePath) {
  return machine?.kind === 'ssh' ? path.posix.dirname(filePath) : path.dirname(filePath)
}

export async function apply(ctx, config = {}) {
  const settings = { hostKeyMode: 'accept-new', pollIntervalMs: 2000, autoSync: true, ...config }
  const logger = ctx.logger ?? console
  const sessionStore = ctx.sessions
  const persistence = ctx.sessionPersistence
  const workspaces = ctx.workspaceRegistry
  const projectionCache = ctx.get('sessionProjectionCache')

  let storage
  let bindingsTable
  let statesTable
  let machinesCache = { machines: [{ id: 'local', label: 'Local machine', kind: 'local' }], warnings: [] }
  let externalCache = { at: 0, byMachine: {}, errors: {}, dsh: [] }
  let scanning = false
  let activeScan = null
  let syncing = false

  const dirty = new Set()
  const lastPoll = new Map()
  const localTransport = new LocalTransport()
  const hostKeyGuard = createHostKeyGuard({
    file: path.join(ROOT, 'known_hosts.json'),
    mode: settings.hostKeyMode,
    logger,
  })

  const getState = id => statesTable.get(id) ?? { bindingId: id, dshSeqs: {}, outSeqs: {}, importedIds: [] }
  const saveState = state => statesTable.put(state.bindingId, state)
  const getBinding = id => bindingsTable.get(id)
  const allBindings = () => [...bindingsTable.entries()].map(([, value]) => value)
  const machineById = id => machinesCache.machines.find(machine => machine.id === id)
  // keyRefFor() lives in lib/transports.js: a credential reference must be a
  // POSIX identifier, and a machine id is not one. Building the name inline is
  // what put an invalid entry in the user's credential store and stopped DSH
  // from starting at all.
  const refFor = machine => keyRefFor(machine.id)

  const refreshMachines = async () => {
    try {
      machinesCache = await discoverMachines()
    } catch (error) {
      machinesCache = {
        machines: [{ id: 'local', label: 'Local machine', kind: 'local' }],
        warnings: [`machine discovery failed: ${error?.message ?? error}`],
      }
    }
    return machinesCache
  }

  // -------------------------------------------------------- transport helpers

  const transportFor = async (machine, keyRef) => {
    if (!machine) throw new Error('unknown machine; refresh the machine list and retry')
    return transportForMachine(machine, machinesCache.machines, ctx.credentials, logger, keyRef, {
      hostKeyGuard,
    })
  }

  // One live transport per machine, reused across scans, polls and syncs, so a
  // 30s discovery tick does not pay for a fresh SSH handshake every time.
  const transportPool = createTransportPool({
    create: (machine, keyRef) => transportFor(machine, keyRef),
    logger,
  })
  const pooledTransport = (machine, keyRef) => transportPool.get(machine, keyRef)
  const withPooledTransport = (machine, keyRef, fn) => transportPool.run(machine, keyRef, fn)
  const discardTransport = machine => transportPool.discard(machine)

  // ---------------------------------------------------------- session helpers

  // ONE workspace for every machine. DSH requires a session's cwd to equal its
  // workspace path exactly (dsh-workspace/lib/index.js:122 throws otherwise, and
  // candidateMatches filters by the same equality), so "one workspace with a
  // folder per machine" is not expressible — a per-machine directory would have
  // to be its own workspace, which is exactly the clutter being fixed here.
  // Machines are distinguished by the session title prefix instead.
  const SYNC_WORKSPACE_DIR = path.join(WORKSPACE_ROOT, 'sync')
  const SYNC_WORKSPACE_TITLE = '会话同步'
  const ensureWorkspace = async (state) => {
    if (state.workspaceId && workspaces.get(state.workspaceId)) {
      const existing = workspaces.get(state.workspaceId)
      // Adopt an older single-machine workspace instead of leaving it behind:
      // its directory is where previously imported sessions already live.
      if (existing.path === SYNC_WORKSPACE_DIR) return state.workspaceId
    }
    await localTransport.mkdir(SYNC_WORKSPACE_DIR)
    const ws = await workspaces.create(SYNC_WORKSPACE_DIR, SYNC_WORKSPACE_TITLE)
    if (state.workspaceId !== ws.id) {
      state.workspaceId = ws.id
      await saveState(state)
    }
    return ws.id
  }

  /** `BAAI-Ascend · <title>` — the only per-machine grouping DSH permits. */
  const machineLabel = machineId => machineById(machineId)?.label ?? machineId
  const titledFor = (binding, title) => {
    const label = machineLabel(binding.machineId)
    const base = String(title ?? '').trim() || path.posix.basename(binding.externalPath) || binding.name
    if (binding.machineId === 'local') return base
    return base.startsWith(`${label} · `) ? base : `${label} · ${base}`
  }

  /** Materialize a brand-new DSH session from normalized records. */
  const createSession = async (binding, state, records, title) => {
    if (!records.length) throw new Error(`no importable messages in ${binding.externalPath}`)
    const id = `conversation-${randomUUID()}`
    const header = {
      version: 4,
      id,
      createdAt: records.find(record => record.ts)?.ts ?? Date.now(),
      cwd: SYNC_WORKSPACE_DIR,
      isSeeded: false,
    }
    const events = buildEvents(records, { createId: randomUUID })
    const named = titledFor(binding, title)
    if (named) {
      events.push({
        type: 'session/title',
        data: { title: named, messageSeqs: [], source: { kind: 'user' } },
        seq: events.length,
        time: events.at(-1)?.time ?? header.createdAt,
      })
    }
    const handle = await persistence.create(header)
    try {
      await handle.append(events)
      await handle.flush()
    } finally {
      await handle.close()
    }
    projectionCache?.coldSnapshot?.(header, 0, events)
    await ensureWorkspace(state)
    await workspaces.get(state.workspaceId)?.attachSession(id)
    return { id, lastSeq: events.length }
  }

  /** Append events to an existing imported session (live first, persistence second). */
  const appendSession = async (sessionId, records, startSeq) => {
    if (!records.length) return startSeq
    const live = sessionStore.get(sessionId)
    if (live) {
      // A resident session already knows its log, so the next turn comes from it.
      const { nextTurn } = await inspectDshLog({ persistence, sessions: sessionStore, sessionId })
      const liveEvents = buildEvents(records, { startSeq, startTurn: nextTurn, createId: randomUUID })
      live.append(liveEvents.map(toLiveInput))
      await sessionStore.flush(live)
      return startSeq + liveEvents.length
    }
    // Derive the current length AND the next turn from the LOG, not from
    // stat().eventCount: the backend may report 0 for a session created in this
    // same run, and both a wrong seq ("append seq mismatch ... expected N") and a
    // reused turn ("turn/start does not open the expected turn") are rejected.
    const { eventCount: seq, nextTurn } = await inspectDshLog({ persistence, sessions: sessionStore, sessionId })
    const events = buildEvents(records, { startSeq, startTurn: nextTurn, createId: randomUUID })
    if (!events.length) return seq
    const shift = seq - startSeq
    const ready = events.map((event, index) => ({
      ...event,
      seq: startSeq + index + shift,
      ...(event.sourceEventSeqs ? { sourceEventSeqs: event.sourceEventSeqs.map(value => value + shift) } : {}),
    }))
    const handle = await persistence.open(sessionId, 'write')
    try {
      await handle.append(ready)
      await handle.flush()
    } finally {
      await handle.close()
    }
    return seq + ready.length
  }

  const dshFacade = {
    getSeq: async sessionId => countDshEvents({ persistence, sessions: sessionStore, sessionId }),
    // DSH has no public truncate API for third-party plugins. Restore of the
    // DSH side is therefore reported for manual cleanup instead of editing
    // persistence files directly (which would risk corrupting the log).
  }

  // ------------------------------------------------------------- sync engine

  const syncIn = async (binding, state, transport) => {
    if (binding.kind === 'deepseekExport') {
      const stat = await transport.stat(binding.externalPath)
      if (!stat) throw new Error(`export file not found: ${binding.externalPath}`)
      if (state.externalSize === stat.size && state.externalMtimeMs === stat.mtimeMs && state.importedIds.length) return 0
      const bytes = await transport.read(binding.externalPath)
      const sessions = await parseDeepSeekExport(bytes, randomUUID)
      let imported = 0
      for (const session of sessions) {
        if (state.importedIds.includes(session.id)) continue
        if (!session.records.length) continue
        const created = await createSession(binding, state, session.records, session.title ?? binding.name)
        binding.dshSessionIds.push(created.id)
        state.dshSeqs[created.id] = created.lastSeq
        state.importedIds.push(session.id)
        imported++
      }
      state.externalSize = stat.size
      state.externalMtimeMs = stat.mtimeMs
      if (imported) await bindingsTable.put(binding.id, binding)
      return imported
    }

    if (binding.kind === 'opencode') {
      const { readOpenCodeMessages } = await import('./lib/opencode.js')
      const sessionId = binding.externalSessionId ?? binding.externalPath
      const delta = await readOpenCodeMessages({ file: binding.dbPath ?? binding.externalPath, sessionId, fromSeq: state.cursor?.offset ?? 0 })
      if (!delta.records.length) {
        if (!binding.dshSessionIds.length) throw new Error(`OpenCode session ${sessionId} has no importable messages`)
        return 0
      }
      if (!binding.dshSessionIds.length) {
        const created = await createSession(binding, state, delta.records, binding.name)
        binding.dshSessionIds.push(created.id)
        state.dshSeqs[created.id] = created.lastSeq
        await bindingsTable.put(binding.id, binding)
      } else {
        const id = binding.dshSessionIds[0]
        state.dshSeqs[id] = await appendSession(id, delta.records, state.dshSeqs[id] ?? 0)
      }
      state.cursor = { offset: delta.cursor, pending: '' }
      return delta.records.length
    }

    const delta = await readJsonlDelta(transport, binding.externalPath, binding.kind, state.cursor)
    if (delta.absent) throw new Error(`source file not found: ${binding.externalPath}`)
    if (!binding.dshSessionIds.length) {
      // An empty source used to materialize an empty DSH session: a session
      // title with no conversation in it, which looks like a successful import
      // and shows nothing. Refuse, and say why in terms the user can act on.
      if (!delta.records.length) {
        throw new Error(
          `${binding.externalPath} has no importable messages. ` +
          'Compacted or metadata-only rollouts carry no conversation text; pick a session that has messages.',
        )
      }
      const created = await createSession(binding, state, delta.records, binding.name)
      binding.dshSessionIds.push(created.id)
      state.dshSeqs[created.id] = created.lastSeq
      await bindingsTable.put(binding.id, binding)
    } else if (delta.records.length) {
      const sessionId = binding.dshSessionIds[0]
      state.dshSeqs[sessionId] = await appendSession(sessionId, delta.records, state.dshSeqs[sessionId] ?? 0)
    }
    state.cursor = delta.cursor
    const stat = await transport.stat(binding.externalPath)
    state.externalSize = stat?.size
    state.externalMtimeMs = stat?.mtimeMs
    return delta.records.length
  }

  const syncOut = async (binding, state, transport, machine) => {
    if (binding.kind === 'deepseekExport') {
      throw new Error('DeepSeek export ZIP is read-only: choose direction "in" (import) for this source')
    }
    if (binding.kind === 'opencode') {
      throw new Error('OpenCode stores sessions in SQLite; importing only. Choose direction "in" for this source')
    }
    let written = 0
    let content = ''
    for (const sessionId of binding.dshSessionIds) {
      // A stale or mistyped session id used to read back as zero messages and
      // report a successful sync that wrote nothing. Fail with the reason.
      if (!(await dshSessionExists({ persistence, sessions: sessionStore, sessionId }))) {
        throw new Error(`DSH session ${sessionId} does not exist; re-select it on the left`)
      }
      const fromSeq = state.outSeqs?.[sessionId] ?? 0
      const messages = await readDshSessionMessages({ persistence, sessions: sessionStore, sessionId, fromSeq, strict: true })
      for (const message of messages) {
        const text = String(message.text ?? '')
        if (!text) continue
        content += renderExternalLine(
          binding.kind,
          { role: message.role, text, ts: message.time },
          `dsh:${sessionId}:${message.seq}`,
        )
      }
      if (messages.length) {
        state.outSeqs ??= {}
        state.outSeqs[sessionId] = Math.max(fromSeq, ...messages.map(message => message.seq))
      }
      written += messages.length
    }
    if (!content) return { written: 0 }
    const statBefore = await transport.stat(binding.externalPath)
    if (!statBefore) await transport.mkdir(dirOf(machine, binding.externalPath))
    const previous = statBefore ? (await transport.read(binding.externalPath)).toString('utf8') : ''
    const next = previous + content
    await transport.write(binding.externalPath, next)
    const stat = await transport.stat(binding.externalPath)
    state.externalSize = stat?.size
    state.externalMtimeMs = stat?.mtimeMs
    // Handed to verify(): the exact bytes the file must now end with, and its
    // size. A write that silently truncated or landed in the wrong file shows
    // up here instead of in the user's source file later.
    return { written, content, expectedSize: Buffer.byteLength(next, 'utf8') }
  }

  const syncBinding = async (binding, forced = false, directionOverride) => {
    const state = getState(binding.id)
    const machine = machineById(binding.machineId)
    const configured = directionOverride ?? binding.direction
    const context = {
      phase: 'sync',
      path: binding.externalPath,
      machine: machine ?? { id: binding.machineId, label: binding.machineId, kind: 'local' },
      transportKind: machine?.kind === 'ssh' ? 'ssh' : 'local',
      // Lets the diagnostics tell "our own data dir is not writable" apart from
      // "the conversation file's parent cannot be created" - same mkdir error,
      // completely different fix.
      dataRoot: ROOT,
    }
    let transport
    let rollback
    let snapshot
    let direction = configured
    let comparison
    try {
      // Pooled: syncing the same machine again (the common case, every poll)
      // must not pay for another SSH handshake.
      transport = await pooledTransport(machine, binding.keyRef)

      // NEWER: decide from the timestamps before writing anything. A binding
      // set to 'both' used to push DSH text over a source file the user had
      // edited a minute earlier; comparing first means the newer copy wins and
      // the older one is only ever appended to.
      comparison = await compareBindingSides(binding, state, transport)
      direction = resolveDirection(configured, comparison)

      // Nothing moved on either side, so there is nothing to write. Reporting a
      // sync here would rewrite a file that is already correct and make the
      // "did it change?" question unanswerable.
      if (direction === 'none') {
        return { id: binding.id, imported: 0, written: 0, direction, configured, comparison, skipped: true }
      }

      // PRE-FLIGHT: read-only. A sync whose preconditions are already broken
      // must mutate nothing, so this runs before any backup or write.
      const ready = await preflight({
        direction,
        binding,
        transport,
        machine: machine ?? { id: binding.machineId, kind: 'local' },
        persistence,
        sessions: sessionStore,
        dshSessionId: binding.dshSessionIds[0],
        dataRoot: ROOT,
      })
      if (!ready.ok) {
        const failure = { ...ready.failure, conditions: ready.failure.conditions, checks: ready.checks }
        state.lastError = failure.reason
        state.lastFailure = failure
        await saveState(state)
        logger.warn?.(`[conversation-sync] ${binding.name}: ${failure.reason}`)
        return { id: binding.id, error: failure.reason, failure, direction, configured, comparison }
      }

      rollback = new SyncRollback({ logger, dshHome: DSH_HOME })
      // BACKUP: the external file and the DSH session directory, both verified
      // readable before the first byte is written.
      snapshot = await rollback.begin({
        bindingId: binding.id,
        direction,
        externalPath: binding.externalPath,
        backupRoot: BACKUP_ROOT,
        externalTransport: transport,
        dshSessionId: binding.dshSessionIds[0],
        dshFacade,
      })

      let imported = 0
      let written = 0
      let outResult
      const sessionIdBefore = binding.dshSessionIds[0]
      const seqBefore = sessionIdBefore ? await dshFacade.getSeq(sessionIdBefore) : 0
      if (direction === 'in' || direction === 'both') imported = await syncIn(binding, state, transport)
      if (direction === 'out' || direction === 'both') {
        outResult = await syncOut(binding, state, transport, machine ?? { kind: 'local' })
        written = outResult.written
      }

      // VERIFY: read both sides back. A write that did not land as reported is
      // a failure - the user would otherwise see "synced" and no new messages.
      const expected = {}
      if (outResult?.expectedSize !== undefined) expected.externalBytes = outResult.expectedSize
      if ((direction === 'in' || direction === 'both') && imported > 0) {
        // Read the messages back the way the export path does. `getSeq` is not
        // usable here: right after persistence.create() the backend's stat()
        // still reports zero events for the new session, so a seq comparison
        // fails a sync that actually worked (it did, in testing). What the user
        // cares about is whether the conversation is readable, so assert that.
        const targetId = binding.dshSessionIds[0]
        const messages = targetId
          ? await readDshSessionMessages({ persistence, sessions: sessionStore, sessionId: targetId, fromSeq: 0, strict: true })
          : []
        if (!messages.length) {
          const error = new Error(`the DSH session has no readable messages after importing ${imported} record(s)`)
          error.phase = 'verify'
          throw error
        }
        if (sessionIdBefore && seqBefore > 0) {
          const seqAfter = await dshFacade.getSeq(targetId)
          if (Number(seqAfter) <= seqBefore) {
            const error = new Error(`the DSH session did not grow (${seqBefore} -> ${seqAfter} events) after importing ${imported} record(s)`)
            error.phase = 'verify'
            throw error
          }
        }
      }
      await rollback.verify(snapshot, {
        direction,
        transport,
        externalPath: binding.externalPath,
        expected,
        dshFacade,
        dshSessionId: binding.dshSessionIds[0],
      })

      await rollback.succeed(snapshot)
      state.lastSyncAt = Date.now()
      // Record what each side looked like at this moment, so the next
      // comparison is an exact "did it change?" rather than a timestamp
      // guess. Without this a real edit made just after a sync is invisible.
      const targetForMark = binding.dshSessionIds[0]
      if (targetForMark) {
        try {
          const marked = await inspectDshLog({ persistence, sessions: sessionStore, sessionId: targetForMark })
          if (marked?.lastTime) state.dshTimeAtSync = marked.lastTime
        } catch { /* the mark is an optimisation, not a requirement */ }
      }
      state.lastError = undefined
      state.lastFailure = undefined
      await saveState(state)
      dirty.delete(binding.id)
      return { id: binding.id, imported, written, direction, configured, comparison }
    } catch (error) {
      const outcome = rollback
        ? await rollback.fail(snapshot, error, context, { externalTransport: transport })
        : { failure: diagnoseFailure(error, context), report: undefined }
      const backupPaths = [snapshot?.external?.backupPath, snapshot?.dsh?.backupPath].filter(Boolean)
      const failure = {
        ...outcome.failure,
        backupPaths,
        restored: outcome.report?.restored,
        cleanup: outcome.report?.errors ?? [],
      }
      state.lastError = failure.reason
      state.lastFailure = failure
      await saveState(state)
      logger.warn?.(`[conversation-sync] ${binding.name}: ${failure.reason}`)
      // A failed sync often means the connection itself is gone; drop it so the
      // next attempt reconnects instead of retrying a dead socket forever.
      if (machine?.kind === 'ssh' && !failure?.reason?.match(/not found|does not exist|permission/i)) {
        discardTransport(machine)
      }
      return { id: binding.id, error: failure.reason, failure, direction, configured, comparison }
    }
  }

  /**
   * Read both sides' modification times.
   *
   * Deliberately cheap and read-only: one stat over the existing transport plus
   * the newest event time from the DSH log. Any failure degrades to 'unknown',
   * which makes the caller keep its configured direction instead of guessing.
   */
  const compareBindingSides = async (binding, state, transport) => {
    let externalMtimeMs
    let externalSize
    try {
      const stat = await transport.stat(binding.externalPath)
      externalMtimeMs = stat?.mtimeMs
      externalSize = stat?.size
    } catch {
      externalMtimeMs = undefined
      externalSize = undefined
    }
    let dshLastTime
    const sessionId = binding.dshSessionIds?.[0]
    if (sessionId) {
      try {
        const inspected = await inspectDshLog({ persistence, sessions: sessionStore, sessionId })
        dshLastTime = inspected?.lastTime
      } catch {
        dshLastTime = undefined
      }
    }
    return compareSides({
      externalMtimeMs,
      externalSize,
      externalPrevMtimeMs: state.externalMtimeMs,
      externalPrevSize: state.externalSize,
      dshLastTime,
      dshTimeAtSync: state.dshTimeAtSync,
      lastSyncAt: state.lastSyncAt,
      direction: binding.direction,
    })
  }

  const syncAll = async (forced = false, direction) => {
    const results = []
    for (const binding of allBindings()) {
      // `checked` is the per-row gate the panel shows: an unchecked binding is
      // parked, not deleted, and never syncs — not on a poll, and not on a bulk
      // "sync everything" either. Only pressing that row's own button syncs it
      // (that path calls syncBinding directly, not this function).
      if (binding.checked === false) continue
      if (forced || (binding.enabled && binding.autoSync)) {
        // The direction has to be passed through: without it every binding falls
        // back to its own stored direction, so "sync out" from the UI silently
        // ran an import instead.
        results.push(await syncBinding(binding, forced, direction))
        // Yield between bindings so SSH polling cannot starve the UI/agent loop.
        await new Promise(resolve => setImmediate(resolve))
      }
    }
    return results
  }

  // -------------------------------------------------------------- discovery

  const scanMachineInto = async machine => {
    try {
      // Kept open between ticks: a scan should not pay for a fresh SSH
      // handshake every 30 seconds.
      const result = await withPooledTransport(machine, undefined, transport => scanMachine(machine, { transport }))
      return { machineId: machine.id, sessions: result.sessions, errors: result.errors }
    } catch (error) {
      const message = String(error?.message ?? error)
      const errors = [message]
      if (/no SSH private key|cannot read the SSH private key|credential/i.test(message)) {
        errors.push(
          `save the private-key PATH for this machine (credential ${refFor(machine)}), ` +
          `or add 'IdentityFile' for it in ~/.ssh/config`,
        )
      }
      return { machineId: machine.id, sessions: [], errors }
    }
  }

  /**
   * Scan every machine, a few at a time.
   *
   * One-at-a-time was a real problem: with twelve hosts, three of which are
   * unreachable, a scan spent over a minute in connect timeouts before the
   * panel learned anything about the reachable ones. Running four at once
   * bounds that, and an unreachable host now costs 8 seconds rather than 15.
   */
  const scanExternal = async force => {
    // A scan already in flight is awaited rather than reported as "no sessions":
    // returning the empty initial cache made the panel show every machine as
    // empty until the scan happened to finish.
    if (scanning) return activeScan ?? externalCache
    if (!force && Date.now() - externalCache.at < SCAN_TTL_MS) return externalCache
    scanning = true
    activeScan = (async () => {
      const byMachine = {}
      const errors = {}
      const results = await mapLimit(machinesCache.machines, 4, scanMachineInto)
      for (const result of results) {
        if (!result) continue
        byMachine[result.machineId] = result.sessions
        if (result.errors.length) errors[result.machineId] = result.errors
      }
      externalCache = { at: Date.now(), byMachine, errors, dsh: await listDshSessions({ persistence, sessions: sessionStore, logger }) }
      return externalCache
    })()
    try {
      return await activeScan
    } finally {
      scanning = false
      activeScan = null
    }
  }

  // What key each machine will actually use, so the panel can show the path
  // instead of a bare "not configured". Falls back to IdentityFile and then to
  // the conventional ~/.ssh defaults, matching what the transport does.
  const keyPaths = async () => {
    const result = {}
    for (const machine of machinesCache.machines) {
      if (machine.kind !== 'ssh') continue
      try {
        result[machine.id] = (await previewKeyPath(machine, ctx.credentials)) ?? ''
      } catch {
        result[machine.id] = ''
      }
    }
    return result
  }

  // ---------------------------------------------------------------- startup

  await ctx.effect(async () => {
    storage = await ctx.storageDomain.open(domain)
    bindingsTable = storage.table('bindings')
    statesTable = storage.table('states')
    await refreshMachines()
    // Sessions imported by versions that made one workspace per machine live
    // under those old directories. Move them into the single sync workspace so
    // the user's storage is one folder, as asked - and so the old workspaces can
    // be emptied. Runs before the first scan, is idempotent, and never throws.
    try {
      const migration = await migrateIntoSyncWorkspace({
        dshHome: DSH_HOME,
        ownedRoot: WORKSPACE_ROOT,
        syncDir: SYNC_WORKSPACE_DIR,
        logger,
      })
      if (migration.moved.length) {
        logger.info?.(`[conversation-sync] moved ${migration.moved.length} imported session(s) into ${SYNC_WORKSPACE_DIR}`)
        // Moving the files is not enough: a session only appears in a workspace
        // whose record lists it, so an un-attached migration would leave the
        // session on disk and invisible in the UI. Attach each one now.
        try {
          await localTransport.mkdir(SYNC_WORKSPACE_DIR)
          const ws = await workspaces.create(SYNC_WORKSPACE_DIR, SYNC_WORKSPACE_TITLE)
          for (const item of migration.moved) {
            try {
              await ws.attachSession(item.sessionId)
            } catch (error) {
              logger.warn?.(`[conversation-sync] could not attach migrated session ${item.sessionId}: ${String(error?.message ?? error)}`)
            }
          }
        } catch (error) {
          logger.warn?.(`[conversation-sync] could not register the sync workspace: ${String(error?.message ?? error)}`)
        }
      }
      for (const failure of migration.errors) {
        logger.warn?.(`[conversation-sync] could not move session ${failure.sessionId}: ${failure.error}`)
      }
    } catch (error) {
      logger.warn?.(`[conversation-sync] session migration failed: ${String(error?.message ?? error)}`)
    }
    void scanExternal(true)
    return () => {
      // Pooled SSH connections outlive the request that opened them, so they
      // must be closed explicitly when the plugin is reloaded or removed.
      discardTransport()
      storage?.close?.()
    }
  }, 'conversation-sync/storage')

  await ctx.effect(() => {
    const tick = async () => {
      if (syncing || !bindingsTable) return
      syncing = true
      try {
        for (const binding of allBindings()) {
          if (binding.checked === false) continue
          if (!binding.enabled || !binding.autoSync) continue
          const now = Date.now()
          const due = now - (lastPoll.get(binding.id) ?? 0) >= (binding.pollMs ?? 2000)
          if (!dirty.has(binding.id) && !due) continue
          lastPoll.set(binding.id, now)
          await syncBinding(binding)
          await new Promise(resolve => setImmediate(resolve))
        }
      } catch (error) {
        logger.warn?.(`[conversation-sync] poll: ${error?.message ?? error}`)
      } finally {
        syncing = false
      }
    }
    const timer = ctx.interval(() => { void tick() }, settings.pollIntervalMs)
    void tick()
    return () => timer?.()
  }, 'conversation-sync/poll')

  await ctx.effect(() => {
    const timer = ctx.interval(() => { void scanExternal(false) }, SCAN_INTERVAL_MS)
    return () => timer?.()
  }, 'conversation-sync/scan-timer')

  ctx.on('session/event', (session, event) => {
    if (!MESSAGE_TYPES.has(event?.type)) return
    for (const binding of bindingsTable ? allBindings() : []) {
      if (binding.dshSessionIds.includes(session?.id)) dirty.add(binding.id)
    }
  })

  // ------------------------------------------------------------- HTTP routes

  const rpc = async request => {
    const body = await request.json().catch(() => ({}))
    const action = body?.action
    if (!bindingsTable && action !== 'status') return Response.json({ error: 'not ready' }, { status: 503 })

    switch (action) {
      case 'status':
        return Response.json({ ready: !!bindingsTable, syncing, scanning, bindings: bindingsTable ? allBindings().length : 0 })

      case 'machines':
        // Re-read ~/.ssh/config on demand: a host added to it should show up
        // without restarting DSH, and the panel refreshes this list every few
        // seconds anyway.
        if (body.refresh) await refreshMachines()
        return Response.json({ machines: machinesCache.machines, warnings: machinesCache.warnings, keys: await keyPaths() })

      case 'sessions': {
        const cache = await scanExternal(!!body.force)
        // The panel groups the DSH side by workspace, and a session cannot name
        // its profile (the header has no such field), so the workspace list is
        // the only honest first level. `sessionIds` comes back already filtered
        // by cwd equality inside the registry.
        let workspaceList = []
        try {
          workspaceList = (workspaces.list?.() ?? []).map(workspace => ({
            id: String(workspace.id ?? workspace.workspaceId ?? ''),
            path: workspace.path,
            title: workspace.title,
            sessionIds: [...(workspace.sessionIds ?? [])],
          }))
        } catch (error) {
          logger.warn?.(`[conversation-sync] cannot list workspaces: ${error?.message ?? error}`)
        }
        return Response.json({
          dsh: cache.dsh,
          external: cache.byMachine,
          errors: cache.errors,
          warnings: machinesCache.warnings,
          workspaces: workspaceList,
          at: cache.at,
        })
      }

      case 'bindings': {
        const list = allBindings()
        // Which side is newer, per binding, so the panel can say so before the
        // user presses anything. A failure here must not fail the listing: an
        // unreachable machine just reports no comparison.
        const comparisons = {}
        await Promise.all(list.map(async binding => {
          const machine = machineById(binding.machineId)
          if (!machine) return
          try {
            const transport = await pooledTransport(machine, binding.keyRef)
            comparisons[binding.id] = await compareBindingSides(binding, getState(binding.id), transport)
          } catch {
            comparisons[binding.id] = { newer: 'unknown', direction: 'both', reason: 'the machine could not be reached' }
          }
        }))
        return Response.json({
          bindings: list,
          states: [...statesTable.entries()].map(([, value]) => value),
          comparisons,
        })
      }

      case 'preferences':
        return Response.json({ preferences: await readPreferences() })

      case 'setPreferences': {
        const current = await readPreferences()
        const next = {
          sidebarEntry: body.sidebarEntry === undefined ? current.sidebarEntry : body.sidebarEntry !== false,
          settingsEntry: body.settingsEntry === undefined ? current.settingsEntry : body.settingsEntry !== false,
        }
        await writePreferences(next)
        return Response.json({ preferences: next })
      }

      case 'setKey': {
        const machineId = String(body.machineId ?? '')
        const machine = machineById(machineId)
        if (!machine || machine.kind !== 'ssh') return Response.json({ error: 'unknown SSH machine' }, { status: 404 })
        const value = String(body.path ?? '')
        if (!value) return Response.json({ error: 'private-key path is required' }, { status: 400 })
        const ref = refFor(machine)
        // The credentials store brand-checks names and validates its whole file
        // on load, so writing an out-of-grammar name here does not fail the
        // call — it fails the NEXT launch of DSH. Refuse instead.
        if (!isValidKeyRef(ref)) {
          return Response.json({ error: `refusing to save under the invalid credential name "${ref}"` }, { status: 500 })
        }
        await ctx.credentials.set(ref, value)
        externalCache.at = 0
        return Response.json({ ok: true, ref: refFor(machine) })
      }

      case 'pair': {
        const raw = body.binding ?? {}
        const binding = bindingSchema.parse({
          ...raw,
          id: raw.id || `bnd-${randomUUID()}`,
          name: raw.name || raw.externalPath || 'Untitled binding',
        })
        if (!binding.externalPath) return Response.json({ error: 'an external path is required' }, { status: 400 })
        if (!binding.dshSessionIds.length && binding.direction === 'out') {
          return Response.json({ error: 'select a DSH session on the left to export' }, { status: 400 })
        }
        await bindingsTable.put(binding.id, binding)
        const state = getState(binding.id)
        await saveState(state)
        const result = await syncBinding(binding, true)
        // A pairing that produced nothing is not a binding the user wants to
        // keep: leave it out of the list so a failed first sync does not add a
        // dead row that has to be removed by hand.
        if (result?.error && !getBinding(binding.id)?.dshSessionIds?.length) {
          await bindingsTable.delete(binding.id)
          await statesTable.delete(binding.id)
          dirty.delete(binding.id)
          return Response.json({ result })
        }
        return Response.json({ binding: getBinding(binding.id), result })
      }

      case 'setBinding': {
        const id = String(body.id ?? '')
        const binding = getBinding(id)
        if (!binding) return Response.json({ error: 'binding not found' }, { status: 404 })
        const next = { ...binding }
        if (body.checked !== undefined) next.checked = body.checked !== false
        if (body.autoSync !== undefined) next.autoSync = body.autoSync === true
        if (body.direction !== undefined) {
          if (!DIRECTIONS.includes(body.direction)) {
            return Response.json({ error: `unknown direction: ${body.direction}` }, { status: 400 })
          }
          next.direction = body.direction
        }
        if (body.enabled !== undefined) next.enabled = body.enabled !== false
        await bindingsTable.put(id, next)
        if (next.checked === false) dirty.delete(id)
        return Response.json({ binding: getBinding(id) })
      }

      case 'unbind': {
        const id = String(body.id ?? '')
        await bindingsTable.delete(id)
        await statesTable.delete(id)
        dirty.delete(id)
        return Response.json({ ok: true })
      }

      case 'sync': {
        if (body.id) {
          const binding = getBinding(String(body.id))
          if (!binding) return Response.json({ error: 'binding not found' }, { status: 404 })
          return Response.json({ results: [await syncBinding(binding, true, body.direction)] })
        }
        return Response.json({ results: await syncAll(true, body.direction) })
      }

      default:
        return Response.json({ error: `unknown action: ${action}` }, { status: 400 })
    }
  }

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/conversation-sync/rpc',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: rpc,
  }), 'conversation-sync/http')
}
