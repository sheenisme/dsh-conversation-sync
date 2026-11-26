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
   * One DSH turn: protected system head (first turn only), user message, then
   * one step per assistant response, each with its paired tool calls/results.
   *
   * A real turn holds several steps: a tool-calling turn is step 1 (assistant
   * text + tool/call + tool/result), and the answer that follows the tool
   * output is step 2. Collapsing a turn to a single step silently dropped every
   * assistant record after the first one, so `steps` is the canonical shape and
   * `assistant`/`tools` stay supported for single-step callers.
   */
  turn({ user, assistant, tools = [], steps, turn, ts }) {
    const plan = steps && steps.length ? steps : [{ assistant, tools }]
    this.add({ type: 'turn/start', data: { turn } }, ts)
    let step = 0
    for (const current of plan) {
      step += 1
      this.add({ type: 'step/start', data: { turn, step } }, ts)
      if (this.firstTurn) {
        this.firstTurn = false
        // V4 refuses the retired V3 `{kind:'plugin', plugin}` wrapper outright
        // ("format v4 message requires a producer-owned source kind"), so the
        // protected head must carry the producer's own kind.
        this.add({
          type: 'system/message',
          data: { turn, step, message: { id: messageId(this.createId), role: 'system', content: [], source: { kind: 'system-prompt' } } },
          surfaceOp: 'append',
        }, ts)
      }
      if (step === 1) {
        this.add({
          type: 'user/message',
          data: { id: messageId(this.createId), role: 'user', content: textBlocks(user?.text), source: { kind: 'user' } },
          surfaceOp: 'append',
        }, ts)
      }
      this.step({ turn, step, assistant: current.assistant, tools: current.tools ?? [], ts: current.assistant?.ts ?? ts })
      this.add({ type: 'step/end', data: { turn, step } }, current.assistant?.ts ?? ts)
    }
    this.add({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } }, ts)
  }

  /** Everything inside one step: the assistant message plus its tool round trip. */
  step({ turn, step, assistant, tools = [], ts }) {
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

    if (assistant || calls.length) {
      // V4 tracks a tool lifecycle: every tool/call must first be ADVERTISED as
      // a `{type:'tool-call'}` block inside an assistant message, and the later
      // tool/call row must repeat the same id/name/arguments. Announcing calls
      // anywhere else fails with "tool/call <id> has no advertised tool
      // lifecycle" and makes the whole session log unreadable.
      const text = String(assistant?.text ?? '')
      const content = text ? [{ type: 'text', text }] : []
      for (const call of calls) {
        content.push({ type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments })
      }
      this.add({
        type: 'assistant/message',
        data: {
          turn, step,
          message: { id: messageId(this.createId), role: 'assistant', content, source: { kind: 'model', provider: 'import', model: 'imported' } },
          stream: [],
        },
        surfaceOp: 'append',
      }, assistant?.ts ?? ts)
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
        const isError = result?.meta?.isError === true
        // V4 wants a FIRST-CLASS tool message: role 'tool', the call id repeated
        // as `toolCallId` (it must equal the source's callId), and plain text
        // content. The released V3 shape - role 'user' wrapping a
        // {type:'tool-result'} block - is rejected by
        // assertV4ToolResultMessage ("requires a tool-role message").
        this.add({
          type: 'tool/result',
          data: {
            turn, step,
            message: {
              id: messageId(this.createId),
              role: 'tool',
              content,
              source: { kind: 'tool', callId: call.id },
              toolCallId: call.id,
              ...(isError ? { isError: true } : {}),
            },
            ...(isError ? { error: { message: String(result?.text ?? 'tool failed') } } : {}),
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
        data: { id: messageId(this.createId), role: 'user', content: textBlocks(tool.text), source: { kind: 'plugin:dsh-conversation-sync' } },
        surfaceOp: 'append',
      }, tool.ts)
    }
  }

  get nextSeq() { return this.seq }
}

/**
 * Pair records into turns, each turn holding one step per assistant response.
 *
 * A user record opens a turn. Every assistant record opens a new step, and the
 * tool records that follow it belong to that step - that is how DSH models a
 * tool round trip (step 1 answers with a call, step 2 answers with the final
 * text). Records before the first assistant (loose tool output, reasoning-only
 * turns) get their own step so nothing is dropped.
 */
export function pairTurns(records) {
  const turns = []
  let pending = undefined
  const flush = () => {
    if (!pending) return
    turns.push({ user: pending.user, steps: pending.steps, ts: pending.ts })
    pending = undefined
  }
  const openStep = () => {
    const step = { assistant: undefined, tools: [] }
    pending.steps.push(step)
    return step
  }
  for (const record of records) {
    if (record.role === 'user' || record.role === 'system') {
      flush()
      pending = { user: record, steps: [], ts: record.ts }
    } else if (record.role === 'assistant') {
      if (!pending) pending = { user: { text: '', role: 'user' }, steps: [], ts: record.ts }
      const step = openStep()
      step.assistant = record
    } else if (record.role === 'tool') {
      if (!pending) pending = { user: { text: '', role: 'user' }, steps: [], ts: record.ts }
      const last = pending.steps[pending.steps.length - 1]
      // Tool records belong to the assistant step they answer; with no
      // preceding assistant they open their own step so the text still lands.
      if (last?.assistant) last.tools.push(record)
      else openStep().tools.push(record)
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
    // Tool-role messages carry tool output, not conversation turns; exporting
    // them as user text would fabricate a turn the user never sent.
    if (!message || message.role === 'system' || message.role === 'developer' || message.role === 'tool') continue
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
