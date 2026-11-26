import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import Schema from '@deepseek-ai/schemastery'
import { LocalTransport, transportForMachine, previewKeyPath } from './lib/transports.js'
import { createTransportPool, mapLimit } from './lib/pool.js'
import { readJsonlDelta, renderExternalLine, parseDeepSeekExport } from './lib/adapters.js'
import { buildEvents, toLiveInput } from './lib/events.js'
import { discoverMachines } from './lib/sshconfig.js'
import { createHostKeyGuard } from './lib/hostkey.js'
import { scanMachine } from './lib/discovery.js'
import { listDshSessions, readDshSessionMessages, dshSessionExists } from './lib/dsh-sessions.js'
import { SyncRollback, diagnoseFailure } from './lib/rollback.js'

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
const DIRECTIONS = ['in', 'out', 'both']
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
  autoSync: z.boolean().default(true),
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
  const keyRefFor = machine => `conversation-sync/ssh-key/${machine.id}`

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

  const ensureWorkspace = async (binding, state) => {
    if (state.workspaceId && workspaces.get(state.workspaceId)) return state.workspaceId
    const dir = path.join(WORKSPACE_ROOT, safeId(binding.machineId))
    await localTransport.mkdir(dir)
    const label = machineById(binding.machineId)?.label ?? binding.machineId
    const ws = await workspaces.create(dir, `会话同步 · ${label}`)
    state.workspaceId = ws.id
    await saveState(state)
    return ws.id
  }

  /** Materialize a brand-new DSH session from normalized records. */
  const createSession = async (binding, state, records, title) => {
    const id = `conversation-${randomUUID()}`
    const header = {
      version: 4,
      id,
      createdAt: records.find(record => record.ts)?.ts ?? Date.now(),
      cwd: path.join(WORKSPACE_ROOT, safeId(binding.machineId)),
      isSeeded: false,
    }
    const events = buildEvents(records, { createId: randomUUID })
    if (title) {
      events.push({
        type: 'session/title',
        data: { title, messageSeqs: [], source: { kind: 'user' } },
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
    await ensureWorkspace(binding, state)
    await workspaces.get(state.workspaceId)?.attachSession(id)
    return { id, lastSeq: events.length }
  }

  /** Append events to an existing imported session (live first, persistence second). */
  const appendSession = async (sessionId, records, startSeq) => {
    const events = buildEvents(records, { startSeq, createId: randomUUID })
    if (!events.length) return startSeq
    const live = sessionStore.get(sessionId)
    if (live) {
      live.append(events.map(toLiveInput))
      await sessionStore.flush(live)
      return startSeq + events.length
    }
    const stat = await persistence.stat(sessionId)
    const seq = stat?.eventCount ?? startSeq
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
    getSeq: async sessionId => {
      const live = sessionStore.get(sessionId)
      if (live) return live.log?.length ?? 0
      const stat = await persistence.stat(sessionId)
      return stat?.eventCount ?? 0
    },
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
    if (!content) return 0
    const statBefore = await transport.stat(binding.externalPath)
    if (!statBefore) await transport.mkdir(dirOf(machine, binding.externalPath))
    await transport.write(binding.externalPath, (statBefore ? await transport.read(binding.externalPath) : Buffer.alloc(0)).toString('utf8') + content)
    const stat = await transport.stat(binding.externalPath)
    state.externalSize = stat?.size
    state.externalMtimeMs = stat?.mtimeMs
    return written
  }

  const syncBinding = async (binding, forced = false, directionOverride) => {
    const state = getState(binding.id)
    const machine = machineById(binding.machineId)
    const direction = directionOverride ?? binding.direction
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
    try {
      // Pooled: syncing the same machine again (the common case, every poll)
      // must not pay for another SSH handshake.
      transport = await pooledTransport(machine, binding.keyRef)
      rollback = new SyncRollback({ logger })
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
      if (direction === 'in' || direction === 'both') imported = await syncIn(binding, state, transport)
      if (direction === 'out' || direction === 'both') written = await syncOut(binding, state, transport, machine ?? { kind: 'local' })

      await rollback.succeed(snapshot)
      state.lastSyncAt = Date.now()
      state.lastError = undefined
      state.lastFailure = undefined
      await saveState(state)
      dirty.delete(binding.id)
      return { id: binding.id, imported, written, direction }
    } catch (error) {
      const outcome = rollback
        ? await rollback.fail(snapshot, error, context, { externalTransport: transport })
        : { failure: diagnoseFailure(error, context), report: undefined }
      const failure = {
        ...outcome.failure,
        backupPaths: snapshot?.external?.backupPath ? [snapshot.external.backupPath] : [],
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
      return { id: binding.id, error: failure.reason, failure, direction }
    }
  }

  const syncAll = async (forced = false, direction) => {
    const results = []
    for (const binding of allBindings()) {
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
          `save the private-key PATH for this machine (credential ${keyRefFor(machine)}), ` +
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
        return Response.json({ dsh: cache.dsh, external: cache.byMachine, errors: cache.errors, warnings: machinesCache.warnings, at: cache.at })
      }

      case 'bindings':
        return Response.json({ bindings: allBindings(), states: [...statesTable.entries()].map(([, value]) => value) })

      case 'setKey': {
        const machineId = String(body.machineId ?? '')
        const machine = machineById(machineId)
        if (!machine || machine.kind !== 'ssh') return Response.json({ error: 'unknown SSH machine' }, { status: 404 })
        const value = String(body.path ?? '')
        if (!value) return Response.json({ error: 'private-key path is required' }, { status: 400 })
        await ctx.credentials.set(keyRefFor(machine), value)
        externalCache.at = 0
        return Response.json({ ok: true, ref: keyRefFor(machine) })
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
        return Response.json({ binding: getBinding(binding.id), result })
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
