// src/miss-log.ts
// 检索未命中日志：把「agent 主动问了库、库却答不出来」的查询记下来。
//
// 为什么需要它：L1/检索层的静默是**设计正确**（无关任务不该提醒），所以"沉默"本身不等于
// 知识缺口。有价值的信号是——**agent 明确问了，但库里没有**。这是两件事的答案来源：
//   ① 一周后"哪些主题是真缺知识"（决定要不要跨库检索 / 主库模型）；
//   ② 命中率的原生埋点（此前只能靠事后挖会话日志，那套口径还踩过假阳性）。
//
// 为什么不写进 vault：仓库有契约测试断言「wiki_query 零写入」，且"检索只读"是插件的公开
// 契约（唯一允许的 vault 写入是 ingest/capture）。日志因此落在**插件状态目录**：
//   <DSH_HOME 或 ~/.dsh>/knj-obsidian/query-misses.jsonl   （与 vaults.json 同级）
// 好处：零 vault 写入、既有测试不受影响，而且跨工作区汇总——正好用来对比"哪个工作区缺货"。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { missLogOff } from './settings.ts'

export interface QueryMissEntry {
  /** ISO 时间戳。 */
  at: string
  /** 当时检索的库根（用于区分工作区）。 */
  vaultRoot: string
  /** 库目录名（人读友好）。 */
  workspace?: string
  query: string
  /** 检索模式：auto / index-only。 */
  mode: string
  /** 该库当时的页数（0 页 = 空库，与「有库但没这主题」区别开）。 */
  totalPages: number
  /** 是否尝试过语义兜底（区分"没试"与"试了也没有"）。 */
  semanticTried: boolean
  semanticStatus?: string
}

const DIR_NAME = 'knj-obsidian'
const FILE_NAME = 'query-misses.jsonl'
/** 上限：日志不能无限膨胀（超上限保留最近 N 条）。 */
const DEFAULT_MAX_ENTRIES = 2000

/** 开关：KNJ_OBSIDIAN_MISS_LOG=off 关闭（默认开启——这一阶段就是要攒数据）。
 *  优先级：env 覆盖 > 设置面板（trigger.missLog）> 默认开。 */
export function missLogEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return !missLogOff(env)
}

function resolveHome(home?: string): string {
  return home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** 日志文件路径（与 vaults.json 同处插件状态目录；绝不落在 vault 里）。 */
export function missLogPath(home?: string): string {
  return join(resolveHome(home), DIR_NAME, FILE_NAME)
}

/**
 * 追加一条未命中记录。任何失败都被吞掉——**诊断日志绝不打断检索**。
 * 用"整文件重写"而非 append，以便同时执行封顶；条目少（≤2000 行）时开销可忽略。
 */
export function recordQueryMiss(
  entry: QueryMissEntry,
  opts: { home?: string; maxEntries?: number } = {},
): void {
  try {
    const file = missLogPath(opts.home)
    mkdirSync(dirname(file), { recursive: true })
    const max = Math.max(1, opts.maxEntries ?? DEFAULT_MAX_ENTRIES)
    let prior: string[] = []
    if (existsSync(file)) {
      prior = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim().length > 0)
    }
    const next = [...prior.slice(-(max - 1)), JSON.stringify(entry)]
    writeFileSync(file, next.join('\n') + '\n', 'utf8')
  } catch {
    // 见上：诊断日志不得影响检索
  }
}
