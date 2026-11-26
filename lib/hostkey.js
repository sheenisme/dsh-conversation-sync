/**
 * Trust-on-first-use host-key guard for SSH transports, modelled on the
 * dsh-remote plugin's hostkey approach. ssh2 >=1.17 passes the raw wire-key
 * Buffer to hostVerifier, so we fingerprint with SHA-256/base64 ourselves.
 *
 * Modes:
 *   'accept-new' (default): record unknown hosts on first connect, then verify.
 *   'verify': reject unknown hosts (known_hosts must be seeded externally).
 *   'off': accept any host key (explicit opt-out; logs a warning).
 *
 * The store is a small JSON file under DSH's own data root, never the user's
 * ~/.ssh/known_hosts, so the plugin cannot corrupt OpenSSH state.
 */

import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'

const DEFAULT_MODE = 'accept-new'

function fingerprint(key) {
  const buffer = Buffer.isBuffer(key)
    ? key
    : Buffer.from(key?.key ?? key?.hash ?? String(key))
  return createHash('sha256').update(buffer).digest('base64')
}

function entryKey(host, port) {
  return `${host}:${port}`
}

export function createHostKeyGuard({ file, mode = DEFAULT_MODE, logger } = {}) {
  let records = {}
  let loaded = false
  let pending = Promise.resolve()

  async function load() {
    if (loaded) return
    loaded = true
    try {
      records = JSON.parse(await fs.readFile(file, 'utf8'))
      if (!records || typeof records !== 'object' || Array.isArray(records)) records = {}
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        logger?.warn?.(`conversation-sync: cannot read host keys: ${error.message}`)
      }
      records = {}
    }
  }

  async function save() {
    await fs.mkdir(file.slice(0, file.lastIndexOf('/')), { recursive: true })
    await fs.writeFile(file, JSON.stringify(records, null, 2), { mode: 0o600 })
  }

  /** Queue a write and remember it so callers can await durability. */
  function saveLater() {
    pending = pending.then(save).catch(error => {
      logger?.warn?.(`conversation-sync: cannot save host key: ${error.message}`)
    })
    return pending
  }

  /** Return an ssh2 `hostVerifier` callback for one host/port. */
  async function verifier(host, port) {
    await load()
    if (mode === 'off') {
      logger?.warn?.(`conversation-sync: host key verification disabled for ${host}`)
      return () => true
    }
    const id = entryKey(host, port)
    return (key, verify) => {
      const fp = fingerprint(key)
      const known = records[id]
      if (!known) {
        if (mode === 'verify') {
          logger?.warn?.(`conversation-sync: unknown host key for ${id} (verify mode); expected fingerprint ${fp}`)
          return verify(false)
        }
        records[id] = { fingerprint: fp, firstSeen: Date.now() }
        saveLater()
        logger?.info?.(`conversation-sync: trusted new host key for ${id}: SHA256:${fp}`)
        return verify(true)
      }
      if (known.fingerprint !== fp) {
        logger?.error?.(`conversation-sync: HOST KEY CHANGED for ${id}! Expected SHA256:${known.fingerprint}, got SHA256:${fp}. Possible man-in-the-middle — refusing.`)
        return verify(false)
      }
      return verify(true)
    }
  }

  async function forget(host, port) {
    await load()
    delete records[entryKey(host, port)]
    await save()
  }

  /** Resolve once every queued write has landed (used by tests and shutdown). */
  const settled = () => pending

  return { verifier, forget, fingerprint, settled }
}
