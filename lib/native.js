/**
 * Native writers: render a DSH conversation back into the exact JSONL shape its
 * own tool writes.
 *
 * The renderers in adapters.js answer "what is the smallest line that tool can
 * still read?". That is enough for a round trip through our own parser, but it
 * is NOT enough for the tool itself: Claude Code reopens a session expecting
 * `parentUuid` chains, `cwd`, a model-bearing assistant message and
 * `tool_use`/`tool_result` blocks; Codex expects a `session_meta` header,
 * monotonically increasing `ordinal` values and `function_call` /
 * `function_call_output` response items. A flattened text-only line makes the
 * tool show a broken or empty transcript.
 *
 * Input is a list of EXCHANGES as produced by `readDshSessionExchanges()`:
 *
 *   { seq, time, role: 'user' | 'assistant', text, calls: [{id,name,arguments}] }
 *   { seq, time, role: 'tool', callId, text, content, isError }
 *
 * An assistant exchange carries the calls it made in `calls`; the matching
 * `role: 'tool'` exchange carries their output. Keeping them as separate
 * exchanges lets each writer place them the way its own tool does.
 *
 * Every emitted line still carries `dshSyncId` (and `dshTitle`), which is what
 * keeps our own reader from importing our own output as a duplicate.
 */

import { adapterFor } from './adapters.js'

function isoTime(value, fallback) {
  const ms = Number(value)
  return new Date(Number.isFinite(ms) && ms > 0 ? ms : fallback).toISOString()
}

function textOfBlocks(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => (typeof block === 'string' ? block : typeof block?.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n')
}

function outputText(exchange) {
  if (typeof exchange.text === 'string' && exchange.text) return exchange.text
  return textOfBlocks(exchange.content)
}

function parseArguments(value) {
  if (typeof value !== 'string') return value ?? {}
  try { return JSON.parse(value) } catch { return { raw: value } }
}

// ------------------------------------------------------------------ Claude Code

/**
 * Claude Code lines. `parentUuid` chains each line to the previous one; the
 * first line of a session has `parentUuid: null`. Tool calls live inside the
 * assistant message as `tool_use` blocks, and their results come back as a
 * `type:'user'` line whose content holds `tool_result` blocks - exactly how the
 * CLI itself records them.
 */
function renderClaudeSession(exchanges, options) {
  const { sessionId, title, cwd, version } = options
  const lines = []
  let parentUuid = null
  let counter = 0
  const nextUuid = () => {
    counter += 1
    return `${sessionId}-dsh-${counter}`
  }
  for (const exchange of exchanges) {
    const timestamp = isoTime(exchange.time, options.now)
    if (exchange.role !== 'tool') {
      const uuid = nextUuid()
      const content = []
      if (exchange.text) content.push({ type: 'text', text: exchange.text })
      for (const call of exchange.calls ?? []) {
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: parseArguments(call.arguments) })
      }
      if (!content.length) continue
      const calls = exchange.calls ?? []
      lines.push(JSON.stringify({
        parentUuid,
        isSidechain: false,
        type: exchange.role,
        message: {
          id: uuid,
          role: exchange.role,
          content,
          ...(exchange.role === 'assistant'
            ? { type: 'message', model: 'dsh', stop_reason: calls.length ? 'tool_use' : 'end_turn', stop_sequence: null }
            : {}),
        },
        uuid,
        timestamp,
        ...(cwd ? { cwd } : {}),
        sessionId,
        ...(version ? { version } : {}),
        dshSyncId: `${sessionId}:${exchange.seq ?? counter}`,
        ...(title ? { dshTitle: title } : {}),
      }))
      parentUuid = uuid
      continue
    }
    if (!exchange.callId) continue
    const uuid = nextUuid()
    lines.push(JSON.stringify({
      parentUuid,
      isSidechain: false,
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: exchange.callId,
          content: outputText(exchange),
          ...(exchange.isError ? { is_error: true } : {}),
        }],
      },
      uuid,
      timestamp,
      ...(cwd ? { cwd } : {}),
      sessionId,
      dshSyncId: `${sessionId}:${exchange.seq ?? counter}`,
      ...(title ? { dshTitle: title } : {}),
    }))
    parentUuid = uuid
  }
  return lines
}

// -------------------------------------------------------------------- Codex CLI

const CODEX_VERSION = '0.0.0-dsh-conversation-sync'

/**
 * Codex rollout lines. A rollout opens with `session_meta`, then every logical
 * item is a `response_item` with an increasing `ordinal`. Tool calls are
 * `function_call` items and their results `function_call_output`, joined by
 * `call_id` - the same join Codex itself uses.
 */
function renderCodexSession(exchanges, options, withHeader) {
  const { sessionId, title, cwd } = options
  const lines = []
  // Ordinals must keep ascending when a later export appends to a rollout that
  // already has items, so the caller passes the highest one already on disk.
  let ordinal = Number(options.ordinalOffset) || 0
  if (withHeader) {
    const stamp = isoTime(exchanges[0]?.time, options.now)
    ordinal += 1
    lines.push(JSON.stringify({
      timestamp: stamp,
      ordinal,
      type: 'session_meta',
      payload: {
        session_id: sessionId,
        id: sessionId,
        timestamp: stamp,
        ...(cwd ? { cwd } : {}),
        originator: 'dsh-conversation-sync',
        cli_version: CODEX_VERSION,
        source: 'dsh-conversation-sync',
        thread_source: 'user',
      },
      dshSyncId: `${sessionId}:meta`,
      ...(title ? { dshTitle: title } : {}),
    }))
  }
  for (const exchange of exchanges) {
    const common = {
      timestamp: isoTime(exchange.time, options.now),
      dshSyncId: `${sessionId}:${exchange.seq ?? ordinal}`,
      ...(title ? { dshTitle: title } : {}),
    }
    if (exchange.role !== 'tool') {
      if (exchange.text) {
        ordinal += 1
        lines.push(JSON.stringify({
          ...common,
          ordinal,
          type: 'response_item',
          payload: {
            type: 'message',
            id: `msg-dsh-${ordinal}`,
            role: exchange.role,
            content: [{ type: exchange.role === 'user' ? 'input_text' : 'output_text', text: exchange.text }],
          },
        }))
      }
      for (const call of exchange.calls ?? []) {
        ordinal += 1
        lines.push(JSON.stringify({
          ...common,
          ordinal,
          type: 'response_item',
          payload: {
            type: 'function_call',
            id: `fc-dsh-${ordinal}`,
            call_id: call.id,
            name: call.name,
            arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}),
          },
        }))
      }
      continue
    }
    if (!exchange.callId) continue
    ordinal += 1
    lines.push(JSON.stringify({
      ...common,
      ordinal,
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        id: `fco-dsh-${ordinal}`,
        call_id: exchange.callId,
        output: outputText(exchange),
      },
    }))
  }
  return lines
}

// ------------------------------------------------------- WorkBuddy / CodeBuddy

/**
 * WorkBuddy rows are one flat object per line: `message` carries the text,
 * `function_call`/`function_call_result` carry the tools joined by `callId`,
 * and `reasoning` carries the model's thinking. `timestamp` is milliseconds.
 */
function renderWorkbuddySession(exchanges, options) {
  const { sessionId, title } = options
  const lines = []
  let counter = 0
  let seq = 0
  const push = obj => {
    counter += 1
    lines.push(JSON.stringify({
      ...obj,
      dshSyncId: `${sessionId}:${seq || counter}`,
      ...(title ? { dshTitle: title } : {}),
    }))
  }
  for (const exchange of exchanges) {
    const timestamp = Number(exchange.time) || options.now
    seq = exchange.seq ?? 0
    if (exchange.role !== 'tool') {
      if (exchange.text) {
        push({
          type: 'message',
          id: `msg-dsh-${counter + 1}`,
          role: exchange.role,
          content: [{ type: exchange.role === 'user' ? 'input_text' : 'output_text', text: exchange.text }],
          timestamp,
        })
      }
      for (const call of exchange.calls ?? []) {
        push({
          type: 'function_call',
          callId: call.id,
          name: call.name,
          arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}),
          timestamp,
        })
      }
      continue
    }
    if (!exchange.callId) continue
    push({
      type: 'function_call_result',
      callId: exchange.callId,
      status: exchange.isError ? 'error' : 'success',
      output: outputText(exchange),
      timestamp,
    })
  }
  return lines
}

// ------------------------------------------------------------- Antigravity

/**
 * Antigravity transcripts are step logs: `source`/`type` decide the role, user
 * text is wrapped in `<USER_REQUEST>`, and tool calls hang off the model step as
 * `tool_calls`. `step_index` must increase monotonically.
 */
function renderAntigravitySession(exchanges, options) {
  const { sessionId, title } = options
  const lines = []
  let step = 0
  for (const exchange of exchanges) {
    step += 1
    const created = isoTime(exchange.time, options.now)
    const common = {
      step_index: step,
      status: 'DONE',
      created_at: created,
      tokens: null,
      dshSyncId: `${sessionId}:${exchange.seq ?? step}`,
      ...(title ? { dshTitle: title } : {}),
    }
    if (exchange.role !== 'tool') {
      if (!exchange.text && !(exchange.calls?.length)) continue
      lines.push(JSON.stringify({
        ...common,
        source: exchange.role === 'assistant' ? 'MODEL' : 'USER_EXPLICIT',
        type: exchange.role === 'assistant' ? 'PLANNER_RESPONSE' : 'USER_INPUT',
        content: exchange.role === 'assistant' ? exchange.text : `<USER_REQUEST>\n${exchange.text}\n</USER_REQUEST>`,
        ...(exchange.calls?.length
          ? { tool_calls: exchange.calls.map(call => ({ name: call.name, args: parseArguments(call.arguments) })) }
          : {}),
      }))
      continue
    }
    if (!exchange.callId) continue
    lines.push(JSON.stringify({
      ...common,
      source: 'SYSTEM',
      type: 'TOOL_RESULT',
      content: outputText(exchange),
      call_id: exchange.callId,
      ...(exchange.isError ? { is_error: true } : {}),
    }))
  }
  return lines
}

// ---------------------------------------------------------------- dispatcher

export function renderSessionLines(kind, exchanges, options = {}) {
  const opts = { now: Date.now(), sessionId: options.sessionId ?? 'dsh-session', ...options }
  if (!exchanges?.length) return ''
  const join = lines => lines.map(line => `${line}\n`).join('')
  if (kind === 'claude') return join(renderClaudeSession(exchanges, opts))
  if (kind === 'codex' || kind === 'trae') return join(renderCodexSession(exchanges, opts, options.withHeader !== false))
  if (kind === 'workbuddy') return join(renderWorkbuddySession(exchanges, opts))
  if (kind === 'antigravity') return join(renderAntigravitySession(exchanges, opts))
  // Other stores keep using their adapter's renderer.
  const adapter = adapterFor(kind)
  return exchanges
    .map(exchange => adapter.render(
      { role: exchange.role, text: exchange.text, ts: exchange.time, meta: { calls: exchange.calls, callId: exchange.callId } },
      `${opts.sessionId}:${exchange.seq ?? 0}`,
      opts.title,
    ))
    .join('')
}

/**
 * Highest `ordinal` already present in a rollout file.
 *
 * Codex numbers every item and a later append must continue above the existing
 * maximum, otherwise the tool sees two items with the same ordinal and drops or
 * reorders history. Returns 0 for a file that has no ordinals.
 */
export function maxOrdinal(text) {
  if (typeof text !== 'string' || !text.includes('"ordinal"')) return 0
  let max = 0
  for (const line of text.split('\n')) {
    if (!line.includes('"ordinal"')) continue
    try {
      const value = Number(JSON.parse(line)?.ordinal)
      if (Number.isFinite(value) && value > max) max = value
    } catch {
      // A partially written trailing line is not a reason to fail an export.
    }
  }
  return max
}
