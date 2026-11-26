// Conversation sync — browser half. Registers a management page on the
// bundle's Plugins entry. All state comes from the Host over the owner-only
// /api/conversation-sync/rpc route; no DSH runtime modules are imported.
window.__ModuleLoader__.load({
  id: 'dsh-conversation-sync',
  factory: (require) => {
    const { jsx, jsxs, Fragment } = require('react/jsx-runtime')
    const { useCallback, useEffect, useState } = require('react')

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

    const KINDS = ['claude', 'codex', 'jsonl', 'deepseekExport']
    const emptySource = () => ({
      id: `src-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: '', kind: 'claude', remote: false, path: '', sshHost: '', sshUser: '',
      sshPort: 22, sshKeyRef: '', pollMs: 2000, autoSync: true, writeBack: true, enabled: true,
    })

    const s = {
      input: { width: '100%', boxSizing: 'border-box', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--dsh-border, #666)', background: 'var(--dsh-input-bg, transparent)', color: 'inherit' },
      label: { display: 'block', fontSize: 12, opacity: 0.8, margin: '8px 0 3px' },
      button: { padding: '6px 12px', borderRadius: 6, border: '1px solid var(--dsh-border, #666)', background: 'var(--dsh-button-bg, transparent)', color: 'inherit', cursor: 'pointer', marginRight: 6 },
      card: { border: '1px solid var(--dsh-border, #666)', borderRadius: 8, padding: 12, margin: '10px 0' },
      row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      small: { fontSize: 12, opacity: 0.7 },
      warn: { color: '#d98b3a', fontSize: 12, margin: '8px 0' },
      error: { color: '#e05252', fontSize: 12, margin: '8px 0' },
    }

    function Page({ t }) {
      const [sources, setSources] = useState([])
      const [states, setStates] = useState([])
      const [editing, setEditing] = useState(undefined)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)

      const load = useCallback(async () => {
        try {
          const data = await rpc('list')
          setSources(data.sources ?? [])
          setStates(data.states ?? [])
        } catch (e) { setError(e.message) }
      }, [])

      useEffect(() => { void load(); const id = setInterval(() => void load(), 3000); return () => clearInterval(id) }, [load])

      const save = async () => {
        if (!editing?.name?.trim() || !editing?.path?.trim()) { setError(t('panel.error')); return }
        setBusy(true)
        try {
          await rpc('save', { source: editing })
          setEditing(undefined)
          await load()
        } catch (e) { setError(e.message) } finally { setBusy(false) }
      }

      const remove = async id => {
        if (!window.confirm(t('panel.confirmRemove'))) return
        setBusy(true)
        try { await rpc('remove', { id }); await load() } catch (e) { setError(e.message) } finally { setBusy(false) }
      }

      const sync = async id => {
        setBusy(true)
        try { await rpc('sync', id ? { id } : {}); await load() } catch (e) { setError(e.message) } finally { setBusy(false) }
      }

      const stateFor = id => states.find(x => x.sourceId === id)
      const setField = (key, value) => setEditing(current => ({ ...current, [key]: value }))

      return jsxs('div', { children: [
        jsxs('div', { style: s.row, children: [
          jsx('h3', { children: t('panel.title') }),
          jsx('button', { style: s.button, onClick: () => void sync(), disabled: busy, children: t('panel.syncNow') }),
          jsx('button', { style: s.button, onClick: () => setEditing(emptySource()), children: t('panel.addSource') }),
        ] }),
        jsx('div', { style: s.small, children: t('panel.subtitle') }),
        error ? jsx('div', { style: s.error, children: error }) : null,
        ...sources.map(source => {
          const state = stateFor(source.id)
          return jsxs('div', { style: s.card, key: source.id, children: [
            jsxs('div', { style: s.row, children: [
              jsx('strong', { children: source.name }),
              jsx('span', { style: s.small, children: t(`panel.kinds.${source.kind}`) }),
              jsx('span', { style: s.small, children: source.enabled ? t('panel.enabled') : t('panel.disabled') }),
              source.remote ? jsx('span', { style: s.small, children: `SSH ${source.sshUser}@${source.sshHost}` }) : null,
            ] }),
            jsx('div', { style: s.small, children: source.path }),
            state?.lastSyncAt ? jsx('div', { style: s.small, children: `${t('panel.lastSync')} ${new Date(state.lastSyncAt).toLocaleString()}` }) : null,
            state?.lastError ? jsx('div', { style: s.error, children: state.lastError }) : null,
            jsxs('div', { style: { ...s.row, marginTop: 8 }, children: [
              jsx('button', { style: s.button, onClick: () => void sync(source.id), disabled: busy, children: t('panel.syncNow') }),
              jsx('button', { style: s.button, onClick: () => setEditing({ ...source }), children: t('panel.editSource') }),
              jsx('button', { style: s.button, onClick: () => void remove(source.id), disabled: busy, children: t('panel.removeSource') }),
            ] }),
          ] })
        }),
        sources.length === 0 ? jsx('div', { style: s.small, children: t('panel.noSources') }) : null,
        editing ? jsxs('div', { style: s.card, children: [
          jsx('h4', { children: t('panel.editSource') }),
          jsx('label', { style: s.label, children: t('panel.fields.name') }),
          jsx('input', { style: s.input, value: editing.name, onChange: e => setField('name', e.target.value) }),
          jsx('label', { style: s.label, children: t('panel.fields.kind') }),
          jsx('select', { style: s.input, value: editing.kind, onChange: e => setField('kind', e.target.value) }, KINDS.map(k => jsx('option', { value: k, children: t(`panel.kinds.${k}`) }, k))),
          jsx('label', { style: s.label, children: t('panel.fields.path') }),
          jsx('input', { style: s.input, value: editing.path, onChange: e => setField('path', e.target.value), placeholder: '~/.claude/projects/-workspace/xxx.jsonl' }),
          jsx('label', { style: s.label, children: t('panel.fields.remote') }),
          jsx('input', { type: 'checkbox', checked: !!editing.remote, onChange: e => setField('remote', e.target.checked) }),
          editing.remote ? jsxs(Fragment, { children: [
            jsx('label', { style: s.label, children: t('panel.fields.sshHost') }),
            jsx('input', { style: s.input, value: editing.sshHost ?? '', onChange: e => setField('sshHost', e.target.value) }),
            jsx('label', { style: s.label, children: t('panel.fields.sshUser') }),
            jsx('input', { style: s.input, value: editing.sshUser ?? '', onChange: e => setField('sshUser', e.target.value) }),
            jsx('label', { style: s.label, children: t('panel.fields.sshPort') }),
            jsx('input', { type: 'number', style: s.input, value: editing.sshPort ?? 22, onChange: e => setField('sshPort', Number(e.target.value)) }),
            jsx('label', { style: s.label, children: t('panel.fields.sshKeyRef') }),
            jsx('input', { style: s.input, value: editing.sshKeyRef ?? '', onChange: e => setField('sshKeyRef', e.target.value), placeholder: 'conversation-sync/ssh-key' }),
          ] }) : null,
          jsx('label', { style: s.label, children: t('panel.fields.writeBack') }),
          jsx('input', { type: 'checkbox', checked: !!editing.writeBack, onChange: e => setField('writeBack', e.target.checked) }),
          jsx('div', { style: s.warn, children: t('panel.warnings.writeBack') }),
          jsx('label', { style: s.label, children: t('panel.fields.autoSync') }),
          jsx('input', { type: 'checkbox', checked: !!editing.autoSync, onChange: e => setField('autoSync', e.target.checked) }),
          jsxs('div', { style: { ...s.row, marginTop: 12 }, children: [
            jsx('button', { style: s.button, onClick: () => void save(), disabled: busy, children: t('panel.save') }),
            jsx('button', { style: s.button, onClick: () => setEditing(undefined), children: t('panel.cancel') }),
          ] }),
        ] }) : null,
      ] })
    }

    const inject = ['slots', 'locale']

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en: {
        summary: 'Conversation sync',
        'panel.title': 'Conversation sync',
        'panel.subtitle': 'Import external conversations and keep both sides in sync',
        'panel.addSource': 'Add source', 'panel.editSource': 'Edit source', 'panel.removeSource': 'Remove source',
        'panel.syncNow': 'Sync now', 'panel.confirmRemove': 'Remove this source?', 'panel.cancel': 'Cancel',
        'panel.enabled': 'Enabled', 'panel.disabled': 'Disabled', 'panel.noSources': 'No sources configured yet.',
        'panel.save': 'Save', 'panel.saved': 'Saved', 'panel.error': 'Please fill in the name and path',
        'panel.lastSync': 'Last sync:', 'panel.remote': 'Remote SSH source',
        'panel.fields.name': 'Name', 'panel.fields.kind': 'Source type', 'panel.fields.path': 'Path or file',
        'panel.fields.remote': 'Remote SSH source', 'panel.fields.sshHost': 'SSH host', 'panel.fields.sshUser': 'SSH user',
        'panel.fields.sshPort': 'SSH port', 'panel.fields.sshKeyRef': 'SSH private-key credential reference',
        'panel.fields.writeBack': 'Write back to original file', 'panel.fields.autoSync': 'Enable real-time sync',
        'panel.kinds.claude': 'Claude Code', 'panel.kinds.codex': 'Codex CLI', 'panel.kinds.jsonl': 'Generic JSONL',
        'panel.kinds.deepseekExport': 'DeepSeek export ZIP',
        'panel.warnings.writeBack': 'Warning: write-back edits the original tool\'s live files. Backups are made before each write; data loss is still possible.',
      }, zh: {
        summary: '会话同步',
        'panel.title': '会话同步', 'panel.subtitle': '导入外部会话并保持两端同步',
        'panel.addSource': '添加来源', 'panel.editSource': '编辑来源', 'panel.removeSource': '删除来源',
        'panel.syncNow': '立即同步', 'panel.confirmRemove': '确定删除这个来源？', 'panel.cancel': '取消',
        'panel.enabled': '已启用', 'panel.disabled': '已停用', 'panel.noSources': '尚未配置来源。',
        'panel.save': '保存', 'panel.saved': '已保存', 'panel.error': '请填写名称和路径',
        'panel.lastSync': '上次同步：', 'panel.remote': '远端 SSH 来源',
        'panel.fields.name': '名称', 'panel.fields.kind': '来源类型', 'panel.fields.path': '路径或文件',
        'panel.fields.remote': '远端 SSH 来源', 'panel.fields.sshHost': 'SSH 主机', 'panel.fields.sshUser': 'SSH 用户',
        'panel.fields.sshPort': 'SSH 端口', 'panel.fields.sshKeyRef': 'SSH 私钥凭据引用',
        'panel.fields.writeBack': '写回原始文件', 'panel.fields.autoSync': '启用实时同步',
        'panel.kinds.claude': 'Claude Code', 'panel.kinds.codex': 'Codex CLI', 'panel.kinds.jsonl': '通用 JSONL',
        'panel.kinds.deepseekExport': 'DeepSeek 导出 ZIP',
        'panel.warnings.writeBack': '警告：写回会直接修改原工具的活跃文件。每次写入前会自动备份，但仍可能发生数据丢失。',
      } }), 'conversation-sync/dictionaries')
      ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config', key: PKG, locale: NS,
      }, ({ t, view }) => (view === 'summary' ? t('summary') : jsx(Page, { t })))), 'conversation-sync/page')
    }

    return { apply, inject }
  },
})
