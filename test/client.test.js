import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The browser half is a plain ES module wrapped in DSH's module loader, so it
// can be executed here with a stub loader, a stub slots registry and a stub
// locale service. That is enough to catch the class of bug that is invisible to
// every host-side test: a slot that is never registered, a service missing from
// the inject list, or a locale key that does not exist.

const here = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8')

function loadClient() {
  let definition
  globalThis.window = { __ModuleLoader__: { load: value => { definition = value } } }
  // eslint-disable-next-line no-new-func
  new Function(source)()
  assert.ok(definition, 'client.js did not call __ModuleLoader__.load()')

  const dictionaries = {}
  const registrations = []
  const ctx = {
    slots: {
      inject: (name, fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
      register: options => { registrations.push(options); return () => {} },
    },
    locale: {
      register: (ns, dicts) => { dictionaries[ns] = dicts; return () => {} },
      bind: ns => key => dictionaries[ns]?.en?.[key] ?? key,
    },
    effect: fn => { fn(); return () => {} },
    sessions: { refresh: async () => {} },
  }
  const module = definition.factory(name => ({
    'react/jsx-runtime': { jsx: () => null, jsxs: () => null, Fragment: null },
    react: { useCallback: () => {}, useEffect: () => {}, memo: () => {}, useMemo: () => {}, useState: () => [] },
  })[name])
  module.apply(ctx)
  return { module, dictionaries, registrations, definition }
}

test('client: declares the services it actually uses', () => {
  const { module } = loadClient()
  // `sessions` is not decoration: without it the sidebar never learns about a
  // session the plugin just wrote, which was a reported bug.
  assert.ok(module.inject.includes('sessions'), 'the sessions service must be injected')
  assert.ok(module.inject.includes('slots'))
  assert.ok(module.inject.includes('locale'))
})

test('client: registers the panel and a settings sidebar entry', () => {
  const { registrations } = loadClient()
  const names = registrations.map(entry => entry.name)
  assert.ok(names.includes('plugins.bundle.config'), 'the plugin panel must stay registered')
  assert.ok(names.includes('settings.section'), 'the feature must be reachable from Settings')
  assert.ok(names.includes('settings.section.icon'), 'the Settings entry needs an icon slot')
  const section = registrations.find(entry => entry.name === 'settings.section')
  assert.equal(section.id, 'dsh-conversation-sync')
  assert.equal(typeof section.label, 'function')
  assert.ok(Number.isFinite(section.order))
})

test('client: both dictionaries carry the same keys, including the settings label', () => {
  const { dictionaries } = loadClient()
  const dict = dictionaries['conversation-sync']
  assert.ok(dict, 'the conversation-sync dictionaries must be registered')
  const en = Object.keys(dict.en).sort()
  const zh = Object.keys(dict.zh).sort()
  assert.deepEqual(zh, en, 'en and zh must not drift apart')
  assert.ok(en.includes('settings.nav'), 'the Settings entry needs a label key')
})

test('client: every t() key used by the UI exists in the dictionary', () => {
  const { dictionaries } = loadClient()
  const dict = dictionaries['conversation-sync'].en
  const used = new Set([...source.matchAll(/t\('([a-zA-Z0-9_.]+)'\)/g)].map(match => match[1]))
  const missing = [...used].filter(key => !(key in dict))
  assert.deepEqual(missing, [], `missing locale keys: ${missing.join(', ')}`)
})
