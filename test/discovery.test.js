import test from 'node:test'
import assert from 'node:assert/strict'
import { walk, scanMachine } from '../lib/discovery.js'
import { memoryTransport } from './helpers.js'

test('walk(): recursive listing honors depth, suffix predicate, dotfile/symlink skip', async () => {
  const t = memoryTransport({
    '/root/a.jsonl': '',
    '/root/sub/b.jsonl': '',
    '/root/sub/deep/c.jsonl': '',
    '/root/sub/deep/deeper/d.jsonl': '',
    '/root/.hidden.jsonl': '',
    '/root/not.txt': '',
  })
  const files = await walk(t, '/root', 2, (_e, p) => p.endsWith('.jsonl'))
  const names = files.map(f => f.path).sort()
  assert.deepEqual(names, ['/root/a.jsonl', '/root/sub/b.jsonl', '/root/sub/deep/c.jsonl'])
  assert.ok(!names.some(n => n.includes('.hidden')))
  assert.ok(!names.some(n => n.includes('deeper')))
})

test('scanMachine(): finds Claude/Codex/DeepSeek roots with metadata', async () => {
  const home = '/home/tester'
  const t = memoryTransport({
    [`${home}/.claude/projects/proj/s1.jsonl`]:
      '{"type":"user","sessionId":"s1","message":{"role":"user","content":[{"type":"text","text":"hello claude"}]}}\n',
    [`${home}/.codex/sessions/2026/01/01/rollout-x.jsonl`]:
      '{"type":"session_meta","payload":{"session_id":"thread-1"}}\n' +
      '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello codex"}]}}\n',
    [`${home}/.dsh-conversation-sync/exports/export.zip`]: 'PK\x03\x04fake',
  })
  const { machineId, sessions, errors } = await scanMachine({ id: 'local' }, { transport: t, home })
  assert.equal(machineId, 'local')
  assert.deepEqual(errors, [])
  const kinds = sessions.map(s => s.kind).sort()
  assert.deepEqual(kinds, ['claude', 'codex', 'deepseekExport'])
  const claude = sessions.find(s => s.kind === 'claude')
  assert.equal(claude.name, 's1')
  assert.equal(claude.preview, 'hello claude')
  assert.equal(claude.count, 1)
  const codex = sessions.find(s => s.kind === 'codex')
  assert.equal(codex.name, 'thread-1')
  assert.equal(codex.preview, 'hello codex')
})

test('scanMachine(): absent tool roots are silent, not errors', async () => {
  // A machine that simply runs none of these tools must not look broken: only
  // real failures (permissions, IO) are surfaced to the user.
  const { sessions, errors } = await scanMachine({ id: 'ssh:empty' }, {
    transport: memoryTransport({}, { home: '/home/empty' }), home: '/home/empty',
  })
  assert.deepEqual(sessions, [])
  assert.deepEqual(errors, [])
})

test('scanMachine(): a real read failure is still reported', async () => {
  const transport = memoryTransport({}, { home: '/home/broken' })
  transport.list = async () => { const error = new Error('permission denied'); error.code = 'EACCES'; throw error }
  const { errors } = await scanMachine({ id: 'ssh:broken' }, { transport, home: '/home/broken' })
  assert.ok(errors.length > 0)
  assert.match(errors[0], /permission denied/)
})
