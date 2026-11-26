/**
 * Build DSH v4 session events from normalized external records. Only event
 * types from dsh-session's KNOWN_SESSION_EVENT_TYPES are used; surface events
 * carry surfaceOp:'append', and seq/time follow the shipped importer exactly.
 */

const textBlocks = text => [{ type: 'text', text: text || '' }]

function messageId(createId) {
  return createId()
}

/** Build a contiguous run of events with monotonically non-decreasing time. */
export class EventBuilder {
  constructor({ startSeq = 0, startTime = 0, createId }) {
    this.events = []
    this.seq = startSeq
    this.time = startTime
    this.createId = createId
    this.firstTurn = true
  }

  add(event, time) {
    if (typeof time === 'number' && Number.isFinite(time)) this.time = Math.max(this.time, time)
    this.events.push({ ...event, seq: this.seq++, time: this.time })
  }

  /** One DSH turn: system head (first turn only), user message, assistant message. */
  turn({ user, assistant, turn, ts }) {
    this.add({ type: 'turn/start', data: { turn } }, ts)
    const step = 1
    this.add({ type: 'step/start', data: { turn, step } }, ts)
    if (this.firstTurn) {
      this.firstTurn = false
      this.add({
        type: 'system/message',
        data: { turn, step, message: { id: messageId(this.createId), role: 'system', content: [], source: { kind: 'system-prompt' } } },
        surfaceOp: 'append',
      }, ts)
    }
    this.add({
      type: 'user/message',
      data: { id: messageId(this.createId), role: 'user', content: textBlocks(user?.text), source: { kind: 'user' } },
      surfaceOp: 'append',
    }, ts)
    if (assistant) {
      this.add({
        type: 'assistant/message',
        data: {
          turn, step,
          message: { id: messageId(this.createId), role: 'assistant', content: textBlocks(assistant.text), source: { kind: 'model', provider: 'import', model: 'imported' } },
          stream: [],
        },
        surfaceOp: 'append',
      }, assistant.ts)
    }
    this.add({ type: 'step/end', data: { turn, step } }, assistant?.ts ?? ts)
    this.add({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } }, assistant?.ts ?? ts)
  }

  get nextSeq() { return this.seq }
}

/** Pair user records with the following assistant record (if any). */
export function pairTurns(records) {
  const turns = []
  let pending = undefined
  for (const record of records) {
    if (record.role === 'user' || record.role === 'tool' || record.role === 'system') {
      if (pending) turns.push({ user: pending.user, assistant: undefined, ts: pending.ts })
      pending = { user: record, ts: record.ts }
    } else if (record.role === 'assistant') {
      if (pending) {
        turns.push({ user: pending.user, assistant: record, ts: pending.ts })
        pending = undefined
      } else {
        turns.push({ user: { text: '', role: 'user' }, assistant: record, ts: record.ts })
      }
    }
  }
  if (pending) turns.push({ user: pending.user, assistant: undefined, ts: pending.ts })
  return turns
}

export function buildEvents(records, { startSeq = 0, startTime = 0, startTurn = 1, createId }) {
  const builder = new EventBuilder({ startSeq, startTime, createId })
  let turn = startTurn
  for (const paired of pairTurns(records)) {
    builder.turn({ ...paired, turn: turn++ })
  }
  return builder.events
}

/** Extract conversation messages from a DSH event log for reverse sync. */
export function messagesFromEvents(events) {
  const messages = []
  for (const event of events) {
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
    const message = event.data?.message ?? event.data
    if (!message || message.role === 'system' || message.role === 'developer') continue
    const blocks = Array.isArray(message.content) ? message.content : []
    const text = blocks.map(block => block?.type === 'text' ? block.text : '').filter(Boolean).join('\n')
    if (!text) continue
    messages.push({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      text,
      ts: event.time,
      seq: event.seq,
    })
  }
  return messages
}

/** Convert a DSH event into tuple form for a live Session.append(inputs). */
export function toLiveInput(event) {
  const input = [event.type, event.data]
  if (event.surfaceOp) input.push({ surfaceOp: event.surfaceOp })
  return input
}
