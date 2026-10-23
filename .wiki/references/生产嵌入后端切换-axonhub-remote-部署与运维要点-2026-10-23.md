---
id: 生产嵌入后端切换-axonhub-remote-部署与运维要点-2026-10-23
title: 生产嵌入后端切换 axonhub（remote）部署与运维要点（2026-10-23）
category: references
tags: [deployment, embedding, operations, axonhub]
summary: 2026-10-23 起 knj 生产嵌入后端切为 axonhub remote（v15）并完成验收；本页记录运维要点（配置持久化位置、LAN 改配置 ops 形状、换模型重建、密钥来源、回滚）。
tier: supporting
source: agent:capture
confidence: inferred
created: 2026-10-23T07:46:41.939Z
updated: 2026-10-23T07:46:41.939Z
---

## 结论

2026-10-23 15:40 起，dsh-knj-obsidian 生产嵌入后端切换为 axonhub remote（v15），验收全链路通过：semantic-update 459ms 完成 1 文档嵌入（含真实 axonhub HTTP 往返）；wiki_search_semantic / wiki_drill 对改写式提问命中排障页；宿主进程 maps 中 llama 映射数为 0——段错误引爆物（进程内 GGUF 推理）物理消失，NRestarts 从当日 13 次归零起算。

## 运维要点

- 生产配置持久化于 profile patch 条目 user 层：semantic.embed=remote / embedUrl=http://100.93.42.43:8090/v1 / embedModel=baai/bge-m3 / embedKey（明文，与 dsh-self-improved 同款模式）；重启幸存。
- LAN 改配置：POST /api/obsidian-wiki/config，ops 形状 {"op":"set","path":["semantic","embedKey"],"value":…}（段数组 + 必带 op:'set'，漏 op 被当空写；expectedRevision 冲突 409）。
- 换嵌入模型 = 维度变化 = 全量重建索引（边栏「更新索引」或 POST /semantic-update），此后不可随意更换。
- axonhub 密钥来源：dsh-self-improved 的 patch 条目 config.recall.embedding.apiKey（明文存于同文件）。
- 回滚：设置卡片 embed 切回 local（需本地模型与 qmd 在位）或整体降级 p6 包。

## 相关

排障全记录见 references/knj-设置面板与远程嵌入-三层可见性排障全记录-2026-10-23；段错误技术细节见仓库 docs/2026-10-23-dsh-web-segfault-embed-handoff.md。
