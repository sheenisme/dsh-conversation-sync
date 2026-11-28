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
  // 8 tool roots + archived_sessions + 3 antigravity bases
  assert.deepEqual(calls, { findFiles: 12, inspect: 1, walk: 0, read: 0 })
})

test('describe(): text the tool injected in the user seat is not a title', async () => {
  // Codex puts the environment, AGENTS.md and its own briefs into role:"user"
  // messages before the person types anything. A title taken from those made
  // every row read "<environment_context> <cwd>/Users/..." - the count was
  // right and the list was useless.
  const file = '/home/tester/.codex/sessions/s.jsonl'
  const transport = memoryTransport({
    [file]: [
      JSON.stringify({ type: 'session_meta', payload: { session_id: 'abc', thread_source: 'user' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/x</cwd>\n</environment_context>' }] } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /x\n<INSTRUCTIONS>be nice</INSTRUCTIONS>' }] } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the failing test please.' }] } }),
    ].join('\n') + '\n',
  })
  const result = await scanMachine({ id: 'local' }, { transport, home: '/home/tester' })
  const row = result.sessions.find(session => session.path === file)
  assert.equal(row.title, 'Fix the failing test please.')
  assert.equal(row.threadSource, 'user')
  assert.equal(row.importable, true)
})

test('describe(): a three-line stub is listed but marked not importable', async () => {
  // Twenty of sixty rollouts on a real machine were exactly this: metadata, an
  // ENCRYPTED compaction, settings. They cannot be imported, and offering them
  // as ordinary rows produced "no importable messages" only after the click.
  const file = '/home/tester/.codex/sessions/stub.jsonl'
  const transport = memoryTransport({
    [file]: [
      JSON.stringify({ type: 'session_meta', payload: { session_id: 'stub', thread_source: 'guardian_review' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'compaction', encrypted_content: 'gAAAA-encrypted' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'thread_settings_applied' } }),
    ].join('\n') + '\n',
  })
  const result = await scanMachine({ id: 'local' }, { transport, home: '/home/tester' })
  const row = result.sessions.find(session => session.path === file)
  assert.equal(row.importable, false)
  assert.equal(row.threadSource, 'guardian_review')
  // Still listed: hiding it would make the count unexplainable.
  assert.ok(row)
})

test('describe(): a long preamble is read again instead of leaving the row nameless', async () => {
  // The cheap head is 8 KB; a real Codex rollout puts the first user message a
  // median 153 KB in. One extra read must find the title.
  const filler = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>x</environment_context>' }] } })
  const padding = `${filler}\n`.repeat(400) // ~ 100 KB of wrappers
  const file = '/home/tester/.codex/sessions/deep.jsonl'
  const body = `${JSON.stringify({ type: 'session_meta', payload: { session_id: 'deep' } })}\n`
    + padding
    + `${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Deep in the file.' }] } })}\n`
  const transport = memoryTransport({ [file]: body })
  const result = await scanMachine({ id: 'local' }, { transport, home: '/home/tester' })
  const row = result.sessions.find(session => session.path === file)
  assert.equal(row.title, 'Deep in the file.')
})

test('describe(): a title is cut at a boundary and says so', async () => {
  // A hard slice produced "...share a workspace, and", which reads as a
  // truncated file rather than a shortened label.
  const { shortenTitle } = await import('../lib/discovery.js')
  const long = 'You are Codex, an agent based on GPT-6. You and the user share a workspace, and everything you do must stay inside it.'
  const cut = shortenTitle(long, 80)
  assert.ok(cut.length <= 81, `title should fit the budget, got ${cut.length}`)
  assert.ok(cut.endsWith('…'), 'a shortened title must say it was shortened')
  assert.doesNotMatch(cut, /\s…$/, 'no dangling space before the ellipsis')
  // A clause boundary is preferred, and a dangling connective is trimmed.
  assert.match(cut, /workspace…$/)
  assert.doesNotMatch(cut, /\band…$/)
  assert.equal(shortenTitle('short one', 80), 'short one')
})

test('describe(): a system prompt in the user seat is not a title', async () => {
  const file = '/home/tester/.claude/projects/p/s.jsonl'
  const transport = memoryTransport({
    [file]: [
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'You are Codex, an agent based on GPT-6. You and the user share a workspace.' }] } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>\ncontext here\n</system-reminder>' }] } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '# Workflow authoring reference\n\nA workflow structures work.\n\nMore prose.' }] } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '请你清理之前 pip 的缓存' }] } }),
    ].join('\n') + '\n',
  })
  const result = await scanMachine({ id: 'local' }, { transport, home: '/home/tester' })
  const row = result.sessions.find(session => session.path === file)
  assert.equal(row.title, '请你清理之前 pip 的缓存')
})

test('describe(): the first real prompt can sit megabytes into the file', async () => {
  // A real Claude Code session spent its first megabyte on tool output and skill
  // documents; its first genuine prompt was at byte 1,095,161, past both the 8 KB
  // and 256 KB windows. One probe at a deeper offset has to find it.
  const file = '/home/tester/.claude/projects/p/deep.jsonl'
  const noise = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '<task-notification>noise</task-notification>' }] } })
  const filler = `${noise}\n`.repeat(9000) // ~ 1 MB
  const body = filler
    + `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Deep prompt found.' }] } })}\n`
  const transport = memoryTransport({ [file]: body })
  const result = await scanMachine({ id: 'local' }, { transport, home: '/home/tester' })
  const row = result.sessions.find(session => session.path === file)
  assert.equal(row.title, 'Deep prompt found.')
})

test('scanMachine(): archived Codex sessions are flagged, normal sessions are not', async () => {
  // Codex MOVES a rollout into .codex/archived_sessions when the user archives
  // it; the UI needs `archived` to offer an "include archived" toggle.
  const home = '/home/tester'
  const body = [
    JSON.stringify({ type: 'session_meta', payload: { session_id: 'arch-1' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'archived conversation' }] } }),
  ].join('\n') + '\n'
  const t = memoryTransport({
    [`${home}/.codex/archived_sessions/2026/archived.jsonl`]: body,
    [`${home}/.codex/sessions/2026/01/01/normal.jsonl`]: body,
  })
  const { sessions } = await scanMachine({ id: 'local' }, { transport: t, home })
  const archived = sessions.find(s => s.path.includes('archived_sessions'))
  const normal = sessions.find(s => s.path.includes('/sessions/') && !s.path.includes('archived'))
  assert.ok(archived, 'archived session is listed')
  assert.equal(archived.archived, true, 'archived root marks the row')
  assert.equal(normal.archived, false, 'normal sessions root does not')
})

test('scanMachine(): a three-line compaction stub is compacted, a readable thread is not', async () => {
  // A summarised-away Codex thread is a stub (metadata + ENCRYPTED compaction +
  // settings): compaction evidence with NO importable conversation. A thread
  // that merely had a compaction event but still holds messages is readable and
  // must not be hidden by the UI.
  const home = '/home/tester'
  const stub = [
    JSON.stringify({ type: 'session_meta', payload: { session_id: 'stub-1' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'compaction', encrypted_content: 'gAAAA-encrypted' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'thread_settings_applied' } }),
  ].join('\n') + '\n'
  const readable = [
    JSON.stringify({ type: 'session_meta', payload: { session_id: 'readable-1' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'compaction', encrypted_content: 'gAAAA-encrypted' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'still readable' }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'yes you are' }] } }),
  ].join('\n') + '\n'
  const t = memoryTransport({
    [`${home}/.codex/sessions/stub.jsonl`]: stub,
    [`${home}/.codex/sessions/readable.jsonl`]: readable,
  })
  const { sessions } = await scanMachine({ id: 'local' }, { transport: t, home })
  const stubRow = sessions.find(s => s.path.endsWith('stub.jsonl'))
  const readableRow = sessions.find(s => s.path.endsWith('readable.jsonl'))
  assert.equal(stubRow.importable, false)
  assert.equal(stubRow.compacted, true, 'stub with compaction evidence and no messages is compacted')
  assert.equal(readableRow.importable, true)
  assert.equal(readableRow.compacted, false, 'a thread with a compaction event but real messages is NOT compacted')
})

test('scanMachine(): titles come from the adapter, not ad-hoc field parsing', async () => {
  // TRAE records each user turn twice: `event_msg`/`user_message` is the real
  // turn and a Codex-shaped `response_item` is only a replay echo. The adapter
  // knows to prefer the former. Antigravity wraps user text in
  // <USER_REQUEST> tags; the adapter strips the wrapper so the title is clean.
  const home = '/home/tester'
  const traeFile = `${home}/.trae/cli/rollout-trae.jsonl`
  const antiFile = `${home}/.gemini/antigravity-cli/brain/sess-1/.system_generated/logs/transcript.jsonl`
  const trae = [
    JSON.stringify({ type: 'session_meta', payload: { session_id: 'trae-1' } }),
    // The echoed response_item comes FIRST with a decoy title; it must be ignored.
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ECHOED DECOY TITLE' }] } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Real TRAE user question' } }),
  ].join('\n') + '\n'
  const anti = [
    JSON.stringify({ source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-01-01T00:00:00Z', content: '<USER_REQUEST>\nPlease fix the Antigravity adapter\n<ADDITIONAL_METADATA>ignored</ADDITIONAL_METADATA>\n</USER_REQUEST>' }),
  ].join('\n') + '\n'
  // A remote-style transport with findFiles() is used because the local walk()
  // skips dotted directories, and Antigravity's transcript lives under
  // .system_generated/logs/ - exactly the shape findFiles() handles.
  const base = memoryTransport({ [traeFile]: trae, [antiFile]: anti })
  const t = {
    ...base,
    findFiles: async (dir, _depth, suffix) => {
      const all = [...base._store.keys()]
      return all.filter(f => f.startsWith(`${dir}/`) && f.endsWith(suffix))
        .map(full => ({ path: full, name: full.split('/').pop(), isDirectory: false }))
    },
  }
  const { sessions } = await scanMachine({ id: 'local' }, { transport: t, home })
  const traeRow = sessions.find(s => s.path === traeFile)
  const antiRow = sessions.find(s => s.path === antiFile)
  assert.equal(traeRow.title, 'Real TRAE user question', 'title comes from event_msg/user_message, not the echo')
  assert.equal(antiRow.title, 'Please fix the Antigravity adapter', 'title has the <USER_REQUEST> wrapper stripped')
})

test('scanMachine(): preview is longer than 400 characters when enough real text exists', async () => {
  // Previews used to stop at 400 chars (6 lines x 160). With the cap raised to
  // 700 chars and 10 excerpt lines, a session with enough real text shows more.
  const home = '/home/tester'
  const file = `${home}/.claude/projects/p/long-preview.jsonl`
  const lines = []
  for (let i = 0; i < 10; i++) {
    const role = i % 2 === 0 ? 'user' : 'assistant'
    lines.push(JSON.stringify({
      type: role,
      message: { role, content: [{ type: 'text', text: `${role === 'user' ? 'Question' : 'Answer'} ${i}: ${'x'.repeat(150)}` }] },
    }))
  }
  const t = memoryTransport({ [file]: lines.join('\n') + '\n' })
  const { sessions } = await scanMachine({ id: 'local' }, { transport: t, home })
  const row = sessions.find(s => s.path === file)
  assert.ok(row.preview.length > 400, `expected a preview over 400 chars, got ${row.preview.length}`)
})
