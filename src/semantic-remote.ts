// src/semantic-remote.ts
// 远程嵌入后端（KNJ_OBSIDIAN_EMBED=remote 时替代本地 qmd/llama.cpp 通道）。
//
// 为什么要有它（背景：docs/2026-10-23-dsh-web-segfault-embed-handoff.md）：
//   本地路径把 llama.cpp 原生 addon 以进程内 import 加载进宿主主进程，在部分 CPU 上
//   embed 挂死 / 段错误，一崩整个 dsh-web 陪葬。remote 模式下嵌入这一步改为调用
//   OpenAI 兼容的 `POST {url}/embeddings`（如 axonhub / OpenAI / 各家兼容网关），
//   向量与页面哈希存本机 sqlite（node:sqlite，零新增原生依赖），相似度 = 本地余弦——
//   **本机从头到尾不加载任何模型、任何原生推理栈**，引爆物直接消失。
//
// 约束沿用本项目语义层的既有性格：
//   - 可选且默认关闭：不设 KNJ_OBSIDIAN_EMBED=remote 就走原 local 路径，行为零变化
//   - 降级安全：HTTP 失败/超时/维度不符 → 抛错交给上层（runOfflineSearch / refresh）如实降级
//   - 诚实披露：探活失败 modelPresent=false，工具回报 not-ready，绝不假装可用
//   - 知识面隔离：索引库落在 ~/.dsh/knj-obsidian/remote-embed/，绝不进 vault
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { createRequire } from 'node:module'
import {
  FORMAL_CATEGORIES,
  type SemanticRuntime,
  type SemanticStore,
  type SemanticStatusRaw,
} from './semantic-index.ts'
import { effectiveEmbedConfig, REMOTE_EMBED_DEFAULTS, type RemoteEmbedConfig } from './settings.ts'

// 配置常量/类型的真身在 settings.ts（避免循环依赖）；此处转出保持既有引用面不变
export { REMOTE_EMBED_DEFAULTS } from './settings.ts'
export type { RemoteEmbedConfig } from './settings.ts'

/** 解析 KNJ_OBSIDIAN_EMBED* 环境变量（纯 env 版，供测试与对照；运行时入口走 settings.effectiveEmbedConfig）。 */
export function remoteEmbedConfigFromEnv(env: Record<string, string | undefined> = process.env): RemoteEmbedConfig {
  const raw = (env.KNJ_OBSIDIAN_EMBED ?? '').trim().toLowerCase()
  const provider: RemoteEmbedConfig['provider'] = raw === 'remote' ? 'remote' : raw === 'off' ? 'off' : 'local'
  const dimsRaw = Number.parseInt(env.KNJ_OBSIDIAN_EMBED_DIMS ?? '', 10)
  const batchRaw = Number.parseInt(env.KNJ_OBSIDIAN_EMBED_BATCH ?? '', 10)
  const timeoutRaw = Number.parseInt(env.KNJ_OBSIDIAN_EMBED_TIMEOUT_MS ?? '', 10)
  return {
    provider,
    url: env.KNJ_OBSIDIAN_EMBED_URL?.trim() || undefined,
    apiKey: env.KNJ_OBSIDIAN_EMBED_KEY?.trim() || undefined,
    model: env.KNJ_OBSIDIAN_EMBED_MODEL?.trim() || REMOTE_EMBED_DEFAULTS.model,
    dims: Number.isFinite(dimsRaw) && dimsRaw > 0 ? dimsRaw : undefined,
    batch: Number.isFinite(batchRaw) && batchRaw > 0 ? batchRaw : REMOTE_EMBED_DEFAULTS.batch,
    timeoutMs: Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : REMOTE_EMBED_DEFAULTS.timeoutMs,
  }
}

/** 嵌入客户端：texts → 等序向量数组。任何失败抛错（由调用方降级），绝不静默编造。 */
export type EmbedClient = (texts: readonly string[]) => Promise<number[][]>

/** OpenAI 兼容 /embeddings 客户端（fetchImpl 可注入供测试）。 */
export function createHttpEmbedClient(config: RemoteEmbedConfig, fetchImpl: typeof fetch = fetch): EmbedClient {
  return async (texts) => {
    if (texts.length === 0) return []
    const url = `${config.url!.replace(/\/+$/, '')}/embeddings`
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: config.model, input: texts }),
      signal: AbortSignal.timeout(config.timeoutMs),
    })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`embeddings HTTP ${response.status}：${body.slice(0, 200)}`)
    }
    const payload = (await response.json()) as { data?: Array<{ index?: number; embedding?: unknown }> }
    const data = Array.isArray(payload?.data) ? [...payload.data] : []
    if (data.length !== texts.length) throw new Error(`embeddings 返回条数不符：期望 ${texts.length}，实际 ${data.length}`)
    data.sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    let dims = config.dims
    return data.map((entry) => {
      const vector = Array.isArray(entry?.embedding) ? entry.embedding : undefined
      if (!vector || vector.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
        throw new Error('embeddings 返回了非法向量（缺失或含非有限数）')
      }
      if (dims === undefined) dims = vector.length
      if (vector.length !== dims) throw new Error(`向量维度不符：期望 ${dims}，实际 ${vector.length}（模型或 KNJ_OBSIDIAN_EMBED_DIMS 配错？）`)
      return vector
    })
  }
}

/** 余弦相似度（向量预先归一化可省，这里现场算；库规模几百页，代价可忽略）。 */
export function cosine(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  let dot = 0
  let na = 0
  let nb = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i += 1) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** 轻量 frontmatter title 提取（与 semantic-index 的 frontmatterTitle 同语义，独立实现避免耦合）。 */
function frontmatterTitle(text: string): string | undefined {
  if (!text.startsWith('---')) return undefined
  const end = text.indexOf('\n---', 3)
  const head = text.slice(3, end < 0 ? text.length : end)
  const matched = /^title:[ \t]*(.+)$/m.exec(head)
  const title = matched?.[1]?.trim().replace(/^["']|["']$/g, '')
  return title ? title : undefined
}

/** 去掉 frontmatter 的正文（嵌入输入与片段来源）。 */
function bodyOf(text: string): string {
  if (!text.startsWith('---')) return text
  const end = text.indexOf('\n---', 3)
  return end < 0 ? text : text.slice(end + 4)
}

/** 嵌入输入上限（字符）：知识页普遍远小于此；超长页截断并如实影响召回（诚实 MVP，不做分块）。 */
const EMBED_INPUT_MAX_CHARS = 6000

interface VaultPage { relPath: string; absPath: string; category: string; id: string; title?: string; hash: string; embedText: string; snippet: string }

/** 遍历 vault 七个正式分类下的 .md（_system/、wiki-export/、_raw/ 天然不收录）。 */
export function walkVaultPages(wikiRoot: string): VaultPage[] {
  const pages: VaultPage[] = []
  if (!existsSync(wikiRoot)) return pages
  for (const category of FORMAL_CATEGORIES) {
    const dir = join(wikiRoot, category)
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const file of entries) {
      if (!file.toLowerCase().endsWith('.md')) continue
      const absPath = join(dir, file)
      let text: string
      try {
        text = readFileSync(absPath, 'utf8')
      } catch {
        continue
      }
      const id = file.slice(0, -3)
      if (!id) continue
      const body = bodyOf(text)
      pages.push({
        relPath: `${category}/${file}`,
        absPath,
        category,
        id,
        title: frontmatterTitle(text),
        hash: createHash('sha256').update(text, 'utf8').digest('hex'),
        embedText: body.slice(0, EMBED_INPUT_MAX_CHARS),
        snippet: body.replace(/\s+/g, ' ').trim().slice(0, 400),
      })
    }
  }
  return pages
}

/** node:sqlite 可用性惰性探测（极老 Node 缺该模块时 remote 直接判不可用，绝不崩宿主）。 */
let sqliteModule: typeof import('node:sqlite') | undefined
function sqlite(): typeof import('node:sqlite') | undefined {
  if (sqliteModule === undefined) {
    try {
      // ESM 没有 require：createRequire 加载内置模块；缺失/不可用时降级为 undefined
      sqliteModule = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
    } catch {
      sqliteModule = null as unknown as typeof import('node:sqlite')
    }
  }
  return sqliteModule ?? undefined
}

/** 远程向量存储：实现 SemanticStore（searchVector / update / embed / getStatus / close）。 */
export class RemoteVectorStore implements SemanticStore {
  private readonly db: import('node:sqlite').DatabaseSync
  private readonly client: EmbedClient
  private readonly model: string
  private readonly batch: number
  private readonly wikiRoot: string

  constructor(opts: { wikiRoot: string; dbPath: string; client: EmbedClient; model?: string; batch?: number }) {
    const sqliteMod = sqlite()
    if (!sqliteMod) throw new Error('当前 Node 缺少 node:sqlite 模块，remote 嵌入后端不可用')
    this.wikiRoot = opts.wikiRoot
    mkdirSync(join(opts.dbPath, '..'), { recursive: true })
    this.db = new sqliteMod.DatabaseSync(opts.dbPath)
    this.client = opts.client
    this.model = opts.model ?? REMOTE_EMBED_DEFAULTS.model
    this.batch = opts.batch ?? REMOTE_EMBED_DEFAULTS.batch
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pages (
        rel_path TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        id TEXT NOT NULL,
        title TEXT,
        hash TEXT NOT NULL,
        dim INTEGER NOT NULL,
        vector BLOB NOT NULL,
        snippet TEXT NOT NULL
      )
    `)
  }

  /** 刷新流程兼容位：远程模式下同步在 embed() 一步完成（update 保持 no-op）。 */
  async update(): Promise<unknown> {
    return { skipped: true }
  }

  /** 全量对账：新/变页重新嵌入、消失页删除向量；重复运行零 HTTP（哈希不变自动跳过）。 */
  async embed(): Promise<{ docsProcessed: number; chunksEmbedded: number }> {
    const pages = walkVaultPages(this.wikiRoot)
    const existing = new Map<string, string>()
    for (const row of this.db.prepare('SELECT rel_path, hash FROM pages').all() as Array<{ rel_path: string; hash: string }>) {
      existing.set(row.rel_path, row.hash)
    }
    const current = new Set(pages.map((p) => p.relPath))
    for (const relPath of existing.keys()) {
      if (!current.has(relPath)) this.db.prepare('DELETE FROM pages WHERE rel_path = ?').run(relPath)
    }
    const changed = pages.filter((p) => existing.get(p.relPath) !== p.hash)
    let embedded = 0
    for (let i = 0; i < changed.length; i += this.batch) {
      const slice = changed.slice(i, i + this.batch)
      const vectors = await this.client(slice.map((p) => p.embedText))
      const upsert = this.db.prepare(
        'INSERT INTO pages (rel_path, category, id, title, hash, dim, vector, snippet) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(rel_path) DO UPDATE SET category=excluded.category, id=excluded.id, title=excluded.title, hash=excluded.hash, dim=excluded.dim, vector=excluded.vector, snippet=excluded.snippet',
      )
      slice.forEach((page, index) => {
        const vector = vectors[index]!
        upsert.run(
          page.relPath, page.category, page.id, page.title ?? null, page.hash,
          vector.length, Buffer.from(new Float32Array(vector).buffer), page.snippet,
        )
      })
      embedded += slice.length
    }
    return { docsProcessed: pages.length, chunksEmbedded: embedded }
  }

  /** 向量通道：嵌入查询 → 全量余弦 → 按分降序。行形态对齐 qmd（path/score/title/snippet）。 */
  async searchVector(query: string, options?: { limit?: number }): Promise<ReadonlyArray<Record<string, unknown>>> {
    const limit = Math.max(1, options?.limit ?? 8)
    const rows = this.db.prepare('SELECT rel_path, category, id, title, vector, dim, snippet FROM pages').all() as Array<{
      rel_path: string; category: string; id: string; title: string | null; vector: Buffer; dim: number; snippet: string
    }>
    if (rows.length === 0) return []
    const [queryVector] = await this.client([query.slice(0, EMBED_INPUT_MAX_CHARS)])
    const scored = rows.map((row) => {
      const vector = Array.from(new Float32Array(row.vector.buffer, row.vector.byteOffset, row.dim))
      return { row, score: cosine(queryVector!, vector) }
    })
    scored.sort((a, b) => b.score - a.score)
    const wikiRoot = this.wikiRoot
    return scored.slice(0, limit).map(({ row, score }) => ({
      path: join(wikiRoot, row.rel_path),
      score,
      title: row.title ?? row.id,
      snippet: row.snippet,
    }))
  }

  /** 远程 MVP 无本地词面通道：返回空，检索退化为纯向量（词面由 wiki_query 的 L1-L4 承担）。 */
  async searchLex(): Promise<ReadonlyArray<Record<string, unknown>>> {
    return []
  }

  /** 廉价状态：页面计数走目录枚举（不逐文件哈希）；改内容但数量不变的场景由 embed() 对账兜底。 */
  getStatus(): SemanticStatusRaw {
    const pages = walkVaultPages(this.wikiRoot)
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM pages').get() as { n: number }
    const embeddings = row.n
    return {
      documents: pages.length,
      totalDocuments: pages.length,
      embeddings,
      needsEmbedding: Math.max(0, pages.length - embeddings),
      hasVectorIndex: embeddings > 0,
    }
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      // 关闭失败不影响调用方
    }
  }
}

/** 组装远程运行时。返回 null = 明确未启用（off / remote 缺 URL），调用方如实回报未就绪。 */
export async function createRemoteSemanticRuntime(opts: {
  vaultRoot: string
  home?: string
  config?: RemoteEmbedConfig
  fetchImpl?: typeof fetch
  /** 测试注入：跳过 /models 探活。 */
  skipProbe?: boolean
}): Promise<SemanticRuntime | null> {
  const config = opts.config ?? remoteEmbedConfigFromEnv()
  if (config.provider !== 'remote') return null
  if (!config.url) {
    console.warn('[dsh-knj-obsidian] KNJ_OBSIDIAN_EMBED=remote 但未设置 KNJ_OBSIDIAN_EMBED_URL：语义后端不可用')
    return null
  }

  let modelPresent = true
  if (!opts.skipProbe) {
    const doFetch = opts.fetchImpl ?? fetch
    try {
      const response = await doFetch(`${config.url.replace(/\/+$/, '')}/models`, {
        headers: config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {},
        signal: AbortSignal.timeout(3000),
      } as RequestInit)
      modelPresent = response.ok
    } catch {
      modelPresent = false
    }
  }

  const client = createHttpEmbedClient(config, opts.fetchImpl ?? fetch)
  const dir = join(opts.home ?? homedir(), '.dsh', 'knj-obsidian', 'remote-embed')
  const key = createHash('sha256').update(opts.vaultRoot).digest('hex').slice(0, 16)
  const dbPath = join(dir, `${key}-${basename(opts.vaultRoot).replace(/[^\w.-]+/g, '_')}.sqlite`)

  let store: RemoteVectorStore | null = null
  try {
    // 与本地 qmd 的 collection 同口径：知识页在 <vaultRoot>/.wiki 七个分类目录下
    // （buildCollectionConfig 同构；直传 vaultRoot 会少一层、扫到 0 页——实测踩过）
    store = new RemoteVectorStore({ wikiRoot: join(opts.vaultRoot, '.wiki'), dbPath, client, model: config.model, batch: config.batch })
  } catch (error) {
    console.warn(`[dsh-knj-obsidian] remote 语义后端初始化失败：${error instanceof Error ? error.message : String(error)}`)
    return { status: 'index-empty', modelPath: `${config.model} @ ${config.url}`, modelPresent: false, store: null, index: { documents: 0, pendingEmbedding: 0, hasVectorIndex: false }, backendName: 'remote-embed' }
  }

  const status = store.getStatus()
  const runtimeStatus = status.documents === 0 ? 'index-empty' : status.hasVectorIndex && (status.needsEmbedding ?? 0) === 0 ? 'ready' : 'index-stale'
  return {
    status: runtimeStatus,
    modelPath: `${config.model} @ ${config.url}`,
    modelPresent,
    store,
    index: {
      documents: status.documents ?? 0,
      pendingEmbedding: status.needsEmbedding ?? 0,
      hasVectorIndex: status.hasVectorIndex ?? false,
    },
    backendName: 'remote-embed',
  }
}

/**
 * 按环境选择语义运行时（local=qmd 本地 / remote=OpenAI 兼容接口 / off=显式关闭）。
 * local 路径与历史行为完全一致；off 或 remote 未配 URL 返回 null（调用方如实回报未就绪）。
 */
export async function selectSemanticRuntime(opts: {
  vaultRoot: string
  home?: string
  fetchImpl?: typeof fetch
  /** 测试注入：跳过环境变量读取。 */
  config?: RemoteEmbedConfig
}): Promise<SemanticRuntime | null> {
  // 优先级：opts.config（测试注入）> env（临时覆盖）> 设置面板 > 内置默认
  const config = opts.config ?? effectiveEmbedConfig()
  if (config.provider === 'off') return null
  if (config.provider === 'remote') {
    return createRemoteSemanticRuntime({ vaultRoot: opts.vaultRoot, home: opts.home, config, fetchImpl: opts.fetchImpl })
  }
  const { createSemanticRuntime } = await import('./semantic-index.ts')
  return createSemanticRuntime({ vaultRoot: opts.vaultRoot, home: opts.home })
}

/** 兼容两种历史调用形态的工厂（semantic-hits 传 root 字符串；semantic-refresh 传对象）。 */
export function semanticRuntimeFactoryFor(): (
  input: string | { vaultRoot: string; home?: string },
) => Promise<SemanticRuntime | null> {
  return (input) => selectSemanticRuntime(typeof input === 'string' ? { vaultRoot: input } : input)
}
