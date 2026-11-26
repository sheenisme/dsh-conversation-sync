import test from 'node:test'
import assert from 'node:assert/strict'
import { textOf, adapterFor, readJsonlDelta, renderExternalLine } from '../lib/adapters.js'
import { memoryTransport } from './helpers.js'

const meta = { byteOffset: 0 }

test('textOf: string, array, object and nested content', () => {
  assert.equal(textOf('hello'), 'hello')
  assert.equal(textOf(['a', { text: 'b' }]), 'a\nb')
  assert.equal(textOf({ text: 'x' }), 'x')
  assert.equal(textOf({ content: [{ type: 'text', text: 'y' }] }), 'y')
  assert.equal(textOf(42), '')
})

test('adapterFor: known kinds and unknown kind rejection', () => {
  for (const kind of ['claude', 'codex', 'jsonl']) {
    const a = adapterFor(kind)
    assert.equal(typeof a.parse, 'function')
    assert.equal(typeof a.render, 'function')
  }
  assert.throws(() => adapterFor('nope'), /unknown JSONL source kind/)
})

test('Claude: user, assistant with tool_use, tool_result, blob dedupe', () => {
  const parse = adapterFor('claude').parse
  const user = parse(JSON.stringify({
    type: 'user', uuid: 'u1', sessionId: 's1', timestamp: '2026-01-01T00:00:00Z',
    message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  }), meta)
  assert.equal(user.role, 'user')
  assert.equal(user.text, 'hi')

  const assistant = parse(JSON.stringify({
    type: 'assistant', uuid: 'a1', timestamp: '2026-01-01T00:00:01Z',
    message: { role: 'assistant', model: 'claude', content: [
      { type: 'text', text: 'sure' },
      { type: 'tool_use', id: 'tc1', name: 'Read', input: { file: 'x' } },
    ] },
  }), meta)
  assert.equal(assistant.role, 'assistant')
  assert.match(assistant.text, /sure/)
  assert.equal(assistant.meta.calls[0].id, 'tc1')

  const result = parse(JSON.stringify({
    type: 'user', uuid: 'r1', timestamp: '2026-01-01T00:00:02Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tc1', content: 'done' }] },
  }), meta)
  assert.equal(result.role, 'tool')
  assert.equal(result.meta.callId, 'tc1')

  const blob = parse(JSON.stringify({ type: 'api-request-blob', uuid: 'b1', message: { role: 'user', content: [] } }), meta)
  assert.equal(blob, undefined)
})

test('Claude: parallel tool_result blocks expand to multiple records', () => {
  const parse = adapterFor('claude').parse
  const out = parse(JSON.stringify({
    type: 'user', uuid: 'r2',
    message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tc1', content: 'a' },
      { type: 'tool_result', tool_use_id: 'tc2', content: 'b' },
    ] },
  }), meta)
  assert.ok(Array.isArray(out))
  assert.equal(out.length, 2)
  assert.deepEqual(out.map(r => r.meta.callId), ['tc1', 'tc2'])
})

test('Codex: message, reasoning, function_call + output pairing', () => {
  const parse = adapterFor('codex').parse
  const user = parse(JSON.stringify({
    type: 'response_item', ordinal: 0, timestamp: '2026-01-01T00:00:00Z',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
  }), meta)
  assert.equal(user.role, 'user')
  assert.equal(user.text, 'hello')

  const reasoning = parse(JSON.stringify({
    type: 'response_item', ordinal: 1,
    payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking' }] },
  }), meta)
  assert.equal(reasoning.text, '[reasoning] thinking')

  const call = parse(JSON.stringify({
    type: 'response_item', ordinal: 2,
    payload: { type: 'function_call', call_id: 'c1', name: 'bash', arguments: '{"cmd":"ls"}' },
  }), meta)
  assert.equal(call.meta.call.id, 'c1')
  assert.equal(call.meta.kind, 'function_call')

  const output = parse(JSON.stringify({
    type: 'response_item', ordinal: 3,
    payload: { type: 'function_call_output', call_id: 'c1', output: 'file.txt' },
  }), meta)
  assert.equal(output.meta.callId, 'c1')
  assert.equal(output.text, 'file.txt')
})

test('generic JSONL: role/content and dshSyncId dedupe', () => {
  const parse = adapterFor('jsonl').parse
  const row = parse(JSON.stringify({ role: 'assistant', content: 'answer', created_at: '2026-01-01T00:00:00Z' }), meta)
  assert.equal(row.role, 'assistant')
  assert.equal(row.text, 'answer')
  assert.ok(row.ts > 0)
  assert.equal(parse(JSON.stringify({ role: 'user', content: 'echo', dshSyncId: 'x' }), meta), undefined)
})

test('renderExternalLine emits a tagged, parseable line', () => {
  const line = renderExternalLine('jsonl', { role: 'user', text: 'from dsh', ts: 1000 }, 'sync-1')
  const obj = JSON.parse(line)
  assert.equal(obj.dshSyncId, 'sync-1')
  assert.equal(obj.content, 'from dsh')
  // our own line is skipped on re-import
  assert.equal(adapterFor('jsonl').parse(line, meta), undefined)
})

test('readJsonlDelta: incremental cursor, partial line buffering, rotation', async () => {
  const t = memoryTransport({ '/s.jsonl': '{"role":"user","content":"one"}\n{"role":"assistant"' })
  let cursor = {}
  let out = await readJsonlDelta(t, '/s.jsonl', 'jsonl', cursor)
  assert.equal(out.records.length, 1)
  assert.equal(out.records[0].text, 'one')
  assert.ok(out.cursor.pending.length > 0, 'partial line buffered')

  await t.append('/s.jsonl', ',"content":"two"}\n')
  out = await readJsonlDelta(t, '/s.jsonl', 'jsonl', out.cursor)
  assert.equal(out.records.length, 1)
  assert.equal(out.records[0].text, 'two')

  // rotation: file shrinks below cursor
  await t.write('/s.jsonl', '{"role":"user","content":"fresh"}\n')
  out = await readJsonlDelta(t, '/s.jsonl', 'jsonl', out.cursor)
  assert.equal(out.records.length, 1)
  assert.equal(out.records[0].text, 'fresh')
})

test('readJsonlDelta: absent file', async () => {
  const out = await readJsonlDelta(memoryTransport({}), '/missing.jsonl', 'jsonl', {})
  assert.equal(out.absent, true)
  assert.equal(out.records.length, 0)
})

// ---------------------------------------------------- WorkBuddy / CodeBuddy

test('workbuddy: messages, reasoning and function calls joined by callId', () => {
  const parse = adapterFor('workbuddy').parse
  const user = parse(JSON.stringify({
    type: 'message', id: 'm1', role: 'user', timestamp: 1700000000000,
    content: [{ type: 'input_text', text: 'list files' }],
  }), meta)
  assert.equal(user.role, 'user')
  assert.equal(user.text, 'list files')

  const call = parse(JSON.stringify({
    type: 'function_call', id: 'm2', callId: 'call-1', name: 'Bash',
    arguments: '{"command":"ls"}', timestamp: 1700000001000,
  }), meta)
  assert.equal(call.role, 'tool')
  assert.equal(call.meta.callId, 'call-1')
  assert.equal(call.meta.call.name, 'Bash')

  const result = parse(JSON.stringify({
    type: 'function_call_result', id: 'm2', callId: 'call-1', status: 'completed',
    output: [{ type: 'text', text: 'a.txt' }],
  }), meta)
  assert.equal(result.meta.callId, 'call-1')
  assert.equal(result.text, 'a.txt')

  // internal rows are skipped
  assert.equal(parse(JSON.stringify({ type: 'message', role: 'user', isMeta: true, content: 'x' }), meta), undefined)
  assert.equal(parse(JSON.stringify({ type: 'message', role: 'user', content: 'x', dshSyncId: 'y' }), meta), undefined)
})

test('workbuddy: render is re-importable-tagged', () => {
  const line = renderExternalLine('workbuddy', { role: 'assistant', text: 'hi', ts: 1 }, 'sync-w')
  const obj = JSON.parse(line)
  assert.equal(obj.dshSyncId, 'sync-w')
  assert.equal(obj.role, 'assistant')
  assert.equal(adapterFor('workbuddy').parse(line, meta), undefined)
})

// ------------------------------------------------------------------- TRAE

test('trae: user text comes from event_msg, history replay is skipped', () => {
  const parse = adapterFor('trae').parse
  const user = parse(JSON.stringify({
    timestamp: '2026-01-01T00:00:00Z', type: 'event_msg',
    payload: { type: 'user_message', message: 'real prompt' },
  }), meta)
  assert.equal(user.role, 'user')
  assert.equal(user.text, 'real prompt')

  // replaying old history must not duplicate messages
  const replay = parse(JSON.stringify({
    type: 'history_mutation', payload: { operation: 'replace', role: 'user', content: 'old' },
  }), meta)
  assert.equal(replay, undefined)

  // Codex-shaped rows pass through the Codex adapter
  const assistant = parse(JSON.stringify({
    timestamp: '2026-01-01T00:00:01Z', type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
  }), meta)
  assert.equal(assistant.role, 'assistant')
  assert.equal(assistant.text, 'done')
})

// -------------------------------------------------------------- Antigravity

test('antigravity: USER_REQUEST unwrapped, model + checkpoint handling', () => {
  const parse = adapterFor('antigravity').parse
  const user = parse(JSON.stringify({
    step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-01-01T00:00:00Z',
    content: '<USER_REQUEST>\nfix the bug\n</USER_REQUEST>\n<ADDITIONAL_METADATA>{"x":1}</ADDITIONAL_METADATA>',
  }), meta)
  assert.equal(user.role, 'user')
  assert.equal(user.text, 'fix the bug')

  const model = parse(JSON.stringify({
    step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-01-01T00:00:01Z',
    content: 'on it', tool_calls: [{ name: 'read_file', arguments: { path: 'a.js' } }],
  }), meta)
  assert.equal(model.role, 'assistant')
  assert.equal(model.meta.calls[0].name, 'read_file')

  assert.equal(parse(JSON.stringify({ source: 'SYSTEM', type: 'CHECKPOINT', content: 'x' }), meta), undefined)
})

test('antigravity: render writes the USER_REQUEST wrapper and is echo-safe', () => {
  const line = renderExternalLine('antigravity', { role: 'user', text: 'hello', ts: 1 }, 's1')
  const obj = JSON.parse(line)
  assert.equal(obj.source, 'USER_EXPLICIT')
  assert.match(obj.content, /<USER_REQUEST>[\s\S]*hello[\s\S]*<\/USER_REQUEST>/)
  // our own written line is never re-imported
  assert.equal(adapterFor('antigravity').parse(line, meta), undefined)
  // ...but the same shape without the tag parses back to the original text
  const foreign = { ...obj }
  delete foreign.dshSyncId
  const row = adapterFor('antigravity').parse(JSON.stringify(foreign), meta)
  assert.equal(row.text, 'hello')
  assert.equal(row.role, 'user')
})
