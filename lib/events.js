/**
 * Build DSH v4 session events from normalized external records. Only event
 * types from dsh-session's KNOWN_SESSION_EVENT_TYPES are used; surface events
 * carry surfaceOp:'append', and seq/time follow the shipped importer exactly.
 *
 * Tool calls/results are emitted as a real tool/call -> tool/result lifecycle
 * (paired by callId via sourceEventSeqs) rather than flattened into text, so a
 * resumed DSH session presents the model with a valid assistant/tool exchange.
 * Pattern follows the shipped dsh-deepseek-chat-import conversation builder.
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

  add(event, time, sourceEventSeqs) {
    if (typeof time === 'number' && Number.isFinite(time)) this.time = Math.max(this.time, time)
    const built = { ...event, seq: this.seq++, time: this.time }
    if (Array.isArray(sourceEventSeqs) && sourceEventSeqs.length) built.sourceEventSeqs = sourceEventSeqs
    this.events.push(built)
    return built
  }

  /**
   * One DSH turn: protected system head (first turn only), user message,
   * assistant message, paired tool calls/results, step/end, turn/end.
   */
  turn({ user, assistant, tools = [], turn, ts }) {
    this.add({ type: 'turn/start', data: { turn } }, ts)
    const step = 1
    this.add({ type: 'step/start', data: { turn, step } }, ts)
    if (this.firstTurn) {
      this.firstTurn = false
      // V4 shape rewrites this plugin source into kind:'system-prompt'; using
      // the V3 source shape keeps the protected head valid across migration.
      this.add({
        type: 'system/message',
        data: { turn, step, message: { id: messageId(this.createId), role: 'system', content: [], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' } } },
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

    // Collect structured tool calls: attached to the assistant record (Claude)
    // or emitted as their own records (Codex).
    const calls = [...(assistant?.meta?.calls ?? [])]
    const resultByCallId = new Map()
    const looseTools = []
    for (const tool of tools) {
      if (tool.meta?.call) {
        // Structured call (Codex function_call / custom_tool_call).
        calls.push(tool.meta.call)
      } else if (tool.meta?.callId && tool.role === 'tool') {
        // Structured result (Claude tool_result / Codex *_call_output).
        resultByCallId.set(tool.meta.callId, tool)
      } else {
        looseTools.push(tool)
      }
    }

    if (calls.length) {
      const callSeqs = []
      for (const call of calls) {
        const seq = this.add({
          type: 'tool/call',
          data: { turn, step, callId: call.id, name: call.name, arguments: call.arguments },
        }, ts)
        callSeqs.push(seq.seq)
      }
      // Every tool/call must close in the same step or resume/V4 migration
      // fails. Unanswered calls get an empty result rather than text.
      calls.forEach((call, index) => {
        const result = resultByCallId.get(call.id)
        const content = result ? (result.meta?.content ?? textBlocks(result.text)) : []
        this.add({
          type: 'tool/result',
          data: {
            turn, step,
            message: {
              id: messageId(this.createId),
              role: 'user',
              content: [{ type: 'tool-result', toolCallId: call.id, content, ...(result?.meta?.isError ? { isError: true } : {}) }],
              source: { kind: 'tool', callId: call.id },
            },
          },
          surfaceOp: 'append',
        }, result?.ts ?? ts, [callSeqs[index]])
      })
    }

    // Records without structured calls keep the legacy text fallback so no
    // content is lost for generic JSONL sources.
    for (const tool of looseTools) {
      this.add({
        type: 'user/message',
        data: { id: messageId(this.createId), role: 'user', content: textBlocks(tool.text), source: { kind: 'plugin', plugin: 'dsh-conversation-sync' } },
        surfaceOp: 'append',
      }, tool.ts)
    }

    this.add({ type: 'step/end', data: { turn, step } }, assistant?.ts ?? ts)
    this.add({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } }, assistant?.ts ?? ts)
  }

  get nextSeq() { return this.seq }
}

/**
 * Pair records into turns. A user record starts a new turn; an assistant record
 * ends it; tool records immediately following an assistant are attached to that
 * assistant's step instead of opening a new user turn.
 */
export function pairTurns(records) {
  const turns = []
  let pending = undefined
  let current = undefined
  const flush = () => {
    if (!pending) return
    turns.push({ user: pending.user, assistant: current?.assistant, tools: current?.tools ?? [], ts: pending.ts })
    pending = undefined
    current = undefined
  }
  for (const record of records) {
    if (record.role === 'user' || record.role === 'system') {
      flush()
      pending = { user: record, ts: record.ts }
    } else if (record.role === 'assistant') {
      if (!pending) {
        pending = { user: { text: '', role: 'user' }, ts: record.ts }
      }
      // A second assistant before a new user closes the previous turn.
      if (current) flush()
      current = { assistant: record, tools: [] }
    } else if (record.role === 'tool') {
      if (current) current.tools.push(record)
      else if (pending) {
        // Tool result with no preceding assistant: keep as loose text.
        current = { assistant: undefined, tools: [record] }
      } else {
        pending = { user: { text: '', role: 'user' }, ts: record.ts }
        current = { assistant: undefined, tools: [record] }
      }
    }
  }
  flush()
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

/** Convert a DSH event into tuple form for Session.append(type, data, opts). */
export function toLiveInput(event) {
  const input = [event.type, event.data]
  if (event.surfaceOp || event.sourceEventSeqs) {
    const opts = {}
    if (event.surfaceOp) opts.surfaceOp = event.surfaceOp
    if (event.sourceEventSeqs) opts.sourceEventSeqs = event.sourceEventSeqs
    input.push(opts)
  }
  return input
}
