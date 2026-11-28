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

test('scanMachine(): a session carries a human title and a readable preview', async () => {
  // A rollout is named after a UUID or a timestamp, which tells a reader
  // nothing. The title is the first thing the user said; the preview shows a
  // few lines of both sides so two similar sessions can be told apart.
  const home = '/home/tester'
  const t = memoryTransport({
    [`${home}/.claude/projects/proj/uuid-1234.jsonl`]:
      '{"type":"user","sessionId":"s1","message":{"role":"user","content":[{"type":"text","text":"Refactor the tokenizer"}]}}\n' +
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I will split it out."}]}}\n' +
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Also add a test"}]}}\n',
  })
  const { sessions } = await scanMachine({ id: 'local' }, { transport: t, home })
  const session = sessions.find(s => s.kind === 'claude')
  // The name is the tool's own session id (here `sessionId` from the rollout,
  // normally a UUID); the file stem is only a fallback.
  assert.equal(session.name, 's1', 'the internal id is still the name')
  assert.equal(session.title, 'Refactor the tokenizer')
  assert.match(session.preview, /Refactor the tokenizer/)
  assert.match(session.preview, /I will split it out\./)
  assert.match(session.preview, /Also add a test/)
})

test('scanMachine(): a rollout with no readable text still lists, with an empty preview', async () => {
  const home = '/home/tester'
  const t = memoryTransport({
    [`${home}/.codex/sessions/2026/01/01/rollout-y.jsonl`]:
      '{"type":"session_meta","payload":{"session_id":"thread-2"}}\n' +
      '{"type":"response_item","payload":{"type":"compaction","encrypted_content":"gAAAA"}}\n',
  })
  const { sessions, errors } = await scanMachine({ id: 'local' }, { transport: t, home })
  assert.deepEqual(errors, [])
  const session = sessions.find(s => s.kind === 'codex')
  assert.equal(session.title, '')
  assert.equal(session.preview, '')
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

test('scanMachine(): a bad SSH key is reported as a key problem, not as "cannot resolve home"', async () => {
  // Regression: transport.home() used to be the first call, so every connect
  // failure — including "cannot read the SSH private key ..." — was rewritten
  // as "cannot resolve home: ENOENT open '.../key.pem'". That pointed the user
  // at the remote home directory when the real fault was the local key path.
  const transport = memoryTransport({}, { home: undefined })
  const keyError = new Error("cannot read the SSH private key '/home/me/.ssh/k.pem': no such file — check the path")
  keyError.code = 'ENOENT'
  keyError.keyPath = '/home/me/.ssh/k.pem'
  transport.home = async () => { throw keyError }
  const { errors } = await scanMachine({ id: 'ssh:box' }, { transport })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /cannot read the SSH private key/)
  assert.ok(!/cannot resolve home/.test(errors[0]))
})

test('scanMachine(): a genuine home-resolution failure still says so', async () => {
  const transport = memoryTransport({}, { home: undefined })
  transport.home = async () => { throw new Error('sftp: realpath failed') }
  const { errors } = await scanMachine({ id: 'ssh:box' }, { transport })
  assert.match(errors[0], /cannot resolve home: sftp: realpath failed/)
})

test('scanMachine(): an unreachable machine reports once and stops probing roots', async () => {
  // Regression: a refused/timed-out connection used to be retried for the home
  // directory and then for every tool root, so one dead host cost four full
  // connect attempts (~70-110s against real hosts) and produced four copies of
  // the same error.
  const transport = memoryTransport({}, { home: undefined })
  let attempts = 0
  const refused = new Error('ssh: connect to host 10.0.0.9 port 22: Connection refused')
  refused.code = 'ECONNREFUSED'
  transport.home = async () => { attempts++; throw refused }
  transport.list = async () => { attempts++; throw refused }
  const { sessions, errors } = await scanMachine({ id: 'ssh:dead' }, { transport })
  assert.deepEqual(sessions, [])
  assert.equal(errors.length, 1)
  assert.match(errors[0], /Connection refused/)
  assert.equal(attempts, 1)
})

test('scanMachine(): a transport error code is not rewritten as a home problem', async () => {
  const transport = memoryTransport({}, { home: undefined })
  const auth = new Error('ubuntu@10.0.0.9: Permission denied (publickey).')
  auth.code = 'EAUTH'
  transport.home = async () => { throw auth }
  const { errors } = await scanMachine({ id: 'ssh:box' }, { transport })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /Permission denied/)
  assert.ok(!/cannot resolve home/.test(errors[0]))
})

test('scanMachine(): a transport with inspect()/findFiles() is used, not a chunked read', async () => {
  // This is the shape that makes a remote scan finish: one round trip for the
  // tree and one per file, instead of one directory listing per level plus a
  // 256 KB-at-a-time read of up to 8 MB for every file.
  const calls = { findFiles: 0, inspect: 0, walk: 0, read: 0 }
  const files = {
    '/home/u/.claude/projects/p/one.jsonl': '{"sessionId":"s1","type":"user","message":{"role":"user","content":"hello"}}\n',
  }
  const transport = {
    kind: 'ssh',
    calls,
    _store: files,
    async home() { return '/home/u' },
    async findFiles(dir, depth, suffix) {
      calls.findFiles++
      const prefix = `${dir}/`
      if (!Object.keys(files).some(f => f.startsWith(prefix))) return undefined
      return Object.keys(files).filter(f => f.startsWith(prefix) && f.endsWith(suffix))
        .map(full => ({ path: full, name: full.split('/').pop(), isDirectory: false }))
    },
    async inspect(file) {
      calls.inspect++
      const body = files[file]
      if (body === undefined) return undefined
      return { size: body.length, mtimeMs: 1700000000000, count: body.split('\n').length - 1, head: Buffer.from(body) }
    },
    // Only the OpenCode database probe is allowed to stat(); a session file must
    // not be, because inspect() already answered everything about it.
    async stat(file) {
      if (file.endsWith('opencode.db')) return undefined
      throw new Error(`stat(${file}) should not be needed when inspect() exists`)
    },
    async read() { calls.read++; throw new Error('read() should not be needed when inspect() exists') },
    async list() { calls.walk++; return [] },
    async close() {},
  }
  const { sessions, errors } = await scanMachine({ id: 'ssh:u' }, { transport })
  assert.deepEqual(errors, [])
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].count, 1)
  assert.equal(sessions[0].kind, 'claude')
  // One find per root (8 tool roots + 3 Antigravity bases), one inspect per file.
  // The point of the assertion: no per-directory listing and no chunked read.
  assert.deepEqual(calls, { findFiles: 11, inspect: 1, walk: 0, read: 0 })
})
