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

// apply() reads the stored placement preferences before registering anything
// (so an entry the user turned off never flashes on). That makes registration
// asynchronous, so this helper awaits the fetch it performs.
async function loadClient(preferences = { sidebarEntry: true, settingsEntry: true }) {
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ preferences }) })
  try {
    return await loadClientSync()
  } finally {
    globalThis.fetch = previousFetch
  }
}

async function loadClientSync() {
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
  // Let the preferences fetch resolve and its .then register the entries.
  for (let i = 0; i < 5; i += 1) await new Promise(resolve => setImmediate(resolve))
  return { module, dictionaries, registrations, definition }
}

test('client: declares the services it actually uses', async () => {
  const { module } = await loadClient()
  // `sessions` is not decoration: without it the sidebar never learns about a
  // session the plugin just wrote, which was a reported bug.
  assert.ok(module.inject.includes('sessions'), 'the sessions service must be injected')
  assert.ok(module.inject.includes('slots'))
  assert.ok(module.inject.includes('locale'))
})

test('client: registers the panel and a settings sidebar entry', async () => {
  const { registrations } = await loadClient()
  const names = registrations.map(entry => entry.name)
  assert.ok(names.includes('plugins.bundle.config'), 'the plugin panel must stay registered')
  assert.ok(names.includes('settings.section'), 'the feature must be reachable from Settings')
  assert.ok(names.includes('settings.section.icon'), 'the Settings entry needs an icon slot')
  const section = registrations.find(entry => entry.name === 'settings.section')
  assert.equal(section.id, 'dsh-conversation-sync')
  assert.equal(typeof section.label, 'function')
  assert.ok(Number.isFinite(section.order))
})

test('client: the sidebar entry is a real sidebar panel, on by default', async () => {
  const { registrations } = await loadClient()
  const names = registrations.map(entry => entry.name)
  assert.ok(names.includes('sidebar.panellist'), 'the feature must also live in the left sidebar')
  assert.ok(names.includes('main'), 'a sidebar panel needs a page to show')
  const panel = registrations.find(entry => entry.name === 'sidebar.panellist')
  assert.equal(panel.id, 'dsh-conversation-sync')
  assert.equal(typeof panel.label, 'function')
})

test('client: a placement switched off is never registered', async () => {
  const { registrations } = await loadClient({ sidebarEntry: false, settingsEntry: true })
  const names = registrations.map(entry => entry.name)
  assert.ok(names.includes('settings.section'), 'Settings stays when only the sidebar is off')
  assert.ok(!names.includes('sidebar.panellist'), 'the sidebar entry must not appear when its switch is off')
  assert.ok(!names.includes('main'), 'the sidebar page must not be registered either')
})

test('client: turning off Settings removes only that entry', async () => {
  const { registrations } = await loadClient({ sidebarEntry: true, settingsEntry: false })
  const names = registrations.map(entry => entry.name)
  assert.ok(!names.includes('settings.section'), 'the Settings entry must not appear when its switch is off')
  assert.ok(!names.includes('settings.section.icon'))
  assert.ok(names.includes('sidebar.panellist'), 'the sidebar entry is independent')
})

test('client: both dictionaries carry the same keys, including the settings label', async () => {
  const { dictionaries } = await loadClient()
  const dict = dictionaries['conversation-sync']
  assert.ok(dict, 'the conversation-sync dictionaries must be registered')
  const en = Object.keys(dict.en).sort()
  const zh = Object.keys(dict.zh).sort()
  assert.deepEqual(zh, en, 'en and zh must not drift apart')
  assert.ok(en.includes('settings.nav'), 'the Settings entry needs a label key')
})

test('client: every t() key used by the UI exists in the dictionary', async () => {
  const { dictionaries } = await loadClient()
  const dict = dictionaries['conversation-sync'].en
  const used = new Set([...source.matchAll(/t\('([a-zA-Z0-9_.]+)'\)/g)].map(match => match[1]))
  const missing = [...used].filter(key => !(key in dict))
  assert.deepEqual(missing, [], `missing locale keys: ${missing.join(', ')}`)
})
