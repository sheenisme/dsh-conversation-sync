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
      columns: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, alignItems: 'start' },
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

      const load = useCallback(async (force = false) => {
        try {
          const [m, sess, b] = await Promise.all([
            rpc('machines'),
            rpc('sessions', { force }),
            rpc('bindings'),
          ])
          setMachines(m.machines ?? [])
          setMachineWarnings(m.warnings ?? [])
          setKeys(m.keys ?? {})
          setCache(sess)
          setBindings(b.bindings ?? [])
          setStates(b.states ?? [])
          setError('')
        } catch (e) { setError(e.message) }
      }, [])

      useEffect(() => { void load(); const id = setInterval(() => void load(), 5000); return () => clearInterval(id) }, [load])

      const externalSessions = useMemo(() => cache.external?.[machineFilter] ?? [], [cache, machineFilter])
      const selectedMachine = machines.find(m => m.id === machineFilter)
      const stateFor = id => states.find(x => x.bindingId === id)
      const boundExternal = path => bindings.find(b => b.externalPath === path && b.machineId === machineFilter)
      const boundDsh = id => bindings.find(b => b.dshSessionIds?.includes(id))

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
          await load(true)
        } catch (e) { setError(e.message) } finally { setBusy(false) }
      }

      const sync = async (id, direction) => {
        setBusy(true)
        try {
          const result = await rpc('sync', id ? { id, direction } : {})
          if (result.results?.length === 1) setLastResult(result.results[0])
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
        error ? jsx('div', { style: s.error, children: error }) : null,
        lastResult?.failure ? jsxs('div', { style: s.error, children: [
          jsx('div', { children: `${t('panel.failure')} ${lastResult.failure.reason}` }),
          ...(lastResult.failure.conditions ?? []).map((c, i) => jsx('div', { style: s.condition, children: `• ${c}` }, i)),
          ...(lastResult.failure.cleanup ?? []).map((c, i) => jsx('div', { style: s.condition, children: `• ${c}` }, `c${i}`)),
        ] }) : null,
        machineWarnings.length ? jsx('div', { style: s.warn, children: machineWarnings.join(' · ') }) : null,

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
            jsx('span', { style: s.small, children: `${t('panel.key')}: ${keys[machineFilter] ? t('panel.keySet') : t('panel.keyMissing')}` }),
            jsx('button', { style: s.button, onClick: () => setKeyEdit(machineFilter), children: t('panel.setKey') }),
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
              (cache.dsh?.length ?? 0) === 0 ? jsx('div', { style: s.small, children: t('panel.noDsh') }) : null,
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
              externalSessions.length === 0 ? jsx('div', { style: s.small, children: t('panel.noExternal') }) : null,
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
      'panel.title': 'Conversation sync — bidirectional + Remote-SSH',
      'panel.subtitle': 'Left: all DSH sessions · Right: sessions on each machine · pick a direction to sync',
      'panel.refresh': 'Refresh sessions', 'panel.machines': 'Machines (from ~/.ssh/config, jump hosts included)',
      'panel.jump': 'jump host', 'panel.key': 'SSH private key', 'panel.keySet': 'configured', 'panel.keyMissing': 'not configured',
      'panel.setKey': 'Set key path', 'panel.keyPath': 'Private-key PATH on this machine (stored as a DSH credential). Point it at the .pub file to use ssh-agent, which is how passphrase-protected keys work.',
      'panel.dshColumn': 'DSH sessions (this installation)', 'panel.externalColumn': 'External sessions (selected machine)',
      'panel.import': '← Import to DSH', 'panel.export': 'Export to remote →', 'panel.bidirectional': '⇄ Sync both ways',
      'panel.arrowsHint': 'Select one session on each side, then choose a direction. A one-sided session is imported/exported first, then kept in sync.',
      'panel.bindings': 'Active sync bindings', 'panel.bound': 'bound:', 'panel.externalOnly': 'No DSH session yet — use Import to create one, or select a DSH session on the left before exporting.',
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
      'panel.title': '会话同步 — 双向同步 + Remote-SSH',
      'panel.subtitle': '左侧：DSH 全部会话 · 右侧：各机器上的会话 · 选择方向进行同步',
      'panel.refresh': '刷新会话', 'panel.machines': '机器（来自 ~/.ssh/config，跳板机也算）',
      'panel.jump': '跳板机', 'panel.key': 'SSH 私钥', 'panel.keySet': '已配置', 'panel.keyMissing': '未配置',
      'panel.setKey': '设置私钥路径', 'panel.keyPath': '本机上的私钥文件路径（保存为 DSH 凭据）',
      'panel.dshColumn': 'DSH 会话（当前安装）', 'panel.externalColumn': '外部会话（当前机器）',
      'panel.import': '← 导入到 DSH', 'panel.export': '导出到远端 →', 'panel.bidirectional': '⇄ 双向同步',
      'panel.arrowsHint': '左右各选一个会话，再选择方向。只有一侧有的会话会先导入/导出，然后保持同步。',
      'panel.bindings': '生效中的同步绑定', 'panel.bound': '已绑定：', 'panel.externalOnly': '尚无 DSH 会话——先点“导入”创建，或先在左侧选中 DSH 会话再导出。',
      'panel.noDsh': '未找到 DSH 会话。', 'panel.noExternal': '该机器上未找到会话。请配置 SSH 私钥后刷新。',
      'panel.noBindings': '还没有绑定。在上方选择两个会话并选择方向。',
      'panel.lastSync': '上次同步：', 'panel.failure': '同步失败：', 'panel.pickLeft': '请先在左侧选择一个 DSH 会话。',
      'panel.pickRight': '请先在右侧选择一个外部会话。',
      'panel.removeSource': '删除绑定', 'panel.confirmRemove': '确定删除这个同步绑定？', 'panel.cancel': '取消', 'panel.save': '保存',
      'panel.kinds.claude': 'Claude Code', 'panel.kinds.codex': 'Codex CLI', 'panel.kinds.workbuddy': 'WorkBuddy / CodeBuddy', 'panel.kinds.trae': 'TRAE', 'panel.kinds.antigravity': 'Antigravity', 'panel.kinds.opencode': 'OpenCode', 'panel.kinds.jsonl': '通用 JSONL', 'panel.kinds.deepseekExport': 'DeepSeek 导出 ZIP',
      'panel.warnings.writeBack': '警告：写回会直接修改原工具的活跃文件。每次写入前都会备份，失败时自动回滚，但仍可能发生数据丢失。',
    }

    const inject = ['slots', 'locale']

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'conversation-sync/dictionaries')
      ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config', key: PKG, locale: NS,
      }, ({ t, view }) => (view === 'summary' ? t('summary') : jsx(Page, { t })))), 'conversation-sync/page')
    }

    return { apply, inject }
  },
})
