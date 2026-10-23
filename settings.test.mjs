// settings.test.mjs — 设置面板化第一批：语义/嵌入组（env > 面板 > 内置默认）
// 覆盖：effectiveEmbedConfig 三层优先级、三个布尔开关的 off 语义、volatile 解包、
//       /api/obsidian-wiki/config HTTP 通道（探活栅栏 / embedKey 置空 / 409 冲突映射 / settings 缺席降级）。
// 全程 mock，不联网、不碰宿主。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  effectiveEmbedConfig, semanticFallbackOff, drillOff, autoRefreshOff,
  resolveKnjConfig, setSemanticSettings, mountSettingsHttp,
} from './lib/settings.js'

/** 面板语义组夹具（其余字段给默认值）。 */
const panel = (overrides = {}) => ({
  embed: 'local', embedUrl: '', embedKey: '', embedModel: '', embedDims: 0,
  embedBatch: 16, embedTimeoutMs: 30000,
  semanticFallback: true, drill: true, autoRefresh: true, ...overrides,
})

test('effectiveEmbedConfig：无面板无 env = 内置默认（local）', () => {
  setSemanticSettings(undefined)
  const cfg = effectiveEmbedConfig({})
  assert.equal(cfg.provider, 'local')
  assert.equal(cfg.url, undefined)
  assert.equal(cfg.model, 'baai/bge-m3')
  assert.equal(cfg.dims, undefined)
  assert.equal(cfg.batch, 16)
  assert.equal(cfg.timeoutMs, 30000)
})

test('effectiveEmbedConfig：面板补位（env 未设时生效）', () => {
  setSemanticSettings(panel({ embed: 'remote', embedUrl: 'http://panel/v1', embedModel: 'panel-model', embedDims: 1024 }))
  try {
    const cfg = effectiveEmbedConfig({})
    assert.equal(cfg.provider, 'remote')
    assert.equal(cfg.url, 'http://panel/v1')
    assert.equal(cfg.model, 'panel-model')
    assert.equal(cfg.dims, 1024)
    assert.equal(cfg.batch, 16)
  } finally {
    setSemanticSettings(undefined)
  }
})

test('effectiveEmbedConfig：env 覆盖面板（优先级铁律）', () => {
  setSemanticSettings(panel({ embed: 'remote', embedUrl: 'http://panel/v1', embedModel: 'panel-model' }))
  try {
    const cfg = effectiveEmbedConfig({
      KNJ_OBSIDIAN_EMBED: 'off',
      KNJ_OBSIDIAN_EMBED_URL: 'http://env/v1',
    })
    assert.equal(cfg.provider, 'off') // env 显式 off 压过面板 remote
    assert.equal(cfg.url, 'http://env/v1') // env URL 压过面板
    assert.equal(cfg.model, 'panel-model') // env 未设 → 面板值生效
  } finally {
    setSemanticSettings(undefined)
  }
})

test('布尔开关三态：env=off 永远关；面板 false 关；默认开', () => {
  setSemanticSettings(panel({ semanticFallback: false, drill: false, autoRefresh: false }))
  try {
    assert.equal(semanticFallbackOff({}), true)
    assert.equal(drillOff({}), true)
    assert.equal(autoRefreshOff({}), true)
    // env 显式 off 同样关（且与面板无关）
    assert.equal(semanticFallbackOff({ KNJ_OBSIDIAN_SEMANTIC_FALLBACK: 'off' }), true)
    // env 设了非 off 值 → env 已"表态"，但开关只有 off 才关，面板 false 仍关（文档化口径）
    assert.equal(semanticFallbackOff({ KNJ_OBSIDIAN_SEMANTIC_FALLBACK: 'x' }), true)
  } finally {
    setSemanticSettings(undefined)
  }
  assert.equal(semanticFallbackOff({}), false)
  assert.equal(drillOff({}), false)
  assert.equal(autoRefreshOff({}), false)
})

test('resolveKnjConfig：volatile 引用解包 + undefined 回默认', () => {
  const resolved = resolveKnjConfig({
    semantic: { get: () => panel({ embed: 'remote' }) },
    vaultRegistryFile: { get: () => '/tmp/vaults.json' },
  })
  assert.equal(resolved.semantic.embed, 'remote')
  assert.equal(resolved.vaultRegistryFile, '/tmp/vaults.json')
  const fallback = resolveKnjConfig(undefined)
  assert.equal(fallback.semantic.embed, 'local')
  assert.equal(fallback.semantic.semanticFallback, true)
})

/** 构造 mock res：捕获 writeHead/end。 */
function mockRes() {
  const out = { status: undefined, body: undefined, writeHead(status) { out.status = status }, end(body) { out.body = body } }
  return out
}

function mockSettingsService(rows) {
  return {
    describe: () => rows,
    mutate: async (ns, ops, revision) => {
      if (revision === 7) { const e = new Error('conflict'); e.name = 'SettingsConflictError'; throw e }
      rows[0].revision = (rows[0].revision ?? 0) + 1
      return { ok: true, ns, ops }
    },
  }
}

/** 构造 mock req：可被 for-await 消费的 body。 */
const mockReq = (method, body) => ({
  method,
  socket: { remoteAddress: '127.0.0.1' },
  setEncoding() {},
  async *[Symbol.asyncIterator]() { if (body !== undefined) yield body },
})

test('mountSettingsHttp：GET 描述符（embedKey 置空）+ POST 变更（400/409/200）+ settings 缺席不注册', async () => {
  const routes = []
  const webServer = { register: (route) => { routes.push(route); return () => {} } }
  const rows = [{ ns: 'dsh-knj-obsidian', revision: 3, value: { semantic: { embedKey: 'secret', embed: 'local' } }, base: {}, user: {} }]
  const settings = mockSettingsService(rows)

  // settings 缺席：不注册路由，返回 no-op disposer
  const empty = mountSettingsHttp({}, { webServer })
  assert.equal(routes.length, 0)
  empty()

  const dispose = mountSettingsHttp({}, { webServer, settings, get: () => undefined })
  assert.equal(routes.length, 1)
  const handler = routes[0].handler

  // GET：loopback 放行，embedKey 置空
  const res1 = mockRes()
  await handler(mockReq('GET'), res1)
  assert.equal(res1.status, 200)
  const body1 = JSON.parse(res1.body)
  assert.equal(body1.ok, true)
  assert.equal(body1.descriptor.value.semantic.embedKey, '')
  assert.equal(body1.descriptor.revision, 3)

  // POST：ops 非数组 → 400
  const res2 = mockRes()
  await handler(mockReq('POST', '{"ops":{}}'), res2)
  assert.equal(res2.status, 400)

  // POST：revision 冲突 → 409（mock 在 expectedRevision=7 时抛 SettingsConflictError）
  const res3 = mockRes()
  await handler(mockReq('POST', '{"ops":[{"path":"semantic.embed","value":"remote"}],"expectedRevision":7}'), res3)
  assert.equal(res3.status, 409)
  assert.equal(JSON.parse(res3.body).code, 'conflict')

  // POST：成功 → 200 且 revision 前进
  const res4 = mockRes()
  await handler(mockReq('POST', '{"ops":[{"path":"semantic.embed","value":"remote"}],"expectedRevision":3}'), res4)
  assert.equal(res4.status, 200)
  assert.equal(JSON.parse(res4.body).descriptor.revision, 4)

  // 非 loopback 且未配对 → 403
  const res6 = mockRes()
  const foreignReq = { method: 'GET', socket: { remoteAddress: '100.64.0.8' }, setEncoding() {} }
  await handler(foreignReq, res6)
  assert.equal(res6.status, 403)

  dispose()
})
