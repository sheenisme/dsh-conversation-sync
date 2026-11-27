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
 * Exact event count of a stored session, derived from its LOG.
 *
 * `persistence.stat().eventCount` is explicitly optional ("when the backend can
 * provide it cheaply"), and the JSONL backend reports 0 for a session created in
 * the same process before it has been re-scanned. Trusting it made an append
 * target seq 0 on a log that already held 13 events, which the backend rejected
 * with "append seq mismatch ... expected 13 at index 0, got 0".
 */
export async function inspectDshLog({ persistence, sessions, sessionId } = {}) {
  const live = sessions?.get?.(sessionId)
  if (live && Array.isArray(live.log)) {
    return { eventCount: live.log.length, nextTurn: nextTurnOf(live.log), lastTime: lastTimeOf(live.log) }
  }
  if (typeof persistence?.open !== 'function') return { eventCount: 0, nextTurn: 1, lastTime: undefined }
  const handle = await persistence.open(sessionId, 'read')
  try {
    let total = 0
    let nextTurn = 1
    let lastTime
    const page = 1000
    for (;;) {
      const result = await handle.read(total, page)
      const events = Array.isArray(result) ? result : (result?.events ?? [])
      nextTurn = nextTurnOf(events, nextTurn)
      lastTime = lastTimeOf(events, lastTime)
      total += events.length
      if (events.length < page) return { eventCount: total, nextTurn, lastTime }
    }
  } finally {
    await handle?.close?.()
  }
}

/**
 * Wall-clock time of the newest stored event.
 *
 * This is what "which side is newer" is decided on. Event time is a monotonic
 * stamp DSH assigns, and for a session that has never been touched it equals
 * the header's createdAt closely enough for a comparison; an empty session
 * reports undefined and the caller falls back to the header.
 */
function lastTimeOf(events, floor) {
  let newest = floor
  for (const event of events) {
    const time = Number(event?.time)
    if (Number.isFinite(time) && (newest === undefined || time > newest)) newest = time
  }
  return newest
}

/**
 * The turn number an appended batch must start at.
 *
 * Every event carries a `turn`; reusing one that already exists makes the
 * backend reject the append with `SessionFormatError: turn/start does not open
 * the expected turn`. Counting from 1 again on each append is exactly that bug,
 * so the next append starts after the highest turn already stored.
 */
function nextTurnOf(events, floor = 1) {
  let highest = floor - 1
  for (const event of events) {
    // The turn number lives in `data`, not on the event envelope: turn/start
    // carries `data.turn`, step/* carries `data.turn` and `data.step`.
    const turn = Number(event?.data?.turn ?? event?.turn)
    if (Number.isFinite(turn) && turn > highest) highest = turn
  }
  return highest + 1
}

/** Exact event count of a stored session, derived from its log. */
export async function countDshEvents(options = {}) {
  const { eventCount } = await inspectDshLog(options)
  return eventCount
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
    // `count` must always mean "messages", never raw events: a row with a
    // snapshot used to report eventCount (7 for one import) while a row read
    // from its log reported messages (1), so the same session showed two
    // different numbers. Always derive the message count from the log; the
    // snapshot count is only a fallback when the log cannot be read.
    let count
    let preview = ''
    let readError

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
        count = messageCount
      } catch (error) {
        // Keep the row with snapshot-only data when its log cannot be read.
        // Surface the reason on the row: a silent empty preview looks exactly
        // like an empty session, which sent me chasing a non-existent bug.
        readError = String(error?.message ?? error)
        if (count === undefined) count = item.eventCount
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
      ...(readError ? { readError } : {}),
      source: 'dsh',
    })
  }
  return rows
}

/**
 * Whether a DSH session exists. Used before an export so that a stale or typo'd
 * session id fails with a reason instead of silently writing nothing.
 */
export async function dshSessionExists({ persistence, sessions, sessionId } = {}) {
  const id = String(sessionId ?? '')
  if (!id) return false
  if (sessions?.get?.(id)) return true
  if (typeof persistence?.stat !== 'function') return false
  try {
    return !!(await persistence.stat(id))
  } catch {
    return false
  }
}

/**
 * Read user/assistant messages from a session, preferring the live store.
 * A failed read resolves to an empty array (a listing must not blow up because
 * one log is unreadable); pass `strict: true` to surface the error instead,
 * which is what an export needs - otherwise a missing session looks like a
 * successful sync that wrote nothing.
 */
export async function readDshSessionMessages({ persistence, sessions, sessionId, fromSeq = 0, strict = false } = {}) {
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
  } catch (error) {
    if (strict) throw error
    return []
  }
}
