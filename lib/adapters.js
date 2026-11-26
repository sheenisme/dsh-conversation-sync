/**
 * External conversation adapters. Each adapter converts one line of an
 * external JSONL store into a normalized record:
 *   { role: 'user' | 'assistant' | 'tool' | 'system', text, ts, meta }
 * and can render a DSH-origin record back into a line for write-back.
 * Normalized records are intentionally simple: DSH events are built from
 * them by events.js.
 */

export function textOf(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join('\n')
  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return value.text
    if (typeof value.content !== 'undefined') return textOf(value.content)
  }
  return ''
}

/** Normalize an arbitrary tool-output value into DSH text content blocks. */
function textBlocksSafe(value) {
  if (typeof value === 'string') return value ? [{ type: 'text', text: value }] : []
  if (Array.isArray(value)) {
    const blocks = []
    for (const item of value) {
      if (item && typeof item === 'object' && item.type === 'text') blocks.push({ type: 'text', text: item.text ?? '' })
      else if (typeof item === 'string' && item) blocks.push({ type: 'text', text: item })
      else if (item && typeof item === 'object' && typeof item.text === 'string') blocks.push({ type: 'text', text: item.text })
    }
    return blocks
  }
  if (value && typeof value === 'object' && typeof value.text === 'string') return value.text ? [{ type: 'text', text: value.text }] : []
  return value === undefined || value === null ? [] : [{ type: 'text', text: JSON.stringify(value) }]
}

function splitJsonl(buffer, state) {
  state.pending = (state.pending ?? '') + buffer.toString('utf8')
  const lines = []
  let cut = 0
  for (;;) {
    const nl = state.pending.indexOf('\n', cut)
    if (nl < 0) break
    const raw = state.pending.slice(cut, nl)
    cut = nl + 1
    if (raw.trim().length) lines.push(raw)
  }
  state.pending = state.pending.slice(cut)
  return lines
}

// ---------------------------------------------------------------- Claude Code

function claudeBlockText(block) {
  if (!block || typeof block !== 'object') return ''
  switch (block.type) {
    case 'text': return block.text ?? ''
    case 'thinking': return `[thinking] ${block.thinking ?? ''}`
    case 'tool_use': return `[tool_use ${block.name ?? 'tool'}] ${JSON.stringify(block.input ?? {})}`
    case 'tool_result': return typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '')
    case 'image': return '[image]'
    default: return block.text ?? ''
  }
}

function parseClaudeLine(line, meta) {
  let obj
  try { obj = JSON.parse(line) } catch { return undefined }
  if (obj?.dshSyncId) return undefined // our own write-back, never echo
  const content = obj?.message?.content
  const blocks = Array.isArray(content) ? content : []
  const toolResults = blocks.filter(b => b?.type === 'tool_result')
  const base = {
    ts: obj.timestamp ? Date.parse(obj.timestamp) || null : null,
    meta: {
      uuid: obj.uuid, parentUuid: obj.parentUuid, sessionId: obj.sessionId,
      isSidechain: obj.isSidechain === true, messageId: obj.message?.id,
      apiBlockIndex: obj.apiBlockIndex ?? null, model: obj.message?.model,
      byteOffset: meta.byteOffset,
    },
  }
  if (obj.type === 'user' && obj.message?.role === 'user' && toolResults.length === 0) {
    return { ...base, role: 'user', text: textOf(obj.message.content), meta: { ...base.meta, blocks } }
  }
  if (obj.type === 'user' && toolResults.length > 0) {
    const args = (block, index) => ({
      ...base,
      role: 'tool',
      text: claudeBlockText(block),
      meta: {
        ...base.meta,
        blocks: [block],
        kind: 'tool_result',
        callId: block.tool_use_id,
        content: [{ type: 'text', text: typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '') }],
        isError: block.is_error === true,
      },
    })
    // One JSONL line can carry several tool_result blocks (parallel tools).
    return toolResults.length === 1 ? args(toolResults[0], 0) : toolResults.map(args)
  }
  if (obj.type === 'assistant' && obj.message?.role === 'assistant') {
    const calls = blocks.filter(b => b?.type === 'tool_use').map(b => ({
      id: b.id,
      name: b.name ?? 'tool',
      arguments: typeof b.input === 'string' ? b.input : JSON.stringify(b.input ?? {}),
    }))
    const text = blocks.filter(b => b?.type !== 'tool_use').map(claudeBlockText).filter(Boolean).join('\n')
    return { ...base, role: 'assistant', text, meta: { ...base.meta, blocks, calls } }
  }
  return undefined
}

function renderClaude(record, syncId) {
  const role = record.role === 'assistant' ? 'assistant' : 'user'
  return JSON.stringify({
    type: role,
    uuid: syncId,
    sessionId: record.meta?.sessionId,
    timestamp: new Date(record.ts ?? Date.now()).toISOString(),
    message: { id: syncId, role, content: [{ type: 'text', text: record.text }] },
    dshSyncId: syncId,
  }) + '\n'
}

// ------------------------------------------------------------------- Codex CLI

function codexText(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(codexText).filter(Boolean).join('\n')
  if (!value || typeof value !== 'object') return ''
  switch (value.type) {
    case 'input_text': case 'output_text': case 'summary_text': return value.text ?? ''
    case 'input_image': return '[image]'
    case 'encrypted_content': return ''
    default: return typeof value.text === 'string' ? value.text : ''
  }
}

function parseCodexLine(line, meta) {
  let obj
  try { obj = JSON.parse(line) } catch { return undefined }
  if (obj?.dshSyncId) return undefined
  const p = obj?.payload
  const base = {
    ts: obj.timestamp ? Date.parse(obj.timestamp) || null : null,
    meta: { ordinal: obj.ordinal, sessionId: p?.session_id, turnId: p?.internal_chat_message_metadata_passthrough?.turn_id ?? p?.turn_id, messageId: p?.id, byteOffset: meta.byteOffset },
  }
  if (obj.type === 'response_item' && p?.type === 'message') {
    const role = p.role === 'assistant' ? 'assistant' : p.role === 'user' ? 'user' : 'system'
    return { ...base, role, text: codexText(p.content), meta: { ...base.meta, blocks: p.content } }
  }
  if (obj.type === 'response_item' && p?.type === 'reasoning') {
    const text = (p.summary ?? []).map(codexText).filter(Boolean).join('\n')
    if (!text) return undefined
    return { ...base, role: 'assistant', text: `[reasoning] ${text}`, meta: { ...base.meta, kind: 'reasoning' } }
  }
  // Codex emits four tool payload types: function_call / function_call_output
  // and custom_tool_call / custom_tool_call_output, joined by call_id.
  const CODEX_CALLS = ['function_call', 'custom_tool_call']
  const CODEX_OUTPUTS = ['function_call_output', 'custom_tool_call_output']
  if (obj.type === 'response_item' && CODEX_CALLS.includes(p?.type)) {
    const rawArgs = p.arguments ?? p.input ?? ''
    const args = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs)
    const text = `[tool_call ${p.name ?? ''}] ${args}`
    return {
      ...base, role: 'tool', text,
      meta: { ...base.meta, kind: p.type, callId: p.call_id, call: { id: p.call_id, name: p.name ?? 'tool', arguments: args } },
    }
  }
  if (obj.type === 'response_item' && CODEX_OUTPUTS.includes(p?.type)) {
    return {
      ...base, role: 'tool', text: codexText(p.output),
      meta: { ...base.meta, kind: p.type, callId: p.call_id, content: textBlocksSafe(p.output) },
    }
  }
  if (obj.type === 'response_item' && p?.type === 'agent_message') {
    return { ...base, role: 'assistant', text: codexText(p.message ?? p.content), meta: { ...base.meta, kind: 'agent_message', author: p.author } }
  }
  return undefined
}

function renderCodex(record, syncId) {
  const role = record.role === 'assistant' ? 'assistant' : 'user'
  return JSON.stringify({
    timestamp: new Date(record.ts ?? Date.now()).toISOString(),
    type: 'response_item',
    payload: { type: 'message', id: syncId, role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text: record.text }] },
    dshSyncId: syncId,
  }) + '\n'
}

// --------------------------------------------------- WorkBuddy / CodeBuddy

/**
 * WorkBuddy (workbuddy.cn / workbuddy.ai) and its CodeBuddy Code core store one
 * flat JSON object per line. Message rows carry `role`; tool rows are separate
 * `function_call` / `function_call_result` records joined by `callId` (NOT
 * `id`, which is the model message id and is shared between parallel calls).
 */
function workbuddyText(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(workbuddyText).filter(Boolean).join('\n')
  if (!value || typeof value !== 'object') return ''
  switch (value.type) {
    case 'input_text': case 'output_text': case 'reasoning_text': case 'text': return value.text ?? ''
    case 'input_image': return '[image]'
    default: return typeof value.text === 'string' ? value.text : ''
  }
}

function parseWorkbuddyLine(line, meta) {
  let obj
  try { obj = JSON.parse(line) } catch { return undefined }
  if (obj?.dshSyncId) return undefined
  // Rows the tool itself marks as internal/compaction artifacts are skipped.
  if (obj.skipRun || obj.isMeta || obj.isCompactInternal || obj.isCompacted) return undefined
  const ts = typeof obj.timestamp === 'number' ? obj.timestamp : obj.timestamp ? Date.parse(obj.timestamp) || null : null
  const base = { ts, meta: { id: obj.id, byteOffset: meta.byteOffset, parentId: obj.parentId } }
  if (obj.type === 'message' && (obj.role === 'user' || obj.role === 'assistant')) {
    const text = workbuddyText(obj.content)
    if (!text) return undefined
    return { ...base, role: obj.role, text, meta: { ...base.meta, blocks: obj.content, model: obj.model } }
  }
  if (obj.type === 'reasoning') {
    const text = workbuddyText(obj.rawContent ?? obj.content)
    if (!text) return undefined
    return { ...base, role: 'assistant', text: `[thinking] ${text}`, meta: { ...base.meta, kind: 'reasoning' } }
  }
  if (obj.type === 'function_call') {
    const rawArgs = obj.arguments ?? obj.input ?? ''
    const args = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs)
    return {
      ...base, role: 'tool', text: `[tool_call ${obj.name ?? 'tool'}] ${args}`,
      meta: { ...base.meta, kind: 'function_call', callId: obj.callId, call: { id: obj.callId, name: obj.name ?? 'tool', arguments: args } },
    }
  }
  if (obj.type === 'function_call_result') {
    const output = obj.output ?? obj.content
    const text = workbuddyText(output)
    return {
      ...base, role: 'tool', text,
      meta: { ...base.meta, kind: 'function_call_result', callId: obj.callId, content: textBlocksSafe(output), isError: obj.status === 'error' },
    }
  }
  return undefined
}

function renderWorkbuddy(record, syncId) {
  const role = record.role === 'assistant' ? 'assistant' : 'user'
  return JSON.stringify({
    type: 'message',
    id: syncId,
    role,
    content: [{ type: role === 'user' ? 'input_text' : 'output_text', text: record.text }],
    timestamp: record.ts ?? Date.now(),
    dshSyncId: syncId,
  }) + '\n'
}

// ---------------------------------------------------------------- TRAE (CLI)

/**
 * TRAE's CLI writes Codex-style rollouts plus its own `history_mutation` rows.
 * Real user input hides in `event_msg.user_message` (a plain `role:'user'`
 * response_item can be a runtime injection), and replayed history arrives as
 * `history_mutation` with operation 'replace', which must be skipped.
 */
function parseTraeLine(line, meta) {
  let obj
  try { obj = JSON.parse(line) } catch { return undefined }
  if (obj?.dshSyncId) return undefined
  const p = obj?.payload
  const ts = obj.timestamp ? Date.parse(obj.timestamp) || null : null
  const base = { ts, meta: { ordinal: obj.ordinal, byteOffset: meta.byteOffset, sessionId: p?.session_id } }
  if (obj.type === 'history_mutation') {
    if ((p?.operation ?? obj.operation) === 'replace') return undefined
    const text = textOf(p?.content ?? p?.message ?? obj.content)
    if (!text) return undefined
    return { ...base, role: p?.role === 'assistant' ? 'assistant' : 'user', text, meta: { ...base.meta, kind: 'history_mutation' } }
  }
  if (obj.type === 'event_msg' && p?.type === 'user_message') {
    const text = textOf(p.message ?? p.content ?? p.text)
    if (!text) return undefined
    return { ...base, role: 'user', text, meta: { ...base.meta, kind: 'user_message' } }
  }
  return parseCodexLine(line, meta)
}

// ------------------------------------------------------------- Antigravity

/**
 * Antigravity (Gemini-based) writes `transcript.jsonl` under
 * `~/.gemini/antigravity-cli|antigravity-ide|antigravity/brain/<session>/`
 * under `.system_generated/logs/transcript.jsonl`.
 * There is no `role`: `source`/`type` decide it. User text is wrapped in
 * `<USER_REQUEST>...</USER_REQUEST>`; `created_at` is RFC3339.
 */
function antigravityClean(text) {
  if (typeof text !== 'string') return textOf(text)
  return text
    .replace(/^[\s\S]*?<USER_REQUEST>/, '')
    .replace(/<\/USER_REQUEST>[\s\S]*$/, '')
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '')
    .trim()
}

function parseAntigravityLine(line, meta) {
  let obj
  try { obj = JSON.parse(line) } catch { return undefined }
  if (obj?.dshSyncId) return undefined
  const source = String(obj.source ?? '')
  const type = String(obj.type ?? '')
  const ts = obj.created_at ? Date.parse(obj.created_at) || null : null
  const base = { ts, meta: { stepIndex: obj.step_index, type, source, byteOffset: meta.byteOffset } }
  const isUser = /USER/i.test(source) || type === 'USER_INPUT'
  const isModel = /MODEL/i.test(source) || type === 'PLANNER_RESPONSE'
  const text = isUser ? antigravityClean(obj.content) : textOf(obj.content)
  if (!text) return undefined
  // CHECKPOINT is a compaction marker; GENERIC/SYSTEM rows are harness step logs
  // ("Created At ... Encountered error in step execution") with no user meaning.
  if (type === 'CHECKPOINT' || type === 'GENERIC') return undefined
  if (source === 'SYSTEM') return undefined
  const role = isUser ? 'user' : isModel ? 'assistant' : undefined
  if (!role) return undefined
  const calls = Array.isArray(obj.tool_calls) ? obj.tool_calls.map((call, index) => ({
    id: `${obj.step_index ?? 'step'}-${index}`,
    name: call?.name ?? Object.keys(call ?? {})[0] ?? 'tool',
    arguments: typeof call?.arguments === 'string' ? call.arguments : JSON.stringify(call?.arguments ?? call ?? {}),
  })) : []
  return { ...base, role, text, meta: { ...base.meta, model: obj.model, calls } }
}

function renderAntigravity(record, syncId) {
  const isUser = record.role !== 'assistant'
  return JSON.stringify({
    step_index: 0,
    source: isUser ? 'USER_EXPLICIT' : 'MODEL',
    type: isUser ? 'USER_INPUT' : 'PLANNER_RESPONSE',
    status: null,
    created_at: new Date(record.ts ?? Date.now()).toISOString(),
    content: isUser ? `<USER_REQUEST>\n${record.text}\n</USER_REQUEST>` : record.text,
    dshSyncId: syncId,
  }) + '\n'
}

// --------------------------------------------------------------- Generic JSONL

function parseGenericLine(line, meta) {
  let obj
  try { obj = JSON.parse(line) } catch { return undefined }
  if (obj?.dshSyncId) return undefined
  const m = obj.message ?? obj
  const role = m.role ?? m.type
  if (role !== 'user' && role !== 'assistant' && role !== 'tool' && role !== 'system') return undefined
  const ts = obj.timestamp ?? m.timestamp ?? obj.created_at
  return {
    role,
    text: textOf(m.content ?? m.text ?? obj.content),
    ts: typeof ts === 'number' ? ts : ts ? Date.parse(ts) || null : null,
    meta: { id: obj.id ?? m.id, byteOffset: meta.byteOffset },
  }
}

function renderGeneric(record, syncId) {
  return JSON.stringify({ id: syncId, role: record.role, content: record.text, timestamp: new Date(record.ts ?? Date.now()).toISOString(), dshSyncId: syncId }) + '\n'
}

const JSONL_ADAPTERS = {
  claude: { parse: parseClaudeLine, render: renderClaude },
  codex: { parse: parseCodexLine, render: renderCodex },
  workbuddy: { parse: parseWorkbuddyLine, render: renderWorkbuddy },
  trae: { parse: parseTraeLine, render: renderCodex },
  antigravity: { parse: parseAntigravityLine, render: renderAntigravity },
  jsonl: { parse: parseGenericLine, render: renderGeneric },
}

export function adapterFor(kind) {
  const adapter = JSONL_ADAPTERS[kind]
  if (!adapter) throw new Error(`unknown JSONL source kind: ${kind}`)
  return adapter
}

/**
 * Read new records from a JSONL file using a byte-offset cursor. Returns the
 * new records and the advanced cursor. Incomplete trailing lines are buffered
 * in the cursor's `pending` field and picked up on the next poll.
 */
/**
 * Drop the echoes a rollout writer replays on top of its own event stream.
 * TRAE records every user turn twice: `event_msg`/`user_message` (the real
 * turn) and a Codex-shaped `response_item` message with the same text (the
 * request echo). Without this the imported conversation shows each question
 * twice. `seen` carries the texts already emitted so the echo of a turn split
 * across two reads is dropped as well.
 */
function dedupeRecords(kind, records, cursor) {
  if (kind !== 'trae') return { records, userTexts: undefined }
  const seen = new Set(Array.isArray(cursor?.userTexts) ? cursor.userTexts : [])
  const kept = []
  for (const record of records) {
    if (record.role !== 'user') { kept.push(record); continue }
    const text = String(record.text ?? '').trim()
    if (record.meta?.kind === 'user_message') {
      seen.add(text)
      kept.push(record)
      continue
    }
    // A user message that is not an event_msg is the replay echo: skip it when
    // the same turn was already recorded.
    if (text && seen.has(text)) continue
    if (text) seen.add(text)
    kept.push(record)
  }
  return { records: kept, userTexts: [...seen].slice(-200) }
}

export async function readJsonlDelta(transport, file, kind, cursor) {
  const stat = await transport.stat(file)
  if (!stat) return { records: [], cursor, absent: true }
  let offset = typeof cursor?.offset === 'number' ? cursor.offset : 0
  if (offset > stat.size) offset = 0 // file was rotated or truncated
  const bytes = offset === stat.size ? Buffer.alloc(0) : await transport.read(file, offset)
  const state = { pending: cursor?.pending ?? '' }
  const lines = splitJsonl(bytes, state)
  const parse = adapterFor(kind).parse
  const records = []
  for (const line of lines) {
    const parsed = parse(line, { byteOffset: offset })
    if (!parsed) continue
    // A single source line can expand into several records (e.g. parallel
    // Claude tool_result blocks), so flatten before handing to the event builder.
    if (Array.isArray(parsed)) records.push(...parsed)
    else records.push(parsed)
  }
  const deduped = dedupeRecords(kind, records, cursor)
  return {
    records: deduped.records,
    cursor: {
      offset: offset + bytes.length,
      pending: state.pending,
      ...(deduped.userTexts ? { userTexts: deduped.userTexts } : {}),
    },
    absent: false,
  }
}

export function renderExternalLine(kind, record, syncId) {
  return adapterFor(kind).render(record, syncId)
}

// -------------------------------------------------------------- DeepSeek ZIP

/** Parse a DeepSeek web-export ZIP (raw bytes) into sessions of normalized records. */
export async function parseDeepSeekExport(zipBytes, createId) {
  const { unzipSync, strFromU8 } = await import('fflate')
  const files = unzipSync(new Uint8Array(zipBytes))
  const text = name => {
    const bytes = files[name]
    return bytes ? strFromU8(bytes) : undefined
  }
  const manifest = JSON.parse(text('manifest.json') ?? '{}')
  if (manifest.export_format_version !== 3) {
    throw new Error(`unsupported DeepSeek export format version: ${manifest.export_format_version}`)
  }
  const index = JSON.parse(text('chat_session_index.json') ?? '[]')
  const sessions = []
  for (const item of index) {
    const raw = JSON.parse(text(`chat_sessions/${item.id}.json`) ?? 'null')
    if (!raw?.messages) continue
    const records = []
    for (const message of raw.messages) {
      const fragments = Array.isArray(message.fragments) ? message.fragments : []
      const parts = []
      for (const fragment of fragments) {
        if (fragment.type === 'REQUEST' || fragment.type === 'RESPONSE' || fragment.type === 'THINK' || fragment.type === 'TEMPLATE_RESPONSE') {
          if (fragment.content) parts.push(fragment.type === 'THINK' ? `[thinking] ${fragment.content}` : fragment.content)
        } else if (fragment.type === 'TOOL_SEARCH') {
          parts.push(`[search ${JSON.stringify(fragment.queries ?? [])}]`)
        } else if (fragment.type === 'TOOL_OPEN' && fragment.url) {
          parts.push(`[open ${fragment.url}]`)
        } else if (fragment.type === 'TOOL_FIND' && fragment.pattern) {
          parts.push(`[find ${fragment.pattern}]`)
        } else if (fragment.type === 'READ_LINK') {
          parts.push((fragment.results ?? []).map(r => `[link ${r.url}]`).join('\n'))
        } else if (fragment.type === 'TOOL_IMAGE_SEARCH') {
          parts.push('[image search]')
        } else if (fragment.type === 'FILE') {
          parts.push((fragment.files ?? []).map(f => `[file ${f.file_name ?? f.id}]`).join('\n'))
        }
      }
      const textValue = parts.filter(Boolean).join('\n')
      if (!textValue) continue
      records.push({
        role: message.role === 'USER' ? 'user' : 'assistant',
        text: textValue,
        ts: Date.parse(message.inserted_at) || null,
        meta: { exportId: message.id, parentId: message.parent_id },
      })
    }
    sessions.push({
      id: String(raw.id ?? item.id),
      title: raw.title ?? undefined,
      createdAt: Date.parse(item.inserted_at) || Date.now(),
      records,
    })
  }
  return sessions
}
