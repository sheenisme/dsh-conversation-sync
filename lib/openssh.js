import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * A transport that drives the system `ssh` binary instead of the `ssh2` module.
 *
 * `ssh2` cannot be a normal dependency of a DSH plugin: pnpm 12 refuses to
 * install a package whose dependency ships a build script unless the *profile*
 * opts in via `allowBuilds`, and the profile belongs to the user. Declaring it
 * as an optional peer means it is simply absent on a clean install, where every
 * SSH machine then fails with "Cannot find package 'ssh2'" — the plugin looks
 * broken while quietly reporting nothing.
 *
 * Talking to the machine's own `ssh` is also more correct: it inherits the
 * user's real `~/.ssh/config`, agent, `ProxyJump`, `Include`, `known_hosts` and
 * any `Match` blocks, so a host that works in a terminal works here. Every
 * operation is one short command over a multiplexed connection, which keeps the
 * protocol surface small enough to be obviously correct.
 */

const SSH_TIMEOUT_MS = Number(process.env.CONVERSATION_SYNC_SSH_TIMEOUT ?? 30000)

/** POSIX shell single-quote quoting: safe for any byte except NUL. */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`
}

function run(argv, { input, timeoutMs = SSH_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] })
    const out = []
    const err = []
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      // Keep the message short: the argv contains the control socket path and
      // possibly the key path, neither of which belongs in a user-facing error.
      const error = new Error(`ssh to ${argv[argv.length - 2] ?? 'the machine'} did not complete within ${timeoutMs}ms`)
      error.code = 'ETIMEDOUT'
      reject(error)
    }, timeoutMs)
    child.stdout.on('data', chunk => out.push(chunk))
    child.stderr.on('data', chunk => err.push(chunk))
    child.on('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString() })
    })
    if (input !== undefined) child.stdin.end(input)
    else child.stdin.end()
  })
}

/**
 * Codes that mean the connection itself is unusable — no later command on the
 * same transport can succeed, so remembering the failure is both faster and
 * more honest than repeating the same 15-second timeout.
 */
const FATAL_CODES = new Set(['EAUTH', 'EHOSTKEY', 'ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'ESSH'])

let cachedAvailability

/** Whether the system has an `ssh` we can use at all. */
export async function systemSshAvailable() {
  if (cachedAvailability !== undefined) return cachedAvailability
  try {
    const result = await run(['ssh', '-V'], { timeoutMs: 5000 })
    // `ssh -V` prints to stderr and exits 0 on OpenSSH; some builds exit 1.
    cachedAvailability = /OpenSSH/i.test(result.stderr) || result.code === 0
  } catch {
    cachedAvailability = false
  }
  return cachedAvailability
}

export class OpenSshTransport {
  constructor({ host, port = 22, username, privateKeyPath, via = [], logger } = {}) {
    this.kind = 'ssh'
    this.host = host
    this.port = port
    this.username = username
    this.privateKeyPath = privateKeyPath
    // The system ssh handles ProxyJump itself; `via` is kept for display and so
    // the caller can still see why a machine is grouped under a jump host.
    this.via = via
    this.logger = logger
    this.closed = false
    // A machine that cannot be reached must fail once, not once per scanned
    // root. Without this a dead host costs four full connect attempts (home +
    // three tool roots) and a scan of a dozen hosts takes minutes.
    this._fatal = undefined
    this._home = undefined
    this._controlPath = path.join(os.tmpdir(), `dsh-cs-ssh-${process.pid}-${Math.random().toString(36).slice(2, 10)}`)
  }

  /** Arguments shared by every invocation: identity, multiplexing, timeouts. */
  _baseArgs() {
    const args = [
      '-o', 'ControlMaster=auto',
      '-o', `ControlPath=${this._controlPath}`,
      '-o', 'ControlPersist=120',
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=15',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
    ]
    if (this.port && Number(this.port) !== 22) args.push('-p', String(this.port))
    if (this.privateKeyPath) args.push('-i', this.privateKeyPath, '-o', 'IdentitiesOnly=yes')
    if (this.username) args.push('-l', this.username)
    return args
  }

  _target() {
    return this.host
  }

  /** Run a shell snippet on the remote host, returning stdout as a Buffer. */
  async _exec(script, options = {}) {
    if (this.closed) throw Object.assign(new Error(`SSH connection to ${this.host} is closed`), { code: 'ECLOSED' })
    if (this._fatal) throw this._fatal
    const argv = ['ssh', ...this._baseArgs(), this._target(), script]
    const result = await run(argv, options)
    if (result.code !== 0) {
      const message = result.stderr.trim() || `ssh exited ${result.code}`
      const error = new Error(message)
      error.code = classifySshFailure(message, result.code)
      if (FATAL_CODES.has(error.code)) this._fatal = error
      // The exit status is the signal the remote shell uses for "absent" and
      // "in the way"; stderr is empty for those, so callers must be able to
      // read the code rather than pattern-match a message.
      error.exitCode = result.code
      error.stderr = result.stderr
      throw error
    }
    return result.stdout
  }

  async home() {
    if (this.closed) throw Object.assign(new Error(`SSH connection to ${this.host} is closed`), { code: 'ECLOSED' })
    if (this._home !== undefined) return this._home
    const out = await this._exec('printf %s "$HOME"')
    const home = out.toString().trim()
    if (!home) throw new Error(`could not determine the home directory on ${this.host}`)
    this._home = home
    return home
  }

  async stat(file) {
    // GNU stat and BSD stat disagree on flags; try both rather than guessing the
    // remote's userland.
    const script =
      `f=${shellQuote(file)}; ` +
      `if [ ! -e "$f" ]; then exit 3; fi; ` +
      `if stat -c '%s %Y' "$f" >/dev/null 2>&1; then stat -c '%s %Y' "$f"; ` +
      `elif stat -f '%z %m' "$f" >/dev/null 2>&1; then stat -f '%z %m' "$f"; ` +
      `else echo "no usable stat on this host" >&2; exit 4; fi`
    try {
      const out = (await this._exec(script)).toString().trim()
      const [size, seconds] = out.split(/\s+/)
      const bytes = Number(size)
      // mtime is only used for ordering; a missing one must not break listing.
      const mtimeMs = Number(seconds) * 1000
      return { size: Number.isFinite(bytes) ? bytes : 0, mtimeMs: Number.isFinite(mtimeMs) ? mtimeMs : 0 }
    } catch (error) {
      if (error.exitCode === 3 || error.code === 'ENOENT') return undefined
      throw error
    }
  }

  async list(dir) {
    // `ls -1Ap` is POSIX and marks directories with a trailing slash, which
    // lets one round trip answer "what is here and which of these are dirs".
    const script = `d=${shellQuote(dir)}; if [ ! -d "$d" ]; then exit 3; fi; ls -1Ap "$d"`
    try {
      const out = (await this._exec(script)).toString()
      return out
        .split('\n')
        .filter(name => name.length > 0)
        .map(name => (name.endsWith('/')
          ? { name: name.slice(0, -1), isDirectory: true }
          : { name, isDirectory: false }))
    } catch (error) {
      if (error.exitCode === 3 || error.code === 'ENOENT') return undefined
      throw error
    }
  }

  async mkdir(dir) {
    const script = `d=${shellQuote(dir)}; if [ -d "$d" ]; then exit 0; fi; ` +
      `if [ -e "$d" ]; then echo "a file is in the way" >&2; exit 5; fi; mkdir -p "$d"`
    try {
      await this._exec(script)
    } catch (error) {
      if (error.exitCode === 5 || /a file is in the way/.test(String(error.message))) {
        throw new Error(`cannot create the directory ${dir}: a file is in the way`)
      }
      throw error
    }
  }

  async read(file, offset = 0, length) {
    const count = length === undefined ? '' : ` | head -c ${Math.max(0, Number(length))}`
    const script = `f=${shellQuote(file)}; ` +
      `if [ ! -f "$f" ]; then exit 3; fi; ` +
      `tail -c +${Math.max(1, Number(offset) + 1)} "$f"${count}`
    try {
      return await this._exec(script)
    } catch (error) {
      if (error.exitCode === 3 || error.code === 'ENOENT') {
        return Buffer.alloc(0)
      }
      throw error
    }
  }

  async write(file, content) {
    if (this._fatal) throw this._fatal
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content))
    await this.mkdir(path.posix.dirname(file))
    const script = `cat > ${shellQuote(file)}`
    const result = await run(['ssh', ...this._baseArgs(), this._target(), script], { input: buffer })
    if (result.code !== 0) {
      const error = new Error(result.stderr.trim() || `ssh exited ${result.code}`)
      error.code = classifySshFailure(String(error.message), result.code)
      throw error
    }
  }

  async append(file, content) {
    if (this._fatal) throw this._fatal
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content))
    await this.mkdir(path.posix.dirname(file))
    const script = `cat >> ${shellQuote(file)}`
    const result = await run(['ssh', ...this._baseArgs(), this._target(), script], { input: buffer })
    if (result.code !== 0) {
      const error = new Error(result.stderr.trim() || `ssh exited ${result.code}`)
      error.code = classifySshFailure(String(error.message), result.code)
      throw error
    }
  }

  async copyToBackup(file, backupFile) {
    await this.mkdir(path.posix.dirname(backupFile))
    const script = `cp ${shellQuote(file)} ${shellQuote(backupFile)}`
    await this._exec(script)
  }

  close() {
    if (this.closed) return
    this.closed = true
    // Tear the master connection down so no orphan process outlives the plugin.
    const child = spawn('ssh', ['-o', `ControlPath=${this._controlPath}`, '-O', 'exit', this._target()], {
      stdio: 'ignore',
      detached: true,
    })
    child.on('error', () => {})
    child.unref()
    fs.rm(this._controlPath, { force: true }).catch(() => {})
  }
}

/**
 * Turn ssh's stderr into a code the rollback diagnostics can name. Keeping the
 * mapping here means an SSH failure is explained without the caller having to
 * parse English.
 */
export function classifySshFailure(message, code) {
  const text = String(message)
  if (/Permission denied|Authentication failed|no supported authentication/i.test(text)) return 'EAUTH'
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|host key.*mismatch/i.test(text)) return 'EHOSTKEY'
  if (/Could not resolve hostname|Name or service not known|nodename nor servname/i.test(text)) return 'ENOTFOUND'
  if (/Connection refused/i.test(text)) return 'ECONNREFUSED'
  if (/timed out|Connection timed out|Operation timed out/i.test(text)) return 'ETIMEDOUT'
  if (/No such file or directory/i.test(text)) return 'ENOENT'
  if (/Permission denied \(publickey/i.test(text)) return 'EAUTH'
  return code === 255 ? 'ESSH' : `ESSH:${code}`
}
