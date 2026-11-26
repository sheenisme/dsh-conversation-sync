/** Shared test helpers: a pure in-memory transport implementing the facade
 *  used by discovery.js and readJsonlDelta (stat/list/read/home/write/append). */

export function memoryTransport(files = {}, { home = '/home/tester' } = {}) {
  const store = new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)]))
  const dirs = new Set(['/'])

  const ensureDirs = p => {
    const parts = p.split('/').filter(Boolean)
    let cur = ''
    for (const part of parts) {
      cur += '/' + part
      dirs.add(cur)
    }
  }
  for (const f of store.keys()) ensureDirs(f.slice(0, f.lastIndexOf('/')))

  return {
    kind: 'local',
    async stat(p) {
      const b = store.get(p)
      if (b) return { size: b.length, mtimeMs: 1, isDirectory: false }
      if (dirs.has(p.replace(/\/$/, ''))) return { size: 0, mtimeMs: 0, isDirectory: true }
      return undefined
    },
    async list(p) {
      const base = p.replace(/\/$/, '')
      // A real local/SSH transport throws ENOENT for a missing directory;
      // scanMachine relies on that to report per-root errors.
      if (base !== '/' && !dirs.has(base)) {
        const err = new Error(`ENOENT ${base}`); err.code = 'ENOENT'; throw err
      }
      const out = []
      const seen = new Set()
      for (const f of store.keys()) {
        const idx = f.lastIndexOf('/')
        const parent = idx <= 0 ? '/' : f.slice(0, idx)
        if (parent === base) {
          const name = f.slice(idx + 1)
          if (seen.has(name)) continue
          seen.add(name)
          out.push({ name, isDirectory: false, isSymbolicLink: false })
        }
      }
      const prefix = base === '/' ? '/' : base + '/'
      for (const d of dirs) {
        if (d === base || !d.startsWith(prefix)) continue
        const rest = d.slice(prefix.length)
        if (!rest.includes('/')) {
          if (seen.has(rest)) continue
          seen.add(rest)
          out.push({ name: rest, isDirectory: true, isSymbolicLink: false })
        }
      }
      return out
    },
    async read(p, offset = 0, length) {
      const b = store.get(p)
      if (!b) throw new Error(`ENOENT ${p}`)
      return length === undefined ? b.subarray(offset) : b.subarray(offset, offset + length)
    },
    async write(p, data) { ensureDirs(p.slice(0, p.lastIndexOf('/'))); store.set(p, Buffer.from(data)) },
    async append(p, data) { store.set(p, Buffer.concat([store.get(p) ?? Buffer.alloc(0), Buffer.from(data)])) },
    async mkdir(p) { ensureDirs(p) },
    async copyToBackup(from, to) { store.set(to, Buffer.from(store.get(from) ?? Buffer.alloc(0))); ensureDirs(to.slice(0, to.lastIndexOf('/'))) },
    async home() { return home },
    async close() {},
    _store: store,
  }
}
