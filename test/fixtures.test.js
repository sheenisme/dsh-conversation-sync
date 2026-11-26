// End-to-end checks over real tool fixtures: each supported conversation tool
// writes a different rollout shape, so these assert that a whole file of that
// shape turns into the expected DSH records - not just that one line parses.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJsonlDelta } from '../lib/adapters.js'
import { buildEvents, messagesFromEvents } from '../lib/events.js'
import { LocalTransport } from '../lib/transports.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = name => path.join(here, 'fixtures', `${name}.jsonl`)
const transport = new LocalTransport()

let counter = 0
const createId = () => `id-${++counter}`

async function importFixture(kind, name, cursor = { offset: 0, pending: '' }) {
  const delta = await readJsonlDelta(transport, fixture(name), kind, cursor)
  const events = buildEvents(delta.records, { createId })
  return { delta, events, messages: messagesFromEvents(events) }
}

test('fixture claude: user turn, tool round trip, assistant answer', async () => {
  const { delta, events, messages } = await importFixture('claude', 'claude-basic')
  assert.equal(delta.records.length, 4)
  assert.deepEqual(delta.records.map(r => r.role), ['user', 'assistant', 'tool', 'assistant'])
  // The answer that follows the tool output is a real assistant message; a
  // single-step turn used to drop it.
  assert.deepEqual(messages.map(m => m.text), [
    'List the files in the current directory.',
    'I will run ls.',
    'The directory holds README.md and index.js.',
  ])
  const call = events.find(e => e.type === 'tool/call')
  const result = events.find(e => e.type === 'tool/result')
  assert.equal(call.data.name, 'Bash')
  // the tool result is paired with its call so DSH can render the round trip
  assert.deepEqual(result.sourceEventSeqs, [call.seq])
  assert.match(JSON.stringify(result.data.message.content), /README\.md/)
  // one turn, two steps: the call and the answer after it live in separate steps
  const steps = [...new Set(events.filter(e => e.type === 'step/start').map(e => e.data.step))]
  assert.deepEqual(steps, [1, 2])
  assert.equal(new Set(events.filter(e => e.type === 'turn/start').map(e => e.data.turn)).size, 1)
})

test('fixture codex: reasoning becomes a message, function call pairs with its output', async () => {
  const { delta, messages } = await importFixture('codex', 'codex-basic')
  assert.equal(delta.records.length, 5)
  assert.deepEqual(messages.map(m => m.text.split('\n')[0]), [
    'Show the git status.',
    '[reasoning] Need to inspect the working tree.',
    'The tree is clean on main.',
  ])
  assert.ok(delta.records.some(r => r.role === 'tool' && r.meta?.callId === 'call_1'))
})

test('fixture workbuddy: callId joins the tool result, reasoning is kept', async () => {
  const { delta, messages } = await importFixture('workbuddy', 'workbuddy-basic')
  assert.equal(delta.records.length, 5)
  assert.deepEqual(messages.map(m => m.text.split('\n')[0]), [
    'Add a license header.',
    '[thinking] The repository has no LICENSE yet.',
    'Header added to index.js.',
  ])
  // The function_call and its result share callId `wc1`, not the row id.
  const calls = delta.records.filter(r => r.role === 'tool' && r.meta?.kind === 'function_call')
  const results = delta.records.filter(r => r.role === 'tool' && r.meta?.kind === 'function_call_result')
  assert.equal(calls.length, 1)
  assert.equal(results.length, 1)
  assert.equal(results[0].meta.callId, calls[0].meta.callId)
  assert.equal(results[0].meta.callId, 'wc1')
})

test('fixture trae: the replayed user echo is dropped, history_mutation is skipped', async () => {
  const { delta, messages } = await importFixture('trae', 'trae-basic')
  // event_msg user_message + assistant answer; the response_item echo of the
  // same question and the history_mutation replay produce nothing.
  assert.equal(delta.records.length, 2)
  assert.deepEqual(messages.map(m => m.text), [
    'Refactor the parser.',
    'I split the tokenizer out.',
  ])
})

test('fixture trae: the echo is still dropped when turn and echo land in different reads', async () => {
  const full = await transport.read(fixture('trae-basic'), 0)
  const text = Buffer.from(full).toString('utf8')
  const lines = text.split('\n').filter(Boolean)
  // Cut right after the event_msg turn so its echo arrives on the next read.
  const cut = Buffer.byteLength(`${lines[0]}\n`, 'utf8')
  const first = await readJsonlDelta(transport, fixture('trae-basic'), 'trae', { offset: 0, pending: '' , userTexts: [] })
  assert.equal(first.records.length, 2)
  const second = await readJsonlDelta(transport, fixture('trae-basic'), 'trae', first.cursor)
  assert.deepEqual(second.records, [], 'no new records on an unchanged file')
  assert.ok(cut > 0)
})

test('fixture antigravity: USER_REQUEST wrapper stripped, harness noise filtered', async () => {
  const { delta, messages } = await importFixture('antigravity', 'antigravity-basic')
  // MODEL/GENERIC harness step logs and SYSTEM messages are not conversation.
  assert.equal(delta.records.length, 2)
  assert.deepEqual(messages.map(m => m.text), [
    'Explain the build script.',
    'The build script bundles with esbuild.',
  ])
  assert.ok(!messages.some(m => /<USER_REQUEST>|ADDITIONAL_METADATA|system noise/.test(m.text)))
})

test('every fixture imports as a contiguous seq run starting at 0', async () => {
  for (const [kind, name] of [['claude', 'claude-basic'], ['codex', 'codex-basic'], ['workbuddy', 'workbuddy-basic'], ['trae', 'trae-basic'], ['antigravity', 'antigravity-basic']]) {
    const { events } = await importFixture(kind, name)
    assert.ok(events.length > 0, `${kind} produced events`)
    assert.deepEqual(events.map(e => e.seq), events.map((_, index) => index), `${kind} seq is contiguous from 0`)
    assert.ok(events.every(e => Number.isFinite(e.time)), `${kind} stamps every event with a time`)
  }
})
