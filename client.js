// Conversation sync — browser half.
//
// Layout, from the top down:
//   1. what this page does, and where it may appear
//   2. two trees: DSH on the left (workspace → session), machines on the right
//      (machine → tool → session)
//   3. the pairing buttons, which need one selection on each side
//   4. the bindings table: checkbox, direction, manual/auto, which side is newer
//
// Styling uses the app's own design tokens (--dsw-alias-*), so light and dark
// follow the theme instead of a hard-coded palette. There is no CSS-in-JS
// helper in this host, so one <style> tag is injected and the classes are
// prefixed `cs-`.
window.__ModuleLoader__.load({
  id: 'dsh-conversation-sync',
  factory: (require) => {
    const { jsx, jsxs } = require('react/jsx-runtime')
    const { useCallback, useEffect, useMemo, useState } = require('react')

    const PKG = 'dsh-conversation-sync'
    const NS = 'conversation-sync'
    const rpc = (action, extra = {}) => fetch('api/conversation-sync/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, ...extra }),
    }).then(async response => {
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
      return data
    })

    // ---------------------------------------------------------------- styling
    //
    // Only semantic tokens: --dsw-static-* would not flip in dark mode, and a
    // literal colour would not follow the theme at all.
    const CSS = `
.cs-root{display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.cs-head{display:flex;flex-direction:column;gap:4px}
.cs-title{display:flex;align-items:center;gap:8px;margin:0;font-size:16px;font-weight:600;line-height:24px}
.cs-sub{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.cs-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
/* A framed group so it is clear the buttons inside act on the two selections
   above and on nothing else. */
.cs-actionBar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 12px;
  border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);
  background:var(--dsw-alias-bg-layer-3)}
.cs-actionScope{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1 1 200px}
.cs-actionTitle{font-size:12px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-secondary)}
.cs-actionHint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.cs-spacer{flex:1 1 auto}
.cs-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;padding:0 10px;
  font:inherit;font-size:12px;line-height:18px;cursor:pointer;color:var(--dsw-alias-label-primary);
  background:transparent;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm)}
.cs-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.cs-btn:disabled{opacity:.4;cursor:not-allowed}
.cs-btn.primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border-color:transparent}
.cs-btn.primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.cs-btn.quiet{border-color:transparent;color:var(--dsw-alias-label-secondary)}
.cs-btn.quiet:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.cs-btn.danger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 35%,transparent)}
.cs-trees{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;align-items:start}
.cs-pane{display:flex;flex-direction:column;min-width:0;border:.5px solid var(--dsw-alias-border-l2);
  border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);overflow:hidden}
.cs-paneHead{display:flex;align-items:center;gap:6px;height:34px;padding:0 10px;
  border-bottom:.5px solid var(--dsw-alias-border-l2);font-size:12px;font-weight:600;
  color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}
.cs-paneBody{max-height:320px;overflow-y:auto;padding:4px}
.cs-group{display:flex;flex-direction:column}
.cs-groupRow{display:flex;align-items:center;gap:6px;height:28px;padding:0 6px;border-radius:var(--dsw-radius-xs);
  cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.cs-groupRow:hover{background:var(--dsw-alias-interactive-bg-hover)}
.cs-groupRow.sel{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}
.cs-caret{width:12px;flex:0 0 12px;text-align:center;opacity:.6}
.cs-groupName{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cs-item{display:flex;align-items:flex-start;gap:6px;padding:5px 6px 5px 20px;border-radius:var(--dsw-radius-xs);cursor:pointer}
.cs-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.cs-item.sel{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent);
  box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-selected)}
/* Already bound, but not the row the user is working on: present, dimmer, and
   marked, so it is obvious why pairing it again is allowed (that is a merge). */
.cs-item.bound{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 7%,transparent)}
.cs-item.bound .cs-itemTitle{color:var(--dsw-alias-label-secondary)}
.cs-item.bound::before{content:'';position:absolute;left:6px;top:50%;width:4px;height:4px;margin-top:-2px;
  border-radius:999px;background:var(--dsw-alias-state-success-primary)}
.cs-item{position:relative}
.cs-badge{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:16px;padding:0 4px;
  border-radius:999px;font-size:10px;line-height:16px;font-weight:600;
  color:var(--dsw-alias-state-success-primary);
  background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent)}
.cs-itemMain{flex:1 1 auto;min-width:0}
.cs-itemTitle{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px}
.cs-itemMeta{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:16px;
  color:var(--dsw-alias-label-tertiary)}
.cs-tag{display:inline-flex;align-items:center;padding:0 6px;border-radius:999px;font-size:11px;line-height:16px;
  font-weight:500;color:var(--dsw-alias-label-tertiary);border:.5px solid var(--dsw-alias-border-l4)}
.cs-tag.on{color:var(--dsw-alias-state-success-primary);
  background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent);border-color:transparent}
.cs-tag.busy{color:var(--dsw-alias-state-business-primary);
  background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent);border-color:transparent}
.cs-empty{padding:10px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.cs-note{padding:8px 10px;border-radius:var(--dsw-radius-sm);font-size:12px;line-height:18px;
  background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}
.cs-err{display:flex;flex-direction:column;gap:2px;padding:8px 10px;border-radius:var(--dsw-radius-sm);
  font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);
  background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);
  border:.5px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 28%,transparent)}
.cs-warn{font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-primary)}
.cs-hint{margin-left:10px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.cs-field{display:flex;flex-direction:column;gap:4px;padding:8px 0}
.cs-label{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.cs-input{height:30px;padding:0 10px;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);
  border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1)}
.cs-input:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary)}
.cs-check{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:18px;cursor:pointer;
  color:var(--dsw-alias-label-secondary)}
.cs-check input{width:14px;height:14px;margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:inherit}
.cs-table{width:100%;border-collapse:collapse;font-size:12px;line-height:18px}
.cs-table th{text-align:left;padding:6px 8px;font-weight:500;color:var(--dsw-alias-label-tertiary);
  border-bottom:.5px solid var(--dsw-alias-border-l2);white-space:nowrap}
.cs-table td{padding:8px;border-bottom:.5px solid var(--dsw-alias-border-l1);vertical-align:middle}
.cs-table tr:last-child td{border-bottom:none}
.cs-table tr.off td{opacity:.55}
.cs-name{display:flex;flex-direction:column;gap:1px;min-width:0}
.cs-nameTitle{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:260px;color:var(--dsw-alias-label-primary)}
.cs-nameMeta{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:260px;font-size:11px;
  color:var(--dsw-alias-label-tertiary)}
.cs-select{height:26px;padding:0 6px;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);
  background:var(--dsw-alias-bg-layer-3);border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-xs)}
.cs-newer{font-size:11px;line-height:16px}
.cs-newer.external{color:var(--dsw-alias-state-warn-primary)}
.cs-newer.dsh{color:var(--dsw-alias-state-business-primary)}
.cs-newer.equal,.cs-newer.unknown{color:var(--dsw-alias-label-tertiary)}
.cs-scroll{overflow-x:auto}
`

    let styleApplied = false
    const applyStyle = () => {
      if (styleApplied || typeof document === 'undefined') return
      styleApplied = true
      const id = `${PKG}/style`
      if (document.querySelector(`style[data-plugin-css="${id}"]`)) return
      const tag = document.createElement('style')
      tag.dataset.plugin = PKG
      tag.dataset.pluginCss = id
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // Where the two entries live. Both are on by default; each toggle registers
    // or disposes its own slot entry, so turning one off removes it immediately
    // instead of waiting for a reload.
    let applyPlacement = () => {}
    let hostSessions
    const refreshDshSessions = async () => {
      // A stale sidebar is better than a failed sync, so this never throws.
      try { await hostSessions?.refresh?.() } catch { /* ignore */ }
    }

    // The left tree lists existing DSH sessions, but importing a conversation
    // that has never been in DSH has to create one. Rather than weakening the
    // "both sides must be chosen" rule, the left pane offers an explicit
    // new-session target — so there is always something on the left to choose.
    const NEW_LEFT = '__new__'

    const titleOf = item => item?.title || item?.name || item?.id || '—'
    const shortId = id => String(id ?? '').length > 18 ? `${String(id).slice(0, 12)}…${String(id).slice(-4)}` : String(id ?? '')

    /** A collapsible group: a clickable header row plus its children. */
    const Group = ({ open, onToggle, label, count, selected, children }) => jsxs('div', {
      className: 'cs-group',
      children: [
        jsxs('div', {
          className: `cs-groupRow${selected ? ' sel' : ''}`,
          onClick: onToggle,
          role: 'button',
          tabIndex: 0,
          onKeyDown: event => { if (event.key === 'Enter' || event.key === ' ') onToggle() },
          children: [
            jsx('span', { className: 'cs-caret', children: open ? '▾' : '▸' }),
            jsx('span', { className: 'cs-groupName', title: label, children: label }),
            jsx('span', { className: 'cs-tag', children: count }),
          ],
        }),
        open ? children : null,
      ],
    })

    function Page({ t }) {
      const [machines, setMachines] = useState([])
      const [machineWarnings, setMachineWarnings] = useState([])
      const [keys, setKeys] = useState({})
      const [cache, setCache] = useState({ dsh: [], external: {}, errors: {}, workspaces: [], at: 0 })
      const [bindings, setBindings] = useState([])
      const [states, setStates] = useState([])
      const [comparisons, setComparisons] = useState({})
      // Selection is a pair: a DSH session on the left, an external session on
      // the right. Neither side alone can be bound.
      const [left, setLeft] = useState('')
      const [right, setRight] = useState(null)
      const [openGroups, setOpenGroups] = useState({})
      const [keyEdit, setKeyEdit] = useState('')
      const [keyValue, setKeyValue] = useState('')
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const [lastResult, setLastResult] = useState(undefined)
      // The host answers 503 "not ready" until its storage is open. That is a
      // loading state, not an empty one: showing "no sessions" for it is what
      // made the panel look empty for the first seconds after it opened.
      const [loading, setLoading] = useState(true)
      const [prefs, setPrefs] = useState({ sidebarEntry: true, settingsEntry: true })

      const load = useCallback(async (force = false) => {
        try {
          const [m, sess, b, p] = await Promise.all([
            rpc('machines', force ? { refresh: true } : {}),
            rpc('sessions', { force }),
            rpc('bindings'),
            rpc('preferences'),
          ])
          setMachines(m.machines ?? [])
          setMachineWarnings(m.warnings ?? [])
          setKeys(m.keys ?? {})
          setCache(sess)
          setBindings(b.bindings ?? [])
          setStates(b.states ?? [])
          setComparisons(b.comparisons ?? {})
          setPrefs(p.preferences ?? { sidebarEntry: true, settingsEntry: true })
          setError('')
          setLoading(false)
        } catch (e) {
          // "not ready" resolves itself; anything else is a real error to show.
          if (!/not ready/i.test(e.message)) { setError(e.message); setLoading(false) }
        }
      }, [])

      useEffect(() => { void load(); const id = setInterval(() => void load(), 5000); return () => clearInterval(id) }, [load])

      const stateFor = id => states.find(x => x.bindingId === id)
      // A session may be bound more than once on purpose: two sources bound to
      // one DSH session is how you merge two conversations into one. So these
      // return every match, and the trees show the count.
      const boundDsh = id => bindings.filter(b => b.dshSessionIds?.includes(id))
      const boundExternal = (machineId, sessionPath, kind) =>
        bindings.filter(b => b.externalPath === sessionPath && b.machineId === machineId && (!kind || b.kind === kind))
      const toggleGroup = key => setOpenGroups(prev => ({ ...prev, [key]: prev[key] === false }))

      // LEFT TREE: workspace → session. A session cannot name its profile (the
      // session header has no such field, and the sessions directory never
      // depends on it), so the workspace is the only honest top level — it is
      // also exactly how DSH's own sidebar groups sessions.
      const leftTree = useMemo(() => {
        const sessions = cache.dsh ?? []
        const byId = new Map(sessions.map(session => [session.id, session]))
        const claimed = new Set()
        const groups = []
        for (const workspace of cache.workspaces ?? []) {
          const rows = []
          for (const id of workspace.sessionIds ?? []) {
            const session = byId.get(id)
            if (!session) continue
            claimed.add(id)
            rows.push(session)
          }
          if (!rows.length) continue
          rows.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
          groups.push({ key: `ws:${workspace.id}`, label: workspace.title || workspace.path, rows })
        }
        const orphans = sessions.filter(session => !claimed.has(session.id))
        if (orphans.length) {
          groups.push({ key: 'ws:none', label: t('panel.noWorkspace'), rows: orphans })
        }
        return groups
      }, [cache.dsh, cache.workspaces, t])

      // RIGHT TREE: machine → tool → session.
      const rightTree = useMemo(() => {
        return machines.map(machine => {
          const sessions = cache.external?.[machine.id] ?? []
          const byKind = new Map()
          for (const session of sessions) {
            if (!byKind.has(session.kind)) byKind.set(session.kind, [])
            byKind.get(session.kind).push(session)
          }
          return {
            machine,
            total: sessions.length,
            errors: cache.errors?.[machine.id] ?? [],
            kinds: [...byKind.entries()].map(([kind, rows]) => ({ kind, rows })),
          }
        })
      }, [machines, cache.external, cache.errors])

      const setPreference = async patch => {
        try {
          const next = await rpc('setPreferences', patch)
          setPrefs(next.preferences ?? prefs)
          // The placement of the entries is a client decision, so the change has
          // to be applied here; the host only remembers it.
          applyPlacement?.(next.preferences)
        } catch (e) { setError(e.message) }
      }

      // Both sides are required, for every direction: an import needs to know
      // which DSH session to grow, and an export needs to know what to write.
      const pair = async direction => {
        if (!right) { setError(t('panel.pickRight')); return }
        if (!left) { setError(t('panel.pickLeft')); return }
        // The new-session target means "create the DSH side from this source";
        // any real selection means "write into that existing session".
        const targets = left === NEW_LEFT ? [] : [left]
        setBusy(true)
        try {
          // OpenCode sessions live inside one SQLite file: the file is the
          // external path and the row id is the session selector.
          const opencode = right.kind === 'opencode'
          const result = await rpc('pair', {
            binding: {
              name: titleOf(right),
              machineId: right.machineId,
              externalPath: opencode ? (right.dbPath ?? right.path) : right.path,
              externalSessionId: opencode ? right.id : undefined,
              dbPath: opencode ? (right.dbPath ?? right.path) : undefined,
              kind: right.kind,
              dshSessionIds: targets,
              direction,
              pollMs: 2000,
              autoSync: false,
              checked: true,
              enabled: true,
            },
          })
          setLastResult(result.result)
          if (result.result?.failure) setError(result.result.failure.reason)
          await refreshDshSessions()
          await load(true)
        } catch (e) { setError(e.message) } finally { setBusy(false) }
      }

      const sync = async (id, direction) => {
        setBusy(true)
        try {
          const result = await rpc('sync', id ? { id, direction } : {})
          if (result.results?.length === 1) setLastResult(result.results[0])
          await refreshDshSessions()
          await load()
        } catch (e) { setError(e.message) } finally { setBusy(false) }
      }

      const updateBinding = async (id, patch) => {
        setBusy(true)
        try {
          await rpc('setBinding', { id, ...patch })
          await load()
        } catch (e) { setError(e.message) } finally { setBusy(false) }
      }

      const unbind = async id => {
        if (!window.confirm(t('panel.confirmRemove'))) return
        setBusy(true)
        try { await rpc('unbind', { id }); await load() } catch (e) { setError(e.message) } finally { setBusy(false) }
      }

      // Select-all is derived from the table, so it can never drift out of step
      // with the rows: it reads "all", "none" or "some" from the current list.
      const checkedCount = bindings.filter(binding => binding.checked !== false).length
      const allChecked = bindings.length > 0 && checkedCount === bindings.length

      // One round trip for the whole table. Toggling row by row would leave the
      // table half-updated if the user clicked twice quickly.
      const toggleAll = async () => {
        const next = !allChecked
        setBusy(true)
        try {
          await rpc('setBindingAll', { checked: next })
          await load()
        } catch (e) { setError(e.message) } finally { setBusy(false) }
      }

      // Sync only what is checked, in one request. The host skips unchecked
      // bindings on its own, so this is the same gate the poll uses.
      const syncChecked = async () => {
        setBusy(true)
        try {
          const result = await rpc('sync')
          const results = result.results ?? []
          setLastResult(results.length === 1 ? results[0] : { batch: results.length })
          await refreshDshSessions()
          await load()
        } catch (e) { setError(e.message) } finally { setBusy(false) }
      }

      const saveKey = async () => {
        if (!keyEdit || !keyValue.trim()) return
        setBusy(true)
        try {
          await rpc('setKey', { machineId: keyEdit, path: keyValue.trim() })
          setKeyEdit('')
          setKeyValue('')
          await load(true)
        } catch (e) { setError(e.message) } finally { setBusy(false) }
      }

      const newerLabel = binding => {
        const comparison = comparisons[binding.id]
        if (!comparison) return null
        const key = comparison.newer
        const text = key === 'external' ? t('panel.newerExternal')
          : key === 'dsh' ? t('panel.newerDsh')
            : key === 'equal' ? t('panel.newerEqual')
              : t('panel.newerUnknown')
        return jsx('span', { className: `cs-newer ${key}`, title: comparison.reason, children: text })
      }

      const renderLeft = () => {
        const newRow = jsxs('div', {
          className: `cs-item${left === NEW_LEFT ? ' sel' : ''}`,
          onClick: () => setLeft(left === NEW_LEFT ? '' : NEW_LEFT),
          role: 'button',
          tabIndex: 0,
          onKeyDown: event => { if (event.key === 'Enter') setLeft(NEW_LEFT) },
          children: [
            jsxs('div', { className: 'cs-itemMain', children: [
              jsx('div', { className: 'cs-itemTitle', children: t('panel.newSession') }),
              jsx('div', { className: 'cs-itemMeta', children: t('panel.newSessionHint') }),
            ] }),
          ],
        }, 'new')
        if (loading) return [newRow, jsx('div', { className: 'cs-empty', children: t('panel.loading') })]
        if (!leftTree.length) return [newRow, jsx('div', { className: 'cs-empty', children: t('panel.noDsh') })]
        return [newRow, ...leftTree.map(group => {
          const open = openGroups[group.key] !== false
          return jsx(Group, {
            open,
            onToggle: () => toggleGroup(group.key),
            label: group.label,
            count: group.rows.length,
            children: jsx('div', {
              children: group.rows.map(session => {
                const boundTo = boundDsh(session.id)
                const selected = left === session.id
                // Three states, because they answer three different questions:
                // "is this the one I am about to use", "is it already wired up",
                // and "is it wired up but not what I picked".
                const state = selected ? 'sel' : boundTo.length ? 'bound' : ''
                return jsxs('div', {
                  className: `cs-item${state ? ` ${state}` : ''}`,
                  onClick: () => setLeft(selected ? '' : session.id),
                  role: 'button',
                  tabIndex: 0,
                  onKeyDown: event => { if (event.key === 'Enter') setLeft(session.id) },
                  children: [
                    jsxs('div', { className: 'cs-itemMain', children: [
                      jsxs('div', { className: 'cs-itemTitle', title: titleOf(session), children: [
                        titleOf(session),
                        boundTo.length > 1 ? jsx('span', { className: 'cs-badge', title: t('panel.multiBound'), children: `×${boundTo.length}` }) : null,
                      ] }),
                      jsxs('div', { className: 'cs-itemMeta', children: [
                        `${shortId(session.id)}${session.count !== undefined ? ` · ${session.count}` : ''}`,
                        boundTo.length ? ` · ${t('panel.bound')}` : '',
                      ] }),
                    ] }),
                  ],
                }, session.id)
              }),
            }),
          }, group.key)
        })]
      }

      const renderRight = () => {
        if (loading) return jsx('div', { className: 'cs-empty', children: t('panel.loading') })
        if (!rightTree.length) return jsx('div', { className: 'cs-empty', children: t('panel.noExternal') })
        return rightTree.map(({ machine, total, errors, kinds }) => {
          const machineKey = `m:${machine.id}`
          const machineOpen = openGroups[machineKey] !== false
          const isSsh = machine.kind === 'ssh'
          return jsxs('div', {
            children: [
              jsx(Group, {
                open: machineOpen,
                onToggle: () => toggleGroup(machineKey),
                label: `${isSsh ? '⇄ ' : '⌂ '}${machine.label}`,
                count: total,
                children: jsxs('div', {
                  children: [
                    errors.length ? jsx('div', { className: 'cs-warn', style: { padding: '4px 6px 4px 20px' }, children: errors.join(' · ') }) : null,
                    isSsh ? jsxs('div', {
                      className: 'cs-bar',
                      style: { padding: '2px 6px 4px 20px' },
                      children: [
                        jsx('span', { className: 'cs-itemMeta', style: { flex: '1 1 auto' }, title: keys[machine.id] ?? '', children: `${t('panel.key')}: ${keys[machine.id] ? keys[machine.id] : t('panel.keyMissing')}` }),
                        jsx('button', {
                          className: 'cs-btn quiet',
                          onClick: () => { setKeyEdit(machine.id); setKeyValue(keys[machine.id] ?? '') },
                          children: t('panel.setKey'),
                        }),
                      ],
                    }) : null,
                    keyEdit === machine.id ? jsxs('div', {
                      className: 'cs-field',
                      style: { padding: '4px 6px 8px 20px' },
                      children: [
                        jsx('span', { className: 'cs-label', children: t('panel.keyPath') }),
                        jsx('input', {
                          className: 'cs-input',
                          value: keyValue,
                          onChange: e => setKeyValue(e.target.value),
                          placeholder: '~/.ssh/id_ed25519',
                        }),
                        jsxs('div', { className: 'cs-bar', children: [
                          jsx('button', { className: 'cs-btn primary', disabled: busy, onClick: () => void saveKey(), children: t('panel.save') }),
                          jsx('button', { className: 'cs-btn', onClick: () => setKeyEdit(''), children: t('panel.cancel') }),
                        ] }),
                      ],
                    }) : null,
                    ...kinds.map(({ kind, rows }) => {
                      const kindKey = `k:${machine.id}:${kind}`
                      const kindOpen = openGroups[kindKey] !== false
                      return jsx(Group, {
                        open: kindOpen,
                        onToggle: () => toggleGroup(kindKey),
                        label: t(`panel.kinds.${kind}`),
                        count: rows.length,
                        children: jsx('div', {
                          children: rows.map(session => {
                            const selected = right?.machineId === machine.id && right?.path === session.path && right?.kind === kind
                            const boundTo = boundExternal(machine.id, session.path, kind)
                            const state = selected ? 'sel' : boundTo.length ? 'bound' : ''
                            return jsxs('div', {
                              className: `cs-item${state ? ` ${state}` : ''}`,
                              onClick: () => setRight(selected ? null : { ...session, machineId: machine.id }),
                              role: 'button',
                              tabIndex: 0,
                              onKeyDown: event => { if (event.key === 'Enter') setRight({ ...session, machineId: machine.id }) },
                              children: [
                                jsxs('div', { className: 'cs-itemMain', children: [
                                  jsxs('div', { className: 'cs-itemTitle', title: titleOf(session), children: [
                                    titleOf(session),
                                    boundTo.length > 1 ? jsx('span', { className: 'cs-badge', title: t('panel.multiBound'), children: `×${boundTo.length}` }) : null,
                                  ] }),
                                  jsxs('div', { className: 'cs-itemMeta', children: [
                                    session.count !== undefined ? `${session.count} · ` : '',
                                    session.path,
                                    boundTo.length ? ` · ${t('panel.bound')}` : '',
                                  ] }),
                                ] }),
                              ],
                            }, `${machine.id}:${kind}:${session.path}`)
                          }),
                        }),
                      }, kindKey)
                    }),
                  ],
                }),
              }),
            ],
          }, machineKey)
        })
      }

      const renderBindings = () => {
        if (!bindings.length) return jsx('div', { className: 'cs-empty', children: t('panel.noBindings') })
        return jsx('div', { className: 'cs-scroll', children: jsxs('table', {
          className: 'cs-table',
          children: [
            jsx('thead', { children: jsx('tr', { children: [
              jsx('th', { style: { width: 28 }, children: '' }),
              jsx('th', { children: t('panel.colBinding') }),
              jsx('th', { children: t('panel.colDirection') }),
              jsx('th', { children: t('panel.colMode') }),
              jsx('th', { children: t('panel.colNewer') }),
              jsx('th', { children: t('panel.colActions') }),
            ] }) }),
            jsx('tbody', { children: bindings.map(binding => {
              const state = stateFor(binding.id)
              const checked = binding.checked !== false
              return jsxs('tr', {
                className: checked ? '' : 'off',
                children: [
                  jsx('td', { children: jsx('input', {
                    type: 'checkbox',
                    checked,
                    title: t('panel.checkedHint'),
                    onChange: e => void updateBinding(binding.id, { checked: e.target.checked }),
                  }) }),
                  jsx('td', { children: jsxs('div', { className: 'cs-name', children: [
                    jsx('span', { className: 'cs-nameTitle', title: binding.name, children: binding.name }),
                    jsx('span', { className: 'cs-nameMeta', title: binding.externalPath, children: `${binding.machineId} · ${binding.externalPath}` }),
                    state?.lastFailure
                      ? jsxs('span', { className: 'cs-nameMeta', style: { color: 'var(--dsw-alias-state-error-primary)' }, children: `${t('panel.failure')} ${state.lastFailure.reason}` })
                      : state?.lastSyncAt
                        ? jsx('span', { className: 'cs-nameMeta', children: `${t('panel.lastSync')} ${new Date(state.lastSyncAt).toLocaleString()}` })
                        : null,
                  ] }) }),
                  jsx('td', { children: jsx('select', {
                    className: 'cs-select',
                    value: binding.direction,
                    disabled: busy,
                    onChange: e => void updateBinding(binding.id, { direction: e.target.value }),
                    children: [
                      jsx('option', { value: 'auto', children: t('panel.dirAuto') }),
                      jsx('option', { value: 'in', children: t('panel.dirIn') }),
                      jsx('option', { value: 'out', children: t('panel.dirOut') }),
                      jsx('option', { value: 'both', children: t('panel.dirBoth') }),
                    ],
                  }) }),
                  jsx('td', { children: jsx('select', {
                    className: 'cs-select',
                    value: binding.autoSync ? 'auto' : 'manual',
                    disabled: busy,
                    onChange: e => void updateBinding(binding.id, { autoSync: e.target.value === 'auto' }),
                    children: [
                      jsx('option', { value: 'manual', children: t('panel.modeManual') }),
                      jsx('option', { value: 'auto', children: t('panel.modeAuto') }),
                    ],
                  }) }),
                  jsx('td', { children: newerLabel(binding) }),
                  jsx('td', { children: jsxs('div', { className: 'cs-bar', children: [
                    jsx('button', {
                      className: 'cs-btn',
                      disabled: busy || !checked,
                      onClick: () => void sync(binding.id, binding.direction),
                      children: t('panel.syncNow'),
                    }),
                    jsx('button', {
                      className: 'cs-btn danger',
                      disabled: busy,
                      onClick: () => void unbind(binding.id),
                      children: t('panel.removeSource'),
                    }),
                  ] }) }),
                ],
              }, binding.id)
            }) }),
          ],
        }) })
      }

      const selection = jsxs('div', { className: 'cs-note', children: [
        jsx('div', { children: `${t('panel.selectedLeft')}: ${left === NEW_LEFT ? t('panel.newSession') : left ? titleOf((cache.dsh ?? []).find(s => s.id === left)) : t('panel.none')}` }),
        jsx('div', { children: `${t('panel.selectedRight')}: ${right ? titleOf(right) : t('panel.none')}` }),
      ] })

      return jsxs('div', { className: 'cs-root', children: [
        jsxs('div', { className: 'cs-head', children: [
          jsxs('div', { className: 'cs-bar', children: [
            jsx('h3', { className: 'cs-title', children: t('panel.title') }),
            jsx('span', { className: 'cs-spacer' }),
            jsx('button', { className: 'cs-btn', onClick: () => void load(true), disabled: busy, children: t('panel.refresh') }),
          ] }),
          jsx('p', { className: 'cs-sub', children: t('panel.subtitle') }),
        ] }),

        jsxs('div', { className: 'cs-bar', children: [
          jsx('span', { className: 'cs-sub', children: t('panel.placement') }),
          jsxs('label', { className: 'cs-check', children: [
            jsx('input', {
              type: 'checkbox',
              checked: prefs.sidebarEntry !== false,
              onChange: e => void setPreference({ sidebarEntry: e.target.checked }),
            }),
            t('panel.sidebarEntry'),
          ] }),
          jsxs('label', { className: 'cs-check', children: [
            jsx('input', {
              type: 'checkbox',
              checked: prefs.settingsEntry !== false,
              onChange: e => void setPreference({ settingsEntry: e.target.checked }),
            }),
            t('panel.settingsEntry'),
          ] }),
        ] }),

        error ? jsx('div', { className: 'cs-err', children: error }) : null,
        lastResult?.failure ? jsxs('div', { className: 'cs-err', children: [
          jsx('div', { children: `${t('panel.failure')} ${lastResult.failure.reason}` }),
          ...(lastResult.failure.conditions ?? []).map((c, i) => jsx('div', { children: `• ${c}` }, i)),
          ...(lastResult.failure.cleanup ?? []).map((c, i) => jsx('div', { children: `• ${c}` }, `c${i}`)),
        ] }) : null,
        machineWarnings.length ? jsx('div', { className: 'cs-warn', children: machineWarnings.join(' · ') }) : null,

        jsxs('div', { className: 'cs-trees', children: [
          jsxs('div', { className: 'cs-pane', children: [
            jsxs('div', { className: 'cs-paneHead', children: [
              jsx('span', { children: t('panel.dshColumn') }),
              jsx('span', { className: 'cs-spacer' }),
              jsx('span', { className: 'cs-tag', children: cache.dsh?.length ?? 0 }),
            ] }),
            jsx('div', { className: 'cs-paneBody', children: renderLeft() }),
          ] }),
          jsxs('div', { className: 'cs-pane', children: [
            jsxs('div', { className: 'cs-paneHead', children: [
              jsx('span', { children: t('panel.externalColumn') }),
              jsx('span', { className: 'cs-spacer' }),
              jsx('span', { className: 'cs-tag', children: Object.values(cache.external ?? {}).reduce((sum, rows) => sum + (rows?.length ?? 0), 0) }),
            ] }),
            jsx('div', { className: 'cs-paneBody', children: renderRight() }),
          ] }),
        ] }),

        selection,

        // The buttons below act on the two selections above and nothing else,
        // so they say so and stay disabled until both exist.
        jsxs('div', { className: 'cs-actionBar', children: [
          jsxs('div', { className: 'cs-actionScope', children: [
            jsx('span', { className: 'cs-actionTitle', children: t('panel.pairScope') }),
            jsx('span', { className: 'cs-actionHint', children: t('panel.arrowsHint') }),
          ] }),
          jsxs('div', { className: 'cs-bar', children: [
            jsx('button', {
              className: 'cs-btn primary',
              disabled: busy || !left || !right,
              title: t('panel.importHint'),
              onClick: () => void pair('in'),
              children: t('panel.import'),
            }),
            jsx('button', {
              className: 'cs-btn primary',
              disabled: busy || !left || !right,
              title: t('panel.exportHint'),
              onClick: () => void pair('out'),
              children: t('panel.export'),
            }),
            jsx('button', {
              className: 'cs-btn',
              disabled: busy || !left || !right,
              title: t('panel.bothHint'),
              onClick: () => void pair('both'),
              children: t('panel.bidirectional'),
            }),
            jsx('button', {
              className: 'cs-btn',
              disabled: busy || !left || !right,
              title: t('panel.autoPairHint'),
              onClick: () => void pair('auto'),
              children: t('panel.autoPair'),
            }),
          ] }),
        ] }),

        jsxs('div', { className: 'cs-pane', children: [
          jsxs('div', { className: 'cs-paneHead', children: [
            jsx('span', { children: t('panel.bindings') }),
            jsx('span', { className: 'cs-tag', children: `${checkedCount}/${bindings.length}` }),
            jsx('span', { className: 'cs-spacer' }),
            // These two act on the whole table, which the label says outright.
            jsxs('label', { className: 'cs-check', title: t('panel.selectAllHint'), children: [
              jsx('input', {
                type: 'checkbox',
                checked: allChecked,
                disabled: busy || !bindings.length,
                onChange: () => void toggleAll(),
              }),
              t('panel.selectAll'),
            ] }),
            jsx('button', {
              className: 'cs-btn primary',
              disabled: busy || !checkedCount,
              title: t('panel.syncCheckedHint'),
              onClick: () => void syncChecked(),
              children: t('panel.syncChecked'),
            }),
          ] }),
          renderBindings(),
        ] }),

        jsx('div', { className: 'cs-warn', children: t('panel.warnings.writeBack') }),
      ] })
    }

    const en = {
      summary: 'Conversation sync',
      'settings.nav': 'Conversation sync',
      'panel.title': 'Conversation sync',
      'panel.subtitle': 'Left: DSH sessions grouped by workspace. Right: machines, each tool, and its sessions. Select one on each side to bind them.',
      'panel.refresh': 'Refresh',
      'panel.noWorkspace': 'No workspace',
      'panel.newSession': 'New session',
      'panel.newSessionHint': 'create a DSH session from the source on the right',
      'panel.dshColumn': 'DSH sessions',
      'panel.externalColumn': 'External sessions',
      'panel.import': '← Import into DSH',
      'panel.export': 'Export to machine →',
      'panel.bidirectional': 'Both ways ⇄',
      'panel.autoPair': 'Newer side wins ⤵',
      'panel.arrowsHint': 'The arrow points at where the text goes: ← into the selected DSH session, → out to the selected machine file.',
      'panel.pairScope': 'Create a binding from the two selections',
      'panel.importHint': 'Append the machine session into the selected DSH session. Nothing is written to the machine.',
      'panel.exportHint': 'Append the DSH session into the selected machine file. Nothing is written to DSH.',
      'panel.bothHint': 'Write both ways, unless one side is clearly newer — then only that side is written.',
      'panel.autoPairHint': 'Compare the two sides and write only the newer one into the older. Does nothing when they are in step.',
      'panel.multiBound': 'Bound to more than one session — this merges conversations',
      'panel.selectAll': 'All',
      'panel.selectAllHint': 'Check or uncheck every binding. Only checked bindings sync.',
      'panel.syncChecked': 'Sync checked',
      'panel.syncCheckedHint': 'Sync every checked binding now, in one pass.',
      'panel.selectedLeft': 'Left',
      'panel.selectedRight': 'Right',
      'panel.none': 'nothing selected',
      'panel.bindings': 'Bindings',
      'panel.colBinding': 'Binding',
      'panel.colDirection': 'Direction',
      'panel.colMode': 'Mode',
      'panel.colNewer': 'Newer side',
      'panel.colActions': 'Actions',
      'panel.dirAuto': 'Auto (newer wins)',
      'panel.dirIn': 'Import only',
      'panel.dirOut': 'Export only',
      'panel.dirBoth': 'Both ways',
      'panel.modeManual': 'Manual',
      'panel.modeAuto': 'Automatic',
      'panel.syncNow': 'Sync now',
      'panel.checkedHint': 'Only checked bindings sync',
      'panel.newerExternal': 'machine',
      'panel.newerDsh': 'DSH',
      'panel.newerEqual': 'in step',
      'panel.newerUnknown': 'unknown',
      'panel.loading': 'Loading sessions… (the plugin host is still starting)',
      'panel.placement': 'Show this page in:',
      'panel.sidebarEntry': 'left sidebar',
      'panel.settingsEntry': 'Settings',
      'panel.noDsh': 'No DSH sessions found.',
      'panel.noExternal': 'No sessions found on these machines. Set the SSH key and refresh.',
      'panel.noBindings': 'No bindings yet. Select a session on each side, then choose a direction.',
      'panel.lastSync': 'Last sync:',
      'panel.failure': 'Sync failed:',
      'panel.pickLeft': 'Select a DSH session on the left first.',
      'panel.pickRight': 'Select an external session on the right first.',
      'panel.removeSource': 'Remove',
      'panel.confirmRemove': 'Remove this sync binding?',
      'panel.cancel': 'Cancel',
      'panel.save': 'Save',
      'panel.key': 'SSH key',
      'panel.keySet': 'configured',
      'panel.keyMissing': 'not configured',
      'panel.setKey': 'Set key',
      'panel.keyPath': 'Private-key PATH on this machine (stored as a DSH credential). Point it at the .pub file to use ssh-agent.',
      'panel.bound': 'bound',
      'panel.kinds.claude': 'Claude Code',
      'panel.kinds.codex': 'Codex CLI',
      'panel.kinds.workbuddy': 'WorkBuddy / CodeBuddy',
      'panel.kinds.trae': 'TRAE',
      'panel.kinds.antigravity': 'Antigravity',
      'panel.kinds.opencode': 'OpenCode',
      'panel.kinds.jsonl': 'Generic JSONL',
      'panel.kinds.deepseekExport': 'DeepSeek export ZIP',
      'panel.warnings.writeBack': 'Write-back edits the original tool\'s live files. A backup is taken before every write and restored if verification fails, but data loss is still possible.',
    }
    const zh = {
      summary: '会话同步',
      'settings.nav': '会话同步',
      'panel.title': '会话同步',
      'panel.subtitle': '左侧：DSH 会话，按工作区分组。右侧：机器 → 工具 → 会话。左右各选一个即可建立绑定。',
      'panel.refresh': '刷新',
      'panel.noWorkspace': '未归属工作区',
      'panel.newSession': '新建会话',
      'panel.newSessionHint': '用右侧的来源创建一个 DSH 会话',
      'panel.dshColumn': 'DSH 会话',
      'panel.externalColumn': '外部会话',
      'panel.import': '← 导入到 DSH',
      'panel.export': '导出到机器 →',
      'panel.bidirectional': '双向 ⇄',
      'panel.autoPair': '以较新一侧为准 ⤵',
      'panel.arrowsHint': '箭头指向文字的去处：← 写入选中的 DSH 会话，→ 写入选中的机器文件。',
      'panel.pairScope': '用左右两个选择建立绑定',
      'panel.importHint': '把机器上的会话追加进选中的 DSH 会话。不会改动机器上的文件。',
      'panel.exportHint': '把 DSH 会话追加进选中的机器文件。不会改动 DSH。',
      'panel.bothHint': '两个方向都写；但如果一侧明显更新，则只写那一侧。',
      'panel.autoPairHint': '先比对两侧，只把较新的一侧写进较旧的一侧。两侧一致时什么都不做。',
      'panel.multiBound': '绑定了多个会话——相当于合并对话',
      'panel.selectAll': '全选',
      'panel.selectAllHint': '一次勾选或取消所有绑定。只有勾选的绑定才会同步。',
      'panel.syncChecked': '同步已勾选',
      'panel.syncCheckedHint': '立刻把已勾选的绑定全部同步一遍。',
      'panel.selectedLeft': '左侧',
      'panel.selectedRight': '右侧',
      'panel.none': '未选择',
      'panel.bindings': '同步绑定',
      'panel.colBinding': '绑定',
      'panel.colDirection': '方向',
      'panel.colMode': '模式',
      'panel.colNewer': '较新一侧',
      'panel.colActions': '操作',
      'panel.dirAuto': '自动（较新者优先）',
      'panel.dirIn': '仅导入',
      'panel.dirOut': '仅导出',
      'panel.dirBoth': '双向',
      'panel.modeManual': '手动',
      'panel.modeAuto': '自动',
      'panel.syncNow': '立即同步',
      'panel.checkedHint': '只有勾选的绑定才会同步',
      'panel.newerExternal': '机器',
      'panel.newerDsh': 'DSH',
      'panel.newerEqual': '一致',
      'panel.newerUnknown': '未知',
      'panel.loading': '正在加载会话……（插件宿主还在启动）',
      'panel.placement': '入口位置：',
      'panel.sidebarEntry': '左侧边栏',
      'panel.settingsEntry': '设置页',
      'panel.noDsh': '未找到 DSH 会话。',
      'panel.noExternal': '这些机器上未找到会话。请配置 SSH 私钥后刷新。',
      'panel.noBindings': '还没有绑定。在左右两侧各选一个会话，再选择方向。',
      'panel.lastSync': '上次同步：',
      'panel.failure': '同步失败：',
      'panel.pickLeft': '请先在左侧选择一个 DSH 会话。',
      'panel.pickRight': '请先在右侧选择一个外部会话。',
      'panel.removeSource': '删除',
      'panel.confirmRemove': '确定删除这个同步绑定？',
      'panel.cancel': '取消',
      'panel.save': '保存',
      'panel.key': 'SSH 私钥',
      'panel.keySet': '已配置',
      'panel.keyMissing': '未配置',
      'panel.setKey': '设置私钥',
      'panel.keyPath': '本机上的私钥文件路径（保存为 DSH 凭据）。指向 .pub 文件即可使用 ssh-agent。',
      'panel.bound': '已绑定',
      'panel.kinds.claude': 'Claude Code',
      'panel.kinds.codex': 'Codex CLI',
      'panel.kinds.workbuddy': 'WorkBuddy / CodeBuddy',
      'panel.kinds.trae': 'TRAE',
      'panel.kinds.antigravity': 'Antigravity',
      'panel.kinds.opencode': 'OpenCode',
      'panel.kinds.jsonl': '通用 JSONL',
      'panel.kinds.deepseekExport': 'DeepSeek 导出 ZIP',
      'panel.warnings.writeBack': '写回会直接修改原工具的活跃文件。每次写入前都会备份，校验失败会自动还原，但仍可能发生数据丢失。',
    }

    const inject = ['slots', 'locale', 'sessions']

    // The same 16px mark in every seat. The slots pass {size, active}; drawing a
    // real SVG (not a text arrow) keeps it on the same baseline and width as the
    // built-in icons at any font.
    const MarkIcon = ({ size = 16, active } = {}) => jsx('svg', {
      width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
      stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
      'aria-hidden': true, opacity: active === false ? 0.75 : 1,
      'data-conversation-sync-icon': true,
      children: [
        // Two opposed arrows: the bidirectional promise of the feature.
        jsx('path', { d: 'M2.5 5.5h8.5M8.5 3l2.5 2.5-2.5 2.5', key: 'a' }),
        jsx('path', { d: 'M13.5 10.5H5M7.5 8 5 10.5 7.5 13', key: 'b' }),
      ],
    })

    function apply(ctx) {
      hostSessions = ctx.sessions
      applyStyle()
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'conversation-sync/dictionaries')

      // The plugin's own detail page (Plugins → this bundle) always renders:
      // it is where a user looks to confirm the plugin is installed at all, so
      // it must not be one of the switchable placements.
      ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config', key: PKG, locale: NS,
      }, ({ t, view }) => (view === 'summary' ? t('summary') : jsx(Page, { t })))), 'conversation-sync/page')

      const entries = {
        settingsEntry: {
          section: () => ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section',
            id: PKG,
            order: 45,
            label: () => '会话同步',
            locale: NS,
            inject: () => ({}),
          }, Page)),
          icon: () => ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
            name: 'settings.section.icon',
            id: PKG,
            order: 45,
            label: 'conversation-sync/settings-icon',
            inject: () => ({}),
          }, MarkIcon)),
        },
        sidebarEntry: {
          list: () => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist',
            id: PKG,
            order: 30,
            label: () => '会话同步',
            locale: NS,
            inject: () => ({}),
          }, MarkIcon)),
          // `main` is keyed by `key`, while `sidebar.panellist` is keyed by `id`.
          // They must carry the SAME value, because clicking the sidebar entry
          // calls layout.selectPanel(id), and that throws
          //   layout.selectPanel: main panel "<id>" is not registered
          // unless a main panel with that key exists. Passing `id` here left the
          // entry looking installed but opening nothing at all.
          main: () => ctx.slots.inject('main', () => ctx.slots.register({
            name: 'main',
            key: PKG,
            order: 30,
            locale: NS,
            inject: () => ({}),
          }, Page)),
        },
      }

      const placements = {
        settingsEntry: [entries.settingsEntry.section, entries.settingsEntry.icon],
        sidebarEntry: [entries.sidebarEntry.list, entries.sidebarEntry.main],
      }

      const applied = { settingsEntry: null, sidebarEntry: null }

      const applyNow = preferences => {
        for (const [key, registrars] of Object.entries(placements)) {
          const wanted = preferences?.[key] !== false
          const current = applied[key]
          if (wanted && !current) {
            // The registrar returns a disposer through ctx.slots.inject; the
            // effect wrapper gives us the same handle here.
            applied[key] = { dispose: registrars.map(registrar => ctx.effect(registrar, `conversation-sync/${key}`)) }
          } else if (!wanted && current) {
            for (const dispose of current.dispose) { try { dispose?.() } catch { /* already gone */ } }
            applied[key] = null
          }
        }
      }

      // Page calls this after a toggle, so the change is visible at once.
      applyPlacement = applyNow

      ctx.effect(() => {
        // Read the stored preferences before registering anything: registering
        // first and then removing would flash an entry the user turned off.
        rpc('preferences')
          .then(result => applyNow(result?.preferences))
          .catch(() => applyNow(undefined))
        return () => {
          for (const entry of Object.values(applied)) {
            for (const dispose of entry?.dispose ?? []) { try { dispose?.() } catch { /* already gone */ } }
          }
          applied.settingsEntry = null
          applied.sidebarEntry = null
          applyPlacement = () => {}
        }
      }, 'conversation-sync/placements')
    }

    return { apply, inject }
  },
})
