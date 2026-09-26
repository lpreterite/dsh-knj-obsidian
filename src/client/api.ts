/** 与后端 /api/obsidian-wiki/* 通信的客户端。同源 fetch。 */
export interface PageSummary {
  id: string
  category: string
  title: string
  confidence: string
}

export interface WikiPage {
  id: string
  title: string
  category: string
  tags: string[]
  source: string
  confidence: string
  created: string
  updated: string
  body: string
}

export interface SearchCandidate {
  id: string
  category: string
  title: string
  confidence: string
  snippet: string
}

export interface LintReport {
  orphans: string[]
  brokenLinks: { from: string; target: string }[]
  missingFrontmatter: string[]
  pageCount: number
}

const BASE = '/api/obsidian-wiki'

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path)
  if (!res.ok) throw new Error(`wiki api ${path}: ${res.status}`)
  return res.json() as Promise<T>
}

export function fetchPages(): Promise<{ pages: PageSummary[]; total: number }> {
  return getJson(`${BASE}/pages`)
}

/** v5：磁盘原文（含 frontmatter），源码视图/编辑用。 */
export async function fetchRawPage(id: string, category: string): Promise<string> {
  const res = await fetch(`${BASE}/page?id=${encodeURIComponent(id)}&category=${encodeURIComponent(category)}&raw=1`)
  const data = await res.json() as { raw?: string; error?: string }
  if (!res.ok || data.error) throw new Error(data.error ?? `wiki api: ${res.status}`)
  return data.raw ?? ''
}

/** v5：全文保存（同源 JSON POST）。成功返回解析后的页面。 */
export async function saveRawPage(id: string, category: string, raw: string): Promise<WikiPage> {
  const res = await fetch(`${BASE}/page?id=${encodeURIComponent(id)}&category=${encodeURIComponent(category)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ raw }),
  })
  const data = await res.json() as { page?: WikiPage; error?: string }
  if (!res.ok || data.error) throw new Error(data.error ?? `save failed: ${res.status}`)
  return data.page as WikiPage
}

export function fetchSearch(q: string, mode: 'auto' | 'index-only' = 'auto'): Promise<{ candidates: SearchCandidate[]; strategy: string }> {
  return getJson(`${BASE}/search?q=${encodeURIComponent(q)}&mode=${mode}`)
}

export function fetchLint(): Promise<LintReport> {
  return getJson(`${BASE}/lint`)
}

/** v6：重建 index.md（同源 POST）。 */
export async function rebuildIndex(): Promise<{ pageCount: number }> {
  const res = await fetch(`${BASE}/rebuild-index`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  const data = await res.json() as { pageCount?: number; error?: string }
  if (!res.ok || data.error) throw new Error(data.error ?? `rebuild failed: ${res.status}`)
  return { pageCount: data.pageCount ?? 0 }
}

export interface ImportResult {
  imported: number
  updated: number
  skipped: number
  /** 2026-09-20 契约变更：导入 = 保真搬运到 `_raw/` 暂存区，不再直接写正式分类。 */
  files: Array<{ source: string; staged: string; status: string }>
  stagedDir?: string
  hint?: string
}

/** v6：路径导入 md（同源 POST）。 */
export async function importMd(path: string, category: string): Promise<ImportResult> {
  const res = await fetch(`${BASE}/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, category }),
  })
  const data = await res.json() as Partial<ImportResult> & { error?: string }
  if (!res.ok || data.error) throw new Error(data.error ?? `import failed: ${res.status}`)
  return data as ImportResult
}

// ---------- v7 vault 管理 ----------

export interface VaultInfo {
  id: string
  name: string
  root: string
  source: 'cwd' | 'workspace' | 'attached'
}

export interface VaultListEntry extends VaultInfo {
  pageCount: number
  /** 磁盘上是否已有 .wiki（注册 ≠ 建库；false 时 UI 提供「初始化知识库」入口） */
  initialized: boolean
}

export interface VaultsResponse {
  current: VaultInfo | null
  vaults: VaultListEntry[]
}

export function fetchVaults(): Promise<VaultsResponse> {
  return getJson(`${BASE}/vaults`)
}

async function postVault(action: string, payload: Record<string, unknown>): Promise<VaultsResponse> {
  const res = await fetch(`${BASE}/vault/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await res.json() as Partial<VaultsResponse> & { error?: string }
  if (!res.ok || data.error) throw new Error(data.error ?? `vault ${action} failed: ${res.status}`)
  return data as VaultsResponse
}

/** 按目录激活（跟工作区走）：已注册仅切换，未注册自动挂接。 */
export const activateVault = (root: string): Promise<VaultsResponse> => postVault('activate', { root })

export const switchVault = (id: string): Promise<VaultsResponse> => postVault('switch', { id })

export const attachVault = (root: string, name?: string): Promise<VaultsResponse> => postVault('attach', name?.trim() ? { root, name: name.trim() } : { root })

export const removeVault = (id: string): Promise<VaultsResponse> => postVault('remove', { id })

// ---------- 还原点（checkpoint） ----------
export interface CheckpointMeta { id: string; createdAt: string; pageCount: number }

export async function fetchCheckpoints(): Promise<CheckpointMeta[]> {
  const data = await getJson<{ checkpoints: CheckpointMeta[] }>(`${BASE}/checkpoints`)
  return data.checkpoints
}

/** 从还原点回滚（同源 JSON POST）。
 *  mode 默认 `merge`（非破坏性：只撤销快照内页面的修改，保留快照后新增页）；
 *  `exact` = 整库回到快照（会删除快照后新增页），需显式传入。 */
export async function restoreCheckpoint(id: string, mode: 'merge' | 'exact' = 'merge'): Promise<{ pageCount: number; restored: number; keptNewer: number; mode: string }> {
  const res = await fetch(`${BASE}/checkpoint/restore`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, mode }),
  })
  const data = await res.json() as { pageCount?: number; restored?: number; keptNewer?: number; mode?: string; error?: string }
  if (!res.ok || data.error) throw new Error(data.error ?? `restore failed: ${res.status}`)
  return { pageCount: data.pageCount ?? 0, restored: data.restored ?? 0, keptNewer: data.keptNewer ?? 0, mode: data.mode ?? mode }
}

/** 取单个知识页（非 raw）。 */
export async function fetchPage(id: string, category: string): Promise<WikiPage> {
  const res = await fetch(`${BASE}/page?id=${encodeURIComponent(id)}&category=${encodeURIComponent(category)}`)
  const data = await res.json() as { page?: WikiPage; error?: string }
  if (!res.ok || data.error || !data.page) throw new Error(data.error ?? `page api: ${res.status}`)
  return data.page
}

// ---------- v8 本地语义索引（严格离线） ----------

export interface SemanticRefreshRun {
  ok: boolean
  at: string
  documents: number
  chunks: number
  durationMs: number
  note?: string
}

export interface SemanticStatus {
  available: boolean
  modelPresent: boolean
  indexState: 'ready' | 'index-empty' | 'index-stale'
  documents: number
  pendingEmbedding: number
  hasVectorIndex: boolean
  refreshing: boolean
  startedAt?: string
  elapsedMs?: number
  /** 本进程内实测的一次冷启动耗时（首次刷新），用于给出「约 N 秒」的估算。 */
  coldStartMs?: number
  lastRun?: SemanticRefreshRun
  note?: string
}

export function fetchSemanticStatus(): Promise<SemanticStatus> {
  return getJson(`${BASE}/semantic-status`)
}

/** 触发后台重建索引（立刻返回；进度靠 fetchSemanticStatus 轮询）。 */
export async function triggerSemanticUpdate(): Promise<{ started: boolean; running: boolean; status: SemanticStatus }> {
  const res = await fetch(`${BASE}/semantic-update`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  const data = await res.json() as { started?: boolean; running?: boolean; status?: SemanticStatus; error?: string }
  if (!res.ok || data.error) throw new Error(data.error ?? `semantic update failed: ${res.status}`)
  return { started: data.started ?? false, running: data.running ?? false, status: data.status as SemanticStatus }
}
