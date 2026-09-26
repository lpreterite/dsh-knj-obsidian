// importer.test.mjs — md 路径导入：保真搬运到 _raw/ 暂存区（2026-09-20 契约变更）
//
// 变更理由（实测 + 上游背书）：
//  1) 实测：4 个库 26 页里 source=import:* 的页面 **0 条**——这条路径从未产出过知识页；
//  2) 语义：它做的是"保真搬运"，而知识层要的是"LLM 提炼"；直接把未提炼内容写进 7 个正式分类
//     会稀释检索质量（长页多主题稀释嵌入已实测），且没有 confidence 判定、没有去重织链；
//  3) 上游模型本来就是这么设计的：obsidian-wiki 的 `_raw/` = Staging（"next ingest promotes them"），
//     且参考文档明确警告"草稿被当成正式知识检索/引用"的风险。
//
// 新契约：导入 = 把原文**逐字节保真**落到 `<wiki>/_raw/`（不改写 frontmatter、不剥标题、不判定分类）。
// `_raw/` 在构造上不可检索（RETRIEVAL_CATEGORIES 只有 7 类，语义索引 pattern 也只匹配那 7 类），
// 因此暂存内容不会污染 L1 / wiki_query / 语义检索；正式页仍由 wiki_ingest 产生。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VaultStore } from './lib/vault-store.js'
import { importPath } from './lib/importer.js'
import { retrieve } from './lib/retriever.js'

function makeSrcDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-obsidian-src-'))
}
function makeVault() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-obsidian-imp-'))
  const store = new VaultStore(dir)
  store.ensure()
  return { dir, store }
}
const rawPath = (dir, name) => join(dir, '.wiki', '_raw', name)

test('单文件：保真落到 _raw/（不解析 frontmatter、不剥标题、不判定分类）', () => {
  const src = makeSrcDir()
  const { dir, store } = makeVault()
  try {
    const text = '# 我的笔记\n\n正文第一段。\n'
    writeFileSync(join(src, 'my-note.md'), text, 'utf8')
    const r = importPath(store, join(src, 'my-note.md'), 'references')

    assert.equal(r.imported, 1)
    assert.equal(r.files[0].staged, '_raw/my-note.md')
    assert.ok(existsSync(rawPath(dir, 'my-note.md')), '应落在 _raw/')
    assert.equal(readFileSync(rawPath(dir, 'my-note.md'), 'utf8'), text, '原文逐字节保真（含 # 标题）')
    assert.equal(store.readPage('my-note', 'references'), null, '不得写进正式分类')
    assert.match(r.hint, /_raw|暂存/, '必须提示这是暂存、需蒸馏成正式页')
  } finally { rmSync(src, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }) }
})

test('带合法 frontmatter 的文件同样原样暂存（不再按声明 id/category 入库）', () => {
  const src = makeSrcDir()
  const { dir, store } = makeVault()
  try {
    const fm = ['---', 'id: existing-page', 'title: 已有页', 'category: concepts', 'tags: [keep]', '---', '', '原有正文', ''].join('\n')
    writeFileSync(join(src, 'whatever-name.md'), fm, 'utf8')
    const r = importPath(store, src, 'references')
    assert.equal(r.imported, 1)
    assert.equal(readFileSync(rawPath(dir, 'whatever-name.md'), 'utf8'), fm, 'frontmatter 原样保留（保真是这条路径的唯一职责）')
    assert.equal(store.readPage('existing-page', 'concepts'), null, '不得按 frontmatter 声明入库')
  } finally { rmSync(src, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }) }
})

test('目录递归：收集嵌套 md，排除 node_modules/.git/target；源文件只读不变', () => {
  const src = makeSrcDir()
  const { dir, store } = makeVault()
  try {
    writeFileSync(join(src, 'a.md'), 'A 正文', 'utf8')
    mkdirSync(join(src, 'sub'))
    writeFileSync(join(src, 'sub', 'b.md'), 'B 正文', 'utf8')
    mkdirSync(join(src, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(src, 'node_modules', 'pkg', 'skip.md'), '不应导入', 'utf8')
    const before = readFileSync(join(src, 'a.md'), 'utf8')
    const r = importPath(store, src, 'references')
    assert.equal(r.imported, 2, JSON.stringify(r.files))
    assert.ok(!r.files.some((f) => f.staged.includes('skip')), '排除 node_modules')
    assert.equal(readFileSync(join(src, 'a.md'), 'utf8'), before, '源文件不变')
    assert.ok(existsSync(rawPath(dir, 'a.md')) && existsSync(rawPath(dir, 'b.md')))
  } finally { rmSync(src, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }) }
})

test('幂等与更新：同名同内容→skipped 且磁盘不变；同名不同内容→updated 覆盖', () => {
  const src = makeSrcDir()
  const { dir, store } = makeVault()
  try {
    writeFileSync(join(src, 'same.md'), '初始内容', 'utf8')
    importPath(store, src, 'references')
    const before = readFileSync(rawPath(dir, 'same.md'), 'utf8')

    const r2 = importPath(store, src, 'references')
    assert.equal(r2.skipped, 1, '未修改重导应跳过')
    assert.equal(r2.imported, 0)
    assert.equal(readFileSync(rawPath(dir, 'same.md'), 'utf8'), before, '磁盘未变')

    writeFileSync(join(src, 'same.md'), '改过的内容', 'utf8')
    const r3 = importPath(store, src, 'references')
    assert.equal(r3.updated, 1, '内容变化按更新处理')
    assert.equal(readFileSync(rawPath(dir, 'same.md'), 'utf8'), '改过的内容')
  } finally { rmSync(src, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }) }
})

test('暂存内容不可检索：_raw/ 不进 L1/wiki_query（构造上被白名单排除）', () => {
  const src = makeSrcDir()
  const { dir, store } = makeVault()
  try {
    writeFileSync(join(src, 'secret-draft.md'), '# 限流算法草稿\n\n退避抖动尚未整理。\n', 'utf8')
    importPath(store, src, 'references')

    assert.equal(store.listPagesReadonly().length, 0, '_raw 不出现在页面清单里')
    assert.deepEqual(retrieve(store, '限流算法草稿').candidates, [], '检索不得命中暂存内容')
  } finally { rmSync(src, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }) }
})

test('超限拒绝：单文件 >1MB 或总数 >500 → 整体失败，无部分写入', () => {
  const src = makeSrcDir()
  const { dir, store } = makeVault()
  try {
    writeFileSync(join(src, 'big.md'), 'x'.repeat(1024 * 1024 + 10), 'utf8')
    assert.throws(() => importPath(store, src, 'references'), /超过|1MB|limit/i, '超 1MB 报错')
    writeFileSync(join(src, 'big.md'), 'x'.repeat(100), 'utf8')
    for (let i = 0; i < 501; i++) writeFileSync(join(src, `f${i}.md`), `内容${i}`, 'utf8')
    assert.throws(() => importPath(store, src, 'references'), /500|超过|limit/i, '超数量报错')
    assert.ok(!existsSync(rawPath(dir, 'big.md')) && !existsSync(rawPath(dir, 'f0.md')), '无部分写入')
  } finally { rmSync(src, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }) }
})

test('非法路径：不存在的路径 → 报错不崩', () => {
  const { dir, store } = makeVault()
  try {
    assert.throws(() => importPath(store, join(dir, 'no-such-path'), 'references'), /不存在|not found|ENOENT/i)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
