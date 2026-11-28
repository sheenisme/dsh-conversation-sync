import test from 'node:test'
import assert from 'node:assert/strict'
import { renderSessionLines } from '../lib/native.js'
import { readJsonlDelta } from '../lib/adapters.js'
import { buildEvents, messagesFromEvents } from '../lib/events.js'

const memory = files => {
  const store = new Map(Object.entries(files))
  return {
    kind: 'memory',
    async stat(file) {
      const value = store.get(file)
      return value === undefined ? undefined : { size: Buffer.byteLength(value), mtimeMs: 1 }
    },
    async read(file) {
      const value = store.get(file)
      if (value === undefined) throw Object.assign(new Error('no such file'), { code: 'ENOENT' })
      return Buffer.from(value)
    },
    async write(file, data) { store.set(file, data) },
    async home() { return '/home/tester' },
    file: name => store.get(name),
  }
}

const exchanges = [
  { seq: 1, time: 1_700_000_000_000, role: 'user', text: 'List the files.' },
  { seq: 2, time: 1_700_000_001_000, role: 'assistant', text: 'I will run ls.', calls: [{ id: 'call_1', name: 'Bash', arguments: '{"command":"ls"}' }] },
  { seq: 3, time: 1_700_000_002_000, role: 'tool', callId: 'call_1', text: 'README.md\nindex.js' },
  { seq: 4, time: 1_700_000_003_000, role: 'assistant', text: 'Two files.' },
]

const parseAll = async (kind, text) => {
  const transport = memory({ '/tmp/x.jsonl': text })
  const delta = await readJsonlDelta(transport, '/tmp/x.jsonl', kind, { offset: 0, pending: '' })
  return delta.records
}

test('claude: native lines carry the envelope the CLI itself writes', () => {
  const text = renderSessionLines('claude', exchanges, { sessionId: 'sess-1', title: 'Demo', cwd: '/work' })
  const lines = text.trim().split('\n').map(line => JSON.parse(line))
  assert.equal(lines.length, 4)
  const [user, assistant, result, answer] = lines
  // parentUuid chains every line to the previous one, first is null
  assert.equal(user.parentUuid, null)
  assert.equal(assistant.parentUuid, user.uuid)
  assert.equal(result.parentUuid, assistant.uuid)
  assert.equal(answer.parentUuid, result.uuid)
  assert.equal(user.cwd, '/work')
  assert.equal(user.sessionId, 'sess-1')
  assert.equal(user.type, 'user')
  // the assistant carries a real message object with a model and tool_use block
  assert.equal(assistant.message.role, 'assistant')
  assert.equal(assistant.message.model, 'dsh')
  assert.equal(assistant.message.stop_reason, 'tool_use')
  const use = assistant.message.content.find(block => block.type === 'tool_use')
  assert.equal(use.id, 'call_1')
  assert.equal(use.name, 'Bash')
  assert.deepEqual(use.input, { command: 'ls' })
  // the tool result is a user-role line with a tool_result block, as Claude does
  assert.equal(result.type, 'user')
  assert.equal(result.message.content[0].type, 'tool_result')
  assert.equal(result.message.content[0].tool_use_id, 'call_1')
  assert.equal(result.message.content[0].content, 'README.md\nindex.js')
})

test('claude: our own lines round-trip through the parser', async () => {
  // Drop our marker so this exercises the SHAPE, not the self-import guard.
  const text = renderSessionLines('claude', exchanges, { sessionId: 'sess-1', title: 'Demo' })
    .trim().split('\n')
    .map(line => { const obj = JSON.parse(line); delete obj.dshSyncId; delete obj.dshTitle; return JSON.stringify(obj) })
    .join('\n') + '\n'
  const records = await parseAll('claude', text)
  const messages = messagesFromEvents(buildEvents(records, { createId: (() => { let n = 0; return () => `id-${++n}` })() }))
    .filter(message => message.role === 'user' || message.role === 'assistant')
  assert.deepEqual(messages.map(message => message.text), [
    'List the files.',
    'I will run ls.',
    'Two files.',
  ])
})

test('codex: a rollout opens with session_meta and numbers every item', () => {
  const text = renderSessionLines('codex', exchanges, { sessionId: 'sess-2', title: 'Demo', cwd: '/work' })
  const lines = text.trim().split('\n').map(line => JSON.parse(line))
  const header = lines[0]
  assert.equal(header.type, 'session_meta')
  assert.equal(header.ordinal, 1)
  assert.equal(header.payload.session_id, 'sess-2')
  assert.equal(header.payload.cwd, '/work')
  const items = lines.slice(1)
  assert.deepEqual(items.map(item => item.ordinal), items.map((_, index) => index + 2))
  assert.deepEqual(items.map(item => item.payload.type), [
    'message', 'message', 'function_call', 'function_call_output', 'message',
  ])
  // the call and its output are joined by one call_id
  const call = items.find(item => item.payload.type === 'function_call')
  const output = items.find(item => item.payload.type === 'function_call_output')
  assert.equal(call.payload.call_id, 'call_1')
  assert.equal(output.payload.call_id, call.payload.call_id)
  assert.equal(call.payload.name, 'Bash')
})

test('codex: appending does not write a second session_meta', () => {
  const high = text => Math.max(...text.trim().split('\n').map(line => JSON.parse(line).ordinal))
  const first = renderSessionLines('codex', exchanges.slice(0, 2), { sessionId: 'sess-3', withHeader: true })
  const second = renderSessionLines('codex', exchanges.slice(2), { sessionId: 'sess-3', withHeader: false, ordinalOffset: high(first) })
  const lines = `${first}${second}`.trim().split('\n').map(line => JSON.parse(line))
  assert.equal(lines.filter(line => line.type === 'session_meta').length, 1)
  // ordinals keep ascending across the append
  const ordinals = lines.map(line => line.ordinal)
  assert.equal(new Set(ordinals).size, ordinals.length)
  assert.deepEqual(ordinals, [...ordinals].sort((a, b) => a - b))
})

test('codex: our own lines round-trip, including the tool pair', async () => {
  // Strip our marker first: a line we wrote is deliberately ignored on import,
  // and this test is about whether the SHAPE survives a reader that does not
  // know our marker (which is what Codex itself is).
  const text = renderSessionLines('codex', exchanges, { sessionId: 'sess-4' })
    .trim().split('\n')
    .map(line => { const obj = JSON.parse(line); delete obj.dshSyncId; delete obj.dshTitle; return JSON.stringify(obj) })
    .join('\n') + '\n'
  const records = await parseAll('codex', text)
  const roles = records.map(record => record.role)
  assert.deepEqual(roles, ['user', 'assistant', 'tool', 'tool', 'assistant'])
  const call = records.find(record => record.meta?.kind === 'function_call')
  const output = records.find(record => record.meta?.kind === 'function_call_output')
  assert.equal(call.meta.callId, 'call_1')
  assert.equal(output.meta.callId, call.meta.callId)
  const events = buildEvents(records, { createId: (() => { let n = 0; return () => `id-${++n}` })() })
  const result = events.find(event => event.type === 'tool/result')
  assert.equal(result.data.message.role, 'tool')
  assert.equal(result.data.message.toolCallId, 'call_1')
  assert.deepEqual(result.sourceEventSeqs, [events.find(event => event.type === 'tool/call').seq])
})

test('every rendered line is tagged so an import never eats our own output', async () => {
  for (const kind of ['claude', 'codex', 'jsonl', 'workbuddy', 'antigravity']) {
    const text = renderSessionLines(kind, exchanges, { sessionId: 'sess-5' })
    const first = JSON.parse(text.trim().split('\n')[0])
    assert.equal(typeof first.dshSyncId, 'string', `${kind} line must carry dshSyncId`)
  }
  // and the JSONL reader drops them instead of re-importing
  const text = renderSessionLines('claude', exchanges, { sessionId: 'sess-6' })
  assert.deepEqual(await parseAll('claude', text), [])
})

test('workbuddy: message + function_call/result rows joined by callId', async () => {
  const text = renderSessionLines('workbuddy', exchanges, { sessionId: 'sess-7' })
  const lines = text.trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(lines.map(line => line.type), ['message', 'message', 'function_call', 'function_call_result', 'message'])
  const call = lines.find(line => line.type === 'function_call')
  const result = lines.find(line => line.type === 'function_call_result')
  assert.equal(call.callId, 'call_1')
  assert.equal(result.callId, call.callId)
  assert.equal(typeof lines[0].timestamp, 'number')
  // and our own reader gets the same conversation back
  const stripped = text.trim().split('\n')
    .map(line => { const obj = JSON.parse(line); delete obj.dshSyncId; return JSON.stringify(obj) }).join('\n') + '\n'
  const records = await parseAll('workbuddy', stripped)
  const built = buildEvents(records, { createId: (() => { let n = 0; return () => `id-${++n}` })() })
  const texts = messagesFromEvents(built).map(message => message.text)
  assert.deepEqual(texts, ['List the files.', 'I will run ls.', 'Two files.'])
})

test('antigravity: steps are numbered and user text keeps the wrapper', () => {
  const text = renderSessionLines('antigravity', exchanges, { sessionId: 'sess-8' })
  const lines = text.trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(lines.map(line => line.step_index), lines.map((_, index) => index + 1))
  const user = lines[0]
  assert.equal(user.source, 'USER_EXPLICIT')
  assert.equal(user.type, 'USER_INPUT')
  assert.match(user.content, /<USER_REQUEST>\nList the files\.\n<\/USER_REQUEST>/)
  const model = lines[1]
  assert.equal(model.source, 'MODEL')
  assert.equal(model.type, 'PLANNER_RESPONSE')
  assert.equal(model.tool_calls[0].name, 'Bash')
  assert.deepEqual(model.tool_calls[0].args, { command: 'ls' })
})

test('native writers never invent a turn from a tool result', () => {
  // A tool row must not become a plain-text user message in any format: that
  // would fabricate a question the user never asked. Claude Code does store a
  // tool result on a `type:'user'` line, but ONLY as a `tool_result` block -
  // that is the shape we must keep, so check the block, not the line type.
  for (const kind of ['claude', 'codex', 'workbuddy', 'antigravity']) {
    const only = renderSessionLines(kind, [exchanges[2]], { sessionId: 'sess-9', withHeader: false })
    const parsed = only.trim().split('\n').map(line => JSON.parse(line))
    if (kind === 'claude') {
      const blocks = parsed[0].message.content
      assert.equal(parsed[0].type, 'user')
      assert.deepEqual(blocks.map(block => block.type), ['tool_result'])
      assert.equal(blocks[0].tool_use_id, 'call_1')
      continue
    }
    if (kind === 'antigravity') {
      // antigravity has no user-role field; the tool row is a SYSTEM step
      assert.equal(parsed[0].source, 'SYSTEM', 'antigravity tool row must be SYSTEM')
      continue
    }
    if (kind === 'codex') {
      assert.equal(parsed[0].payload.type, 'function_call_output')
      continue
    }
    assert.equal(parsed[0].type, 'function_call_result')
  }
})
