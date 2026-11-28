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
  return { module, dictionaries, registrations, definition, source }
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

  // The sidebar keys its entries by `id`, but a main panel is keyed by `key`.
  // Clicking an entry calls layout.selectPanel(id), which throws
  //   layout.selectPanel: main panel "<id>" is not registered
  // unless a main panel carries that exact key. Registering `main` with `id`
  // made the entry look installed and open nothing - the reported bug.
  const main = registrations.find(entry => entry.name === 'main')
  assert.equal(main.key, 'dsh-conversation-sync', 'the main panel must be keyed, not id-ed')
  assert.equal(main.key, panel.id, 'the sidebar id and the main key must be the same value')
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

test('client: the bindings table offers select-all and a batch sync', async () => {
  const { source } = await loadClient()
  // Both act on the whole table, so both must exist and go through one request:
  // toggling row by row leaves the table half-updated on a fast double click.
  assert.match(source, /setBindingAll/, 'select-all must use the single-request RPC')
  assert.match(source, /syncChecked/, 'the table needs a batch sync button')
  assert.match(source, /checkedCount/, 'the header must show how many are checked')
})

test('client: a session bound more than once is still visible and marked', async () => {
  const { source } = await loadClient()
  // Binding one session twice is how two conversations get merged, so the row
  // must not disappear once it is bound - it changes state instead.
  assert.match(source, /boundDsh = id => bindings\.filter/, 'bound sessions are a list, not a single match')
  assert.match(source, /cs-item\.bound/, 'a bound session needs its own visual state')
  assert.match(source, /cs-badge/, 'more than one binding needs a count badge')
})

test('client: the two-sided choices are one segmented control, not two buttons', async () => {
  // They differ only in what happens when both sides moved - a policy, not a
  // different action - so they share one control and one Bind button.
  assert.match(source, /cs-seg'/)
  assert.match(source, /bothMode === 'both' \? ' on' : ''/)
  assert.match(source, /bothMode === 'auto' \? ' on' : ''/)
  assert.match(source, /setBothMode\('both'\)/)
  assert.match(source, /setBothMode\('auto'\)/)
  assert.match(source, /pair\(bothMode\)/)
  // The four old buttons are gone: one action per direction, plus the control.
  assert.doesNotMatch(source, /void pair\('both'\)/)
  assert.doesNotMatch(source, /void pair\('auto'\)/)
})

test('client: the info bar shows the running host version and recent activity', async () => {
  // A stale host is otherwise invisible: the client bundle reloads on refresh
  // while the host keeps its old code until the app restarts.
  assert.match(source, /rpc\('status'\)/)
  assert.match(source, /status\.version/)
  assert.match(source, /status\.activity/)
  assert.match(source, /cs-logLine/)
  assert.match(source, /cs-dot/)
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
  // `t(` must be the translation function itself: `createElement('style')` also
  // ends in `t(` and used to show up here as a phantom missing key.
  const used = new Set([...source.matchAll(/(?<![A-Za-z0-9_$.])t\('([a-zA-Z0-9_.]+)'\)/g)].map(match => match[1]))
  const missing = [...used].filter(key => !(key in dict))
  assert.deepEqual(missing, [], `missing locale keys: ${missing.join(', ')}`)
})
