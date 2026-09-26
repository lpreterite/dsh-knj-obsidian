// src/importer.ts
// 路径导入 = **保真搬运**到 `<wiki>/_raw/` 暂存区。
//
// 2026-09-20 契约变更（原实现：解析 frontmatter → 写入 7 个正式分类）：
//   1) 实测证据：4 个库 26 页里 `source: import:*` 的页面 **0 条**——这条路径从未产出过知识页；
//   2) 语义理由：它做的是搬运，而知识层要的是提炼（无 confidence 判定、无去重织链）；
//      未提炼内容直接进正式分类会稀释检索质量（长页多主题稀释嵌入已实测）。
//   3) 上游模型本就如此：obsidian-wiki 的 `_raw/` = Staging（"next ingest promotes them"），
//      参考文档并明确警告"草稿被当成正式知识检索/引用"的风险。
//   本仓的语义索引 pattern 是**白名单**（只匹配 7 个正式分类），所以 `_raw/` 天然不可检索，
//   不需要上游那种 ignore 补丁。
//
// 保真 = 调用方给什么就写什么：不解析 frontmatter、不剥首标题、不判定分类。
// 安全模型不变：源文件只读；落点名经 SAFE_ID_RE 校验（VaultStore.stageRawFile 内建）。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { VaultStore } from './vault-store.ts'
import { RAW_DIR, SaveError } from './vault-store.ts'
import type { WikiCategory } from './types.ts'

export interface ImportFileResult {
  /** 源文件绝对路径（只读；用于用户核对）。 */
  source: string
  /** 暂存落点，相对 `.wiki`（如 `_raw/my-note.md`）。 */
  staged: string
  status: 'imported' | 'updated' | 'skipped'
}

export interface ImportReport {
  imported: number
  updated: number
  skipped: number
  files: ImportFileResult[]
  /** 暂存目录名（固定 `_raw`）。 */
  stagedDir: string
  /** 一句给用户/调用方的提示：这是暂存、未提炼、需蒸馏成正式页。 */
  hint: string
}

export interface ImportLimits {
  maxFiles: number
  maxBytes: number
  maxDepth: number
}

const DEFAULT_LIMITS: ImportLimits = { maxFiles: 500, maxBytes: 1024 * 1024, maxDepth: 12 }
const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'target', 'dist', '__pycache__', '.wiki'])

/** 文件名 → 合法落点名：小写、非法字符折叠为 -、去首尾 -；空则回退 untitled。导出供测试。 */
export function sanitizeId(name: string): string {
  const base = name.toLowerCase()
    .replace(/\.md$/i, '')
    .replace(/[^a-z0-9\u4e00-\u9fff-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return base || 'untitled'
}

interface Collected { path: string; relName: string }

function collect(root: string, limits: ImportLimits): Collected[] {
  const out: Collected[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > limits.maxDepth) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (EXCLUDE_DIRS.has(entry.name)) continue
        walk(join(dir, entry.name), depth + 1)
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        out.push({ path: join(dir, entry.name), relName: entry.name })
      }
    }
  }
  const st = statSync(root)
  if (st.isFile()) {
    if (!root.toLowerCase().endsWith('.md')) throw new Error(`仅支持 .md 文件：${root}`)
    out.push({ path: root, relName: basename(root) })
  } else if (st.isDirectory()) {
    walk(root, 0)
  }
  if (out.length === 0) throw new Error(`路径下没有 .md 文件：${root}`)
  if (out.length > limits.maxFiles) {
    throw new Error(`文件数超上限：${out.length} > ${limits.maxFiles}，请分批导入`)
  }
  return out
}

/**
 * 把 `.md` 文件/目录**保真搬运**到 `<wiki>/_raw/` 暂存区。
 *
 * @param category 仅作为「蒸馏时的建议归类」写进提示，**不再决定落点**（保留下来的原因是
 *   边栏的导入控件仍在传它；旧签名因此向后兼容）。
 */
export function importPath(
  store: VaultStore,
  root: string,
  category: WikiCategory = 'references',
  limits: ImportLimits = DEFAULT_LIMITS,
): ImportReport {
  let rootStat
  try {
    rootStat = statSync(root)
  } catch {
    throw new SaveError(404, `路径不存在：${root}`)
  }
  if (!rootStat.isFile() && !rootStat.isDirectory()) throw new SaveError(400, `路径既非文件也非目录：${root}`)

  const collected = collect(root, limits)
  // 先全部读入并校验大小（超限整体失败，不做部分写入）
  const sources: Array<{ path: string; name: string; text: string }> = []
  for (const c of collected) {
    const st = statSync(c.path)
    if (st.size > limits.maxBytes) {
      throw new Error(`文件超过 ${Math.floor(limits.maxBytes / 1024)}KB 上限：${c.path}（${Math.floor(st.size / 1024)}KB）`)
    }
    sources.push({ path: c.path, name: c.relName, text: readFileSync(c.path, 'utf8') })
  }

  const report: ImportReport = {
    imported: 0,
    updated: 0,
    skipped: 0,
    files: [],
    stagedDir: RAW_DIR,
    hint: `已保真暂存到 ${RAW_DIR}/（未提炼，暂不参与检索；蒸馏时可作为「${category}」参考）。`
      + `让 agent 从 ${RAW_DIR}/ 提炼成正式知识页后，才会被 L1 / wiki_query / 语义检索命中。`,
  }

  for (const src of sources) {
    const staged = store.stageRawFile(sanitizeId(src.name), src.text)
    if (staged.status === 'imported') report.imported += 1
    else if (staged.status === 'updated') report.updated += 1
    else report.skipped += 1
    report.files.push({ source: src.path, staged: staged.relPath, status: staged.status })
  }
  return report
}
