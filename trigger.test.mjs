// trigger.test.mjs
// 任务级知识触发（L1）与回合级沉淀提醒（L5）的契约测试。
//
// 设计要点（2026-09-20）：
//  - 触发时机是「任务」而不是「每次工具调用」——用户明确否掉了挂在 edit/write 前（太频繁）。
//  - 匹配用「页面侧词表扫任务原文 + 绝对命中数」，不用 retrieve() 的占比打分：
//    任务句长、分母大，占比天然偏低（实测「怎么避免定时器在错误的时钟下工作」占比近 0）。
//  - 最高危失败模式是**自激循环**：本插件注入的提醒本身就是一条 user 消息，
//    若被当成新任务就会在下一 pre-step 再次触发。A3 用例把这条钉死。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VaultStore } from './lib/vault-store.js'
import {
  matchTaskPages, renderTaskReminder, renderCaptureReminder,
  latestDirectUserTask, foldTurnFacts, triggerEnabled, installTrigger,
  currentTurnOf, turnToolCalls, injectedNotices, taskSummaryOf, CAPTURE_SUMMARY,
  subagentTriggerEnabled, delegationDepthOf,
} from './lib/trigger.js'

const NOW = '2026-08-25T00:00:00.000Z'

function makeVault() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-obsidian-trigger-'))
  const store = new VaultStore(dir)
  store.ensure()
  return { dir, store }
}

function seed(store) {
  store.writePage({
    id: 'dsh-plugin-dev-pitfalls', title: 'DSH 插件开发踩坑手册', category: 'references',
    tags: ['dsh', 'pitfall'], source: 'agent:session-2026-08-27', confidence: 'extracted', created: NOW, updated: NOW,
    body: '## Cron 时区被强制成 UTC\n\ndsh-scheduler 的 cron 表达式按 UTC 解释。',
  })
  store.writePage({
    id: 'rate-limiting', title: 'Rate Limiting 踩坑', category: 'concepts',
    tags: ['rate-limiting', 'api'], source: 's', confidence: 'extracted', created: NOW, updated: NOW,
    body: '429 处理要指数退避。',
  })
}

/** user/message 事件：`source.kind === 'user'` 才是「直接用户任务」（权威判据见 dsh-doublecheck）。 */
function userEvent(seq, text, kind = 'user') {
  return { type: 'user/message', seq, data: { source: { kind }, content: [{ type: 'text', text }] } }
}
/**
 * tool/call 事件：真实宿主在 turn/step/tool 事件上都带 `data.turn`
 * （见 dsh-session 的 SessionEventMap），回合边界靠它——夹具必须带上。
 */
function toolCall(seq, name, args, turn = 1) {
  return { type: 'tool/call', seq, data: { name, arguments: JSON.stringify(args), turn } }
}
/** 本插件自己注入过的提醒（落盘后回放时会出现在事件流里）。 */
function injectedNoticeEvent(seq, summary) {
  return { type: 'user/message', seq, data: { source: { kind: 'plugin', plugin: 'dsh-knj-obsidian', form: 'notice', summary } } }
}

test('matchTaskPages：任务原话提到术语时召回相关页（页面侧词表扫文本，绝对命中数）', (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  seed(store)

  const hits = matchTaskPages(store, '帮我看看 dsh-scheduler 的 cron 时区问题，插件里定时任务没触发')
  const ids = hits.map((h) => h.id)
  assert.ok(ids.includes('dsh-plugin-dev-pitfalls'), '应召回踩坑手册')
  assert.ok(hits[0].hits.length > 0, '每条候选必须给出命中词（模型据此判断要不要读）')
  assert.ok(hits[0].source.length > 0, '候选需带 source 以便追溯')
})

test('matchTaskPages：无关任务必须完全静默（宁可不说是第一原则）', (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  seed(store)

  assert.deepEqual(matchTaskPages(store, '帮我把这张图片的尺寸改成 800x600'), [])
  assert.deepEqual(matchTaskPages(store, '今天天气怎么样'), [])
})

test('matchTaskPages：空库 / 空任务文本不得抛错，返回空数组', (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  assert.deepEqual(matchTaskPages(store, 'dsh 插件的时区问题'), [])
  seed(store)
  assert.deepEqual(matchTaskPages(store, '   '), [])
})

test('matchTaskPages：结果有上限且按分降序（不把整库倒给模型）', (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  seed(store)
  const hits = matchTaskPages(store, 'dsh 插件 dsh 插件 dsh 插件 pitfall 踩坑 时区 cron', { max: 1 })
  assert.equal(hits.length, 1)
})

test('A3 防自激循环：插件注入的消息绝不被当成新任务', (t) => {
  const events = [
    userEvent(1, '帮我修一下 dsh-scheduler 的时区问题'),
    // 本插件自己注入的提醒（形态对齐 createUserMessage({ source: { kind: 'plugin', ... } })）
    userEvent(2, '[知识库提示] 相关页面：dsh-plugin-dev-pitfalls', 'plugin'),
    // 宿主注入的 AGENTS.md 基线
    userEvent(3, '## 动手前先看知识库', 'agent-instructions'),
    userEvent(4, 'DSH file policy snapshot', 'runtime-context'),
  ]
  const latest = latestDirectUserTask(events)
  assert.equal(latest.seq, 1, '只有 source.kind === \'user\' 的才算任务')
  assert.match(latest.text, /时区问题/)
})

test('latestDirectUserTask：取最后一条直接用户消息；没有则返回 undefined', () => {
  assert.equal(latestDirectUserTask([]), undefined)
  assert.equal(latestDirectUserTask([userEvent(1, '', 'plugin')]), undefined)
  const events = [userEvent(1, '第一件事'), userEvent(2, '第二件事')]
  assert.equal(latestDirectUserTask(events).seq, 2)
})

test('L5 foldTurnFacts：读过库 + 改过库外文件 + 没写回库 → 三者齐备才提醒', (t) => {
  // 齐备
  const full = foldTurnFacts([
    toolCall(1, 'read', { file_path: 'D:\\workspace\\iobs_pro\\.wiki\\index.md' }),
    toolCall(2, 'edit', { file_path: 'D:\\workspace\\iobs_pro\\plugins\\x\\src\\a.ts' }),
  ])
  assert.deepEqual(full, { readVault: true, mutatedOutside: true, wroteVault: false })

  // 已写回 → 不再提醒
  const captured = foldTurnFacts([
    toolCall(1, 'read', { file_path: '.wiki\\index.md' }),
    toolCall(2, 'edit', { file_path: 'plugins\\x\\src\\a.ts' }),
    toolCall(3, 'wiki_capture', { title: 'x' }),
  ])
  assert.equal(captured.wroteVault, true)

  // 没读过库 → 不提醒
  const noRead = foldTurnFacts([toolCall(1, 'edit', { file_path: 'plugins\\x\\src\\a.ts' })])
  assert.equal(noRead.readVault, false)

  // 只改了库内的页面（属于知识维护本身）→ 不算「改了代码」
  const onlyVaultEdit = foldTurnFacts([
    toolCall(1, 'read', { file_path: '.wiki\\index.md' }),
    toolCall(2, 'edit', { file_path: '.wiki\\references\\a.md' }),
  ])
  assert.equal(onlyVaultEdit.mutatedOutside, false)

  // 语义检索也算「用过库」
  const semantic = foldTurnFacts([toolCall(1, 'wiki_search_semantic', { query: 'x' }), toolCall(2, 'write', { file_path: 'plugins\\y.ts' })])
  assert.equal(semantic.readVault, true)
})

test('renderTaskReminder / renderCaptureReminder：文案含关键动作与可追溯信息', (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  seed(store)

  const text = renderTaskReminder(matchTaskPages(store, 'dsh-scheduler 的 cron 时区问题'))
  assert.match(text, /dsh-plugin-dev-pitfalls/)
  assert.match(text, /忽略|无关/, '必须给模型「可以忽略」的出口，否则会把提醒当命令')
  assert.ok(!/\bMUST\b|必须读/.test(text), '不得写成命令式（它不是门禁）')

  const capture = renderCaptureReminder()
  assert.match(capture, /wiki_capture|wiki_ingest/)
})

test('A6 开关：KNJ_OBSIDIAN_TRIGGER=off 时整体关闭', () => {
  assert.equal(triggerEnabled({}), true)
  assert.equal(triggerEnabled({ KNJ_OBSIDIAN_TRIGGER: 'off' }), false)
  assert.equal(triggerEnabled({ KNJ_OBSIDIAN_TRIGGER: ' OFF ' }), false)
  assert.equal(triggerEnabled({ KNJ_OBSIDIAN_TRIGGER: 'on' }), true)
})

// ---------------------------------------------------------------------------
// 接线层（installTrigger）：用假 host / 假 agent 断言真实行为。
// 注入文本走注入点 deps.createNotice —— 默认实现会动态 import 宿主的 @deepseek-ai/dsh-llm，
// 在插件仓库里解析不到，因此测试必须注入（也正是它可注入的原因）。
// ---------------------------------------------------------------------------

function fakeHost() {
  const handlers = new Map()
  return { on: (event, handler) => handlers.set(event, handler), handlers }
}
function fakeAgent(events, { delegationDepth } = {}) {
  const injected = []
  const session = { snapshotEvents: () => events }
  if (delegationDepth !== undefined) session.header = { delegationDepth }
  // inject 挂在 **agent** 上（不是 session 上）：宿主注入接口就是 agent.inject
  return { injected, agent: { session, inject: (m) => injected.push(m) } }
}
const notice = (text, summary) => ({ text, summary })

async function preStep(host, agent) {
  return host.handlers.get('agent/pre-step')({ agent }, async () => ({ kind: 'ok' }))
}

test('A2 L1 接线：新任务命中 → 注入一次；同一任务后续步骤不再注入；无命中则完全静默', async (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  seed(store)

  const host = fakeHost()
  installTrigger(host, { currentReadonly: () => store }, { createNotice: async (text, summary) => notice(text, summary) })

  const events = [userEvent(1, '帮我看看 dsh-scheduler 的 cron 时区问题，插件里定时任务没触发')]
  const { agent, injected } = fakeAgent(events)

  await preStep(host, agent)
  assert.equal(injected.length, 1, '新任务命中应注入一次')
  assert.match(injected[0].text, /dsh-plugin-dev-pitfalls/, '提醒必须给出候选页 id')
  assert.match(injected[0].text, /命中：/, '提醒必须给出「为什么提这一页」（命中词）——只给 id 等于让模型盲猜')
  assert.match(injected[0].text, /忽略|无关/)
  assert.equal(injected[0].summary, taskSummaryOf(1), '摘要带任务 seq：重启后据此判定同一任务已提醒')

  // 同一任务的后续步骤（或多个 pre-step）不得重复注入
  await preStep(host, agent)
  await preStep(host, agent)
  assert.equal(injected.length, 1, '同一个任务只提醒一次')

  // 新任务但无关 → 静默
  events.push(userEvent(2, '帮我把这张图片的尺寸改成 800x600'))
  await preStep(host, agent)
  assert.equal(injected.length, 1, '无关任务必须静默')
})

test('A3 接线：只有插件/宿主注入的消息时不得触发（防自激循环）', async (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  seed(store)

  const host = fakeHost()
  installTrigger(host, { currentReadonly: () => store }, { createNotice: async (text) => notice(text) })

  const events = [
    userEvent(1, 'dsh 插件的 cron 时区问题', 'plugin'),
    userEvent(2, '## 动手前先看知识库', 'agent-instructions'),
  ]
  const { agent, injected } = fakeAgent(events)
  await preStep(host, agent)
  assert.equal(injected.length, 0, '非直用户消息绝不能当成任务（否则会自激循环）')
})

test('A5 接线：L5 三者齐备才提醒，且每会话只提醒一次', async (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  seed(store)

  const host = fakeHost()
  installTrigger(host, { currentReadonly: () => store }, { createNotice: async (text) => notice(text) })
  const events = [
    userEvent(1, 'dsh 插件的时区问题'),
    toolCall(2, 'read', { file_path: 'D:\\workspace\\iobs_pro\\.wiki\\index.md' }),
    toolCall(3, 'edit', { file_path: 'D:\\workspace\\iobs_pro\\plugins\\x\\src\\a.ts' }),
  ]
  const { agent, injected } = fakeAgent(events)
  const turnStopping = host.handlers.get('agent/turn-stopping')

  await turnStopping({ agent })
  assert.equal(injected.length, 1, '读过库 + 改了代码 + 没写回 → 提醒一次')
  assert.match(injected[0].text, /wiki_capture|wiki_ingest/)

  await turnStopping({ agent })
  assert.equal(injected.length, 1, '每会话最多提醒一次')
})

test('A5 接线：已写回库 / 只改库内页面 时不得提醒', async (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  seed(store)

  const host = fakeHost()
  installTrigger(host, { currentReadonly: () => store }, { createNotice: async (text) => notice(text) })
  const { agent, injected } = fakeAgent([
    toolCall(1, 'read', { file_path: '.wiki\\index.md' }),
    toolCall(2, 'edit', { file_path: 'plugins\\x\\src\\a.ts' }),
    toolCall(3, 'wiki_capture', { title: 'x' }),
  ])
  await host.handlers.get('agent/turn-stopping')({ agent })
  assert.equal(injected.length, 0, '已写回则不再提醒')
})

test('A6 接线：KNJ_OBSIDIAN_TRIGGER=off 时 L1/L5 都不注入，且**一次都不检索**', async (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  seed(store)

  const saved = process.env.KNJ_OBSIDIAN_TRIGGER
  process.env.KNJ_OBSIDIAN_TRIGGER = 'off'
  t.after(() => {
    if (saved === undefined) delete process.env.KNJ_OBSIDIAN_TRIGGER
    else process.env.KNJ_OBSIDIAN_TRIGGER = saved
  })

  const host = fakeHost()
  // 取库这一步是「检索」的入口：计数即可断言「关掉开关 = 连库都不取」
  let providerCalls = 0
  installTrigger(host, { currentReadonly: () => { providerCalls += 1; return store } }, { createNotice: async (text, summary) => notice(text, summary) })
  const { agent, injected } = fakeAgent([
    userEvent(1, 'dsh 插件的 cron 时区问题'),
    toolCall(2, 'read', { file_path: '.wiki\\index.md' }),
    toolCall(3, 'edit', { file_path: 'plugins\\x\\src\\a.ts' }),
  ])
  await preStep(host, agent)
  await host.handlers.get('agent/turn-stopping')({ agent })
  assert.equal(injected.length, 0, '开关关闭时不得注入任何东西')
  assert.equal(providerCalls, 0, '开关关闭时不得检索（取库次数必须为 0）')
})

test('接线：provider 不可用 / 注入点抛错都不得打断主流程', async () => {
  const host = fakeHost()
  installTrigger(
    host,
    { currentReadonly: () => { throw new Error('vault 不可用') } },
    { createNotice: async () => { throw new Error('注入失败') } },
  )
  const { agent } = fakeAgent([userEvent(1, 'dsh 插件的 cron 时区问题')])
  const decision = await preStep(host, agent)
  assert.deepEqual(decision, { kind: 'ok' }, 'pre-step 必须原样返回 decision（触发层不阻断）')
})

// ---------------------------------------------------------------------------
// 对抗审查（2026-09-21）发现的四处缺陷，逐条钉死：
//  1) L5 回合边界：原来按「seq 水位线」折叠，进程重启后水位线是 -1 → 第一次
//     turn-stopping 把**整份历史**当一个回合，把几天前的读库+改码误报成本回合。
//  2) 一次语义：原来只在进程内的 WeakMap 里，重启/恢复会话即可再次注入。
//  3) 只读保证：currentVault() 曾经回退 provider.current()，那条路径会 ensure() 建 .wiki。
//  4) 安装健壮性：ctx.on 抛错会冒泡出插件 apply。
// ---------------------------------------------------------------------------

test('L5 回合边界：本回合只读了代码（上一回合才读过库+改过码）→ 必须静默', async (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  seed(store)

  const host = fakeHost()
  installTrigger(host, { currentReadonly: () => store }, { createNotice: async (text, summary) => notice(text, summary) })
  const { agent, injected } = fakeAgent([
    // 回合 1：读过库 + 改了代码（旧实现会在这里置位，且把这份历史带进回合 2）
    toolCall(1, 'read', { file_path: '.wiki\\index.md' }, 1),
    toolCall(2, 'edit', { file_path: 'plugins\\x\\src\\a.ts' }, 1),
    // 回合 2：只读了一个源码文件——本回合没有「用过库」
    userEvent(3, '继续'),
    toolCall(4, 'read', { file_path: 'plugins\\x\\src\\a.ts' }, 2),
  ])
  await host.handlers.get('agent/turn-stopping')({ agent })
  assert.equal(injected.length, 0, '上一回合的事实不得算进本回合（否则每个新回合都会误报）')
})

test('L5 一次语义可跨重启：日志里已有沉淀提醒 → 新装的实例不得再注入', async (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  seed(store)

  const host = fakeHost()
  installTrigger(host, { currentReadonly: () => store }, { createNotice: async (text, summary) => notice(text, summary) })
  const { agent, injected } = fakeAgent([
    toolCall(1, 'read', { file_path: '.wiki\\index.md' }, 1),
    toolCall(2, 'edit', { file_path: 'plugins\\x\\src\\a.ts' }, 1),
    injectedNoticeEvent(3, CAPTURE_SUMMARY), // 重启前那次提醒已经落盘
  ])
  await host.handlers.get('agent/turn-stopping')({ agent })
  assert.equal(injected.length, 0, '会话日志里已有提醒 → 重启后不得重复注入（WeakMap 会丢，日志不会）')
})

test('L1 一次语义可跨重启：日志里已有该任务的提示 → 同一任务不得再注入', async (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  seed(store)

  const host = fakeHost()
  installTrigger(host, { currentReadonly: () => store }, { createNotice: async (text, summary) => notice(text, summary) })
  const { agent, injected } = fakeAgent([
    userEvent(1, 'dsh 插件的 cron 时区问题'),
    injectedNoticeEvent(2, taskSummaryOf(1)),
  ])
  await preStep(host, agent)
  assert.equal(injected.length, 0, '同一任务（seq 1）在重启后不得重复注入')
})

test('只读保证：provider 缺 currentReadonly 时不得回退 current()（那条路径会建 .wiki）', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-obsidian-trigger-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = new VaultStore(dir)
  store.ensure() // 库本身存在；要断言的是「触发层不会再去建/改任何东西」

  let currentCalls = 0
  const host = fakeHost()
  installTrigger(
    host,
    { current: () => { currentCalls += 1; return store } },
    { createNotice: async (text, summary) => notice(text, summary) },
  )
  const { agent, injected } = fakeAgent([
    userEvent(1, 'dsh 插件的 cron 时区问题'),
    toolCall(2, 'read', { file_path: '.wiki\\index.md' }, 1),
    toolCall(3, 'edit', { file_path: 'plugins\\x\\src\\a.ts' }, 1),
  ])
  const decision = await preStep(host, agent)
  assert.equal(currentCalls, 0, '缺 currentReadonly 时必须静默，不得走会 ensure() 的写路径')
  assert.equal(injected.length, 0, '没有只读取库能力 → L1 不触发')
  // L5 不依赖库（只折叠事件），它照常工作——这里只再确认它也没碰写路径
  await host.handlers.get('agent/turn-stopping')({ agent })
  assert.equal(currentCalls, 0, 'L5 同样不得取写路径的库')
  assert.deepEqual(decision, { kind: 'ok' }, '仍不得阻断主流程')
})

test('安装健壮性：宿主 ctx.on 抛错时安装不冒泡，且另一条监听仍生效', async (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  seed(store)

  const handlers = new Map()
  const host = {
    on: (event, handler) => {
      if (event === 'agent/pre-step') throw new Error('宿主拒绝注册 pre-step')
      handlers.set(event, handler)
    },
  }
  assert.doesNotThrow(() => {
    installTrigger(host, { currentReadonly: () => store }, { createNotice: async (text, summary) => notice(text, summary) })
  }, '一条注册失败不得冒泡出插件的 apply（否则会打断后续链路）')

  const { agent, injected } = fakeAgent([
    toolCall(1, 'read', { file_path: '.wiki\\index.md' }, 1),
    toolCall(2, 'edit', { file_path: 'plugins\\x\\src\\a.ts' }, 1),
  ])
  await handlers.get('agent/turn-stopping')({ agent })
  assert.equal(injected.length, 1, 'pre-step 注册失败不应影响 turn-stopping 的正常工作')
})

test('子代理策略：KNJ_OBSIDIAN_TRIGGER_SUBAGENT=off 时仅顶层会话触发', async (t) => {
  const { dir, store } = makeVault()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  seed(store)

  const saved = process.env.KNJ_OBSIDIAN_TRIGGER_SUBAGENT
  t.after(() => {
    if (saved === undefined) delete process.env.KNJ_OBSIDIAN_TRIGGER_SUBAGENT
    else process.env.KNJ_OBSIDIAN_TRIGGER_SUBAGENT = saved
  })

  // 默认：子代理同样触发（提醒不阻断，且子代理也需要知识）
  assert.equal(subagentTriggerEnabled({}), true)
  assert.equal(delegationDepthOf({ header: { delegationDepth: 2 } }), 2)
  assert.equal(delegationDepthOf({}), 0)

  const host = fakeHost()
  installTrigger(host, { currentReadonly: () => store }, { createNotice: async (text, summary) => notice(text, summary) })
  const events = [userEvent(1, 'dsh 插件的 cron 时区问题')]

  const sub = fakeAgent(events, { delegationDepth: 1 })
  await preStep(host, sub.agent)
  assert.equal(sub.injected.length, 1, '默认策略下子代理也会被提醒')

  process.env.KNJ_OBSIDIAN_TRIGGER_SUBAGENT = 'off'
  const sub2 = fakeAgent([userEvent(2, 'dsh 插件的 cron 时区问题')], { delegationDepth: 1 })
  await preStep(host, sub2.agent)
  assert.equal(sub2.injected.length, 0, '开关关闭后子代理不再触发')

  const top = fakeAgent([userEvent(3, 'dsh 插件的 cron 时区问题')], { delegationDepth: 0 })
  await preStep(host, top.agent)
  assert.equal(top.injected.length, 1, '顶层会话不受子代理开关影响')
})

test('纯函数：currentTurnOf / turnToolCalls / injectedNotices 的边界', () => {
  assert.equal(currentTurnOf([]), null)
  assert.equal(currentTurnOf([userEvent(1, 'x')]), null, 'user/message 不带回合号')
  assert.equal(currentTurnOf([toolCall(1, 'read', {}, 3), userEvent(2, 'x')]), 3, '取最后一条带回合号的事件')
  assert.equal(currentTurnOf([toolCall(1, 'read', {}, 1), toolCall(2, 'read', {}, 2)]), 2, '取最后一个回合号')

  const calls = turnToolCalls([toolCall(1, 'read', {}, 1), toolCall(2, 'edit', {}, 2), userEvent(3, 'x')], 2)
  assert.equal(calls.length, 1, '只留本回合的 tool/call')
  assert.equal(calls[0].data.name, 'edit')

  const notices = injectedNotices([
    injectedNoticeEvent(1, CAPTURE_SUMMARY),
    injectedNoticeEvent(2, taskSummaryOf(7)),
    { type: 'user/message', seq: 3, data: { source: { kind: 'plugin', plugin: 'other-plugin', summary: '别的插件' } } },
    userEvent(4, '人说的话'),
  ])
  assert.deepEqual([...notices].sort(), [CAPTURE_SUMMARY, taskSummaryOf(7)].sort(), '只认本插件注入的提醒摘要')
})
