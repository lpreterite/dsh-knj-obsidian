// src/settings.ts
// 设置面板化（issue #2 第一批：语义/嵌入组）。
//
// 0.2.0 设置模型（模式照搬 dsh-self-improved 的成熟实现）：
//   - 本文件导出的 zod schema **就是设置页**（命名空间 = profile 条目 id = dsh-knj-obsidian）
//   - semantic 组整体 .volatile()：设置页保存 → Loader 原地提交进运行 fiber 并派发
//     loader/volatile-update（不重挂条目）→ apply() 里重解析并热应用（换后端即重建语义运行时）
//   - vaultRegistryFile 保持普通字段：改动走整条目重挂载，语义正确
//
// **优先级铁律：env 覆盖 > 设置面板 > 内置默认**。
//   env 仍然最高——测试注入（node --test 全靠 env 打开关）与「排查时临时覆盖」都不被面板绑架；
//   面板值只在 env 未设置时生效；两者都没有用内置默认。
//
// 非 loopback 访问：官方 configForms 在非回环页面被宿主置为 memory 模式（一律 unavailable，
// 刷新无效，官方设计）。本文件同时挂 GET/POST /api/obsidian-wiki/config HTTP 通道
// （走宿主侧 SettingsForms describe/mutate，embedKey 下发置空防明文回传），
// 让 Tailscale/配对访问下照常可改——与 dsh-self-improved 的 /config 同构。
import type { IncomingMessage, ServerResponse } from 'node:http'
import z from '@deepseek-ai/schemastery'

/** 远程嵌入默认值与配置形态（配置属 settings 域，放这里避免 settings ↔ semantic-remote 循环依赖）。 */
export const REMOTE_EMBED_DEFAULTS = { model: 'baai/bge-m3', batch: 16, timeoutMs: 30_000 } as const

/** 远程嵌入配置。 */
export interface RemoteEmbedConfig {
  provider: 'local' | 'remote' | 'off'
  /** OpenAI 兼容根地址（含 /v1），如 http://100.93.42.43:8090/v1 */
  url?: string
  apiKey?: string
  /** 嵌入模型名（请求体 model 字段），默认 baai/bge-m3 */
  model: string
  /** 期望向量维度；不设则采用首次返回的长度并在其后强制一致 */
  dims?: number
  batch: number
  timeoutMs: number
}

/** 语义/嵌入组设置（第一批面板化的 10 个；对应 KNJ_OBSIDIAN_EMBED* / SEMANTIC_FALLBACK / DRILL / AUTO_REFRESH）。 */
export interface SemanticSettings {
  embed: 'local' | 'remote' | 'off'
  embedUrl: string
  embedKey: string
  embedModel: string
  embedDims: number
  embedBatch: number
  embedTimeoutMs: number
  semanticFallback: boolean
  drill: boolean
  autoRefresh: boolean
}

export interface KnjConfig {
  semantic: SemanticSettings
  vaultRegistryFile: string
}

/**
 * 插件设置 schema：即 DSH 设置页内容（命名空间 dsh-knj-obsidian）。
 * 注意 schemastery 不是 zod：无 .enum/.int/z.infer——枚举用 z.union，非负整数用 z.natural()，
 * 类型手写（与 dsh-self-improved 同法）。
 */
export const KnjConfigSchema = z.object({
  semantic: z.object({
    embed: z.union(['local', 'remote', 'off']).default('local'),
    embedUrl: z.string().default(''),
    embedKey: z.string().default(''),
    embedModel: z.string().default(''),
    embedDims: z.natural().default(0),
    embedBatch: z.natural().default(16),
    embedTimeoutMs: z.natural().default(30000),
    semanticFallback: z.boolean().default(true),
    drill: z.boolean().default(true),
    autoRefresh: z.boolean().default(true),
  }).volatile(),
  vaultRegistryFile: z.string().default(''),
})

/** volatile 字段解析产物是引用（{ get(): value }），apply 入口统一解包成普通值。 */
function readLeaf<T>(field: unknown): T {
  if (field !== null && typeof field === 'object' && typeof (field as { get?: unknown }).get === 'function') {
    return (field as { get: () => T }).get()
  }
  return field as T
}

/** 语义/嵌入组的内置默认（与 schema default 一致；rawConfig 缺失/字段缺失时兜底）。 */
export const DEFAULT_SEMANTIC_SETTINGS: SemanticSettings = {
  embed: 'local',
  embedUrl: '',
  embedKey: '',
  embedModel: '',
  embedDims: 0,
  embedBatch: REMOTE_EMBED_DEFAULTS.batch,
  embedTimeoutMs: REMOTE_EMBED_DEFAULTS.timeoutMs,
  semanticFallback: true,
  drill: true,
  autoRefresh: true,
}

const EMBED_PROVIDERS: ReadonlySet<string> = new Set(['local', 'remote', 'off'])

/** 解包 rawConfig 里的 volatile 引用（幂等：普通值原样通过），并兜 schema 默认。 */
export function resolveKnjConfig(raw: unknown): KnjConfig {
  const src = (raw ?? {}) as Record<string, unknown>
  const semanticRaw = (readLeaf<Partial<SemanticSettings>>(src.semantic) ?? {}) as Partial<SemanticSettings>
  const embed = EMBED_PROVIDERS.has(String(semanticRaw.embed)) ? semanticRaw.embed as SemanticSettings['embed'] : DEFAULT_SEMANTIC_SETTINGS.embed
  const semantic: SemanticSettings = { ...DEFAULT_SEMANTIC_SETTINGS, ...semanticRaw, embed }
  const vaultRegistryFile = readLeaf<string>(src.vaultRegistryFile) ?? ''
  return { semantic, vaultRegistryFile }
}

// ---------- 运行时设置持有者（apply 注入；dispose 清空 → 测试与未挂载路径纯 env 行为不变） ----------

let semanticSettings: SemanticSettings | undefined

/** apply() 挂载/热更新时写入；dispose 时清空（清空后一切读取回落到 env，与历史行为一致）。 */
export function setSemanticSettings(settings: SemanticSettings | undefined): void {
  semanticSettings = settings
}

export function getSemanticSettings(): SemanticSettings | undefined {
  return semanticSettings
}

// ---------- 优先级解析：env 覆盖 > 设置面板 > 内置默认 ----------

const envText = (env: Record<string, string | undefined>, name: string): string =>
  (env[name] ?? '').trim()

/**
 * 嵌入后端生效配置。语义与 remoteEmbedConfigFromEnv 完全同形，只是每一档先问 env、
 * 再问设置面板、最后落内置默认。测试直接传 env 对象时行为与纯 env 版逐字节一致。
 */
export function effectiveEmbedConfig(env: Record<string, string | undefined> = process.env): RemoteEmbedConfig {
  const panel = semanticSettings
  const providerRaw = envText(env, 'KNJ_OBSIDIAN_EMBED') || panel?.embed || 'local'
  const provider: RemoteEmbedConfig['provider'] =
    providerRaw === 'remote' ? 'remote' : providerRaw === 'off' ? 'off' : 'local'
  const url = envText(env, 'KNJ_OBSIDIAN_EMBED_URL') || (panel?.embedUrl ?? '').trim() || undefined
  const apiKey = envText(env, 'KNJ_OBSIDIAN_EMBED_KEY') || (panel?.embedKey ?? '').trim() || undefined
  const model = envText(env, 'KNJ_OBSIDIAN_EMBED_MODEL') || (panel?.embedModel ?? '').trim() || REMOTE_EMBED_DEFAULTS.model
  const dimsEnv = Number.parseInt(envText(env, 'KNJ_OBSIDIAN_EMBED_DIMS'), 10)
  const dims = Number.isFinite(dimsEnv) && dimsEnv > 0 ? dimsEnv : (panel?.embedDims ?? 0) > 0 ? panel!.embedDims : undefined
  const batchEnv = Number.parseInt(envText(env, 'KNJ_OBSIDIAN_EMBED_BATCH'), 10)
  const batch = Number.isFinite(batchEnv) && batchEnv > 0 ? batchEnv : (panel?.embedBatch ?? 0) > 0 ? panel!.embedBatch : REMOTE_EMBED_DEFAULTS.batch
  const timeoutEnv = Number.parseInt(envText(env, 'KNJ_OBSIDIAN_EMBED_TIMEOUT_MS'), 10)
  const timeoutMs = Number.isFinite(timeoutEnv) && timeoutEnv > 0 ? timeoutEnv : (panel?.embedTimeoutMs ?? 0) > 0 ? panel!.embedTimeoutMs : REMOTE_EMBED_DEFAULTS.timeoutMs
  return { provider, url, apiKey, model, dims, batch, timeoutMs }
}

/** 语义兜底开关（KNJ_OBSIDIAN_SEMANTIC_FALLBACK / 面板 semanticFallback；默认开）。 */
export function semanticFallbackOff(env: Record<string, string | undefined> = process.env): boolean {
  if (envText(env, 'KNJ_OBSIDIAN_SEMANTIC_FALLBACK').toLowerCase() === 'off') return true
  return semanticSettings?.semanticFallback === false
}

/** wiki_drill 开关（KNJ_OBSIDIAN_DRILL / 面板 drill；默认开）。 */
export function drillOff(env: Record<string, string | undefined> = process.env): boolean {
  if (envText(env, 'KNJ_OBSIDIAN_DRILL').toLowerCase() === 'off') return true
  return semanticSettings?.drill === false
}

/** 语义自动刷新开关（KNJ_OBSIDIAN_AUTO_REFRESH / 面板 autoRefresh；默认开）。 */
export function autoRefreshOff(env: Record<string, string | undefined> = process.env): boolean {
  if (envText(env, 'KNJ_OBSIDIAN_AUTO_REFRESH').toLowerCase() === 'off') return true
  return semanticSettings?.autoRefresh === false
}

// ---------- 非 loopback 设置 HTTP 通道（GET/POST /api/obsidian-wiki/config） ----------

const SETTINGS_NS = 'dsh-knj-obsidian'

const isLoopbackRequest = (req: IncomingMessage): boolean => {
  const addr = req.socket.remoteAddress ?? ''
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

const isAllowedRequest = (ctx: unknown, req: IncomingMessage): boolean => {
  if (isLoopbackRequest(req)) return true
  try {
    // 非 loopback 需 remote-web-ui 配对设备（对齐 dsh-usage 的访问栅栏）
    const pairing = (ctx as { get?: (name: string) => unknown }).get?.('remoteWebUiPairing') as
      | { isPairedDevice?: (req: IncomingMessage) => boolean }
      | undefined
    return typeof pairing?.isPairedDevice === 'function' ? pairing.isPairedDevice(req) === true : false
  } catch {
    return false
  }
}

/** embedKey 永不明文回传浏览器：下发时置空（留空 = 保持现值）。 */
function blankEmbedKey(section: unknown): void {
  if (section !== null && typeof section === 'object') {
    const semantic = (section as { semantic?: { embedKey?: unknown } }).semantic
    if (semantic && typeof semantic.embedKey === 'string') semantic.embedKey = ''
  }
}

/**
 * 挂载 /api/obsidian-wiki/config（GET = 设置描述符；POST = {ops, expectedRevision} 变更）。
 * settings 服务经防御性读取获取（缺失时静默跳过——绝不影响 tools/routes，与 workspaceRegistry 同法）。
 */
export function mountSettingsHttp(ctx: unknown, hostCtx: unknown): () => void {
  const host = hostCtx as {
    webServer?: { register?: (route: Record<string, unknown>) => unknown }
    settings?: { describe?: () => Array<Record<string, unknown>>; mutate?: (ns: string, ops: unknown, revision?: number) => Promise<unknown> }
    get?: (name: string) => unknown
  }
  const settings = (host.settings
    ?? (typeof host.get === 'function' ? host.get('settings') as typeof host.settings : undefined)) ?? undefined
  const register = host.webServer?.register
  if (!register || !settings?.describe || !settings.mutate) return () => {}

  const writeJson = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  const readBody = async (req: IncomingMessage): Promise<string> => {
    let body = ''
    req.setEncoding('utf8')
    for await (const chunk of req) body += chunk
    return body
  }
  const describeConfig = (): Record<string, unknown> | null => {
    const row = settings.describe!().find((d) => d.ns === SETTINGS_NS)
    if (!row) return null
    const value = structuredClone(row.value ?? {})
    const base = structuredClone(row.base ?? {})
    const user = structuredClone(row.user ?? {})
    blankEmbedKey(value)
    blankEmbedKey(base)
    blankEmbedKey(user)
    return { ns: row.ns, revision: row.revision, value, base, user, autoGenerate: row.autoGenerate }
  }

  let unregister: (() => void) | undefined
  try {
    // register 返回注销函数（host webServer 契约）；注册失败静默跳过，不影响 tools/routes
    const maybe = register({
      kind: 'exact',
      path: '/api/obsidian-wiki/config',
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!isAllowedRequest(ctx, req)) return writeJson(res, 403, { ok: false, error: 'forbidden' })
        if (req.method === 'GET') {
          const descriptor = describeConfig()
          if (!descriptor) return writeJson(res, 404, { ok: false, error: 'entry not active' })
          return writeJson(res, 200, { ok: true, descriptor })
        }
        if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = JSON.parse(await readBody(req)) as { ops?: unknown; expectedRevision?: number }
          if (!Array.isArray(body.ops)) return writeJson(res, 400, { ok: false, error: 'ops must be an array' })
          await settings.mutate!(SETTINGS_NS, body.ops, body.expectedRevision)
          const descriptor = describeConfig()
          writeJson(res, 200, { ok: true, descriptor })
        } catch (error) {
          const name = (error as { name?: string }).name ?? ''
          const code = (error as { code?: string }).code ?? ''
          if (name === 'SettingsConflictError' || code === 'SETTINGS_CONFLICT') {
            return writeJson(res, 409, { ok: false, code: 'conflict', error: String((error as Error).message ?? 'conflict') })
          }
          writeJson(res, 400, { ok: false, error: String(error) })
        }
      },
    })
    if (typeof maybe === 'function') unregister = maybe as () => void
  } catch {
    return () => {}
  }
  return () => {
    try {
      unregister?.()
    } catch {
      // 注销失败不影响其它清理
    }
  }
}
