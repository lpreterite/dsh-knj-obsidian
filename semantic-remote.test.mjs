// semantic-remote.test.mjs — 远程嵌入后端（KNJ_OBSIDIAN_EMBED=remote）
// 覆盖：env 解析、HTTP 客户端契约（条数/维度/排序/错误）、存储对账（增量嵌+删页）、
//       余弦检索排序、探活失败如实回报、selectSemanticRuntime 分派（off/remote/local）。
// 全程 mock fetch，不联网；向量库落在临时目录，不碰真实 ~/.dsh。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import {
  remoteEmbedConfigFromEnv, createHttpEmbedClient, cosine, walkVaultPages,
  createRemoteSemanticRuntime, selectSemanticRuntime,
} from './lib/semantic-remote.js'

const require = createRequire(import.meta.url)
let sqliteOK = true
try {
  require('node:sqlite')
} catch {
  sqliteOK = false
}

const ROOT = join(tmpdir(), `knj-remote-test-${process.pid}`)
mkdirSync(ROOT, { recursive: true })
test.after(() => { rmSync(ROOT, { recursive: true, force: true }) })

function makeVault() {
  const wikiRoot = join(ROOT, 'vault', '.wiki')
  mkdirSync(join(wikiRoot, 'concepts'), { recursive: true })
  mkdirSync(join(wikiRoot, 'references'), { recursive: true })
  writeFileSync(join(wikiRoot, 'concepts', 'rate-limit.md'),
    '---\nid: rate-limit\ntitle: 限流策略\ncategory: concepts\n---\n\n限流采用令牌桶，超限返回 429。\n')
  writeFileSync(join(wikiRoot, 'references', 'api-notes.md'),
    '---\nid: api-notes\ntitle: API 备注\ncategory: references\n---\n\napi 网关超时 30 秒，注意重试。\n')
  return wikiRoot
}

/** 确定性 4 维向量：命中关键词置 1（检索排序测试用）。 */
function embedOf(text) {
  return [
    text.includes('限流') ? 1 : 0,
    text.includes('api') || text.includes('网关') ? 1 : 0,
    1,
    0,
  ]
}

/** mock fetch：/models 探活 + /embeddings 嵌入（记录调用，可断言零调用）。 */
function mockFetch(opts = {}) {
  const calls = { models: 0, embeddings: [] }
  const impl = async (url, init) => {
    if (String(url).endsWith('/models')) {
      calls.models += 1
      return { ok: opts.modelsFail ? false : true, status: opts.modelsFail ? 503 : 200 }
    }
    if (String(url).endsWith('/embeddings')) {
      const body = JSON.parse(init.body)
      calls.embeddings.push(body)
      if (opts.embeddingsFail) return { ok: false, status: 500, text: async () => 'boom' }
      const input = Array.isArray(body.input) ? body.input : [body.input]
      return {
        ok: true, status: 200,
        json: async () => ({ data: input.map((text, index) => ({ index, embedding: embedOf(text) })) }),
      }
    }
    return { ok: false, status: 404, text: async () => 'not found' }
  }
  return { impl, calls }
}

const CONFIG = (overrides = {}) => ({
  provider: 'remote', url: 'http://embed.test/v1', model: 'baai/bge-m3',
  batch: 16, timeoutMs: 5000, ...overrides,
})

test('remoteEmbedConfigFromEnv：默认 local；unknown 回退；remote 缺 URL 保留 provider 由上层拒', () => {
  assert.equal(remoteEmbedConfigFromEnv({}).provider, 'local')
  assert.equal(remoteEmbedConfigFromEnv({ KNJ_OBSIDIAN_EMBED: 'REMOTE' }).provider, 'remote')
  assert.equal(remoteEmbedConfigFromEnv({ KNJ_OBSIDIAN_EMBED: 'what' }).provider, 'local')
  assert.equal(remoteEmbedConfigFromEnv({ KNJ_OBSIDIAN_EMBED: 'off' }).provider, 'off')
  const cfg = remoteEmbedConfigFromEnv({
    KNJ_OBSIDIAN_EMBED: 'remote', KNJ_OBSIDIAN_EMBED_URL: ' http://x/v1 ', KNJ_OBSIDIAN_EMBED_KEY: 'k',
    KNJ_OBSIDIAN_EMBED_MODEL: 'm2', KNJ_OBSIDIAN_EMBED_DIMS: '1024', KNJ_OBSIDIAN_EMBED_BATCH: '8',
  })
  assert.equal(cfg.url, 'http://x/v1')
  assert.equal(cfg.model, 'm2')
  assert.equal(cfg.dims, 1024)
  assert.equal(cfg.batch, 8)
})

test('createHttpEmbedClient：请求体/鉴权头正确；按 index 还原顺序；维度首采后强制一致', async () => {
  const calls = []
  const client = createHttpEmbedClient(CONFIG({ dims: undefined, apiKey: 'k' }), async (url, init) => {
    calls.push({ url, init })
    return {
      ok: true, status: 200,
      json: async () => ({ data: [{ index: 1, embedding: [0, 0, 0, 1] }, { index: 0, embedding: [1, 1, 1, 1] }] }),
    }
  })
  const out = await client(['a', 'b'])
  assert.equal(calls[0].url, 'http://embed.test/v1/embeddings')
  assert.equal(calls[0].init.headers.authorization, 'Bearer k')
  assert.deepEqual(JSON.parse(calls[0].init.body).input, ['a', 'b'])
  assert.deepEqual(out, [[1, 1, 1, 1], [0, 0, 0, 1]]) // index 还原，不是响应顺序
  // 无 KEY 时不带鉴权头
  const noKey = createHttpEmbedClient(CONFIG({ dims: undefined }), async () => ({ ok: true, status: 200, json: async () => ({ data: [{ index: 0, embedding: [1, 0] }] }) }))
  await noKey(['x']) // 不抛即通过（headers 由实现决定，这里只验不炸）
  // 维度不符：配置 dims=4 但返回 3 → 抛错
  const strict = createHttpEmbedClient(CONFIG({ dims: 4 }), async () => ({
    ok: true, status: 200, json: async () => ({ data: [{ index: 0, embedding: [1, 2, 3] }] }),
  }))
  await assert.rejects(() => strict(['x']), /维度不符/)
  // HTTP 500 → 抛错带状态码（调用方降级）
  const failing = createHttpEmbedClient(CONFIG(), async () => ({ ok: false, status: 500, text: async () => 'boom' }))
  await assert.rejects(() => failing(['x']), /HTTP 500/)
})

test('cosine：同向≈1、正交 0、零向量 0', () => {
  assert.ok(Math.abs(cosine([1, 0, 1, 0], [1, 0, 1, 0]) - 1) < 1e-12)
  assert.equal(cosine([1, 0, 0, 0], [0, 1, 0, 0]), 0)
  assert.equal(cosine([0, 0, 0, 0], [1, 0, 0, 0]), 0)
})

test('walkVaultPages：只收七个正式分类的 .md；title/哈希/片段齐备', () => {
  const wikiRoot = makeVault()
  mkdirSync(join(wikiRoot, '_system'), { recursive: true })
  writeFileSync(join(wikiRoot, '_system', 'x.md'), '垃圾')
  const pages = walkVaultPages(wikiRoot)
  assert.deepEqual(pages.map((p) => p.relPath).sort(), ['concepts/rate-limit.md', 'references/api-notes.md'])
  const page = pages.find((p) => p.id === 'rate-limit')
  assert.equal(page.title, '限流策略')
  assert.equal(page.hash.length, 64)
  assert.ok(page.embedText.includes('令牌桶'))
  assert.ok(!page.embedText.startsWith('---'))
})

test('RemoteVectorStore：增量嵌入（重跑零 HTTP）+ 检索排序 + 删页清理 + 状态计数', { skip: !sqliteOK }, async () => {
  const home = mkdtempSync(join(ROOT, 'home-'))
  const wikiRoot = makeVault()
  const { impl, calls } = mockFetch()
  const runtime = await createRemoteSemanticRuntime({ vaultRoot: wikiRoot, home, config: CONFIG(), fetchImpl: impl, skipProbe: false })
  assert.ok(runtime, 'remote 已配置应返回运行时')
  assert.equal(runtime.backendName, 'remote-embed')
  assert.equal(runtime.modelPresent, true)
  assert.equal(runtime.status, 'index-stale') // 有页面、还没嵌入
  assert.ok(runtime.modelPath.includes('baai/bge-m3'))

  const first = await runtime.store.embed()
  assert.equal(first.docsProcessed, 2)
  assert.equal(first.chunksEmbedded, 2)
  assert.equal(calls.embeddings.length, 1) // 2 篇合并进一次批量请求

  // 重跑：哈希不变 → 零 HTTP、零嵌入
  const second = await runtime.store.embed()
  assert.equal(second.docsProcessed, 2)
  assert.equal(second.chunksEmbedded, 0)
  assert.equal(calls.embeddings.length, 1)

  // 检索：『限流』应命中 concepts/rate-limit 且分数更高
  const hits = await runtime.store.searchVector('限流怎么处理', { limit: 5 })
  assert.ok(hits.length >= 2)
  assert.equal(hits[0].path, join(wikiRoot, 'concepts', 'rate-limit.md'))
  assert.ok(hits[0].score > hits[1].score)
  const shapedLimit = await runtime.store.searchVector('限流', { limit: 1 })
  assert.equal(shapedLimit.length, 1)

  // 状态：向量就位 → ready
  const status = runtime.store.getStatus()
  assert.equal(status.documents, 2)
  assert.equal(status.needsEmbedding, 0)
  assert.equal(status.hasVectorIndex, true)

  // 删页：文件消失 → 对账后向量删除
  rmSync(join(wikiRoot, 'references', 'api-notes.md'))
  const third = await runtime.store.embed()
  assert.equal(third.docsProcessed, 1)
  assert.equal(third.chunksEmbedded, 0)
  assert.equal(runtime.store.getStatus().documents, 1)

  runtime.store.close()
  assert.ok(existsSync(join(home, '.dsh', 'knj-obsidian', 'remote-embed')))
})

test('探活失败：modelPresent=false 如实回报，不假装可用', { skip: !sqliteOK }, async () => {
  const home = mkdtempSync(join(ROOT, 'home2-'))
  const wikiRoot = makeVault()
  const { impl } = mockFetch({ modelsFail: true })
  const runtime = await createRemoteSemanticRuntime({ vaultRoot: wikiRoot, home, config: CONFIG(), fetchImpl: impl })
  assert.ok(runtime)
  assert.equal(runtime.modelPresent, false)
  runtime.store.close()
})

test('selectSemanticRuntime 分派：off → null；remote 缺 URL → null；local → 走原 qmd 路径', async () => {
  assert.equal(await selectSemanticRuntime({ vaultRoot: '/tmp/x', config: CONFIG({ provider: 'off' }) }), null)
  assert.equal(await selectSemanticRuntime({ vaultRoot: '/tmp/x', config: CONFIG({ url: undefined }) }), null)
  // local：本机无论 qmd 是否安装都返回非 null 的可诊断运行时（store 可能为 null）
  const local = await selectSemanticRuntime({ vaultRoot: '/tmp/x', config: { provider: 'local', model: 'm', batch: 1, timeoutMs: 100 } })
  assert.ok(local, 'local 分派不应返回 null（可诊断运行时）')
  assert.equal(local.backendName, undefined)
})
