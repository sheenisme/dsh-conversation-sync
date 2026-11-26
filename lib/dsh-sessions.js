/**
 * Enumerate DSH sessions for the conversation-sync source picker. Uses only
 * injected DSH services (persistence + live session store), no DSH imports.
 * Persisted snapshots carry the keys needed for sorting/limiting, so we sort
 * and cap BEFORE opening read handles: reading thousands of logs to render a
 * couple hundred rows would be needlessly slow.
 */

const MESSAGE_TYPES = new Set(['user/message', 'assistant/message'])

/** Resolve `event.data` (the Message itself, or `{ message: Message }`). */
function messageOf(data) {
  return data?.message ?? data
}

/**
 * Plain text from a DSH message. Returns null for roles that must be ignored
 * (system/developer/tool), otherwise the joined block text. Content may be a
 * string, or blocks of `{type:'text'|'reasoning', text}` / plain strings.
 */
function messageText(data) {
  const message = messageOf(data)
  if (!message) return null
  const role = message.role
  if (role && role !== 'user' && role !== 'assistant') return null
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block)
      continue
    }
    if ((block?.type === 'text' || block?.type === 'reasoning') && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

function firstLine(text) {
  return text.split('\n').find(line => line.trim())?.trim() || undefined
}

/**
 * Events for one session: live log when resident, otherwise a read handle.
 * When `end` is given we request at most `end - start` events (200 for preview).
 */
async function readEvents(id, { persistence, sessions }, start, end, preferLive = false) {
  const live = preferLive ? sessions?.get?.(id) : undefined
  if (live && Array.isArray(live.log)) {
    return end === undefined ? live.log.slice(start) : live.log.slice(start, end)
  }
  if (typeof persistence?.open !== 'function') return []
  const handle = await persistence.open(id, 'read')
  try {
    const result = end === undefined
      ? await handle.read(start)
      : await handle.read(start, end)
    return Array.isArray(result) ? result : (result?.events ?? [])
  } finally {
    await handle?.close?.()
  }
}

/**
 * List readable DSH sessions with a short preview and message count.
 * Sorts/limits snapshots first; only the chosen rows get a log read.
 */
export async function listDshSessions({ persistence, sessions, limit = 5000, previewLines = 3, logger } = {}) {
  if (typeof persistence?.list !== 'function') return []
  const listed = await persistence.list()
  const snapshots = Array.isArray(listed)
    ? listed
    : (listed && typeof listed[Symbol.iterator] === 'function' ? [...listed] : [])

  const basics = []
  for (const snapshot of snapshots) {
    const header = snapshot?.header ?? {}
    const id = String(snapshot?.id ?? header.id ?? '')
    if (!id) continue
    basics.push({
      id,
      createdAt: Number(header.createdAt) || 0,
      workspacePath: header.cwd || undefined,
      headerTitle: header.title || header.name || undefined,
      eventCount: snapshot?.eventCount,
    })
  }

  basics.sort((a, b) => b.createdAt - a.createdAt)
  const max = Number(limit)
  const candidates = max > 0 ? basics.slice(0, max) : []
  const rows = []

  for (const item of candidates) {
    let title = item.headerTitle
    let count = item.eventCount
    let preview = ''

    // Read only when a field is missing; a preview is usually the reason.
    if (!title || count === undefined || preview === '') {
      try {
        const events = await readEvents(item.id, { persistence, sessions }, 0, 200)
        let messageCount = 0
        const texts = []
        for (const event of events) {
          if (!MESSAGE_TYPES.has(event?.type)) continue
          const text = messageText(event.data)
          if (text === null) continue
          messageCount++
          if (text) texts.push(text)
        }
        preview = texts.slice(0, Math.max(0, Number(previewLines) || 0))
          .map(text => text.slice(0, 80))
          .join('\n')
          .slice(0, 240)
        if (!title) title = firstLine(preview)
        // Lower bound only: at most 200 events were read; a longer log may hold more.
        if (count === undefined) count = messageCount
      } catch (error) {
        // Keep the row with snapshot-only data when its log cannot be read.
        logger?.warn?.(`[conversation-sync] cannot read DSH session ${item.id}: ${error?.message ?? error}`)
      }
    }

    rows.push({
      id: item.id,
      title: title || 'Untitled session',
      createdAt: item.createdAt,
      ...(item.workspacePath ? { workspacePath: item.workspacePath } : {}),
      count,
      preview,
      source: 'dsh',
    })
  }
  return rows
}

/**
 * Read user/assistant messages from a session, preferring the live store.
 * Never throws: a failed read resolves to an empty array.
 */
export async function readDshSessionMessages({ persistence, sessions, sessionId, fromSeq = 0 } = {}) {
  try {
    const id = String(sessionId ?? '')
    if (!id) return []
    const start = Math.max(0, Number(fromSeq) || 0)
    const events = await readEvents(id, { persistence, sessions }, start, undefined, true)
    const messages = []
    for (const event of events ?? []) {
      if (!MESSAGE_TYPES.has(event?.type)) continue
      const seq = Number(event.seq) || 0
      if (seq < start) continue
      // Some logs omit `role`; the event type still determines it.
      let role = messageOf(event.data)?.role
      if (!role) role = event.type === 'assistant/message' ? 'assistant' : 'user'
      if (role !== 'user' && role !== 'assistant') continue
      const text = messageText(event.data)
      if (text === null) continue
      messages.push({ seq, time: event.time ?? 0, role, text })
    }
    messages.sort((a, b) => a.seq - b.seq)
    return messages
  } catch {
    return []
  }
}
