import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { createTransport } from './lib/transports.js'
import { readJsonlDelta, renderExternalLine, parseDeepSeekExport } from './lib/adapters.js'
import { buildEvents, messagesFromEvents, toLiveInput } from './lib/events.js'

export const name = 'dsh-conversation-sync'
export const inject = ['connection', 'credentials', 'sessionPersistence', 'sessionProjectionCache', 'workspaceRegistry', 'sessions', 'storageDomain']

const NS = 'conversation-sync'
const ROOT = path.join(os.homedir(), '.dsh', 'conversation-sync')
const WORKSPACE_ROOT = path.join(ROOT, 'workspaces')
const BACKUP_ROOT = path.join(ROOT, 'backups')
const KINDS = ['claude', 'codex', 'jsonl', 'deepseekExport']
const MESSAGE_TYPES = new Set(['user/message', 'assistant/message'])

const sourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(KINDS),
  remote: z.boolean().default(false),
  path: z.string(),
  sshHost: z.string().optional(),
  sshUser: z.string().optional(),
  sshPort: z.number().optional(),
  sshKeyRef: z.string().optional(),
  pollMs: z.number().optional(),
  autoSync: z.boolean().default(true),
  writeBack: z.boolean().default(true),
  enabled: z.boolean().default(true),
})

const stateSchema = z.object({
  sourceId: z.string(),
  cursor: z.object({ offset: z.number(), pending: z.string() }).optional(),
  sessionId: z.string().optional(),
  sessionIds: z.array(z.string()).optional(),
  importedIds: z.array(z.string()).optional(),
  lastSeq: z.number().optional(),
  dshSeq: z.number().optional(),
  fileSize: z.number().optional(),
  fileMtimeMs: z.number().optional(),
  workspaceId: z.string().optional(),
  lastSyncAt: z.number().optional(),
  lastError: z.string().optional(),
})

const domain = {
  name: 'conversation_sync',
  version: 1,
  tables: {
    sources: { valueSchema: sourceSchema },
    states: { valueSchema: stateSchema },
  },
}

function safeId(value) {
  return String(value).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function apply(ctx) {
  const logger = ctx.logger ?? console
  const sessionStore = ctx.sessions
  const persistence = ctx.sessionPersistence
  const workspaces = ctx.workspaceRegistry
  const projectionCache = ctx.get('sessionProjectionCache')
  let storage
  let sourcesTable
  let statesTable
  const reverse = new Map() // DSH session id -> source id
  const dirty = new Set() // source ids needing write-back
  let syncing = false

  const refreshReverse = () => {
    reverse.clear()
    for (const [, state] of statesTable.entries()) {
      for (const id of [state.sessionId, ...(state.sessionIds ?? [])].filter(Boolean)) {
        reverse.set(id, state.sourceId)
      }
    }
  }

  const getState = id => statesTable.get(id) ?? { sourceId: id }
  const saveState = state => statesTable.put(state.sourceId, state)
  const getSource = id => sourcesTable.get(id)

  // -------------------------------------------------------- session helpers

  const ensureWorkspace = async (source, state) => {
    if (state.workspaceId && workspaces.get(state.workspaceId)) return state.workspaceId
    const dir = path.join(WORKSPACE_ROOT, `${safeId(source.kind)}-${safeId(source.id)}`)
    await (await createTransport({ remote: false }, ctx.credentials, logger)).mkdir(dir)
    const ws = await workspaces.create(dir, `会话导入 · ${source.name}`)
    state.workspaceId = ws.id
    await saveState(state)
    return ws.id
  }

  /** Materialize a brand-new DSH session from normalized records. */
  const createSession = async (source, state, records, title) => {
    const id = `conversation-${randomUUID()}`
    const header = {
      version: 4,
      id,
      createdAt: records.find(r => r.ts)?.ts ?? Date.now(),
      cwd: path.join(WORKSPACE_ROOT, `${safeId(source.kind)}-${safeId(source.id)}`),
      isSeeded: false,
    }
    const events = buildEvents(records, { createId: randomUUID })
    if (title) {
      // dsh-session-title reads this log-only event. Emit it into the log so the
      // title persists even though this session is not a live store session.
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
    await ensureWorkspace(source, state)
    await workspaces.get(state.workspaceId).attachSession(id)
    return { id, lastSeq: events.length }
  }

  /** Append events to an existing imported session (live first, then persistence). */
  const appendSession = async (sessionId, records, startSeq) => {
    const events = buildEvents(records, { startSeq, createId: randomUUID })
    if (!events.length) return startSeq
    const live = sessionStore.get(sessionId)
    if (live) {
      // Batch append so observers see all events of a turn together, preserving
      // tool/call -> tool/result sourceEventSeqs references.
      live.append(events.map(toLiveInput))
      await sessionStore.flush(live)
      return startSeq + events.length
    }
    const stat = await persistence.stat(sessionId)
    const seq = stat?.eventCount ?? startSeq
    // Rebase seq AND sourceEventSeqs if the persisted next-seq differs from
    // the watermark we built against, keeping tool/call references valid.
    const shift = seq - startSeq
    const ready = events.map((event, index) => ({
      ...event,
      seq: startSeq + index + shift,
      ...(event.sourceEventSeqs ? { sourceEventSeqs: event.sourceEventSeqs.map(s => s + shift) } : {}),
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

  /** Read DSH-origin messages from a session above a seq watermark. */
  const readDshMessages = async (sessionId, fromSeq) => {
    const live = sessionStore.get(sessionId)
    if (live) {
      const log = live.log ?? []
      return log.filter(event => event.seq > fromSeq && MESSAGE_TYPES.has(event.type))
    }
    try {
      const handle = await persistence.open(sessionId, 'read')
      try {
        const { events } = await handle.read(Math.max(0, fromSeq))
        return (events ?? []).filter(event => event.seq > fromSeq && MESSAGE_TYPES.has(event.type))
      } finally {
        await handle.close()
      }
    } catch {
      return []
    }
  }

  // ------------------------------------------------------------ sync engine

  const syncJsonlSource = async (source, state, transport) => {
    const file = source.path
    const delta = await readJsonlDelta(transport, file, source.kind, state.cursor)
    if (delta.absent) {
      const stat = await transport.stat(file)
      if (!stat) throw new Error(`source file not found: ${file}`)
    }
    if (!state.sessionId) {
      const created = await createSession(source, state, delta.records, source.name)
      state.sessionId = created.id
      state.lastSeq = created.lastSeq
      state.dshSeq = created.lastSeq
    } else if (delta.records.length) {
      state.lastSeq = await appendSession(state.sessionId, delta.records, state.lastSeq ?? 0)
    }
    state.cursor = delta.cursor
    const stat = await transport.stat(file)
    state.fileSize = stat?.size
    state.fileMtimeMs = stat?.mtimeMs
    return delta.records.length
  }

  const syncDeepSeekExport = async (source, state, transport) => {
    const stat = await transport.stat(source.path)
    if (!stat) throw new Error(`export file not found: ${source.path}`)
    if (state.fileSize === stat.size && state.fileMtimeMs === stat.mtimeMs) return 0
    const bytes = await transport.read(source.path)
    const sessions = await parseDeepSeekExport(bytes, randomUUID)
    state.sessionIds = state.sessionIds ?? []
    state.importedIds = state.importedIds ?? []
    let imported = 0
    for (const session of sessions) {
      if (state.importedIds.includes(session.id)) continue
      const records = session.records
      if (!records.length) continue
      const created = await createSession(source, state, records, session.title ?? source.name)
      state.sessionIds.push(created.id)
      state.importedIds.push(session.id)
      imported++
    }
    state.fileSize = stat.size
    state.fileMtimeMs = stat.mtimeMs
    return imported
  }

  const writeBack = async (source, state, transport) => {
    if (source.kind === 'deepseekExport' || !source.writeBack || !state.sessionId) return 0
    const ids = [state.sessionId, ...(state.sessionIds ?? [])].filter(Boolean)
    let written = 0
    for (const sessionId of ids) {
      const fromSeq = state.dshSeq ?? 0
      const events = await readDshMessages(sessionId, fromSeq)
      if (!events.length) continue
      let content = ''
      for (const event of events) {
        const message = event.data?.message ?? event.data
        const blocks = Array.isArray(message?.content) ? message.content : []
        const text = blocks.map(block => block?.type === 'text' ? block.text : '').filter(Boolean).join('\n')
        if (!text) continue
        const role = message.role === 'assistant' ? 'assistant' : 'user'
        const syncId = `dsh:${sessionId}:${event.seq}`
        content += renderExternalLine(source.kind, { role, text, ts: event.time }, syncId)
      }
      if (!content) continue
      const backup = path.join(BACKUP_ROOT, `${safeId(source.id)}`, `${Date.now()}-${path.basename(source.path)}`)
      await transport.copyToBackup(source.path, backup)
      await transport.append(source.path, content)
      state.dshSeq = Math.max(state.dshSeq ?? 0, ...events.map(event => event.seq))
      written += events.length
    }
    return written
  }

  const syncSource = async (source, forced = false) => {
    const state = getState(source.id)
    try {
      const transport = await createTransport(source, ctx.credentials, logger)
      try {
        let count = 0
        if (source.kind === 'deepseekExport') {
          count = await syncDeepSeekExport(source, state, transport)
        } else {
          count = await syncJsonlSource(source, state, transport)
        }
        const written = dirty.has(source.id) || forced ? await writeBack(source, state, transport) : 0
        state.lastSyncAt = Date.now()
        state.lastError = undefined
        await saveState(state)
        dirty.delete(source.id)
        refreshReverse()
        return { id: source.id, imported: count, written }
      } finally {
        transport.close?.()
      }
    } catch (error) {
      state.lastError = String(error?.message ?? error)
      await saveState(state)
      logger.warn?.(`[conversation-sync] ${source.name}: ${state.lastError}`)
      return { id: source.id, error: state.lastError }
    }
  }

  const syncAll = async (forced = false) => {
    const results = []
    for (const source of sourcesTable.entries()) {
      if (forced || (source[1].enabled && source[1].autoSync)) {
        results.push(await syncSource(source[1], forced))
        // Yield to the event loop between sources so remote SSH polling of
        // many sources cannot starve the UI/agent loop (pattern from
        // dsh-plugin-codex-import).
        await new Promise(resolve => setImmediate(resolve))
      }
    }
    return results
  }

  // ---------------------------------------------------------------- startup

  await ctx.effect(async () => {
    storage = await ctx.storageDomain.open(domain)
    sourcesTable = storage.table('sources')
    statesTable = storage.table('states')
    refreshReverse()
    return () => storage?.close?.()
  }, 'conversation-sync/storage')

  await ctx.effect(() => {
    const tick = async () => {
      if (syncing) return
      syncing = true
      try { await syncAll() } catch (error) { logger.warn?.(`[conversation-sync] tick: ${error.message}`) }
      finally { syncing = false }
    }
    const timer = ctx.interval(() => { void tick() }, 2000)
    // Immediate first pass unless the caller wants to wait.
    void tick()
    return () => timer?.()
  }, 'conversation-sync/poll')

  ctx.on('session/event', (session, event) => {
    const sourceId = reverse.get(session?.id)
    if (sourceId && MESSAGE_TYPES.has(event?.type)) dirty.add(sourceId)
  })

  // ------------------------------------------------------------- HTTP routes

  const rpc = async request => {
    const body = await request.json()
    const action = body?.action
    if (!sourcesTable) return Response.json({ error: 'not ready' }, { status: 503 })
    switch (action) {
      case 'list':
        return Response.json({
          sources: [...sourcesTable.entries()].map(([, source]) => source),
          states: [...statesTable.entries()].map(([, state]) => state),
        })
      case 'save': {
        const parsed = sourceSchema.parse(body.source)
        await sourcesTable.put(parsed.id, parsed)
        const state = getState(parsed.id)
        if (!state.workspaceId) {
          await ensureWorkspace(parsed, state)
        }
        await saveState(state)
        refreshReverse()
        void syncSource(parsed, true)
        return Response.json({ ok: true, source: parsed })
      }
      case 'remove': {
        const id = String(body.id ?? '')
        await sourcesTable.delete(id)
        await statesTable.delete(id)
        refreshReverse()
        return Response.json({ ok: true })
      }
      case 'sync': {
        if (body.id) {
          const source = getSource(String(body.id))
          if (!source) return Response.json({ error: 'source not found' }, { status: 404 })
          return Response.json({ results: [await syncSource(source, true)] })
        }
        return Response.json({ results: await syncAll(true) })
      }
      case 'status':
        return Response.json({ ready: true, dirty: [...dirty], syncing })
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
