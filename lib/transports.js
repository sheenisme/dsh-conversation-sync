import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Client } from 'ssh2'

/**
 * A transport is a small filesystem facade used by the adapters and by session
 * discovery. It exposes just enough for incremental JSONL/zip reading,
 * append-style writing, and discovering the home directory of the machine.
 * `stat()` returns { size, mtimeMs } or undefined when the path is absent.
 */

class LocalTransport {
  constructor() { this.kind = 'local' }
  async home() { return os.homedir() }
  async stat(file) {
    try {
      const st = await fs.stat(file)
      return { size: st.size, mtimeMs: st.mtimeMs }
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      throw error
    }
  }
  async list(dir) {
    try {
      return (await fs.readdir(dir, { withFileTypes: true }))
        .filter(entry => entry.isFile() || entry.isDirectory())
        .map(entry => ({ name: entry.name, isDirectory: entry.isDirectory() }))
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
  }
  async mkdir(dir) { await fs.mkdir(dir, { recursive: true }) }
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
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, content)
  }
  async append(file, content) {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.appendFile(file, content)
  }
  async copyToBackup(file, backupFile) {
    await fs.mkdir(path.dirname(backupFile), { recursive: true })
    await fs.copyFile(file, backupFile)
  }
  close() { /* nothing to release */ }
}

/**
 * Remote transport via ssh2 SFTP. Supports ProxyJump chains: every hop in
 * `via` is connected in order and the final connection is tunnelled through a
 * forwardOut() stream. Private keys are read from paths held in DSH
 * credentials, so key contents never enter plugin config.
 */
class SshTransport {
  constructor({ host, port = 22, username, privateKeyPath, via = [], logger }) {
    this.kind = 'ssh'
    Object.assign(this, { host, port, username, privateKeyPath, via, logger })
    this._client = undefined
    this._clients = []   // jump-host clients, all ended on close()
    this._sftp = undefined
    this._connecting = undefined
  }

  /** Resolve the home directory via SFTP realpath('.'), no shell needed. */
  async home() {
    const sftp = await this._sftpChannel()
    return new Promise((resolve, reject) => {
      sftp.realpath('.', (error, resolved) => error ? reject(error) : resolve(resolved))
    })
  }

  async _sftpChannel() {
    if (this._sftp) return this._sftp
    if (this._connecting) return this._connecting
    this._connecting = (async () => {
      const privateKey = await fs.readFile(this.privateKeyPath)
      try {
        // Establish the jump chain. Each hop forwards a TCP stream to the next
        // hop (or to the final target) via the SSH connection already open.
        let sock
        for (let index = 0; index < this.via.length; index++) {
          const hop = this.via[index]
          const hopKey = await fs.readFile(hop.privateKeyPath)
          const next = index + 1 < this.via.length ? this.via[index + 1] : this
          const jumpClient = new Client()
          this._clients.push(jumpClient)
          sock = await new Promise((resolve, reject) => {
            jumpClient.once('error', reject)
            jumpClient.on('ready', () => {
              jumpClient.forwardOut('127.0.0.1', 0, next.host ?? next.hostname, next.port ?? 22, (error, stream) => {
                if (error) reject(error)
                else resolve(stream)
              })
            })
            jumpClient.connect({
              host: hop.host ?? hop.hostname,
              port: hop.port ?? 22,
              username: hop.username,
              privateKey: hopKey,
              readyTimeout: 20000,
              keepaliveInterval: 15000,
            })
          })
        }

        const client = new Client()
        this._client = client
        const sftp = await new Promise((resolve, reject) => {
          client.once('error', reject)
          client.on('ready', () => client.sftp((error, channel) => error ? reject(error) : resolve(channel)))
          client.connect({
            host: this.host,
            port: this.port,
            username: this.username,
            privateKey,
            sock, // undefined for direct connections
            readyTimeout: 20000,
            keepaliveInterval: 15000,
          })
        })
        client.removeAllListeners('error')
        client.on('error', error => this.logger?.warn?.(`conversation-sync ssh ${this.host}: ${error.message}`))
        client.on('close', () => { this._sftp = undefined; this._client = undefined })
        this._sftp = sftp
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
    return new Promise((resolve, reject) => {
      this._sftpChannel().then(sftp => {
        sftp[method](...args, (error, result) => error ? reject(error) : resolve(result))
      }, reject)
    })
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
export async function transportForMachine(machine, machines, credentials, logger, keyRef) {
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
  })
}
