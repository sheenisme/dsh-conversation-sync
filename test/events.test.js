import test from 'node:test'
import assert from 'node:assert/strict'
import { EventBuilder, pairTurns, buildEvents, messagesFromEvents, toLiveInput } from '../lib/events.js'

let n = 0
const createId = () => `id-${++n}`

/** Every durable message a v4 event carries in its declared message slots. */
function messagesOf(event) {
  const data = event?.data
  if (!data) return []
  if (event.type === 'user/message') return [data]
  if (['system/message', 'assistant/message', 'tool/result'].includes(event.type)) return data.message ? [data.message] : []
  return []
}

test('EventBuilder: contiguous seq and monotonic time', () => {
  const b = new EventBuilder({ createId })
  b.add({ type: 'turn/start', data: {} }, 100)
  b.add({ type: 'step/start', data: {} }, 50) // earlier time clamps to 100
  b.add({ type: 'step/end', data: {} }, 200)
  assert.deepEqual(b.events.map(e => e.seq), [0, 1, 2])
  assert.deepEqual(b.events.map(e => e.time), [100, 100, 200])
  assert.equal(b.nextSeq, 3)
})

test('turn(): full lifecycle incl. protected head, tool call/result pairing', () => {
  const b = new EventBuilder({ createId })
  b.turn({
    turn: 1, ts: 1000,
    user: { text: 'do it' },
    assistant: { text: 'ok', ts: 1001, meta: { calls: [{ id: 'c1', name: 'Bash', arguments: '{}' }] } },
    tools: [{ role: 'tool', text: 'done', meta: { callId: 'c1', content: [{ type: 'text', text: 'done' }] }, ts: 1002 }],
  })
  const types = b.events.map(e => e.type)
  assert.deepEqual(types, [
    'turn/start', 'step/start', 'system/message', 'user/message', 'assistant/message',
    'tool/call', 'tool/result', 'step/end', 'turn/end',
  ])
  // protected head carries a producer-owned source kind: v4 refuses the
  // retired `{kind:'plugin', plugin}` wrapper with
  // "format v4 message requires a producer-owned source kind".
  assert.equal(b.events[2].surfaceOp, 'append')
  assert.deepEqual(b.events[2].data.message.source, { kind: 'system-prompt' })
  for (const event of b.events) {
    for (const message of messagesOf(event)) {
      assert.notEqual(message.source?.kind, 'plugin', `${event.type} keeps the retired V3 plugin wrapper`)
      assert.ok(message.source?.kind, `${event.type} has a source kind`)
    }
  }
  assert.deepEqual(b.events[3].data.source, { kind: 'user' })
  assert.deepEqual(b.events[4].data.message.source, { kind: 'model', provider: 'import', model: 'imported' })
  const call = b.events.find(e => e.type === 'tool/call')
  const result = b.events.find(e => e.type === 'tool/result')
  assert.equal(call.data.callId, 'c1')
  assert.deepEqual(result.sourceEventSeqs, [call.seq])
  assert.equal(result.surfaceOp, 'append')
})

// V4 rejects the released V3 wrapper shape outright, so a conversation with any
// tool call would fail to import without this exact structure.
test('turn(): tool/result is a first-class tool-role message, not the V3 wrapper', () => {
  const b = new EventBuilder({ createId })
  b.turn({
    turn: 1, ts: 1, user: { text: 'q' },
    assistant: { text: 'a', meta: { calls: [{ id: 'call_9', name: 'Bash', arguments: '{}' }] } },
    tools: [{ role: 'tool', text: 'output line', meta: { callId: 'call_9', content: [{ type: 'text', text: 'output line' }] }, ts: 2 }],
  })
  const result = b.events.find(e => e.type === 'tool/result')
  const message = result.data.message
  assert.equal(message.role, 'tool', 'tool/result message must have role "tool"')
  assert.equal(message.toolCallId, 'call_9')
  assert.equal(message.source.kind, 'tool')
  assert.equal(message.source.callId, message.toolCallId, 'toolCallId must match the source callId')
  // The released wrapper would be a single {type:'tool-result'} block.
  assert.ok(Array.isArray(message.content))
  assert.ok(!message.content.some(block => block?.type === 'tool-result'), 'must not contain a tool-result wrapper')
  assert.equal(message.content[0].type, 'text')
  assert.equal(message.content[0].text, 'output line')
})

test('turn(): a failed tool call marks the result as an error', () => {
  const b = new EventBuilder({ createId })
  b.turn({
    turn: 1, ts: 1, user: { text: 'q' },
    assistant: { text: 'a', meta: { calls: [{ id: 'call_e', name: 'Bash', arguments: '{}' }] } },
    tools: [{ role: 'tool', text: 'boom', meta: { callId: 'call_e', content: [{ type: 'text', text: 'boom' }], isError: true }, ts: 2 }],
  })
  const result = b.events.find(e => e.type === 'tool/result')
  assert.equal(result.data.message.isError, true)
  assert.ok(result.data.error, 'error metadata accompanies a failed result')
})

test('turn(): unanswered tool/call still gets an empty result', () => {
  const b = new EventBuilder({ createId })
  b.turn({
    turn: 1, ts: 1, user: { text: 'q' },
    assistant: { text: 'a', meta: { calls: [{ id: 'c2', name: 'X', arguments: '{}' }] } },
    tools: [],
  })
  const result = b.events.find(e => e.type === 'tool/result')
  assert.ok(result)
  // An unanswered call still closes, so resume/migration cannot fail, and it
  // closes with empty content rather than fabricated output.
  assert.equal(result.data.message.role, 'tool')
  assert.equal(result.data.message.toolCallId, 'c2')
  assert.deepEqual(result.data.message.content, [])
})

test('turn(): only first turn emits protected system head', () => {
  const b = new EventBuilder({ createId })
  b.turn({ turn: 1, ts: 1, user: { text: 'a' }, assistant: { text: 'b' } })
  b.turn({ turn: 2, ts: 2, user: { text: 'c' }, assistant: { text: 'd' } })
  assert.equal(b.events.filter(e => e.type === 'system/message').length, 1)
})

test('pairTurns(): tool after assistant attaches to that turn', () => {
  const records = [
    { role: 'user', text: 'u1', ts: 1 },
    { role: 'assistant', text: 'a1', ts: 2 },
    { role: 'tool', text: 't1', ts: 3 },
    { role: 'user', text: 'u2', ts: 4 },
  ]
  const turns = pairTurns(records)
  assert.equal(turns.length, 2)
  assert.equal(turns[0].steps.length, 1)
  assert.equal(turns[0].steps[0].tools.length, 1)
  assert.equal(turns[0].steps[0].assistant.text, 'a1')
  assert.equal(turns[1].user.text, 'u2')
})

test('pairTurns(): every assistant response keeps its own step in one turn', () => {
  // A tool round trip is step 1 (answer + tool call), and the final answer that
  // reads the tool output is step 2. Both must survive.
  const records = [
    { role: 'user', text: 'q', ts: 1 },
    { role: 'assistant', text: 'call', ts: 2 },
    { role: 'tool', text: 'out', ts: 3 },
    { role: 'assistant', text: 'final', ts: 4 },
  ]
  const turns = pairTurns(records)
  assert.equal(turns.length, 1)
  assert.deepEqual(turns[0].steps.map(s => s.assistant.text), ['call', 'final'])
  assert.equal(turns[0].steps[0].tools.length, 1)
  assert.equal(turns[0].steps[1].tools.length, 0)
})

test('buildEvents(): startSeq/startTurn honored and seq contiguous', () => {
  const events = buildEvents([{ role: 'user', text: 'hi', ts: 1 }], { startSeq: 10, startTurn: 3, createId })
  assert.equal(events[0].seq, 10)
  assert.equal(events[0].data.turn, 3)
  for (let i = 1; i < events.length; i++) assert.equal(events[i].seq, events[i - 1].seq + 1)
})

test('buildEvents(): an appended batch does not repeat the protected system head', () => {
  // Only the session's first turn carries the system/message head. Repeating it
  // on an append is a second head in the middle of the log, and the backend
  // rejects the append.
  const first = buildEvents([{ role: 'user', text: 'one', ts: 1 }], { startTurn: 1, createId })
  assert.equal(first.filter(event => event.type === 'system/message').length, 1)
  const appended = buildEvents([{ role: 'user', text: 'two', ts: 2 }], { startSeq: first.length, startTurn: 2, createId })
  assert.equal(appended.filter(event => event.type === 'system/message').length, 0)
  assert.equal(appended[0].data.turn, 2)
})

test('messagesFromEvents(): extracts user/assistant text, skips system/tool', () => {
  const b = new EventBuilder({ createId })
  b.turn({ turn: 1, ts: 1, user: { text: 'hello' }, assistant: { text: 'world' } })
  const msgs = messagesFromEvents(b.events)
  assert.deepEqual(msgs.map(m => m.role), ['user', 'assistant'])
  assert.deepEqual(msgs.map(m => m.text), ['hello', 'world'])
})

test('toLiveInput(): preserves surfaceOp and sourceEventSeqs in opts', () => {
  const surface = toLiveInput({ type: 'user/message', data: { x: 1 }, surfaceOp: 'append' })
  assert.deepEqual(surface, ['user/message', { x: 1 }, { surfaceOp: 'append' }])
  const withSource = toLiveInput({ type: 'tool/result', data: {}, surfaceOp: 'append', sourceEventSeqs: [5] })
  assert.deepEqual(withSource[2], { surfaceOp: 'append', sourceEventSeqs: [5] })
  const plain = toLiveInput({ type: 'turn/start', data: {} })
  assert.equal(plain.length, 2)
})

// V4 refuses a tool/call that was never advertised as a tool-call content block
// on the assistant message ("has no advertised tool lifecycle"), which makes the
// written log unreadable. Every call must be announced there first.
test('turn(): tool calls are advertised on the assistant message before tool/call', () => {
  const b = new EventBuilder({ createId })
  b.turn({
    turn: 1, ts: 1, user: { text: 'q' },
    assistant: { text: 'a', meta: { calls: [{ id: 'call_a', name: 'Bash', arguments: '{"command":"ls"}' }] } },
    tools: [{ role: 'tool', text: 'ok', meta: { callId: 'call_a', content: [{ type: 'text', text: 'ok' }] }, ts: 2 }],
  })
  const assistant = b.events.find(e => e.type === 'assistant/message')
  const block = assistant.data.message.content.find(part => part.type === 'tool-call')
  assert.ok(block, 'assistant message must advertise the tool call')
  assert.equal(block.id, 'call_a')
  assert.equal(block.name, 'Bash')
  assert.equal(block.arguments, '{"command":"ls"}')
  // The advertised id/name/arguments must match the later tool/call row exactly.
  const call = b.events.find(e => e.type === 'tool/call')
  assert.equal(call.data.callId, block.id)
  assert.equal(call.data.name, block.name)
  assert.equal(call.data.arguments, block.arguments)
})

test('turn(): an assistant message alone still carries only text', () => {
  const b = new EventBuilder({ createId })
  b.turn({ turn: 1, ts: 1, user: { text: 'q' }, assistant: { text: 'plain' } })
  const assistant = b.events.find(e => e.type === 'assistant/message')
  assert.deepEqual(assistant.data.message.content, [{ type: 'text', text: 'plain' }])
})
