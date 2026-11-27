// Conversation sync — browser half. Two-column session picker (DSH on the
// left, external machines on the right) with user-chosen sync direction.
window.__ModuleLoader__.load({
  id: 'dsh-conversation-sync',
  factory: (require) => {
    const { jsx, jsxs, Fragment } = require('react/jsx-runtime')
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

    const s = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 8 },
      row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      // The settings section renders inside a narrow `.options` column, so a
      // fixed two-column grid collapsed into a vertical stack there. auto-fit
      // keeps two columns when there is room and degrades to one without
      // squeezing either pane.
      columns: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12, alignItems: 'start' },
      pane: { border: '1px solid var(--dsh-border, #666)', borderRadius: 8, padding: 10, minHeight: 240 },
      paneHead: { fontSize: 13, fontWeight: 600, marginBottom: 8 },
      card: { border: '1px solid var(--dsh-border, #555)', borderRadius: 6, padding: 8, margin: '6px 0', cursor: 'pointer' },
      selected: { borderColor: '#59b6a0', background: 'rgba(89,182,160,0.12)' },
      input: { width: '100%', boxSizing: 'border-box', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--dsh-border, #666)', background: 'var(--dsh-input-bg, transparent)', color: 'inherit' },
      label: { display: 'block', fontSize: 12, opacity: 0.8, margin: '8px 0 3px' },
      button: { padding: '6px 12px', borderRadius: 6, border: '1px solid var(--dsh-border, #666)', background: 'var(--dsh-button-bg, transparent)', color: 'inherit', cursor: 'pointer', marginRight: 6 },
      accent: { borderColor: '#59b6a0', color: '#59b6a0' },
      small: { fontSize: 12, opacity: 0.72 },
      tag: { fontSize: 11, padding: '1px 6px', borderRadius: 10, border: '1px solid var(--dsh-border, #666)', marginLeft: 6 },
      warn: { color: '#d98b3a', fontSize: 12 },
      error: { color: '#e05252', fontSize: 12, margin: '4px 0' },
      condition: { fontSize: 12, marginLeft: 16, opacity: 0.85 },
      list: { maxHeight: 380, overflowY: 'auto' },
      check: { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, cursor: 'pointer' },
    }

    // Materializing a session writes it to disk, but the browser sidebar is fed
    // by the host's in-memory session list. Without this refresh the imported
    // sessions only appear after a full page reload — which is exactly what a
    // user reported ("imported, workspace created, no sessions shown").
    // Where the two entries live. Both are on by default; each toggle registers
    // or disposes its own slot entry, so turning one off removes it immediately
    // instead of waiting for a reload.
    let applyPlacement = () => {}
    let tr = key => en[key] ?? key
    let hostSessions
    const refreshDshSessions = async () => {
      // A stale sidebar is better than a failed sync, so this never throws.
      try { await hostSessions?.refresh?.() } catch { /* ignore */ }
    }

    const titleOf = item => item?.title || item?.name || item?.id || '—'
    const shortId = id => String(id ?? '').length > 18 ? `${String(id).slice(0, 12)}…${String(id).slice(-4)}` : String(id ?? '')

    function Page({ t }) {
      const [machines, setMachines] = useState([])
      const [machineWarnings, setMachineWarnings] = useState([])
      const [keys, setKeys] = useState({})
      const [cache, setCache] = useState({ dsh: [], external: {}, errors: {}, at: 0 })
      const [bindings, setBindings] = useState([])
      const [states, setStates] = useState([])
      const [left, setLeft] = useState('')
      const [right, setRight] = useState(null)
      const [machineFilter, setMachineFilter] = useState('local')
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
          setPrefs(p.preferences ?? { sidebarEntry: true, settingsEntry: true })
          setError('')
          setLoading(false)
        } catch (e) {
          // "not ready" resolves itself; anything else is a real error to show.
          if (!/not ready/i.test(e.message)) { setError(e.message); setLoading(false) }
        }
      }, [])

      useEffect(() => { void load(); const id = setInterval(() => void load(), 5000); return () => clearInterval(id) }, [load])

      const externalSessions = useMemo(() => cache.external?.[machineFilter] ?? [], [cache, machineFilter])
      const selectedMachine = machines.find(m => m.id === machineFilter)
      const stateFor = id => states.find(x => x.bindingId === id)
      const boundExternal = path => bindings.find(b => b.externalPath === path && b.machineId === machineFilter)
      const boundDsh = id => bindings.find(b => b.dshSessionIds?.includes(id))

      const setPreference = async patch => {
        try {
          const next = await rpc('setPreferences', patch)
          setPrefs(next.preferences ?? prefs)
          // The placement of the entries is a client decision, so the change has
          // to be applied here; the host only remembers it.
          applyPlacement?.(next.preferences)
        } catch (e) { setError(e.message) }
      }

      const pair = async direction => {
        if (!right) { setError(t('panel.pickRight')); return }
        if (direction !== 'in' && !left) { setError(t('panel.pickLeft')); return }
        setBusy(true)
        try {
          // OpenCode sessions live inside one SQLite file: the file is the
          // external path and the row id is the session selector.
          const opencode = right.kind === 'opencode'
          const result = await rpc('pair', {
            binding: {
              name: titleOf(right),
              machineId: machineFilter,
              externalPath: opencode ? (right.dbPath ?? right.path) : right.path,
              externalSessionId: opencode ? right.id : undefined,
              dbPath: opencode ? (right.dbPath ?? right.path) : undefined,
              kind: right.kind,
              dshSessionIds: left ? [left] : [],
              direction,
              pollMs: 2000,
              autoSync: true,
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

      const unbind = async id => {
        if (!window.confirm(t('panel.confirmRemove'))) return
        setBusy(true)
        try { await rpc('unbind', { id }); await load() } catch (e) { setError(e.message) } finally { setBusy(false) }
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

      return jsxs('div', { style: s.wrap, children: [
        jsxs('div', { style: s.row, children: [
          jsx('h3', { style: { margin: 0, marginRight: 8 }, children: t('panel.title') }),
          jsx('button', { style: s.button, onClick: () => void load(true), disabled: busy, children: t('panel.refresh') }),
          jsx('span', { style: s.small, children: t('panel.subtitle') }),
        ] }),
        jsxs('div', { style: s.row, children: [
          jsx('span', { style: s.small, children: t('panel.placement') }),
          jsxs('label', { style: s.check, children: [
            jsx('input', {
              type: 'checkbox',
              checked: prefs.sidebarEntry !== false,
              onChange: e => void setPreference({ sidebarEntry: e.target.checked }),
            }),
            t('panel.sidebarEntry'),
          ] }),
          jsxs('label', { style: s.check, children: [
            jsx('input', {
              type: 'checkbox',
              checked: prefs.settingsEntry !== false,
              onChange: e => void setPreference({ settingsEntry: e.target.checked }),
            }),
            t('panel.settingsEntry'),
          ] }),
        ] }),
        error ? jsx('div', { style: s.error, children: error }) : null,
        lastResult?.failure ? jsxs('div', { style: s.error, children: [
          jsx('div', { children: `${t('panel.failure')} ${lastResult.failure.reason}` }),
          ...(lastResult.failure.conditions ?? []).map((c, i) => jsx('div', { style: s.condition, children: `• ${c}` }, i)),
          ...(lastResult.failure.cleanup ?? []).map((c, i) => jsx('div', { style: s.condition, children: `• ${c}` }, `c${i}`)),
        ] }) : null,
        machineWarnings.length ? jsx('div', { style: s.warn, children: machineWarnings.join(' · ') }) : null,
        loading ? jsx('div', { style: s.small, children: t('panel.loading') }) : null,

        jsxs('div', { style: s.pane, children: [
          jsx('div', { style: s.paneHead, children: t('panel.machines') }),
          jsxs('div', { style: s.row, children: [
            ...machines.map(machine => jsxs('button', {
              key: machine.id,
              style: { ...s.button, ...(machine.id === machineFilter ? s.accent : {}) },
              onClick: () => setMachineFilter(machine.id),
              children: [
                machine.kind === 'local' ? '⌂ ' : '⇄ ',
                machine.label,
                machine.isJump ? ` (${t('panel.jump')})` : '',
              ],
            })),
          ] }),
          selectedMachine?.kind === 'ssh' ? jsxs('div', { style: s.row, children: [
            jsx('span', { style: s.small, children: `${t('panel.key')}: ${keys[machineFilter] ? keys[machineFilter] : t('panel.keyMissing')}` }),
            jsx('button', { style: s.button, onClick: () => { setKeyEdit(machineFilter); setKeyValue(keys[machineFilter] ?? '') }, children: t('panel.setKey') }),
          ] }) : null,
          keyEdit ? jsxs('div', { children: [
            jsx('label', { style: s.label, children: t('panel.keyPath') }),
            jsx('input', { style: s.input, value: keyValue, onChange: e => setKeyValue(e.target.value), placeholder: '~/.ssh/id_ed25519' }),
            jsxs('div', { style: { ...s.row, marginTop: 6 }, children: [
              jsx('button', { style: s.button, onClick: () => void saveKey(), disabled: busy, children: t('panel.save') }),
              jsx('button', { style: s.button, onClick: () => setKeyEdit(''), children: t('panel.cancel') }),
            ] }),
          ] }) : null,
        ] }),

        jsxs('div', { style: s.columns, children: [
          jsxs('div', { style: s.pane, children: [
            jsxs('div', { style: s.paneHead, children: [
              t('panel.dshColumn'), jsx('span', { style: s.tag, children: cache.dsh?.length ?? 0 }),
            ] }),
            jsxs('div', { style: s.list, children: [
              ...(cache.dsh ?? []).map(session => {
                const bound = boundDsh(session.id)
                return jsxs('div', {
                  key: session.id,
                  style: { ...s.card, ...(left === session.id ? s.selected : {}) },
                  onClick: () => setLeft(left === session.id ? '' : session.id),
                  children: [
                    jsx('div', { children: titleOf(session) }),
                    jsx('div', { style: s.small, children: `${shortId(session.id)}${session.count !== undefined ? ` · ${session.count}` : ''}` }),
                    session.preview ? jsx('div', { style: s.small, children: session.preview.slice(0, 100) }) : null,
                    bound ? jsx('div', { style: s.tag, children: `${t('panel.bound')} ${bound.direction}` }) : null,
                  ],
                })
              }),
              (cache.dsh?.length ?? 0) === 0 && !loading ? jsx('div', { style: s.small, children: t('panel.noDsh') }) : null,
            ] }),
          ] }),
          jsxs('div', { style: s.pane, children: [
            jsxs('div', { style: s.paneHead, children: [
              t('panel.externalColumn'), jsx('span', { style: s.tag, children: externalSessions.length }),
            ] }),
            machineFilter !== 'local' && (cache.errors?.[machineFilter]?.length) ? jsx('div', { style: s.warn, children: cache.errors[machineFilter].join(' · ') }) : null,
            jsxs('div', { style: s.list, children: [
              ...externalSessions.map(session => {
                const bound = boundExternal(session.path)
                const key = `${session.machineId}:${session.path}`
                return jsxs('div', {
                  key,
                  style: { ...s.card, ...(right?.path === session.path ? s.selected : {}) },
                  onClick: () => setRight(right?.path === session.path ? null : session),
                  children: [
                    jsx('div', { children: titleOf(session) }),
                    jsx('div', { style: s.small, children: `${t(`panel.kinds.${session.kind}`)} · ${session.path} · ${session.count ?? 0}` }),
                    session.preview ? jsx('div', { style: s.small, children: session.preview.slice(0, 100) }) : null,
                    bound ? jsx('div', { style: s.tag, children: `${t('panel.bound')} ${bound.direction}` }) : null,
                  ],
                })
              }),
              externalSessions.length === 0 && !loading ? jsx('div', { style: s.small, children: t('panel.noExternal') }) : null,
            ] }),
          ] }),
        ] }),

        jsxs('div', { style: s.row, children: [
          jsx('button', { style: { ...s.button, ...s.accent }, disabled: busy, onClick: () => void pair('in'), children: t('panel.import') }),
          jsx('button', { style: { ...s.button, ...s.accent }, disabled: busy, onClick: () => void pair('out'), children: t('panel.export') }),
          jsx('button', { style: { ...s.button, ...s.accent }, disabled: busy, onClick: () => void pair('both'), children: t('panel.bidirectional') }),
          jsx('span', { style: s.small, children: t('panel.arrowsHint') }),
        ] }),

        jsxs('div', { style: s.pane, children: [
          jsx('div', { style: s.paneHead, children: t('panel.bindings') }),
          ...bindings.map(binding => {
            const state = stateFor(binding.id)
            return jsxs('div', { style: s.card, key: binding.id, children: [
              jsxs('div', { style: s.row, children: [
                jsx('strong', { children: binding.name }),
                jsx('span', { style: s.tag, children: binding.direction }),
                jsx('span', { style: s.small, children: `${binding.machineId} · ${binding.externalPath}${binding.externalSessionId ? `#${binding.externalSessionId}` : ''}` }),
              ] }),
              binding.dshSessionIds.length ? jsx('div', { style: s.small, children: `DSH: ${binding.dshSessionIds.map(shortId).join(', ')}` }) : jsx('div', { style: s.small, children: t('panel.externalOnly') }),
              state?.lastSyncAt ? jsx('div', { style: s.small, children: `${t('panel.lastSync')} ${new Date(state.lastSyncAt).toLocaleString()}` }) : null,
              state?.lastFailure ? jsxs('div', { style: s.error, children: [
                jsx('div', { children: `${t('panel.failure')} ${state.lastFailure.reason}` }),
                ...(state.lastFailure.conditions ?? []).map((c, i) => jsx('div', { style: s.condition, children: `• ${c}` }, i)),
              ] }) : null,
              jsxs('div', { style: { ...s.row, marginTop: 6 }, children: [
                jsx('button', { style: s.button, disabled: busy, onClick: () => void sync(binding.id, 'in'), children: t('panel.import') }),
                jsx('button', { style: s.button, disabled: busy, onClick: () => void sync(binding.id, 'out'), children: t('panel.export') }),
                jsx('button', { style: s.button, disabled: busy, onClick: () => void sync(binding.id, 'both'), children: t('panel.bidirectional') }),
                jsx('button', { style: s.button, disabled: busy, onClick: () => void unbind(binding.id), children: t('panel.removeSource') }),
              ] }),
            ] })
          }),
          bindings.length === 0 ? jsx('div', { style: s.small, children: t('panel.noBindings') }) : null,
        ] }),

        jsx('div', { style: s.warn, children: t('panel.warnings.writeBack') }),
      ] })
    }

    const en = {
      summary: 'Conversation sync',
      'settings.nav': 'Conversation sync',
      'panel.title': 'Conversation sync — bidirectional + Remote-SSH',
      'panel.subtitle': 'Left: all DSH sessions · Right: sessions on each machine · pick a direction to sync',
      'panel.refresh': 'Refresh sessions', 'panel.machines': 'Machines (from ~/.ssh/config, jump hosts included)',
      'panel.jump': 'jump host', 'panel.key': 'SSH private key', 'panel.keySet': 'configured', 'panel.keyMissing': 'not configured',
      'panel.setKey': 'Set key path', 'panel.keyPath': 'Private-key PATH on this machine (stored as a DSH credential). Point it at the .pub file to use ssh-agent, which is how passphrase-protected keys work.',
      'panel.dshColumn': 'DSH sessions (this installation)', 'panel.externalColumn': 'External sessions (selected machine)',
      'panel.import': '← Import to DSH', 'panel.export': 'Export to remote →', 'panel.bidirectional': '⇄ Sync both ways',
      'panel.arrowsHint': 'Select one session on each side, then choose a direction. A one-sided session is imported/exported first, then kept in sync.',
      'panel.bindings': 'Active sync bindings', 'panel.bound': 'bound:', 'panel.externalOnly': 'No DSH session yet — use Import to create one, or select a DSH session on the left before exporting.',
      'panel.loading': 'Loading sessions… (the plugin host is still starting)',
      'panel.placement': 'Show this page in:',
      'panel.sidebarEntry': 'left sidebar',
      'panel.settingsEntry': 'Settings',
      'panel.noDsh': 'No DSH sessions found.', 'panel.noExternal': 'No sessions found on this machine. Configure the SSH key and refresh.',
      'panel.noBindings': 'No bindings yet. Pick two sessions above and choose a direction.',
      'panel.lastSync': 'Last sync:', 'panel.failure': 'Sync failed:', 'panel.pickLeft': 'Select a DSH session on the left first.',
      'panel.pickRight': 'Select an external session on the right first.',
      'panel.removeSource': 'Remove binding', 'panel.confirmRemove': 'Remove this sync binding?', 'panel.cancel': 'Cancel', 'panel.save': 'Save',
      'panel.kinds.claude': 'Claude Code', 'panel.kinds.codex': 'Codex CLI', 'panel.kinds.workbuddy': 'WorkBuddy / CodeBuddy', 'panel.kinds.trae': 'TRAE', 'panel.kinds.antigravity': 'Antigravity', 'panel.kinds.opencode': 'OpenCode', 'panel.kinds.jsonl': 'Generic JSONL', 'panel.kinds.deepseekExport': 'DeepSeek export ZIP',
      'panel.warnings.writeBack': 'Warning: write-back edits the original tool\'s live files. A backup is taken before every write and restored on failure, but data loss is still possible.',
    }
    const zh = {
      summary: '会话同步',
      'settings.nav': '会话同步',
      'panel.title': '会话同步 — 双向同步 + Remote-SSH',
      'panel.subtitle': '左侧：DSH 全部会话 · 右侧：各机器上的会话 · 选择方向进行同步',
      'panel.refresh': '刷新会话', 'panel.machines': '机器（来自 ~/.ssh/config，跳板机也算）',
      'panel.jump': '跳板机', 'panel.key': 'SSH 私钥', 'panel.keySet': '已配置', 'panel.keyMissing': '未配置',
      'panel.setKey': '设置私钥路径', 'panel.keyPath': '本机上的私钥文件路径（保存为 DSH 凭据）',
      'panel.dshColumn': 'DSH 会话（当前安装）', 'panel.externalColumn': '外部会话（当前机器）',
      'panel.import': '← 导入到 DSH', 'panel.export': '导出到远端 →', 'panel.bidirectional': '⇄ 双向同步',
      'panel.arrowsHint': '左右各选一个会话，再选择方向。只有一侧有的会话会先导入/导出，然后保持同步。',
      'panel.bindings': '生效中的同步绑定', 'panel.bound': '已绑定：', 'panel.externalOnly': '尚无 DSH 会话——先点“导入”创建，或先在左侧选中 DSH 会话再导出。',
      'panel.loading': '正在加载会话……（插件宿主还在启动）',
      'panel.placement': '入口位置：',
      'panel.sidebarEntry': '左侧边栏',
      'panel.settingsEntry': '设置页',
      'panel.noDsh': '未找到 DSH 会话。', 'panel.noExternal': '该机器上未找到会话。请配置 SSH 私钥后刷新。',
      'panel.noBindings': '还没有绑定。在上方选择两个会话并选择方向。',
      'panel.lastSync': '上次同步：', 'panel.failure': '同步失败：', 'panel.pickLeft': '请先在左侧选择一个 DSH 会话。',
      'panel.pickRight': '请先在右侧选择一个外部会话。',
      'panel.removeSource': '删除绑定', 'panel.confirmRemove': '确定删除这个同步绑定？', 'panel.cancel': '取消', 'panel.save': '保存',
      'panel.kinds.claude': 'Claude Code', 'panel.kinds.codex': 'Codex CLI', 'panel.kinds.workbuddy': 'WorkBuddy / CodeBuddy', 'panel.kinds.trae': 'TRAE', 'panel.kinds.antigravity': 'Antigravity', 'panel.kinds.opencode': 'OpenCode', 'panel.kinds.jsonl': '通用 JSONL', 'panel.kinds.deepseekExport': 'DeepSeek 导出 ZIP',
      'panel.warnings.writeBack': '警告：写回会直接修改原工具的活跃文件。每次写入前都会备份，失败时自动回滚，但仍可能发生数据丢失。',
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
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'conversation-sync/dictionaries')
      // The settings slot needs a translate function of its own; the bundle
      // config slot gets one from its props, the settings section does not.
      try {
        const bound = ctx.locale.bind(NS)
        tr = key => {
          const text = bound(key)
          return text === key ? (en[key] ?? key) : text
        }
      } catch { /* keep the English dictionary fallback */ }

      ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config', key: PKG, locale: NS,
      }, ({ t, view }) => (view === 'summary' ? t('summary') : jsx(Page, { t })))), 'conversation-sync/page')

      // Two independent placements, each with its own switch (both default on):
      //
      //   settingsEntry - a section in Settings, where a feature like this is
      //                   expected to be found.
      //   sidebarEntry  - a panel icon in the left sidebar, for one-click access
      //                   without opening Settings.
      //
      // Each registration is disposed when its switch turns off, so the entry
      // disappears immediately rather than at the next reload.
      const entries = {
        settingsEntry: null,
        sidebarEntry: null,
      }

      const registerSettings = () => ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: PKG, order: 45, locale: NS,
        label: () => tr('settings.nav'),
      }, () => jsx(Page, { t: tr })))

      const registerSettingsIcon = () => ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
        name: 'settings.section.icon', id: PKG, order: 45,
      }, MarkIcon))

      const registerSidebar = () => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: PKG, order: 30, locale: NS,
        label: () => tr('settings.nav'),
      }, ({ size = 16, active } = {}) => jsx(MarkIcon, { size, active })))

      const registerSidebarPage = () => ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main', key: PKG, locale: NS,
      }, () => jsx(Page, { t: tr })))

      const placements = {
        settingsEntry: [registerSettings, registerSettingsIcon],
        sidebarEntry: [registerSidebar, registerSidebarPage],
      }

      const applyNow = preferences => {
        for (const [key, registrars] of Object.entries(placements)) {
          const wanted = preferences?.[key] !== false
          const current = entries[key]
          if (wanted && !current) {
            // The registrar returns a disposer through ctx.slots.inject; the
            // effect wrapper gives us the same handle here.
            entries[key] = { dispose: registrars.map(registrar => ctx.effect(registrar, `conversation-sync/${key}`)) }
          } else if (!wanted && current) {
            for (const dispose of current.dispose) { try { dispose?.() } catch { /* already gone */ } }
            entries[key] = null
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
          for (const entry of Object.values(entries)) {
            for (const dispose of entry?.dispose ?? []) { try { dispose?.() } catch { /* already gone */ } }
          }
          entries.settingsEntry = null
          entries.sidebarEntry = null
          applyPlacement = () => {}
        }
      }, 'conversation-sync/placements')
    }

    return { apply, inject }
  },
})
