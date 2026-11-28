/**
 * Discovery of external conversation files across a filesystem transport.
 * The transport is the same small facade used by the adapters (local fs or
 * SSH/SFTP): stat/list/read/home. All remote paths use POSIX separators.
 */

import path from 'node:path'
import { mapLimit } from './pool.js'
import { adapterFor, textOf } from './adapters.js'

const CHUNK = 256 * 1024
/** Extra window used only when the cheap head has no title (Codex preamble). */
const WIDE_HEAD = 256 * 1024
const MAX_COUNT_BYTES = 8 * 1024 * 1024
const MAX_ENTRIES = 5000
/** Where to look for a title when the head of the file has none. */
const TITLE_PROBE_OFFSETS = [256 * 1024, 1024 * 1024, 4 * 1024 * 1024]

/** Files inspected at once. Each one is a round trip on a remote machine. */
const FILE_CONCURRENCY = 8

/** Join POSIX-style path segments (remote home paths are always POSIX). */
function join(...parts) {
  return path.posix.join(...parts)
}

/**
 * Recursively list files under `dir` matching `predicate(entry, fullPath)`.
 * Up to `maxDepth` levels are descended; directories are never followed via
 * symlinks because the transport only reports isDirectory for real dirs.
 * The total number of collected files is capped at 5000.
 * @returns {Promise<Array<{path:string,name:string,isDirectory:boolean,depth:number}>>}
 */
export async function walk(transport, dir, maxDepth, predicate, options = {}) {
  // Dot-directories are skipped because tool state is full of them, but some
  // conversations live inside one: Antigravity keeps its transcript under
  // `brain/<id>/.system_generated/logs/`. Opting in per call keeps the default
  // walk cheap while letting those roots be found. (Skipping them
  // unconditionally meant a LOCAL scan found no Antigravity sessions at all,
  // while an SSH scan — which asks `find` — did.)
  const keepDots = options.dotDirectories === true
  const results = []
  const visited = new Set()

  async function descend(current, depth) {
    if (depth > maxDepth || results.length >= MAX_ENTRIES) return
    // Let list errors propagate: scanMachine catches them per root.
    const entries = await transport.list(current)
    if (!Array.isArray(entries)) return
    for (const entry of entries) {
      if (results.length >= MAX_ENTRIES) return
      if (!entry || typeof entry.name !== 'string') continue
      if (!keepDots && entry.name.startsWith('.')) continue
      const fullPath = join(current, entry.name)
      if (entry.isSymbolicLink) continue // never follow symlinks
      if (entry.isDirectory) {
        // Guard against cycles even if a transport reports a symlink as a dir.
        if (visited.has(fullPath)) continue
        visited.add(fullPath)
        await descend(fullPath, depth + 1)
      } else if (predicate(entry, fullPath)) {
        results.push({ path: fullPath, name: entry.name, isDirectory: false, depth })
      }
    }
  }

  await descend(dir, 0)
  return results
}

/** Strip a trailing newline and tolerate malformed JSON lines. */
function parseLine(line) {
  try {
    return JSON.parse(line.replace(/\r$/, ''))
  } catch {
    return undefined
  }
}

/** Flatten nested JSONL text fields into a single string.
 *  Kept separate from the adapters' `textOf` so the manual fallback in
 *  userText()/assistantText() retains its original behaviour. */
function localTextOf(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(localTextOf).filter(Boolean).join(' ')
  if (value && typeof value === 'object' && typeof value.text === 'string') return value.text
  return ''
}

/**
 * Text a tool injected in the user role, which is not something the user said.
 *
 * Codex puts the environment, AGENTS.md, the skills list and its own
 * multi-agent briefs into `role: "user"` messages, and they arrive BEFORE the
 * first thing the person typed. Using them as a title is why every row read
 * `<environment_context> <cwd>/Users/...` - technically the first user message,
 * useless as a name.
 */
const INJECTED_PREFIXES = [
  '<environment_context',
  '<user_instructions',
  '<skills_instructions',
  '<multi_agent_role',
  '<multi_agent_mode',
  '<codex_apps_client_time_context',
  '<external_ide_context',
  '<ide_context',
  '<user_context',
  '<system-reminder',
  '<task-notification',
  '<command-message',
  '<command-name',
  '<local-command',
  '<INSTRUCTIONS',
  '# AGENTS.md instructions',
  '# Instructions',
  '# Files pasted by the user',
  // A system prompt stored in the user seat. "You are Codex, an agent based on
  // GPT-6..." became a session title on a real machine.
  'You are Codex',
  'You are an AI',
  'You are a helpful',
  'You are Claude',
  // Command output the user pasted, not something they wrote.
  'Proxy request sent',
  'wget ',
  'curl ',
]

function isInjectedText(text) {
  const trimmed = String(text ?? '').trimStart()
  if (!trimmed) return true
  if (INJECTED_PREFIXES.some(prefix => trimmed.startsWith(prefix))) return true
  // Any wrapper tag on the very first line ("<something>" then a newline) is a
  // harness envelope, not a sentence a person typed.
  if (/^<[a-z][a-z0-9_-]*>/i.test(trimmed) && trimmed.includes('\n')) return true
  // A document the harness loaded into the conversation (a skill reference, a
  // tool manual) is a markdown heading plus prose. It is not something the
  // person said, and using it as a title names the session after the docs.
  if (/^#{1,3} [A-Z]/.test(trimmed) && trimmed.includes('\n\n')) return true
  return false
}

/**
 * Cut a title without cutting a word in half.
 *
 * A hard slice produced titles that end mid-sentence — "…share a workspace,
 * and" — which reads as data loss rather than as a shortened label. Prefer the
 * last sentence or clause boundary inside the budget, then a space, and always
 * say that something was left out.
 */
export function shortenTitle(text, max = 80) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  const window = flat.slice(0, max)
  const boundary = Math.max(
    window.lastIndexOf('。'), window.lastIndexOf('！'), window.lastIndexOf('？'),
    window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '),
    window.lastIndexOf('；'), window.lastIndexOf('; '),
    window.lastIndexOf('，'), window.lastIndexOf(', '),
    window.lastIndexOf(' '),
  )
  let cut = (boundary > max * 0.4 ? window.slice(0, boundary) : window).trimEnd()
  cut = cut.replace(/[，,、；;]$/, '')
  // Do not end on a word that only makes sense with what follows: "…a
  // workspace, and" is a fragment, not a label.
  cut = cut.replace(/\s+(?:and|but|or|nor|so|yet|the|a|an|to|of|in|on|for|with|that|which|is|are|was|were)$/i, '')
  cut = cut.replace(/[，,、；;]$/, '')
  return `${cut}…`
}

/** Return the first user text in a Claude / Codex / WorkBuddy / TRAE /
 *  Antigravity / generic JSONL record. */
function userText(record, kind) {
  if (kind === 'antigravity') {
    const source = String(record.source ?? '')
    const type = String(record.type ?? '')
    const isUser = /USER/i.test(source) || type === 'USER_INPUT'
    if (!isUser) return ''
    const cleaned = String(record.content ?? '')
      .replace(/^[\s\S]*?<USER_REQUEST>/, '')
      .replace(/<\/USER_REQUEST>[\s\S]*$/, '')
      .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '')
      .trim()
    return isInjectedText(cleaned) ? '' : cleaned
  }
  if (!record || typeof record !== 'object') return ''
  const message = record.message ?? record
  const payload = record.payload ?? message.payload
  const roles = [message.role, payload?.role, record.role, record.type]
  if (!roles.includes('user')) return ''
  const candidates = [message.text, message.content, record.text, record.content, payload?.content, payload?.input, payload?.message]
  for (const candidate of candidates) {
    const text = localTextOf(candidate).trim()
    // Skip what the tool said on the user's behalf; keep looking for the
    // sentence the person actually typed.
    if (text && !isInjectedText(text)) return text
  }
  return ''
}

/**
 * Name, human title and preview from the first 256KB of a source file.
 *
 * The `name` is the tool's own session id - stable, and useless to a person: a
 * Claude rollout is named after a UUID and a Codex one after a rollout
 * timestamp, so a list of them is a list of letters. The `title` is therefore
 * the first thing the user actually said, which is how people recognise their
 * own conversations, and `preview` carries a few lines of both sides so the
 * difference between two similar sessions is visible without opening either.
 */
async function describe(transport, file, kind, head, size = 0, count = 0) {
  let buffer
  if (head) {
    // Already fetched by transport.inspect(), which folds the first bytes into
    // the same round trip as the stat.
    buffer = head
  } else {
    try {
      buffer = await transport.read(file, 0, CHUNK)
    } catch {
      buffer = Buffer.alloc(0)
    }
  }
  let scanned = scanHead(buffer.toString('utf8'), kind, file)
  // Codex writes the environment, AGENTS.md and its own briefs before the first
  // thing the user typed - measured at a median of 153 KB into a real rollout,
  // and the single round trip only fetches the first 8 KB. So when the cheap
  // window yields no title, read further.
  //
  // One wider window is not enough: a Claude Code session that spent its first
  // megabyte on tool output and loaded skill documents had its first genuine
  // prompt at byte 1,095,161. Probing a few offsets, each one round trip and
  // only for files that still have no title, is bounded work that finds it.
  //
  // The same probe decides `importable`. It used to be decided by *size* — see
  // the note on `holdsConversation` below — which is precisely the bug this
  // loop exists to remove: a file is a conversation because of what it
  // CONTAINS, never because of how many bytes it has.
  // Probe when we still need an answer AND the answer could be past the window.
  // For `importable` that means only when the file is larger than what we read:
  // deciding "no conversation" from a partial read is the bug, deciding it from
  // the whole file is correct. A summarised stub that already showed its
  // encryption marker is settled evidence — probing it further is three wasted
  // round trips per stub on a remote machine.
  const needsProbe = () => {
    if (!scanned.title) return true
    if (scanned.importable) return false
    if (scanned.sawCompaction) return false
    return size > buffer.length
  }
  if (needsProbe()) {
    const seen = buffer.length
    for (const offset of TITLE_PROBE_OFFSETS) {
      if (offset < seen) continue
      if (offset >= size) break
      try {
        const window = await transport.read(file, offset, Math.min(WIDE_HEAD, size - offset))
        if (!window || window.length === 0) break
        const probe = scanLines(window.toString('utf8').split('\n').slice(1), kind, file)
        if (probe.importable && !scanned.importable) scanned = { ...scanned, importable: true }
        if (probe.title && !scanned.title) scanned = { ...scanned, title: probe.title, preview: probe.preview || scanned.preview }
        if (!needsProbe()) break
      } catch { break }
    }
  }
  const { name, title, preview, importable, sawCompaction, threadSource } = scanned
  // A file we could only read in part cannot be judged "empty" from that part,
  // so when nothing in the probed windows looked like a conversation, look at
  // the END of the file before deciding. Conversations keep going to the end;
  // a summarised stub is three lines and its tail is the same stub.
  //
  // What used to happen here was `importable || (truncated && count > 3)`: any
  // file bigger than the read window was ASSUMED to hold a conversation. That
  // made the verdict depend on file size rather than content, and it inverted
  // the obvious case — every Claude rollout is a big file that passed on the
  // size guess, while a small Claude rollout (a real conversation, just short)
  // was declared "no conversation" and hidden. Claude's rows are
  // `{type:'user'}` / `{type:'assistant'}`, which the Codex-shaped payload
  // whitelist never matches, so the size guess was the ONLY thing keeping
  // Claude sessions visible at all.
  let holdsConversation = importable
  if (!holdsConversation && size > buffer.length && Number(count) > 3) {
    try {
      const tailStart = Math.max(0, size - CHUNK)
      if (tailStart > buffer.length) {
        const tail = await transport.read(file, tailStart, Math.min(CHUNK, size - tailStart))
        if (tail && tail.length) {
          const probe = scanLines(tail.toString('utf8').split('\n').slice(1), kind, file)
          if (probe.importable) holdsConversation = true
          if (probe.importable && !title && probe.title) scanned = { ...scanned, title: probe.title }
        }
      }
    } catch { /* a tail read that fails is not evidence of emptiness */ }
  }
  return {
    name: scanned.name,
    title: scanned.title || title,
    preview: scanned.preview || preview,
    importable: holdsConversation,
    sawCompaction,
    threadSource,
  }
}

/** Everything a reader needs from the first bytes of one file. */
function scanHead(text, kind, file) {
  return scanLines(text.split('\n'), kind, file)
}

/**
 * Name, title, preview and whether the file holds a conversation at all.
 *
 * `importable` is false when every line is bookkeeping: Codex writes a
 * three-line stub (`session_meta` + an ENCRYPTED `compaction` + settings) for
 * threads it has summarised, and twenty of sixty rollouts on one real machine
 * were exactly that. Listing them as sessions gave the user rows that could
 * never be imported, and picking one produced "no importable messages" - so the
 * scan now knows the difference before the user clicks.
 */
function scanLines(lines, kind, file) {
  const stem = path.posix.basename(String(file ?? '')).replace(/\.[^.]+$/, '')
  let name = stem
  let preview = ''
  let title = ''
  let ownTitle = ''
  let lastPrompt = ''
  let importable = false
  let sawCompaction = false
  let threadSource = ''
  const excerpt = []
  let codexSessionId
  let byteOffset = 0

  // The per-tool adapters are the AUTHORITATIVE way to read a message out of a
  // rollout: they encode each tool's real message shape, so the title is the
  // first thing the person actually typed rather than an echo or a wrapper.
  //   - TRAE records every user turn twice: `event_msg`/`user_message` is the
  //     real turn, while a Codex-shaped `response_item` is only a replay echo;
  //     the adapter keeps the former and dedupes the latter.
  //   - Antigravity wraps user text in `<USER_REQUEST>...</USER_REQUEST>`; the
  //     adapter strips that wrapper (and metadata) before returning `text`.
  // The manual userText() below is kept only as a FALLBACK for lines the adapter
  // cannot parse, so pre-existing behaviour for unknown shapes still works.
  let adapterParse
  try { adapterParse = adapterFor(kind).parse } catch { adapterParse = undefined }

  // Not `lines.slice(0, 200)`: a preamble can be hundreds of short wrapper
  // lines, and stopping at an arbitrary count left the row nameless even though
  // the text was inside the window. Stop when the answer is complete instead.
  for (const line of lines) {
    if (title && importable && excerpt.length >= 10) break
    if (!line.trim()) continue
    const currentOffset = byteOffset
    byteOffset += Buffer.byteLength(line) + 1 // JSONL lines are newline-terminated
    const record = parseLine(line)
    if (!record) continue
    if (kind === 'codex' && record.type === 'session_meta' && record.payload?.session_id) {
      codexSessionId = record.payload.session_id
    }
    // Codex marks WHY a thread exists: `user` for a conversation the person
    // started, `guardian_review` for an automated review of another thread,
    // `subagent` for a delegated worker. On one real machine 35 of 60 rollouts
    // were guardian reviews, which is why the list looked both too long and
    // missing the conversations the user remembered writing.
    if (record.type === 'session_meta' && record.payload?.thread_source) {
      threadSource = String(record.payload.thread_source)
    }
    // Antigravity runs small utility turns through the same brain storage: a
    // one-shot "Create a concise title for this session" call, and similar
    // helpers. They are transcripts, but they are not conversations the person
    // wrote, so they carry the same `utility` marker as an automated thread and
    // hide behind the same switch. Skipping them keeps a real listing honest
    // (5 of 9 Antigravity entries on one machine were title generators).
    if (kind === 'antigravity' && /USER/i.test(String(record.source ?? ''))) {
      const prompt = String(record.content ?? '').replace(/<\/?USER_REQUEST>/g, '').trim()
      if (/^System instructions:/i.test(prompt)) threadSource = threadSource || 'utility'
    }
    if (kind === 'claude') {
      const id = record.sessionId || record.session_id
      if (!name.startsWith('__fallback__') && id) name = String(id)
    }
    if (kind === 'trae' && record.type === 'session_meta' && record.payload?.session_id) {
      name = String(record.payload.session_id)
    }
    if (kind === 'workbuddy') {
      const id = record.sessionId || record.session_id
      if (id) name = String(id)
    }
    // A record carrying a real message is what makes a file importable; the
    // encrypted `compaction` payload is deliberately NOT one of them.
    //
    // This used to be a Codex-shaped whitelist (`message`, `reasoning`,
    // `*_call`, `*_call_output`) applied to EVERY kind, so a Claude file — whose
    // rows are `{type:'user'}` / `{type:'assistant'}` — never matched it and was
    // only ever "importable" through the size guess below. Every format answers
    // "is this a message" differently, so ask the format: the adapter is the
    // authority, and this whitelist is kept as a fallback for kinds whose
    // adapter cannot parse a line.
    // Some tools record the conversation's own name. Claude Code writes
    // `{type:'custom-title', customTitle}` when the user renames a session and
    // `{type:'ai-title', aiTitle}` when it generates one. Reading them shows the
    // name the USER knows instead of our guess at the first prompt.
    // `last-prompt` is deliberately last: it is the newest prompt, not a title.
    if (!ownTitle) {
      if (record.type === 'custom-title' && record.customTitle) ownTitle = String(record.customTitle)
      else if (record.type === 'ai-title' && record.aiTitle) ownTitle = String(record.aiTitle)
      else if (!lastPrompt && record.type === 'last-prompt' && record.lastPrompt) lastPrompt = String(record.lastPrompt)
      else if (record.type !== 'last-prompt' && typeof record.title === 'string' && record.title) ownTitle = record.title
    }
    const payloadType = String(record.payload?.type ?? record.type ?? '')
    // An encrypted compaction is the signature of a summarised-away thread.
    if (payloadType === 'compaction') sawCompaction = true
    const couldHoldMessage = payloadType === 'message' || payloadType === 'reasoning'
      || payloadType.endsWith('_call') || payloadType.endsWith('_call_output')
    if (couldHoldMessage) {
      if (kind !== 'antigravity' || /USER|MODEL/i.test(String(record.source ?? ''))) importable = true
    }
    // Authoritative extraction: parse the line with the tool's adapter first.
    // One source line can expand into several normalized records (parallel tool
    // results), and only `role === 'user'` records are eligible for the title.
    let adapterText = ''
    let adapterParsed = false
    let adapterRecords = []
    if (adapterParse) {
      try {
        const parsed = adapterParse(line, { byteOffset: currentOffset })
        if (parsed) {
          adapterRecords = Array.isArray(parsed) ? parsed : [parsed]
          adapterParsed = adapterRecords.length > 0
          for (const normalized of adapterRecords) {
            if (normalized?.role !== 'user') continue
            // TRAE's plain `response_item` user message is a replay echo /
            // runtime injection; the adapter marks the real turn with
            // meta.kind `user_message` or `history_mutation`. Honour that so an
            // echoed response_item is never mistaken for the user's prompt.
            if (kind === 'trae' && !['user_message', 'history_mutation'].includes(normalized.meta?.kind)) continue
            const candidate = textOf(normalized.text).trim()
            if (candidate && !isInjectedText(candidate)) { adapterText = candidate; break }
          }
        }
      } catch { adapterParsed = false }
    }
    // Fallback only for lines the adapter cannot parse at all, so shapes the
    // adapters don't cover keep their previous behaviour. When the adapter DID
    // parse the line, its judgement is final (an empty result for that line is
    // meaningful, e.g. a TRAE echo or an injected preamble).
    // The adapter decides what a message is, per format. If it produced a
    // user/assistant/tool record at all, this line IS conversation content —
    // which is how a Claude rollout, a WorkBuddy row or an Antigravity step
    // qualifies without anyone hard-coding its line types here.
    // A record that carries text (or a tool call/result) is conversation
    // content; a record the adapter produced with nothing in it is not.
    if (adapterRecords.some(item => item && (
      item.role === 'tool'
      || ((item.role === 'user' || item.role === 'assistant') && String(item.text ?? '').trim())
    ))) {
      importable = true
    }
    const said = adapterParsed ? adapterText : userText(record, kind)
    if (!preview) preview = said
    if (!title && said) title = said
    // A preview is only useful if it shows the shape of the conversation, so
    // collect alternating lines rather than one long question.
    if (excerpt.length < 10) {
      const line = said || assistantText(record, kind)
      const trimmed = line.trim()
      if (trimmed) excerpt.push(trimmed.slice(0, 160))
    }
  }

  if (kind === 'codex' && codexSessionId) name = String(codexSessionId)
  // A title the tool itself recorded wins over our guess at the first prompt;
  // the newest prompt is only a stand-in when nothing better exists.
  const resolved = ownTitle || title || lastPrompt
  return {
    name,
    title: shortenTitle(resolved, 80),
    preview: (excerpt.length ? excerpt.join('\n') : (preview || lastPrompt)).slice(0, 700),
    importable,
    sawCompaction,
    threadSource,
  }
}

/**
 * The assistant's side of one record, for the preview only.
 *
 * The adapters are authoritative about what a conversation contains; this is a
 * deliberately loose read used to show context, so it never affects an import.
 */
function assistantText(record, kind) {
  if (!record || typeof record !== 'object') return ''
  if (kind === 'antigravity') {
    const source = String(record.source ?? '')
    if (!/MODEL/i.test(source)) return ''
    return String(record.content ?? '')
  }
  const message = record.message ?? record
  const payload = record.payload ?? message.payload
  const roles = [message.role, payload?.role, record.role]
  if (!roles.includes('assistant')) return ''
  const candidates = [message.text, message.content, record.text, record.content, payload?.content, payload?.message]
  for (const candidate of candidates) {
    const value = textOf(candidate).trim()
    if (value) return value
  }
  return ''
}

/** Count newline-terminated lines in 256KB chunks, up to 8MB. */
async function countLines(transport, file) {
  let offset = 0
  let count = 0
  while (offset < MAX_COUNT_BYTES) {
    const chunk = await transport.read(file, offset, CHUNK)
    if (!chunk?.length) break
    for (let i = 0; i < chunk.length; i++) if (chunk[i] === 0x0a) count++
    offset += chunk.length
    if (chunk.length < CHUNK) break
  }
  return { count, truncated: offset >= MAX_COUNT_BYTES }
}

/**
 * Defensive detection of an archived location from the path alone, in case a
 * file reaches us from a root that is not itself marked `archived`.
 */
function isArchivedPath(file) {
  const normalized = String(file ?? '').replace(/\\/g, '/')
  return /(^|\/)(archived_sessions|archive)(\/|$)/i.test(normalized)
}

/**
 * Whether an error came from the connection itself rather than from the remote
 * path being read. Used to keep "cannot resolve home" for genuine home
 * problems instead of masking an auth or routing failure.
 */
function isTransportError(error) {
  if (!error) return false
  if (error.keyPath) return true
  const code = String(error.code ?? '')
  return code.startsWith('ESSH') || TRANSPORT_CODES.has(code)
}

const TRANSPORT_CODES = new Set(['EAUTH', 'EHOSTKEY', 'ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'ECLOSED'])

/**
 * Name, preview, size and line count for one file, in as few round trips as the
 * transport allows.
 *
 * A remote transport answers all of it with one command; the local one just
 * reads. Counting lines by reading a file in chunks is fine on a local disk and
 * catastrophic over SSH, so the two paths are kept apart here rather than in
 * the transport.
 */
async function inspectFile(transport, file, kind) {
  let meta
  let described
  if (typeof transport.inspect === 'function') {
    const info = await transport.inspect(file)
    if (!info) return undefined
    meta = { size: info.size, mtimeMs: info.mtimeMs, count: info.count, countTruncated: false }
    described = await describe(transport, file, kind, info.head, info.size, info.count)
  } else {
    const stat = await transport.stat(file)
    if (!stat) return undefined
    const { count, truncated } = await countLines(transport, file)
    meta = { size: stat.size, mtimeMs: stat.mtimeMs, count, countTruncated: truncated }
    described = await describe(transport, file, kind, undefined, stat.size, count)
  }
  const { name, title, preview, importable, sawCompaction, threadSource } = described
  // A file that holds no importable conversation at all is not a conversation:
  // a summarised Codex stub (metadata + an ENCRYPTED compaction + settings) or
  // a file whose whole content is bookkeeping. The panel hides these by
  // default, because they can never be imported.
  //
  // This deliberately does NOT require having *seen* the compaction line. A
  // Codex `session_meta` line alone can be ~19 KB (base instructions, world
  // state), so an 8 KB scan window stops inside it and never reaches the
  // `compaction` payload — which made three-line stubs report
  // `sawCompaction:false` and leak into the list even with the switch off.
  // Emptiness is the honest signal; the marker only corroborates it.
  const compacted = importable === false
  return { ...meta, name, title, preview, importable, sawCompaction, compacted, threadSource }
}

export async function scanMachine(machine, { transport, home } = {}) {
  const machineId = machine?.id || 'local'
  const sessions = []
  const errors = []
  let root = home
  if (!root) {
    try {
      root = await transport.home()
    } catch (error) {
      // Do not claim "cannot resolve home" for a failure that is really about
      // reaching the machine at all (bad key path, auth, DNS): that message
      // sent a user hunting for a home-directory problem when the actual cause
      // was a typo in the private-key path. Keep the transport's own reason.
      if (isTransportError(error)) {
        errors.push(String(error?.message ?? error))
      } else {
        errors.push(`cannot resolve home: ${error?.message || error}`)
      }
      // Without a home there is nowhere to look: returning now avoids probing
      // ".claude/projects" relative to the process CWD, which reported the same
      // connection failure once per tool and buried the real cause in noise.
      return { machineId, sessions, errors }
    }
  }

  const roots = [
    { dir: join(root, '.claude', 'projects'), depth: 3, suffix: '.jsonl', kind: 'claude' },
    { dir: join(root, '.codex', 'sessions'), depth: 4, suffix: '.jsonl', kind: 'codex' },
    // Codex MOVES a rollout here when the user archives a thread; it is no
    // longer under sessions/. Skipping this directory made archived
    // conversations vanish from the list even though the file is intact.
    { dir: join(root, '.codex', 'archived_sessions'), depth: 2, suffix: '.jsonl', kind: 'codex', archived: true },
    { dir: join(root, '.workbuddy', 'projects'), depth: 3, suffix: '.jsonl', kind: 'workbuddy' },
    { dir: join(root, '.workbuddy-ai', 'projects'), depth: 3, suffix: '.jsonl', kind: 'workbuddy' },
    { dir: join(root, '.codebuddy', 'projects'), depth: 3, suffix: '.jsonl', kind: 'workbuddy' },
    // TRAE CLI keeps Codex-style rollouts here; TRAE's IDE keeps an encrypted
    // ModularData DB instead, which is deliberately not parsed.
    { dir: join(root, '.trae', 'cli'), depth: 4, suffix: '.jsonl', kind: 'trae' },
    { dir: join(root, '.trae-cn', 'cli'), depth: 4, suffix: '.jsonl', kind: 'trae' },
    { dir: join(root, '.dsh-conversation-sync', 'exports'), depth: 2, suffix: '.zip', kind: 'deepseekExport' },
  ]
  const seen = new Set()

  const listFor = async (dir, depth, suffix, options) => {
    // A remote transport answers the whole tree in one command; the local one
    // walks the directories, where a round trip costs nothing.
    if (typeof transport.findFiles === 'function') {
      return await transport.findFiles(dir, depth, suffix)
    }
    return await walk(transport, dir, depth, (_entry, fullPath) => fullPath.endsWith(suffix), options)
  }

  for (const spec of roots) {
    let files
    try {
      files = await listFor(spec.dir, spec.depth, spec.suffix)
    } catch (error) {
      // A tool that simply is not installed is normal, not an error.
      if (String(error?.code ?? '') !== 'ENOENT' && !/ENOENT/.test(String(error?.message))) {
        errors.push(`${spec.dir}: ${error?.message || error}`)
      }
      continue
    }
    // A missing root is reported as "absent", not as an empty directory.
    if (!Array.isArray(files) || files.length === 0) continue
    // A remote file costs one round trip, so inspecting them one at a time made
    // a machine with 55 rollouts take a minute. A handful in flight is bounded
    // work for the server and turns that into a few seconds.
    const fresh = files.filter(file => !seen.has(file.path))
    for (const file of fresh) seen.add(file.path)
    const infos = await mapLimit(fresh, FILE_CONCURRENCY, async file => {
      try {
        return { file, info: await inspectFile(transport, file.path, spec.kind) }
      } catch (error) {
        errors.push(`${file.path}: ${error?.message || error}`)
        return undefined
      }
    })
    for (const entry of infos) {
      if (!entry?.info) continue
      const { file, info } = entry
      sessions.push({
        id: file.path,
        kind: spec.kind,
        name: info.name,
        title: info.title,
        path: file.path,
        machineId,
        size: info.size,
        mtimeMs: info.mtimeMs,
        count: info.count,
        countTruncated: info.countTruncated,
        preview: info.preview,
        importable: info.importable !== false,
        compacted: info.compacted === true,
        archived: spec.archived === true || isArchivedPath(file.path),
        threadSource: info.threadSource || '',
      })
    }
  }

  // Antigravity: transcript.jsonl lives deep under brain/<id>/.system_generated/logs
  const antigravityBases = [
    join(root, '.gemini', 'antigravity-cli', 'brain'),
    join(root, '.gemini', 'antigravity-ide', 'brain'),
    join(root, '.gemini', 'antigravity', 'brain'),
  ]
  for (const base of antigravityBases) {
    let files
    try {
      files = await listFor(base, 4, 'transcript.jsonl', { dotDirectories: true })
    } catch { continue } // a missing antigravity variant is normal
    if (!Array.isArray(files) || files.length === 0) continue
    const freshAnti = files.filter(file => !seen.has(file.path))
    for (const file of freshAnti) seen.add(file.path)
    const antiInfos = await mapLimit(freshAnti, FILE_CONCURRENCY, async file => {
      try {
        return { file, info: await inspectFile(transport, file.path, 'antigravity') }
      } catch (error) {
        errors.push(`${file.path}: ${error?.message || error}`)
        return undefined
      }
    })
    for (const entry of antiInfos) {
      if (!entry?.info) continue
      const { file, info } = entry
      sessions.push({
        id: file.path, kind: 'antigravity', name: info.name, title: info.title,
        path: file.path, machineId,
        size: info.size, mtimeMs: info.mtimeMs, count: info.count,
        countTruncated: info.countTruncated, preview: info.preview,
        importable: info.importable !== false,
        compacted: info.compacted === true,
        archived: isArchivedPath(file.path),
        threadSource: info.threadSource || '',
      })
    }
  }

  // OpenCode: one SQLite database holding many sessions.
  const opencodeCandidates = [
    join(root, '.local', 'share', 'opencode', 'opencode.db'),
    join(root, '.config', 'opencode', 'opencode.db'),
  ]
  if (process.env.XDG_DATA_HOME) opencodeCandidates.unshift(join(process.env.XDG_DATA_HOME, 'opencode', 'opencode.db'))
  for (const dbPath of opencodeCandidates) {
    try {
      const stat = await transport.stat(dbPath)
      if (!stat) continue
      // The DB is local-only for now: listing it needs node:sqlite and a copy of
      // the file. Skipping it on a remote host is expected, not a failure to
      // report — it would show as an error on every remote scan.
      if (transport.kind !== 'local') continue
      const { listOpenCodeSessions } = await import('./opencode.js')
      const rows = await listOpenCodeSessions({ file: dbPath })
      for (const row of rows) {
        if (seen.has(`${dbPath}#${row.id}`)) continue
        seen.add(`${dbPath}#${row.id}`)
        sessions.push({ ...row, machineId, mtimeMs: row.mtimeMs || stat.mtimeMs })
      }
      break // first existing database wins
    } catch (error) {
      errors.push(`${dbPath}: ${error?.message || error}`)
    }
  }

  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return { machineId, sessions, errors }
}
