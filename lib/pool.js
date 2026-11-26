/**
 * One live transport per machine, reused across scans, polls and syncs.
 *
 * Why this exists: discovery runs every 30 seconds and each sync poll needs the
 * same machine. Creating a transport per call meant a fresh TCP connection,
 * banner exchange, key exchange and authentication for every hop, every tick,
 * forever - which against a remote server with a jump host is a lot of pointless
 * work, and against a strict sshd can even trip connection limits.
 *
 * The pool owns two rules:
 *  - a transport is only created when none is cached for that machine;
 *  - a transport is discarded after a failure, because a dead SFTP channel or a
 *    dropped connection would otherwise make every later attempt fail against
 *    the same broken socket.
 */

/** Errors that mean "this particular call was rejected", not "the link is dead". */
const LINK_INTACT = /not found|does not exist|no such file|permission denied|eacces|is a file in the way|not a directory/i

export function createTransportPool({ create, logger } = {}) {
  if (typeof create !== 'function') throw new Error('createTransportPool requires a create() function')
  const entries = new Map()

  const keyFor = (machine, keyRef) => `${machine?.id ?? 'local'}::${keyRef ?? ''}`

  /** Get (or open) the transport for a machine. */
  const get = async (machine, keyRef) => {
    const key = keyFor(machine, keyRef)
    const existing = entries.get(key)
    // A transport can close itself (ssh2 emits close when a keepalive fails);
    // the entry then stays in the map holding a socket nobody can use.
    if (existing && !existing.closed && existing.transport?.closed !== true) return existing.transport
    if (existing) discard(machine)
    const transport = await create(machine, keyRef)
    entries.set(key, { transport, closed: false })
    return transport
  }

  /** Close and forget one machine's transport (all of them when called bare). */
  const discard = machine => {
    for (const [key, entry] of entries) {
      if (machine && key !== keyFor(machine, undefined) && !key.startsWith(`${machine.id}::`)) continue
      entry.closed = true
      try { entry.transport?.close?.() } catch { /* already gone */ }
      entries.delete(key)
    }
  }

  /**
   * Run `fn(transport)` with the pooled transport. A link-level failure drops the
   * transport so the next attempt reconnects; an ordinary "that file is not
   * there" leaves it alone (reconnecting would just waste a handshake).
   */
  const run = async (machine, keyRef, fn) => {
    const transport = await get(machine, keyRef)
    try {
      return await fn(transport)
    } catch (error) {
      const message = String(error?.message ?? error)
      if (transport.kind === 'ssh' && !LINK_INTACT.test(message)) {
        logger?.warn?.(`[conversation-sync] dropping the connection to ${machine?.id ?? 'local'}: ${message}`)
        discard(machine)
      }
      throw error
    }
  }

  /** Close everything (plugin unload). */
  const closeAll = () => discard()

  return {
    get,
    run,
    discard,
    closeAll,
    get size() { return entries.size },
    /** Test/debug hook: the transport currently cached for a machine. */
    peek: (machine, keyRef) => entries.get(keyFor(machine, keyRef))?.transport,
  }
}
