// src/semantic-hits.ts
// 语义层的「按库取用」共享模块。
//
// 为什么单独成模块：语义运行时（qmd 嵌入 + 本地模型）原本只长在 tools.ts 里，而它有两个消费者——
//   - wiki_query / wiki_drill 的语义通道（tools.ts）
//   - L1 任务级触发在字面 0 命中时的兜底（trigger.ts）
// 触发层必须复用同一个「按库根缓存」的运行时：模型只加载一次；而且触发层**只接受已经热起来**的
// 运行时（冷启动几十秒，绝不能挂住 pre-step，见 requireWarm）。
//
// 开关与语义约束与旧实现逐字一致：`KNJ_OBSIDIAN_SEMANTIC_FALLBACK=off` 一律关闭（含触发层）。
// 只读：检索路径不建 collection、不触发索引、不下载模型。
import { basename } from 'node:path'
import {
  createSemanticRuntime, clampLimit, runOfflineSearch,
  type SemanticHit, type SemanticRuntime,
} from './semantic-index.ts'
import type { SemanticPageHit } from './retriever.ts'
import type { WikiCategory } from './types.ts'

/**
 * 语义兜底开关：`KNJ_OBSIDIAN_SEMANTIC_FALLBACK=off` 时完全关闭。
 * 与 `KNJ_OBSIDIAN_AUTO_REFRESH=off` 同族：单元测试与离线环境用它避免加载 300M 嵌入模型、
 * 不去碰用户真实的 ~/.dsh/qmd（模型冷启动一次就要几十秒，测试里不可接受）。
 */
export function semanticFallbackEnabled(): boolean {
  return (process.env.KNJ_OBSIDIAN_SEMANTIC_FALLBACK ?? '').trim().toLowerCase() !== 'off'
}

/** 创建语义运行时的可注入点（测试替换；默认真实实现，会读 ~/.dsh/qmd 与本地模型）。 */
export type SemanticRuntimeFactory = (root: string) => Promise<SemanticRuntime>

export const defaultSemanticRuntimeFactory: SemanticRuntimeFactory =
  (root) => createSemanticRuntime({ vaultRoot: root })

/** 按库根缓存的语义运行时（进程级；模型只加载一次）。 */
const semanticRuntimes = new Map<string, Promise<SemanticRuntime | null>>()
/** 已解析完成的运行时（同步可读的「热」判据源）。 */
const warmRuntimes = new Map<string, SemanticRuntime | null>()

/** 取（或惰性创建）某库的语义运行时；失败缓存为 null，绝不抛出。 */
export function semanticRuntimeFor(
  vaultRoot: string,
  factory: SemanticRuntimeFactory = defaultSemanticRuntimeFactory,
): Promise<SemanticRuntime | null> {
  const cached = semanticRuntimes.get(vaultRoot)
  if (cached) return cached
  const created = factory(vaultRoot)
    .catch(() => null)
    .then((runtime) => {
      warmRuntimes.set(vaultRoot, runtime)
      return runtime
    })
  semanticRuntimes.set(vaultRoot, created)
  return created
}

/**
 * 同步取「已热」的运行时：**绝不触发创建/加载**。
 * 触发层用它当门——没热过就放弃语义兜底，宁可沉默也不把 pre-step 挂几十秒。
 */
export function warmSemanticRuntime(vaultRoot: string): SemanticRuntime | null {
  return warmRuntimes.get(vaultRoot) ?? null
}

/** 关闭并清空所有缓存的语义运行时（插件 dispose 时调用，避免 sqlite 句柄与模型常驻）。 */
export function disposeSemanticRuntimes(): void {
  for (const pending of semanticRuntimes.values()) {
    void pending.then((runtime) => { try { runtime?.store?.close?.() } catch { /* 关闭失败不影响退出 */ } })
  }
  semanticRuntimes.clear()
  warmRuntimes.clear()
}

export interface SemanticHitsRequest {
  vaultRoot: string
  query: string
  limit: number
  factory?: SemanticRuntimeFactory
  /** true = 只接受已热的运行时（触发层用）；false/缺省 = 允许惰性加载（工具用）。 */
  requireWarm?: boolean
}

/**
 * 取语义原始命中。任何不可用/失败（开关关闭、模型缺失、库缺失、索引为空、后端抛错）
 * 都返回空数组 → 调用方保持纯词面结果，绝不抛错、不联网、不建索引。
 */
export async function semanticRawHits(request: SemanticHitsRequest): Promise<SemanticHit[]> {
  if (!semanticFallbackEnabled()) return []
  const limit = clampLimit(request.limit)
  if (request.requireWarm) {
    const warm = warmSemanticRuntime(request.vaultRoot)
    return warm?.store ? searchWarm(warm.store, request.query, limit) : []
  }
  const runtime = await semanticRuntimeFor(request.vaultRoot, request.factory ?? defaultSemanticRuntimeFactory)
  return runtime?.store ? searchWarm(runtime.store, request.query, limit) : []
}

async function searchWarm(
  store: NonNullable<SemanticRuntime['store']>,
  query: string,
  limit: number,
): Promise<SemanticHit[]> {
  try {
    const outcome = await runOfflineSearch(store, query, limit)
    return outcome.results
  } catch {
    return []
  }
}

/** 语义命中 → 页面命中（给 retrieve() 融合用）。分类合法性由 retrieve() 的白名单兜底。 */
export function toSemanticPageHits(hits: readonly SemanticHit[]): SemanticPageHit[] {
  const out: SemanticPageHit[] = []
  for (const hit of hits) {
    if (!hit?.id || !hit.category) continue
    const category = hit.category as WikiCategory
    out.push(hit.snippet ? { id: hit.id, category, snippet: hit.snippet } : { id: hit.id, category })
  }
  return out
}

/** 语义命中 → 触发层候选（避免 trigger 直接依赖 semantic-index 的类型）。 */
export interface SemanticCandidateHint {
  id: string
  category: string
  score: number
  snippet: string
}

/** 语义原始命中 → 触发层候选（按 score 降序、截断到 limit）。 */
export function toCandidateHints(hits: readonly SemanticHit[], limit: number): SemanticCandidateHint[] {
  const out: SemanticCandidateHint[] = []
  for (const hit of hits) {
    if (!hit?.id || !hit.category) continue
    const score = typeof hit.score === 'number' && Number.isFinite(hit.score) ? hit.score : 0
    out.push({ id: hit.id, category: hit.category, score, snippet: typeof hit.snippet === 'string' ? hit.snippet : '' })
  }
  return out.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, Math.max(0, limit))
}

/** 未命中诊断日志里的「工作区」名（与旧实现同口径）。 */
export function workspaceNameOf(vaultRoot: string): string {
  return basename(vaultRoot)
}

// clampLimit 在此转出：调用方原本从 semantic-index 间接拿它，避免两处各写一遍截断规则。
export { clampLimit }
