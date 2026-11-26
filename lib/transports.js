import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
// ssh2 is only needed for SSH machines. Importing it lazily keeps the local
// transport — and therefore the whole plain-import path and its tests — usable
// in environments where ssh2 is not installed.
let ssh2Module
async function ssh2() {
  if (!ssh2Module) ssh2Module = await import('ssh2')
  return ssh2Module
}

/**
 * A transport is a small filesystem facade used by the adapters and by session
 * discovery. It exposes just enough for incremental JSONL/zip reading,
 * append-style writing, and discovering the home directory of the machine.
 * `stat()` returns { size, mtimeMs } or undefined when the path is absent.
 */

// A filesystem call can block forever on a wedged path (a stale NFS mount, a
// FUSE daemon that stopped answering, /proc on some kernels). Node offers no way
// to cancel it, but an unbounded await would hang the sync handler and the poll
// loop with it, leaving the UI stuck on "syncing" with no error. Reporting a
// timeout at least fails the one binding and says what happened.
export const FS_TIMEOUT_MS = 30000

function withTimeout(promise, what, timeoutMs = FS_TIMEOUT_MS) {
  let timer
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${what} did not complete within ${timeoutMs}ms`)
      error.code = 'ETIMEDOUT'
      reject(error)
    }, timeoutMs)
  })
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer))
}

export class LocalTransport {
  constructor() { this.kind = 'local' }
  async home() { return os.homedir() }
  async stat(file) {
    try {
      const st = await withTimeout(fs.stat(file), `stat ${file}`)
      return { size: st.size, mtimeMs: st.mtimeMs }
    } catch (error) {
      // ENOTDIR means a path component is a regular file: the requested path
      // does not exist, which is the same answer as ENOENT. Reporting it here
      // would make the "is there a file to back up?" check fail with a raw
      // errno instead of letting the write path explain the real problem.
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return undefined
      throw error
    }
  }
  async list(dir) {
    try {
      return (await fs.readdir(dir, { withFileTypes: true }))
        .filter(entry => entry.isFile() || entry.isDirectory())
        .map(entry => ({ name: entry.name, isDirectory: entry.isDirectory() }))
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return []
      throw error
    }
  }
  // Built component by component instead of `fs.mkdir(dir, {recursive:true})`:
  // Node's recursive implementation walks up on ENOENT and retries, so when
  // mkdir reports ENOENT for a parent that DOES exist (Linux /proc does exactly
  // that) it spins forever and wedges the whole harness. Walking the path makes
  // every failure a plain error the caller can report.
  async mkdir(dir) {
    const absolute = path.resolve(dir)
    const { root } = path.parse(absolute)
    let current = root
    for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part)
      try {
        await withTimeout(fs.mkdir(current), `mkdir ${current}`)
      } catch (error) {
        if (error?.code === 'EEXIST') {
          const stat = await fs.stat(current).catch(() => undefined)
          if (stat?.isDirectory()) continue
          throw new Error(`cannot create the directory ${current}: a file is in the way`)
        }
        throw error
      }
    }
  }
  async read(file, offset = 0, length) {
    const handle = await fs.open(file, 'r')
    try {
      const size = (await handle.stat()).size
      if (offset >= size) return Buffer.alloc(0)
      const len = length === undefined ? size - offset : Math.min(length, size - offset)
      const buffer = Buffer.alloc(len)
      const { bytesRead } = await handle.read(buffer, 0, len, offset)
      return buffer.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
  }
  async write(file, content) {
    await this.mkdir(path.dirname(file))
    await withTimeout(fs.writeFile(file, content), `write ${file}`)
  }
  async append(file, content) {
    await this.mkdir(path.dirname(file))
    await withTimeout(fs.appendFile(file, content), `append ${file}`)
  }
  async copyToBackup(file, backupFile) {
    await this.mkdir(path.dirname(backupFile))
    await withTimeout(fs.copyFile(file, backupFile), `copy ${file}`)
  }
  close() { /* nothing to release */ }
}

/**
 * Remote transport via ssh2 SFTP. Supports ProxyJump chains: every hop in
 * `via` is connected in order and the final connection is tunnelled through a
 * forwardOut() stream. Private keys are read from paths held in DSH
 * credentials, so key contents never enter plugin config.
 */
const MAX_JUMP_HOPS = 8 // cycle guard, mirrors dsh-remote
const SFTP_TIMEOUT_MS = 20000

/**
 * Turn a ProxyJump chain into the ordered dial plan.
 *
 * `hops` is ordered outermost-first (the machine you can reach directly comes
 * first). Each entry says: authenticate to `hop` over `transport` (the stream
 * opened by the previous entry, or a plain TCP socket for the first one), then
 * ask `hop` to forward to `next`. The final entry's `next` is the target itself.
 */
export function planJumpChain(hops, target) {
  const list = (hops ?? []).slice(0, MAX_JUMP_HOPS)
  return list.map((hop, index) => {
    const next = index + 1 < list.length ? list[index + 1] : target
    return {
      hop,
      nextHost: next.host ?? next.hostname,
      nextPort: next.port ?? 22,
    }
  })
}

export class SshTransport {
  constructor({ host, port = 22, username, privateKeyPath, via = [], logger, hostKeyGuard } = {}) {
    this.kind = 'ssh'
    Object.assign(this, { host, port, username, privateKeyPath, logger, hostKeyGuard })
    // Defensive copy + hard cap on the jump chain (cycle/length guard).
    this.via = (via ?? []).slice(0, MAX_JUMP_HOPS)
    this._client = undefined
    this._clients = []   // jump-host clients, all ended on close()
    this._sftp = undefined
    this._connecting = undefined
    this._epoch = 0      // generation token: stale connects cannot install clients
    this._sftpDead = false
  }

  /** Build the ssh2 connect config, including TOFU host-key verification. */
  async _connectConfig(target, privateKey, sock) {
    const config = {
      host: target.host ?? target.hostname,
      port: target.port ?? 22,
      username: target.username,
      privateKey,
      sock,
      readyTimeout: 20000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 3,
    }
    if (this.hostKeyGuard?.verifier) {
      config.hostVerifier = await this.hostKeyGuard.verifier(
        config.host, config.port,
      )
    }
    return config
  }

  /** Resolve the home directory via SFTP realpath('.'), no shell needed. */
  async home() {
    const sftp = await this._sftpChannel()
    return new Promise((resolve, reject) => {
      sftp.realpath('.', (error, resolved) => error ? reject(error) : resolve(resolved))
    })
  }

  async _sftpChannel() {
    if (this._sftp && !this._sftpDead) return this._sftp
    if (this._connecting) return this._connecting
    const epoch = this._epoch
    this._connecting = (async () => {
      try {
        const privateKey = await fs.readFile(this.privateKeyPath)
        // Establish the jump chain. Each hop forwards a TCP stream to the next
        // hop (or the final target) over the SSH connection already open. Each
        // hop uses ONLY its own key — target credentials never cross hops.
        let sock
        const { Client } = await ssh2()
        for (const step of planJumpChain(this.via, this)) {
          const hop = step.hop
          const hopKey = await fs.readFile(hop.privateKeyPath)
          // Reached through the tunnel opened by the previous step (none for the
          // first hop), and authenticating with THIS hop's key only.
          const hopConfig = await this._connectConfig(hop, hopKey, sock)
          hopConfig.privateKey = hopKey
          const jumpClient = new Client()
          this._clients.push(jumpClient)
          const nextHost = step.nextHost
          const nextPort = step.nextPort
          sock = await new Promise((resolve, reject) => {
            jumpClient.once('error', reject)
            jumpClient.on('ready', () => {
              // ssh2 >=1.16 can throw synchronously on a dead socket.
              try {
                jumpClient.forwardOut('127.0.0.1', 0, nextHost, nextPort, (error, stream) => {
                  if (error) reject(error)
                  else resolve(stream)
                })
              } catch (error) { reject(error) }
            })
            jumpClient.connect(hopConfig)
          })
        }

        const client = new Client()
        const sftp = await new Promise((resolve, reject) => {
          client.once('error', reject)
          client.on('ready', () => {
            // Opening the channel also gets a timeout; never unref it.
            const timer = setTimeout(() => reject(new Error('SFTP channel open timeout')), SFTP_TIMEOUT_MS)
            client.sftp((error, channel) => {
              clearTimeout(timer)
              if (error) reject(error)
              else resolve(channel)
            })
          })
          this._connectConfig(this, privateKey, sock).then(config => client.connect(config), reject)
        })
        // Epoch guard: close() or a newer connect invalidated this generation.
        if (epoch !== this._epoch) {
          try { client.end() } catch { /* gone */ }
          throw new Error('SSH connection superseded')
        }
        client.removeAllListeners('error')
        client.on('error', error => this.logger?.warn?.(`conversation-sync ssh ${this.host}: ${error.message}`))
        client.on('close', () => { this._sftp = undefined; this._client = undefined; this._sftpDead = true })
        this._client = client
        this._sftp = sftp
        this._sftpDead = false
        return sftp
      } catch (error) {
        this.close()
        throw error
      } finally {
        this._connecting = undefined
      }
    })()
    return this._connecting
  }

  _call(method, args) {
    if (this._sftpDead) return Promise.reject(new Error('SFTP channel closed'))
    return new Promise((resolve, reject) => {
      this._sftpChannel().then(sftp => {
        let settled = false
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          this._noteSftpTimeout()
          reject(new Error(`SFTP ${method} timeout`))
        }, SFTP_TIMEOUT_MS)
        sftp[method](...args, (error, result) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (error) reject(error)
          else resolve(result)
        })
      }, reject)
    })
  }

  _noteSftpTimeout() {
    this._sftpTimeouts = (this._sftpTimeouts ?? 0) + 1
    if (this._sftpTimeouts >= 2) {
      // Two consecutive timeouts mean a dead channel: invalidate so the next
      // call reconnects instead of paying the timeout for every operation.
      this.logger?.warn?.(`conversation-sync: SFTP channel unresponsive; reconnecting`)
      this._sftpDead = true
      this._sftp = undefined
      this._epoch++
      this._sftpTimeouts = 0
    }
  }

  async stat(file) {
    try {
      const st = await this._call('stat', [file])
      return { size: st.size, mtimeMs: (st.mtime ?? 0) * 1000 }
    } catch (error) {
      if (/No such file|ENOENT/.test(String(error?.message))) return undefined
      throw error
    }
  }

  async list(dir) {
    try {
      const entries = await this._call('readdir', [dir])
      return entries.map(entry => ({ name: entry.filename, isDirectory: (entry.attrs?.mode & 0o040000) !== 0 }))
    } catch (error) {
      if (/No such file|ENOENT/.test(String(error?.message))) return []
      throw error
    }
  }

  async mkdir(dir) {
    // SFTP mkdir is not recursive; create path components one by one.
    const parts = dir.split('/').filter(Boolean)
    let current = dir.startsWith('/') ? '/' : ''
    for (const part of parts) {
      current = (current === '/' ? '' : current) + '/' + part
      try { await this._call('mkdir', [current]) } catch {
        const st = await this.stat(current)
        if (!st) throw new Error(`cannot create remote directory ${current}`)
      }
    }
  }

  async read(file, offset = 0, length) {
    const st = await this.stat(file)
    if (!st || offset >= st.size) return Buffer.alloc(0)
    const len = length === undefined ? st.size - offset : Math.min(length, st.size - offset)
    if (len <= 0) return Buffer.alloc(0)
    const handle = await this._call('open', [file, 'r'])
    try {
      let remaining = len
      let position = offset
      const chunks = []
      while (remaining > 0) {
        const size = Math.min(remaining, 65536)
        const chunk = await this._call('read', [handle, Buffer.alloc(size), 0, size, position])
        if (!chunk || chunk.length === 0) break
        chunks.push(chunk)
        position += chunk.length
        remaining -= chunk.length
      }
      return Buffer.concat(chunks)
    } finally {
      await this._call('close', [handle])
    }
  }

  async write(file, content) {
    await this.mkdir(path.posix.dirname(file))
    const handle = await this._call('open', [file, 'w'])
    try { await this._writeAll(handle, content, 0) } finally { await this._call('close', [handle]) }
  }

  async append(file, content) {
    const st = await this.stat(file)
    const handle = await this._call('open', [file, st ? 'a' : 'w'])
    try { await this._writeAll(handle, content, 0) } finally { await this._call('close', [handle]) }
  }

  _writeAll(handle, buffer, offset) {
    if (offset >= buffer.length) return Promise.resolve()
    return new Promise((resolve, reject) => {
      this._sftpChannel().then(sftp => {
        sftp.write(handle, buffer, offset, buffer.length - offset, offset, error => {
          if (error) reject(error)
          else this._writeAll(handle, buffer, buffer.length).then(resolve, reject)
        })
      }, reject)
    })
  }

  async copyToBackup(file, backupFile) {
    const content = await this.read(file)
    await this.write(backupFile, content)
  }

  close() {
    for (const client of this._clients) { try { client.end() } catch { /* gone */ } }
    try { this._client?.end() } catch { /* gone */ }
    this._clients = []
    this._client = undefined
    this._sftp = undefined
  }
}

/** Backward-compatible factory for legacy `sources` rows. */
export async function createTransport(source, credentials, logger) {
  if (!source.remote) return new LocalTransport()
  const resolved = await credentials.resolve(source.sshKeyRef)
  if (!resolved?.value) throw new Error(`SSH credential '${source.sshKeyRef}' is not configured`)
  return new SshTransport({
    host: source.sshHost,
    port: source.sshPort ?? 22,
    username: source.sshUser,
    privateKeyPath: resolved.value,
    logger,
  })
}

/**
 * Factory for a discovered machine. The private key for the machine and for
 * each ProxyJump hop is read from the credential reference
 * `conversation-sync/ssh-key/<machineId>` (configurable via keyRef).
 */
export async function transportForMachine(machine, machines, credentials, logger, keyRef, options = {}) {
  if (!machine || machine.kind === 'local') return new LocalTransport()
  const byId = new Map((machines ?? []).map(item => [item.id, item]))
  const resolveKeyPath = async id => {
    const ref = keyRef ?? `conversation-sync/ssh-key/${id}`
    const resolved = await credentials.resolve(ref)
    if (!resolved?.value) throw new Error(`SSH credential '${ref}' is not configured`)
    return resolved.value
  }
  const via = []
  for (const id of machine.via ?? []) {
    const hop = byId.get(id)
    if (!hop || hop.kind !== 'ssh') continue
    via.push({
      host: hop.hostname ?? hop.host,
      port: hop.port ?? 22,
      username: hop.user,
      privateKeyPath: await resolveKeyPath(hop.id),
    })
  }
  return new SshTransport({
    host: machine.hostname ?? machine.host,
    port: machine.port ?? 22,
    username: machine.user,
    privateKeyPath: await resolveKeyPath(machine.id),
    via,
    logger,
    hostKeyGuard: options.hostKeyGuard,
  })
}
