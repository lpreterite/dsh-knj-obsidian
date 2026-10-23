/**
 * dsh-knj-obsidian 设置页（客户端）：把本插件的 Config namespace（dsh-knj-obsidian）
 * 注册进官方设置页的「插件」分页（plugins.item slot）。
 *
 * 为什么必须由客户端注册（2026-10-23 实机结论）：宿主的设置 UI 不会为任意 describe 行
 * 自动生成导航——每个第三方插件在自己的 client bundle 里用
 * `configForms.whileServed([ns], () => slots.inject('plugins.item', …))` 注册页面
 * （参照 @deepseek-ai/dsh-client-ui-settings-web-search）。Host  serving 该 namespace 期间
 * 页面存在；不 serving（未部署/未启用）时不留痕迹。
 *
 * 表单直接读 `configForms.get(ns)` 的 scope 快照（getSnapshot/subscribe/mutate 公开契约，
 * 参照 dsh-client-ui-primitives 的 SettingsFormScope），保存 = 一次 revision 围栏的
 * mutate（path 为段数组）。embedKey 写-only：draft 留空 = 不产生该字段的 op。
 */
import { createElement as h, useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactElement } from 'react'

export const SETTINGS_NS = 'dsh-knj-obsidian'

/** configForms.get(ns) 返回的 scope（结构化最小面，对齐 dsh-client-ui-primitives SettingsFormScope）。 */
export interface ConfigFormScope {
  getSnapshot(): {
    status: 'loading' | 'ready' | 'unavailable'
    value?: Record<string, unknown>
    base?: unknown
    user?: unknown
    writable: boolean
    revision?: number
  }
  subscribe(listener: () => void): () => void
  mutate(
    ops: ReadonlyArray<{ op: 'set' | 'unset'; path: readonly string[]; value?: unknown }>,
    expectedRevision?: number,
  ): Promise<boolean>
}

export interface ConfigFormsService {
  get(entryId: string): ConfigFormScope
  whileServed(
    namespaces: readonly string[],
    register: (served: ReadonlySet<string>) => (() => void) | void,
  ): () => void
}

export interface SlotsService {
  inject(slot: string, register: () => unknown): unknown
  register(
    descriptor: {
      name: string
      id: string
      order?: number
      label?: string | (() => string)
      locale?: string
      inject?: () => Record<string, unknown>
    },
    component: (props: unknown) => unknown,
  ): unknown
}

type FieldKind = 'text' | 'password' | 'number' | 'boolean' | 'choice'
interface FieldDef {
  /** 完整路径段（如 ['semantic','embedUrl']）。 */
  path: readonly string[]
  label: string
  kind: FieldKind
  hint?: string
  /** choice 的可选项。 */
  choices?: readonly string[]
  /** password 语义：draft 留空 = 不产生 op（保持现值）。 */
  writeOnly?: boolean
}

const SEMANTIC: readonly FieldDef[] = [
  { path: ['semantic', 'embed'], label: '嵌入后端', kind: 'choice', choices: ['local', 'remote', 'off'], hint: 'local=本机 GGUF；remote=调 OpenAI 兼容接口（本机不加载模型）' },
  { path: ['semantic', 'embedUrl'], label: '远程嵌入接口地址', kind: 'text', hint: 'OpenAI 兼容根地址（含 /v1）；embed=remote 时必填' },
  { path: ['semantic', 'embedKey'], label: '远程接口密钥', kind: 'password', writeOnly: true, hint: '留空 = 保持现值' },
  { path: ['semantic', 'embedModel'], label: '嵌入模型', kind: 'text', hint: '留空 = baai/bge-m3' },
  { path: ['semantic', 'embedDims'], label: '向量维度（0=自动）', kind: 'number' },
  { path: ['semantic', 'embedBatch'], label: '批量大小', kind: 'number' },
  { path: ['semantic', 'embedTimeoutMs'], label: '请求超时（毫秒）', kind: 'number' },
  { path: ['semantic', 'semanticFallback'], label: '语义兜底', kind: 'boolean' },
  { path: ['semantic', 'drill'], label: 'wiki_drill 下钻', kind: 'boolean' },
  { path: ['semantic', 'autoRefresh'], label: '入库后自动刷新索引', kind: 'boolean' },
]

const TRIGGER: readonly FieldDef[] = [
  { path: ['trigger', 'enabled'], label: '知识触发总闸', kind: 'boolean' },
  { path: ['trigger', 'fulltext'], label: 'L1 二档（追投正文）', kind: 'boolean' },
  { path: ['trigger', 'vaultIdentity'], label: 'L0 库身份注入', kind: 'boolean' },
  { path: ['trigger', 'recurrence'], label: 'L3 失败复发提醒', kind: 'boolean' },
  { path: ['trigger', 'subagent'], label: '子代理也触发', kind: 'boolean' },
  { path: ['trigger', 'gate'], label: 'L2 高危门强度', kind: 'choice', choices: ['off', 'warn', 'block'], hint: '默认 off：唯一会打断的一层' },
  { path: ['trigger', 'writeGate'], label: '写入闸', kind: 'choice', choices: ['off', 'ask', 'block'], hint: '默认 off：开着会误伤 UI 蒸馏' },
  { path: ['trigger', 'missLog'], label: '未命中埋点', kind: 'boolean' },
]

const TOP: readonly FieldDef[] = [
  { path: ['vaultRegistryFile'], label: 'vault 注册表路径', kind: 'text', hint: '留空 = 默认（~/.dsh/knj-obsidian/vaults.json）；改动需重载插件' },
]

const ALL_FIELDS: readonly FieldDef[] = [...SEMANTIC, ...TRIGGER, ...TOP]

type Drafts = Record<string, string | boolean>

/** 从快照 value 展开成扁平 draft（embedKey 恒空 = write-only）。 */
function draftsFrom(value: Record<string, unknown> | undefined): Drafts {
  const drafts: Drafts = {}
  const read = (path: readonly string[]): unknown => {
    let cur: unknown = value
    for (const seg of path) {
      cur = cur === null || typeof cur !== 'object' ? undefined : (cur as Record<string, unknown>)[seg]
    }
    return cur
  }
  for (const field of ALL_FIELDS) {
    const raw = read(field.path)
    if (field.kind === 'boolean') drafts[field.path.join('.')] = raw === true
    else if (field.kind === 'number') drafts[field.path.join('.')] = String(typeof raw === 'number' ? raw : '')
    else if (field.writeOnly) drafts[field.path.join('.')] = ''
    else drafts[field.path.join('.')] = typeof raw === 'string' ? raw : ''
  }
  return drafts
}

/** Knj 设置卡片：订阅 configForms scope，本地暂存，保存 = 一次 revision 围栏 mutate。 */
export function KnjSettingsCard({ scope }: { scope: ConfigFormScope }): ReactElement {
  const snapshot = useSyncExternalStore(
    useCallback((listener: () => void) => scope.subscribe(listener), [scope]),
    useCallback(() => scope.getSnapshot(), [scope]),
  )
  const [drafts, setDrafts] = useState<Drafts>(() => draftsFrom(snapshot?.value))
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState('')

  // 宿主快照换代（保存成功 / 他端修改）→ 重置本地草稿
  useEffect(() => {
    setDrafts(draftsFrom(snapshot?.value))
  }, [snapshot?.revision])

  const setDraft = (key: string, value: string | boolean): void => setDrafts((prev) => ({ ...prev, [key]: value }))

  const save = useCallback(async () => {
    if (!snapshot?.writable || saving) return
    const ops: Array<{ op: 'set'; path: readonly string[]; value: unknown }> = []
    for (const field of ALL_FIELDS) {
      const key = field.path.join('.')
      const draft = drafts[key]
      const current = field.path.reduce<unknown>((acc, seg) => {
        const cur = acc as Record<string, unknown> | undefined
        return cur === null || cur === undefined ? undefined : cur[seg]
      }, snapshot.value ?? {})
      if (field.kind === 'boolean') {
        if (Boolean(draft) !== (current === true)) ops.push({ op: 'set', path: field.path, value: draft === true })
        continue
      }
      if (field.writeOnly) {
        // 密文：留空 = 保持现值；非空才写
        if (typeof draft === 'string' && draft.trim() !== '') ops.push({ op: 'set', path: field.path, value: draft.trim() })
        continue
      }
      if (field.kind === 'number') {
        const n = Number.parseInt(String(draft), 10)
        if (Number.isFinite(n) && n !== current) ops.push({ op: 'set', path: field.path, value: n })
        continue
      }
      // text / choice
      const next = String(draft ?? '')
      if (next !== String(current ?? '')) ops.push({ op: 'set', path: field.path, value: next })
    }
    if (ops.length === 0) {
      setNote('没有需要保存的修改。')
      return
    }
    setSaving(true)
    setNote('')
    try {
      const ok = await scope.mutate(ops, snapshot.revision)
      setNote(ok ? '已保存（volatile 字段即时生效）。' : '保存被拒绝：请刷新页面后重试（revision 冲突已自动恢复）。')
    } catch (error) {
      setNote(`保存失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setSaving(false)
    }
  }, [drafts, saving, scope, snapshot])

  const status = snapshot?.status ?? 'loading'
  if (status !== 'ready') {
    return h('div', { className: 'knj-settings-card' }, status === 'loading' ? '设置加载中…' : '当前部署未提供此插件的设置。')
  }
  const disabled = !snapshot.writable || saving

  const renderGroup = (title: string, fields: readonly FieldDef[]): ReactElement =>
    h('div', { key: title, style: { marginBottom: 14 } },
      h('div', { style: { fontWeight: 600, margin: '6px 0' } }, title),
      fields.map((field) => {
        const key = field.path.join('.')
        const value = drafts[key]
        const inputStyle = { width: '100%', boxSizing: 'border-box' as const, marginBottom: 2 }
        const control =
          field.kind === 'boolean'
            ? h('label', { key, style: { display: 'flex', alignItems: 'center', gap: 6 } },
                h('input', { type: 'checkbox', checked: value === true, disabled, onChange: (e: { target: { checked: boolean } }) => setDraft(key, e.target.checked) }),
                h('span', null, field.label))
            : h('label', { key, style: { display: 'block', marginBottom: 8 } },
                h('span', { style: { display: 'block', fontSize: 12, opacity: 0.85, marginBottom: 2 } }, field.label),
                field.kind === 'choice'
                  ? h('select', { value: String(value ?? ''), disabled, style: inputStyle, onChange: (e: { target: { value: string } }) => setDraft(key, e.target.value) },
                      (field.choices ?? []).map((c) => h('option', { key: c, value: c }, c)))
                  : h('input', {
                      type: field.kind === 'password' ? 'password' : field.kind === 'number' ? 'number' : 'text',
                      value: String(value ?? ''), disabled, spellCheck: false, style: inputStyle,
                      onChange: (e: { target: { value: string } }) => setDraft(key, e.target.value),
                    }),
                field.hint ? h('span', { style: { display: 'block', fontSize: 11, opacity: 0.6 } }, field.hint) : null)
        return control
      }),
    )

  return h('div', { className: 'knj-settings-card', style: { maxWidth: 560 } },
    h('div', { style: { marginBottom: 10, opacity: 0.8 } },
      '知识库（Obsidian）插件的运行时设置。修改即保存在 profile 的 user 层；env 变量仍然优先于这里的值。'),
    renderGroup('语义 / 嵌入', SEMANTIC),
    renderGroup('触发 / 闸门', TRIGGER),
    renderGroup('其它', TOP),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 } },
      h('button', { disabled: disabled || saving, onClick: () => { void save() }, style: { padding: '4px 14px' } }, saving ? '保存中…' : '保存'),
      h('button', { disabled: saving, onClick: () => setDrafts(draftsFrom(snapshot.value)), style: { padding: '4px 10px' } }, '放弃修改'),
      note ? h('span', { style: { fontSize: 12, opacity: 0.85 } }, note) : null),
    !snapshot.writable ? h('div', { style: { marginTop: 6, fontSize: 12, opacity: 0.7 } }, '当前访问方式下设置为只读（非回环页面由宿主限制）。请从 127.0.0.1:3080 打开设置页编辑，或走 /api/obsidian-wiki/config。') : null,
  )
}

/**
 * 在 client 入口调用：注册进官方设置页的「插件」分页。
 * Host 未 serving 本 namespace（插件未启用/未部署）时不留任何痕迹；configForms/slots
 * 服务缺失（极端裁剪宿主）时返回 undefined，不影响其余客户端功能。
 */
export function mountSettingsPage(ctx: {
  get?(name: string): unknown
  effect(callback: () => unknown, label?: string): unknown
}): (() => void) | undefined {
  const getService = <T,>(name: string): T | undefined => {
    try {
      const viaGet = typeof ctx.get === 'function' ? (ctx.get(name) as T | undefined) : undefined
      if (viaGet !== undefined && viaGet !== null) return viaGet
    } catch { /* ignore */ }
    return undefined
  }
  const configForms = getService<ConfigFormsService>('configForms')
  const slots = getService<SlotsService>('slots')
  if (!configForms || !slots || typeof configForms.get !== 'function' || typeof configForms.whileServed !== 'function') return undefined

  const scope = configForms.get(SETTINGS_NS)
  const card = () => h(KnjSettingsCard, { scope })
  let slotDisposer: unknown
  const off = configForms.whileServed([SETTINGS_NS], () => {
    try {
      slotDisposer = slots.inject('plugins.item', () =>
        slots.register({
          name: 'plugins.item',
          id: 'dsh-knj-obsidian',
          order: 80,
          label: () => '知识库（Obsidian）',
        }, card),
      )
    } catch (error) {
      console.warn('[knj] settings page registration failed:', String(error))
    }
  })
  return () => {
    try { off?.() } catch { /* ignore */ }
    try { (slotDisposer as (() => void) | undefined)?.() } catch { /* ignore */ }
  }
}
