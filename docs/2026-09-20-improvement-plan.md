# dsh-knj-obsidian 改进方案（基线：v2026.9.152）

> 基于实际安装版 `~/.dsh/profiles/web/node_modules/dsh-knj-obsidian`（2026.9.152）逐模块审计后定稿。
> 此前以 2026.9.73 为基线的评审结论中，以下各项**已在该版本实现，无需再做**：
> 检索打分排序（MATCH_SCORE + tier 权重 + 度加权）、indexOnly 全 7 分类、writePage/saveRawPage 原子写、
> capture 跨源避让、ingest 同源复用/异源加后缀、进程内语义层（wiki_search_semantic + semantic-refresh，
> 严格离线、单飞刷新、索引 staleness 报告）、related-check、还原点（checkpoint）、标签词表审计。

## P0 — 检索闭环（当前最大缺口）

### 1. 词面层仍是整串子串匹配
- **问题**：`retriever.ts` 将整个 query 小写后作为一个子串做 `includes`/`indexOf`。"数字人 SOP 流程"这类多词自然语言查询在词面层依旧 0 命中。语义层存在，但见第 2 条——没接上，所以多词查询当前实际表现为"wiki 无匹配"。
- **方案**：query 按空白/标点拆词；任一词命中即产生候选，分数按"命中词数占比"加权（全部词命中 = 现有基础分，部分命中打折）。保持单层语义不变，改动集中在 `frontMatch` 与正文扫描两处。
- **成本**：低。

### 2. 语义融合管道已建成但未接线（最高性价比）
- **问题**：`retrieveWithSemantic()`（semantic.ts）实现了完整的"词面 + 语义"融合，`retrieve()` 也已支持 `semanticHits` 入参与 `matchedBy:'semantic'` 融合去重——但**全源码 0 个调用方**。`wiki_query` 工具（tools.ts）与 HTTP 搜索端点（routes.ts）都只调同步的 `retrieve()`，语义层只能靠 agent 手动另调 `wiki_search_semantic` 且自行合并，实际几乎不会发生。
- **方案**：`wiki_query.execute` 改走 `retrieveWithSemantic`：词面候选为空（或 < 2 条）时才创建语义运行时（运行时创建有开销，冷启动 ~1.5 分钟首次；用 `refresherFor` 同款按库缓存复用），语义命中标记 `matchedBy:'semantic'` 自动排入融合序列。`routes.ts` 搜索端点同样处理。
- **依赖**：无（管道现成）；与第 1 条同 PR 收益最大。
- **成本**：低-中。

### 3. 候选不透传 source + 合成协议未强制整页阅读
- **问题**：`RetrievalCandidate` 没有 `source` 字段（frontmatter 里有数据但检索层丢弃）；`wiki-query/SKILL.md` 的回答结构是"结论 + 支持页 + 每条引用的 snippet"——agent 可以只对 200 字片段作答，"页面 → source → 原始出处"的溯源链在检索协议层断裂，这是对 RAG 化退化的最后防线。
- **方案**：① retriever 候选增加 `source` 字段（`readPage` 已返回该数据）；② SKILL.md 合成段加硬性要求："作答前必须完整阅读候选页正文，snippet 仅用于定位；引用需含页面路径与 source"。
- **成本**：低。

## P1 — 正确性与一致性

### 4. 前置层护栏仍压制正文层
- **问题**：`retrieve()` 中 title/tag 命中即触发护栏、跳过全部正文扫描（`guardTriggered` 分支）。打分排序解决的是"命中结果的排序"，没解决"弱标题命中淹没强正文命中"——A 页标题含查询词、B 页正文深度讨论查询词时，B 永远不出现。
- **方案**：护栏改为条件触发——front 命中数 < 阈值（建议 3）时仍下探正文；或对未被 front 命中的页面补一次正文扫描（成本护栏的本意是省正文扫描，全页已因 mtime 缓存在内存中，实测成本很低）。
- **成本**：低（可与 1、2 同 PR）。

### 5. saveRawPage 对多行 tags 仍静默降级
- **问题**：152 中仍未见多行 YAML tags 的检测与提示，用户在源码态保存多行 tags 数组会被静默丢弃。
- **方案**：保存前检测多行数组结构，明确拒绝并提示改写为单行简写。
- **成本**：低。

### 6. skill 与工具通道语义对齐
- **问题**：`wiki-query/SKILL.md` 的 L2/L3 描述与 retriever 实际行为存在漂移（skill 侧是 grep 全文匹配，工具侧是分层+护栏）。
- **方案**：随第 3 条改 SKILL.md 时一并核对，确保两个通道对同一查询的语义描述一致。
- **成本**：低。

## P2 — 知识质量机制

### 7. 页面级 staleness 追踪
- **问题**：语义索引有 staleness（needsEmbedding 计数 + index-stale 状态），代码采集页有 mine 的 hash 对账（new/changed/deleted），但普通页面（source 指向文档/URL）没有新鲜度追踪——源材料变了页面不会变。
- **方案**：manifest 已存 contentHash；反查源（本地路径可 stat，URL 可 HEAD）变化即标记页面 stale，lint 报告呈现。
- **成本**：中。

### 8. query 未命中沉淀为知识缺口
- **问题**：无匹配时 render 只给一句"可以说把 XX 吸收进 wiki"，说完即丢。
- **方案**：miss 查询追加写入 `_system/query-misses.json`，定期蒸馏成知识缺口清单。
- **成本**：低。

### 9. 每 vault 生成 SCHEMA.md
- **问题**：编译纪律（confidence 判定、页面结构、标签规范）仍硬编码在 skill 与 taxonomy.base.md 中，不随 vault 走；wiki-init 未生成库级"宪法"。
- **方案**：wiki-init 脚手架生成 `_meta/SCHEMA.md`，wiki-collect / wiki-distill 执行前先读。
- **成本**：低-中。

## P3 — 体验加分

### 10. 孤儿页链接推荐
- lint 报孤儿时，用 related-check 同款词汇重叠逻辑推荐"应链向哪几页"，降低修复成本。

### 11. 变更叙事记录
- 页面只有 updated 时间戳；建议 ingest/capture 时在 `_system/changelog.md` 追加一行变更说明，保留"为什么改"。

### 12. index-only 模式与语义层的关系说明
- `mode:'index-only'` 直接短路、忽略 semanticHits——若这是有意保持"零依赖快速通道"，在工具描述里写明"index-only 不含语义层"；若无意，让融合对其生效。

## 建议节奏

1. **一个下午**：#2 接通融合 + #3 source 透传 + SKILL.md 合成协议（都集中在 tools.ts / retriever.ts 出口，是同一刀）
2. **半天**：#1 分词 + #4 护栏条件化（retriever 内部，配差分测试）
3. **半天**：#5 + #6
4. **一个迭代**：#7 staleness + #8 知识缺口 + #9 SCHEMA.md
5. **之后**：P3 顺排
