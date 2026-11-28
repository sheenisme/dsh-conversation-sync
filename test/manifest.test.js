import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const manifest = () => readFile(new URL('../package.json', import.meta.url), 'utf8').then(JSON.parse)

test('manifest: every file it advertises exists in the package', async () => {
  const pkg = await manifest()
  for (const field of ['index.js', 'client.js', 'icon.svg', 'cordis.patch.yml']) {
    await assert.doesNotReject(
      () => readFile(new URL(`../${field}`, import.meta.url)),
      `${field} is advertised but missing`,
    )
  }
  assert.ok(pkg.files.includes('cordis.patch.yml'), 'the bundle patch must ship')
})

test('manifest: exports what the host asks for by name', async () => {
  const pkg = await manifest()
  assert.equal(pkg.exports['.'], './index.js')
  assert.equal(pkg.exports['./client'], './client.js')
  assert.equal(pkg.exports['./cordis.patch.yml'], './cordis.patch.yml')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
})

// A tiny prerelease-aware comparator, so this test needs no dependency.
const parseVersion = text => {
  const [core, pre = ''] = String(text).trim().split('-')
  const [major, minor, patch] = core.split('.').map(Number)
  return { major, minor, patch, pre }
}
const comparePre = (left, right) => {
  if (left === right) return 0
  if (!left) return 1
  if (!right) return -1
  const a = left.split('.')
  const b = right.split('.')
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const one = a[index]
    const two = b[index]
    if (one === undefined) return -1
    if (two === undefined) return 1
    const numOne = /^\d+$/.test(one) ? Number(one) : undefined
    const numTwo = /^\d+$/.test(two) ? Number(two) : undefined
    if (numOne !== undefined && numTwo !== undefined) {
      if (numOne !== numTwo) return numOne < numTwo ? -1 : 1
    } else if (numOne !== undefined) return -1
    else if (numTwo !== undefined) return 1
    else if (one !== two) return one < two ? -1 : 1
  }
  return 0
}
const compareVersions = (left, right) => {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  return comparePre(a.pre, b.pre)
}
const satisfiesRange = (version, range) => String(range).trim().split(/\s+/).every(clause => {
  const match = /^(>=|<=|>|<|=)?(.+)$/.exec(clause)
  const operator = match[1] ?? '='
  const verdict = compareVersions(version, match[2])
  if (operator === '>=') return verdict >= 0
  if (operator === '<=') return verdict <= 0
  if (operator === '>') return verdict > 0
  if (operator === '<') return verdict < 0
  return verdict === 0
})

test('manifest: declares the DSH range it is tested against', async () => {
  const pkg = await manifest()
  assert.equal(pkg.engines.dsh, '>=0.2.2-rc.1 <0.3.0-0')
  assert.equal(pkg.dsh.manifestVersion, 1)
  // The range must admit every release the CI matrix runs, prereleases
  // included: dsh-app-boot calls semver.satisfies(..., {includePrerelease:true}).
  for (const version of ['0.2.2-rc.2', '0.2.2-rc.3', '0.2.2-rc.4', '0.2.2-rc.5', '0.2.3-alpha.2']) {
    assert.ok(satisfiesRange(version, pkg.engines.dsh), `${version} must be admitted`)
  }
  // ...and must reject the next major line, so a future break is caught.
  assert.equal(satisfiesRange('0.3.0', pkg.engines.dsh), false)
})

test('manifest: the comparator itself agrees with semver on the edge cases', async () => {
  // Guards against a comparator that trivially passes everything.
  assert.equal(satisfiesRange('0.2.2-rc.1', '>=0.2.2-rc.1 <0.3.0-0'), true)
  assert.equal(satisfiesRange('0.2.1-rc.5', '>=0.2.2-rc.1 <0.3.0-0'), false)
  assert.equal(satisfiesRange('0.3.0-alpha.1', '>=0.2.2-rc.1 <0.3.0-0'), false)
  assert.equal(satisfiesRange('0.2.2-rc.0', '>=0.2.2-rc.1 <0.3.0-0'), false)
})

test('manifest: the panel is reachable without any optional peer installed', async () => {
  const pkg = await manifest()
  for (const name of Object.keys(pkg.peerDependenciesMeta ?? {})) {
    assert.equal(pkg.peerDependenciesMeta[name].optional, true, `${name} must be optional`)
  }
})
