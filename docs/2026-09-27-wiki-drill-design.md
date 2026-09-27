# wiki_drill 功能详细设计（功能层 + 技术层）

- 日期：2026-09-27
- 状态：**终稿（已拍板）** —— Q1–Q6 全部由用户按推荐拍板，见 §12 已决项
- 目标版本：发布日取号（同日下一正式号）
- 上游需求：本次会话讨论（「优先使用 QMD 检索 → 跟进知识 ID → 找到知识文档 → 沿双链下钻」）+ 用户对「新增 wiki_drill」与「一跳随种子附带、更深 agent 迭代」的确认
- 相关真源：`docs/2026-09-13-qmd-integration-spec.md`（语义层 spec，第一优先级＝零行为变更）

---

## 〇、基线卡

| 项 | 内容 |
|---|---|
| **意图** | 知识库召回不可靠、且检索结果常常「有引用没读原文」——把检索改成「QMD 先召回 → 拿页面 id → 读文档 → 沿双链继续下钻」的可用链路 |
| **目标用户/角色** | ① 在会话里问知识库问题的 agent；② 编排知识采集/消费的开发者 |
| **已承诺能力** | 承诺1 语义（QMD）检索先行，作为主召回通道<br>承诺2 命中结果以**页面 id** 为锚，能定位到具体知识文档<br>承诺3 支持**沿 wikilink 双链继续下钻**<br>承诺4 不改动现有 `wiki_query` 的行为<br>承诺5 下钻形态＝**一跳随种子附带 + 更深由 agent 迭代** |
| **已定边界** | 不做一次性 N 跳子图展开；不改 `wiki_query` 默认；不改 `wiki_search_semantic` 既有契约；不引入新依赖；不做跨库检索；不做分块级命中聚合；不做别名/同义词层 |
| **约束** | 2026-09-13 spec 首条优先级「零行为变更 > 召回质量」；严格离线（云端查询扩展/精排钉死禁用）；检索路径**零写入**；降级必须如实回报、绝不抛错 |

---

## 一、知识输入清单

**直读的仓库文档**：`docs/2026-09-13-qmd-integration-spec.md`（语义层真源：零行为变更、降级六态、零写入、禁用 `store.search()`）、`docs/plans/2026-09-22-skill-provider-registration.md`（同仓设计记录文体）。

**知识库（iobs_pro/.wiki）**：

| 页面 | 用到的结论 |
|---|---|
| `references/semantic-recall-paraphrase-weakness`（core） | 实测：改写式提问下 QMD 拉不到真正相关页，而索引完好（14 文档/43 分块/ready）；成因＝长页多主题稀释嵌入 + 改写使 BM25 静默失效；结论：**排序不可信，必须融合词面**，并建议「分块级命中聚合 / 别名层」作为独立路线 |
| `projects/obsidian-plugin-improvement-plan`（core） | 语义层已接线（词面候选 <2 时调一次）、L1/L5 触发层已完成；仍搁置项含「合成前强制读整页 + wiki_read」——本设计的 D8 正是把它捞回来；「页面原子化是检索质量前提」 |
| `projects/wiki-retrieval-trigger-layer`（core） | 基线 415 会话里 `wiki_query` 仅 17 次、其中 12 次是同一个失败的多词查询；两个成功消费案例都**没用** `wiki_query`（读 index + 直接 read 页面）；其判定标准「命中率低时瓶颈在查询语义，不在触发」；并记录测量口径三个坑（只统计 `tool/result`、`arguments` 需 `JSON.parse`、大会话会被静默跳过） |
| `references/dsh-plugin-add-hang` | 安装/复现口径（`pnpm add --offline`、stdin 断空）——用于本设计的发布步骤 |

**知识缺口（如实标注）**：① **下钻在真实问答里的收益尚无生产观测**，目前只有图论推算 + cron 案例复演；② miss 日志（`<DSH_HOME>/knj-obsidian/query-misses.jsonl`）的真实语料未读，评测化回放待语料齐备后进行。

**图数据实测（本次自测，用于 D2）**：iobs_pro 库 27 页；出链均 1.9、中位 2、最大 6；入链均 2.7、最大 9；**两跳展开覆盖 11–16 页 ≈ 全库 40%–60%**；历史失败案例中，QMD 返回的 `wiki-retrieval-trigger-layer` 有出链直达真正相关的 `dsh-plugin-dev-pitfalls`（入链来源实测确认）。

---

## 二、代码现实卡（直读源码，含证据）

| 关注点 | 现状 | 证据 |
|---|---|---|
| 融合缝 | `retrieve(store, query, {mode, maxCandidates, semanticHits})` → `{candidates, strategy, totalPages}`；融合次序 `front→body→summary→graph→semantic`，首次出现者胜 | `src/retriever.ts:139,246-252` |
| 成本护栏 | `if (!hasSemantic && guardTriggered) return …`（有语义命中时强制下探正文）；`retriever.test.mjs` 断言 `strategy==='title+tag'`「标题命中后不应再查正文」 | `src/retriever.ts:208-214`；`retriever.test.mjs:99` |
| 打分口径 | `scoreOf = (base + min(度×0.1, 2)) × TIER_WEIGHT`；`degreeMap` = 出链+入链（同页重复指向只计一次） | `src/retriever.ts:303,311-321` |
| 出链助手 | `linkedPages(store, id, category)` **只给出链** | `src/retriever.ts`（linkedPages 定义） |
| 反链现状 | 入链在 `lint.ts:121-146` 与 `graph-engine.ts:33-50` **各自内部**算过，无可复用导出 | 同上 |
| 全图 | `buildGraph(store)` → `{nodes, edges(source/target/broken), orphanIds, pageCount}`；`WIKILINK_RE` 与 retriever/lint 一致 | `src/graph-engine.ts:25-71` |
| QMD 命中整形 | `shapeSearchResults`：`displayPath→path→filepath→file`，剥 `qmd://<collection>/`；**`docid` 是内容哈希，绝不当 id** | `src/semantic-index.ts:62-71,127` |
| RRF | `fuseRanked(channels, limit)`，`RRF_K=60`，同页去重 | `src/semantic-index.ts:215-238` |
| 语义运行时 | `createSemanticRuntime({vaultRoot})` → `{store, status, modelPresent}`；`runOfflineSearch(store, query, limit)` → `{results, degraded?, channels}`；**按库缓存** | `src/semantic-index.ts:240-269`；`src/tools.ts:165-172` |
| 状态机与文案 | `classifyStatus` → `ready/index-empty/index-stale/model-missing/library-missing`；`notReadyMessage` 给可执行提示 | `src/semantic-index.ts:152-194` |
| `wiki_query` 现状 | 词面先跑 → `index-only` 或词面候选 ≥ `SEMANTIC_FALLBACK_MIN_CANDIDATES=2` 直接返回 → 否则语义兜底一次并融合 | `src/tools.ts:147-148,781-801` |
| `wiki_search_semantic` | 独立工具；`runOfflineSearch` + 状态分支（model-missing / library-missing / index-empty） | `src/tools.ts:1137-1210` |
| 环境开关 | `KNJ_OBSIDIAN_SEMANTIC_FALLBACK` / `AUTO_REFRESH` / `TRIGGER` / `TRIGGER_SUBAGENT` | `src/tools.ts:172` 等 |
| 整页读取 | **不存在** `wiki_read` 类工具（agent 用内置 read 读 `.wiki/<分类>/<id>.md`） | 工具清单（11 个 `wiki_*`） |
| 词汇 | `WikiCategory` / `WikiTier` / `Confidence` / `WikiPage`；`matchedBy` 既有取值 `index/title/tag/summary/body/graph/semantic` | `src/types.ts:10-20`；`src/retriever.ts` |
| 测试契约面 | `retriever.test.mjs` 18 例、`scored-retrieval.test.mjs` 19 例、`semantic.test.mjs` 8 例、`semantic-index.test.mjs` 16 例、`miss-log.test.mjs` 6 例、`wiki-query-tool.test.mjs` 3 例、`tools.test.mjs` 27 例；全量 383 例 | `node --test "*.test.mjs"` |

---

## 功能层

### 1. 目标与范围

**背景**：库在被大量喂养却很少被消费（基线 415 会话：改库触碰 1719 次 vs `wiki_query` 17 次，其中 12 次是同一个查不到的多词查询）。语义层虽就绪，却只在词面几乎无果时兜底触发；命中后也没有「顺链继续找」的路径，更没有整页读取的工具。

**目标（可观察）**：一次「问知识库」的会话里，agent 用一个工具即可拿到 ① 语义+词面融合排好序的**种子页** ② 每种子的**一跳双链邻居**（带方向、断链标记） ③ 以页 id 反复下钻的入口；并**能打开整页正文**。

**做**：模式 A（query 入口）、模式 B（page 入口）、配套 `wiki_read`、SKILL/README 同步、新开关 `KNJ_OBSIDIAN_DRILL`、miss-log 记下钻空结果。

**不做**：一次性 N 跳子图；改 `wiki_query` 默认；跨库检索；分块级命中聚合；别名/同义词层；UI 图谱与边栏搜索改动（本轮）；新依赖。

**延后**：miss-log 回放评测脚本（等语料齐备）；共享邻接索引（库规模变大后）。

### 2. 用户故事与角色

- 作为 **agent**，我希望「问一句自然语言就能拿到排好序的页面 + 它们的双链邻居」，以便不必先猜关键词、也不会因排序不完美而彻底错过真正相关的那页（延伸自承诺1/2/3）。
- 作为 **agent**，我希望「用一个页 id 就能问『这页链到谁、谁链到它』」，以便一跳一跳读摘要、决定下一页读哪（延伸自承诺3/5）。
- 作为 **agent**，我希望「把命中页整页读进来」，以便引用有出处而不是凭摘要编（延伸自承诺2；本设计新增）。
- 作为 **开发者**，我希望「老工具行为一点没变，且能一键关掉新链路」，以便出问题立刻退回现状（延伸自承诺4）。

### 3. 流程与交互

**主流程（模式 A：query）**

1. agent 调 `wiki_drill({ query: '<自然语言或关键词>' })`
2. 并行取两路证据：词面 `retrieve()`（既有分层，原样调用）+ QMD 离线双通道（`runOfflineSearch`，向量 + BM25 本地 RRF）
3. 两路**按名次 RRF 融合**（RRF_K=60）成种子列表，各带来源标记；再按 `度×tier` 权重排序
4. 对每个种子取**一跳邻接**（出链 + 入链；去自环、剔除库外与幽灵、标断链与方向），按 `度×tier` 排序后取前 N（默认 8）
5. 返回：`seeds[]`（id/分类/标题/tier/confidence/来源/分数/摘要片段 + 各自 `neighbors[]`）+ `strategy` + 索引状态与降级说明 + 截断标注
6. agent 读返回 → 下一页：`wiki_read({ id })` 读整页，或 `wiki_drill({ page: '<id>' })` 继续下钻

**分支流程**

- **索引 stale / 未就绪** → 结果照给，`message` 如实说明「基于旧索引，可能漏新页」并给可执行动作；词面通道不受影响
- **QMD 不可用（库缺失/模型缺失）** → 种子退化为纯词面，`strategy` 与 `message` 如实标注；不抛错、不联网、不自动下载
- **模式 B 的 page id 不存在** → 结构化空结果 + 提示「先用 `wiki_query` 或模式 A 找 id」；**不做模糊匹配去猜**
- **邻居为空** → 明确写「该页无库内双链（可能是孤儿页）」，不静默返回空数组
- **开关关闭** → 工具仍注册，立即返回「已由 `KNJ_OBSIDIAN_DRILL=off` 关闭」

**界面/接口结构**：新增 `wiki_drill`、`wiki_read`；`wiki_query` 与 `wiki_search_semantic` 一字不改；SKILL.md / retrieval-guide.md / README 增加使用引导。

### 4. 状态与边界情况

| 情形 | 用户会看到什么 |
|---|---|
| 查询为空串 | 「查询为空」明确提示，不返回候选（与 `retrieve` 的 `empty-query` 口径一致） |
| 库为空（0 页） | 「库里还没有知识页」+ 指向 `wiki_init` / `wiki_ingest` 的动作提示 |
| 语义索引为空 | 种子仅来自词面，说明「语义索引为空，先更新索引」并给出入口名称 |
| 模型缺失 | 同上，附「模型文件应放 `<modelsDir>\<文件名>`，插件不自动下载」（复用 `notReadyMessage`） |
| 索引陈旧 | 结果照给 + 标注「基于旧索引」+ 更新指引；**明确告知可能漏掉最近新增的页** |
| 种子数超过 limit | 截断 + 标注「已截断（共 N 条种子）」 |
| 邻居过多 | 每种子按度×tier 取前 N + 标注「该页还有 M 个邻居未列出」 |
| 邻居指向已删页 | 以 `broken: true` 列出（双链体检价值），不计入可读候选 |
| id 跨分类同名 | 返回 `category` 供调用方消歧（库内 id 唯一性假设不变） |
| 检索路径写入 | **不允许**：全过程零写入，测试锁死（含 mtime 不变断言） |
| 新开关关闭 | 明确文案，不静默 |

### 5. 数据与兼容影响

- **不新增 vault 数据字段**：不改 frontmatter、不改 `index.md`、不写 manifest、不动 QMD 索引结构。
- `wiki_query` / `wiki_search_semantic` 的入参、出参、`strategy` 与 `matchedBy` 取值集合**全部不变**（老调用方零感知）。
- 新增 `matchedBy` 取值 `graph-neighbor` **只出现在新工具输出**中，与既有 `graph`（L4 一跳出链）区分。

### 6. 验收标准

- **给定**一次 cron 时区类改写提问（库内无共享字面词），**当**调用模式 A，**则**种子或其**某个种子的一跳邻居**包含 `dsh-plugin-dev-pitfalls`，且该邻居标注来源种子与方向（历史失败案例复演）。
- **给定**任一页 id，**当**调用模式 B，**则**返回其出链与入链邻居（各带 `direction`、断链标 `broken: true`），且**不触发嵌入**（毫秒级）。
- **给定**语义索引 stale，**当**调用模式 A，**则**结果照常返回且 `message` 含「基于旧索引」与更新指引（不得静默）。
- **给定**模型缺失，**当**调用模式 A，**则**种子退化为纯词面、`strategy` 如实标注、不抛错、不联网。
- **给定**库中存在 `[[不存在的页]]`，**当**调用模式 B，**则**该邻居以 `broken: true` 出现且不计入可读候选。
- **给定** `wiki_query` 既有全部用例，**当**本次改动落地，**则**其结果与改动前逐字节一致。
- **给定**任意一次模式 A/B 调用，**当**调用结束，**则** vault 内容与 mtime 零变化。
- **给定** `wiki_read({id})`，**当**该页存在，**则**返回整页正文 + frontmatter 摘要 + 出链/入链清单（Q6 已决）。
- **给定**下钻零结果，**当**调用结束，**则** miss 日志追加一条（Q4 已决）。

---

## 技术层

### 7. Context

- **缺口**：语义层只做兜底；图谱只有「词面正文命中页」的一跳出链；无以页为中心的邻接查询；无整页读取。
- **可依托**：`retrieve()`（纯函数、有 18+19 例测试）、`runOfflineSearch` + 按库缓存的 `createSemanticRuntime`、`shapeSearchResults`（id 整形已完成）、`fuseRanked`（RRF）、`buildGraph`（出入链 + 断链）、`scoreOf`/`degreeMap`（度×tier 口径）、`classifyStatus`/`notReadyMessage`、`defineTool` 注册形态。
- **必须绕开**：`store.search()`（会拉起云端查询扩展/精排，违反严格离线）；`docid`（内容哈希）；L2 短路护栏语义（模式 A 自行决定下探）。
- **规范冲突（显式列出）**：`docs/2026-09-13-qmd-integration-spec.md` 的 IN 段落曾设想「`retriever.ts` 改为并行 + RRF 融合，必须打破 L2 短路」；实际落地走的是「词面优先 + 阈值兜底」（由改进施工图记录为已完成）。本设计**不重开**该决策：新工具自带融合层，`retriever.ts` 的分层语义与短路护栏保持原样。

### 8. Goals / Non-Goals

**Goals**：① 语义为主的种子召回 + 词面融合的稳定排序；② 以页为锚的一跳邻接（出入链、断链、方向）；③ 整页读取；④ 降级路径如实回报且零写入；⑤ 既有工具行为逐字节不变。

**Non-Goals**：分块级命中聚合；别名/同义词层；跨库检索；下钻结果自动写回库；UI 图谱与边栏搜索改动（本轮）；离线包与发布渠道改动；新依赖。

### 9. Decisions

**D1 · 新增 `wiki_drill` + `wiki_read`，`wiki_query` 一字不改**
- 方案：新工具承载新语义，老工具零改动。
- 为什么：`retriever.test.mjs`(18)+`scored-retrieval.test.mjs`(19)+`tools.test.mjs`(27)+`wiki-query-tool.test.mjs`(3) 锁着词面优先语义与打分公式；2026-09-13 spec 首条优先级是零行为变更。
- 备选与不选：给 `wiki_query` 加 `mode='semantic-first'` —— 同一工具两种语义会让 SKILL/触发层文案与调用方判断复杂化，且默认值一漂移就踩老契约。
- 影响：功能层 §3；新增 `src/drill.ts` 与两个工具注册。

**D2 · 下钻深度：一跳随种子附带（模式 A 内联）+ 更深由 agent 迭代（模式 B）；不做一次性多跳**
- 方案：模式 A 只带一跳；模式 B 每次一跳，由 agent 反复调用。
- 为什么：实测 27 页库中**两跳覆盖 11–16 页 ≈ 全库 40%–60%** ⇒ 一次性两跳＝把半个库倒进上下文；一跳双链是各页人工维护的「相关」区，精度高。
- 备选与不选：`depth=2` 一次返回 —— 噪声与 token 成本随库增长恶化，枢纽页（入链 9 的 `dsh-plugin-dev-pitfalls`）会放大爆炸。
- 影响：功能层 §3、§4 截断文案；工具 description 首句必须写明「一跳；更深用 page 模式迭代」。

**D3 · 邻接来源：复用 `buildGraph(store)`，不新写第三份入链实现**
- 方案：模式 A/B 的邻接与度数都由 `buildGraph` 推导。
- 为什么：`lint.ts` 与 `graph-engine.ts` 已各算过入链（同一事实两个 owner）；`buildGraph` 另给 `broken` 标记。
- 备选与不选：新增 `backlinksOf(store,id)` 扫全库 —— 不选，等于造第三份实现；库规模变大后再抽共享邻接索引（延后项）。
- 影响：`src/drill.ts` 依赖 `graph-engine`；成本风险见 §10。

**D4 · 种子融合：名次级 RRF（两路各贡献 1/(60+rank)），再乘 `度×tier` 权重**
- 方案：词面与语义两路先各自排序，再 RRF 融合，最后套既有质量口径。
- 为什么：与 QMD 内部融合口径一致（`fuseRanked` 已是 RRF_K=60）；排名级融合不需要对齐两种分量纲；复用既有「度×tier」避免第二套打分。
- 备选与不选：加权和（0.7×语义+0.3×词面）—— 权重是魔法数且分数量纲不可比；纯语义排序 —— 违背知识库实测（改写提问下语义排序不可信）。
- 影响：功能层 §6 首条验收；融合函数导出以便单测。

**D5 · 输出形态：`seeds[]` 与邻居分区块；邻居用 `matchedBy='graph-neighbor'` + `via` + `direction`**
- 方案：种子与邻居不混在一个数组；邻居带来源种子与方向。
- 为什么：「直接命中」与「走链到达」是两种证据强度，平铺会让调用方与模型误判（同类错误见知识库页对「摘要层冒充正文层」的警告）。
- 备选与不选：平铺并复用 `matchedBy='graph'` —— 会让新工具的一跳与老工具 L4 在日志里无法区分。
- 影响：schema；功能层 §4。

**D6 · 索引 stale / 未就绪：结果照给 + 如实标注 + 可执行指引；绝不静默、绝不报错**
- 方案：`strategy` 与 `message` 承载降级事实。
- 为什么：与 `notReadyMessage`、miss-log 的诚实口径一致；静默降级正是「检索无用」印象的来源。
- 备选与不选：stale 时拒绝返回 —— 会让 agent 在索引更新前完全失去检索；自动重建索引 —— 违反检索路径零写入。
- 影响：功能层 §4、§6。

**D7 · 新开关 `KNJ_OBSIDIAN_DRILL=off`**
- 方案：独立开关，`off` 时工具仍在但立即返回关闭文案。
- 为什么：沿用 `KNJ_OBSIDIAN_*` 家族；出问题可一键退回现状。
- 备选与不选：复用 `SEMANTIC_FALLBACK` 开关 —— 两个独立能力共用一个开关，会让「只要语义兜底」的用户被迫放弃下钻。
- 影响：功能层 §4 末行；测试加开关行为断言。

**D8 · `wiki_read` 同批交付**
- 方案：与 `wiki_drill` 同期实现/发版。
- 为什么：承诺2 的落地动作就是读整页；缺它则下钻只能看片段，正是「有引用格式、没读原文」的伪知识来源。
- 备选与不选：分两步先只做 `wiki_drill` —— 同一条流水线拆开，用户先用半条链路、收益测不出来。
- 影响：新增工具与测试；README 工具表。

**D9 · 已拍板的参数与取值范围（Q1–Q6）**
- Q1 种子数 `limit` 默认 **5**（上限 10）；每种子邻居默认 **8**（上限 20）。理由：27 页库够用且上下文可控；上限避免被大库撑爆。
- Q2 **不提供纯语义入口**。理由：知识库实测语义排序不可信，单开纯语义通道等于把已知会骗人的排序暴露给调用方；如确需可临时用 `wiki_search_semantic`。
- Q3 **本轮不接边栏搜索端点**。理由：工具先跑通；边栏是另一条契约面（`routes.ts` 有自己的一致性测试），同批改会扩大回归面。
- Q4 **miss 日志记录下钻空结果**（模式 A 零种子、模式 B 的空邻居不计入）。理由：下钻零结果同样是「查询语义瓶颈」的证据（沿用 `miss-log.ts` 契约：落插件状态目录、上限 2000、写失败静默）。
- Q5 设计文档落盘 **`docs/2026-09-27-wiki-drill-design.md`**（本文件）。
- Q6 `wiki_read` 输出 **整页正文 + frontmatter 摘要 + 出链/入链清单**。理由：一次给全，便于继续下钻；出链/入链清单也顺带暴露断链。

### 10. Risks / Trade-offs

| 风险 | 缓解 / 接受理由 |
|---|---|
| `buildGraph` 每次扫全库正文 → 库大时变慢 | 现库 27 页毫秒级；测试加「`readPage` 调用次数上界」的成本断言防回归；库规模上去后抽共享邻接索引（延后项） |
| 语义种子排序本身不可信 | D4 用 RRF 融合词面 + 度×tier；一跳邻居作为召回补偿；验收绑 cron 复演 |
| 模型加载成本被高频调用放大 | 复用按库缓存运行时；模式 B 零嵌入；模式 A 单次查询只付一次推理 |
| 文档与代码漂移（SKILL/README 说 A、代码做 B） | 文档改动进同一提交；新增测试断言 SKILL.md 含 `wiki_drill`/`wiki_read`（照 `wiki-query-skill.test.mjs` 既有做法） |
| 后人「顺手」加多跳 | D2 的实测数字写进代码注释与 SKILL.md；测试锁「模式 A 邻居只含一跳」 |
| 邻居截断切掉关键页 | 截断按度×tier 排序并标注「还有 M 个未列出」，让 agent 知道可继续下钻 |
| 新工具与 L4 语义混淆 | D5 用独立 `matchedBy` 取值 + `via`/`direction` 字段区分 |

### 11. Migration Plan

不涉及数据迁移（零新增字段、零写入、QMD 索引结构不变、`index.sqlite` 无需重建）。回滚：`KNJ_OBSIDIAN_DRILL=off`；或降级 tgz（`.271` / `.273` 均为干净回滚点，`.270`/`.272` 含死代码残渣不推荐）。

### 12. Open Questions

**已决（用户 2026-09-27 拍板「按推荐」）**：Q1 种子 5/邻居 8；Q2 不提供纯语义入口；Q3 本轮不接边栏；Q4 miss 日志记下钻空结果；Q5 落盘 `docs/2026-09-27-wiki-drill-design.md`；Q6 `wiki_read` 给整页 + 摘要 + 出入链清单。详见 D9。

**仍待确认（不阻塞开工，实现中遇到再定）**：无。

---

## 改动清单（实现时对齐）

| 文件 | 改动 |
|---|---|
| `src/drill.ts` | 新增：邻接推导（复用 `buildGraph`）、种子 RRF 融合、`graph-neighbor` 候选构造、截断与标注 |
| `src/tools.ts` | 注册 `wiki_drill`、`wiki_read`；新开关读取；miss 日志接入下钻空结果 |
| `src/retriever.ts` | **实现后订正：无需改动**。原计划「仅导出 `scoreOf`/`degreeMap`」，实际 `drill.ts` 直接复用已导出的 `TIER_WEIGHT` 并用 `buildGraph` 自建邻接与度数——比改 `retriever.ts` 更小的侵入面，且同样避免第二套打分口径 |
| `wiki-query/SKILL.md` | 增补 `wiki_drill` / `wiki_read` 的使用引导（含「一跳 + 迭代」口径） |
| `wiki-query/references/retrieval-guide.md` | fallback 流程补一条「命中后沿双链下钻」的等价手工做法 |
| `README.md` | 工具表与检索章节补两个工具 |
| `wiki-drill.test.mjs`（新增） | 见下 |

## 测试清单（red-green 落地顺序）

1. 模式 A：假语义后端注入 → 断言种子含语义命中、`strategy` 标注、RRF 融合次序正确；
2. 模式 A：**一跳邻居只含一跳**（不得出现两跳页）；
3. 模式 A：stale / model-missing / index-empty 三态 → 结果与 `message` 如实；
4. 模式 B：出入链方向、`broken: true`、孤儿页文案、未知 id 的结构化空结果；
5. 零写入：调用前后 vault 内容与 mtime 零变化 + `readPage` 调用次数上界；
6. `KNJ_OBSIDIAN_DRILL=off` → 关闭文案；
7. `wiki_read`：整页 + 摘要 + 出入链清单；未知 id 的空结果；
8. 回归：`wiki_query` / `wiki_search_semantic` 既有用例逐字节不变；
9. 文档断言：SKILL.md 含 `wiki_drill` 与 `wiki_read`；
10. 全量回归：`node --test "*.test.mjs"` 全绿。**实测基线：加本文件前 398 例（设计初稿写的 383 是加 `wiki-drill.test.mjs` 之前的旧数）；落地后 404 例全绿**（15 例 lib 层 + 6 例工具层）。
