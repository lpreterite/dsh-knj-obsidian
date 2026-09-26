# 计划：把包内 5 个 skill 注册进宿主 skill registry

- 日期：2026-09-22
- 状态：**已实施**（源码 + 测试 + 本地 tgz 完成；安装 / 重启 / 端到端验收 / 删副本 / 发布均待做，见 §8）
- 目标版本：`2026.9.220`（发布日取号）

## 1. 问题（实测证据）

本插件随包分发 5 个 skill（`wiki-collect` / `wiki-mine` / `wiki-distill` / `wiki-init` / `wiki-query`，均在包根各自目录下），
但它们在模型的 skill catalog 里**不存在**：

- 2026-09-22 实测：`skill wiki-collect` → `unknown or no longer available`；`skill modlens` 同样（另一插件的同类问题）。
- 全包 grep：无任何 `ctx.skills.registerProvider` / `@deepseek-ai/dsh-skill-filesystem` 挂载代码；只有 `client/KnowledgeDistillLauncher.tsx`
  的文案「请使用内置 wiki-collect skill」，并把规则**内联**进触发指令。

**根因**：DSH 的 filesystem skill provider 只扫 5 个根
（`<项目根>/.dsh/skills`、`<项目根>/.agents/skills`、customSkillDirs、`~/.dsh/skills`、`~/.agents/skills`），
且**明确不发现嵌套的 `**/SKILL.md`**（上游 README 原文：「nested `**/SKILL.md` files are deliberately not discovered」）。
包内 skill 既不在这 5 个根下，插件又没注册 provider，于是永远不可见。

**影响面**：所有安装该插件的用户（npm 已发布 `2026.9.201`），不只本机。功能"能跑"只是因为边栏把规则抄进了提示词，
skill 本体（含 wiki_mine → 蒸馏 → 入库的完整流程约束）对模型不可见。

**已做的本机临时缓解（2026-09-22）**：把 4 个 bundle 复制到 `~/.dsh/skills/`，跳过 `wiki-query`（用户根与 `~/.agents/skills`
都已有同名且内容不同的副本）。catalog 已即时刷新，`skill wiki-collect` 可加载，Base directory 指向 `~/.dsh/skills/wiki-collect`。

> ⚠️ 本次修复发布后**必须删除**这 4 个用户根副本：`~/.dsh/skills` 是 rank 400，包内注册是 rank 600，
> 用户根副本会一直赢——不删副本，等于没修。

## 2. 目标与非目标

**目标**：任意装了本插件的 profile，5 个 skill 无需任何手工拷贝即出现在模型 catalog（且随包版本更新自动生效）。

**非目标**：不改 skill 正文语义；不动边栏启动器与触发文案；不新增 peer 依赖；不做 GUI 端的 skill 启停面板。

## 3. 方案（选定：自实现 provider，照 `dsh-design-skills` 模式）

新增 `src/skill-provider.ts`：

1. **显式白名单** 5 个 bundle 名，逐个读 `<pkgRoot>/<name>/SKILL.md`（`import.meta.dirname` 向上一级定位包根）。
   - 为什么不把包根当 root 交给 filesystem provider：包根还有 `README.md`、`taxonomy.base.md`，
     会按「flat `<name>.md`」被扫成 skill，每轮 discovery 产生 2 条 invalid-name 警告。
   - 为什么不把目录挪进 `skills/`：README、`docs/`、测试、边栏文案都引用 `wiki-collect/SKILL.md` 这类路径，移动是纯 churn。
2. **rank 600**（硬编码常量 + 注释指向 `@deepseek-ai/dsh-skill` 的 `BUNDLED_SKILL_RANK`），与 `dsh-design-skills` 同款写法。
   - 600 低于用户根 400 ⇒ 用户/项目里的同名副本自动优先，包内版本只做兜底——正是我们要的语义（也让长期存在的
     `wiki-query` 三份同名副本不再打架）。为拿一个常量新增 peerDep 不值得。
3. **frontmatter 只解析需要的键**：`name`（必填、kebab-case 校验）、`description`（必填）、
   可选 `disable-model-invocation` / `user-invocable`（严格布尔，拼错即抛错）。不引入 yaml 依赖。
4. **挂载期快速失败**：任一台账文件缺失/无 frontmatter 直接抛错，不静默返回空 catalog（照 `dsh-design-skills` 的做法）。
5. `list()` 每次重新读盘（改 SKILL.md 无需重启），`get()` 返回 `content` + `resourceBase` 指向该 bundle 目录
   （`wiki-distill` 的 `extract-dsh-sessions.cjs`、`wiki-query/references/retrieval-guide.md` 靠它按相对路径取用）。

`src/index.ts`：**新增独立一行**注入，不并入现有 `ctx.inject(['tools','webServer'], …)`：

```ts
const disposeSkills = mountSkillProvider(ctx) // 内部用 ctx.inject(['skills'], …)，返回 dispose
```

理由沿用文件顶部那条教训注释：cordis 对硬依赖缺失的 entry 置 INACTIVE，把 `'skills'` 加进现有 inject 会让
tools / routes / trigger **一起**静默失效；独立 inject 最坏只丢 skill 可见性。

## 4. 改动清单

| 文件 | 改动 |
|---|---|
| `src/skill-provider.ts` | 新增（约 90 行）：白名单 + frontmatter 解析 + `ctx.skills.registerProvider()` |
| `src/index.ts` | +1 import；+1 段独立 `ctx.inject(['skills'])`；dispose 合并进现有清理函数 |
| `skill-provider.test.mjs` | 新增（见 §5） |
| `README.md` | v9 段落补一句：5 个 skill 经 provider 注册（rank 600，可被用户根同名副本覆盖） |
| `package.json` | **无需改**：`files` 已含 `lib` / `src` / 5 个 skill 目录；无新增依赖 |

## 5. 测试

新增 `skill-provider.test.mjs`（沿用仓库 `node:test` + `node:assert/strict` 风格）：

1. `list()` 恰好 5 条，每条 `name`/`description` 非空，`rank === 600`；
2. `README.md`、`taxonomy.base.md` **不在**列表内（防回归到"扫包根"的实现）；
3. `get({name:'wiki-collect'})` 返回正文，含「扫描用 wiki_mine」等关键行；
4. `wiki-distill` 的 `resourceBase` 指向包内该目录，且 `extract-dsh-sessions.cjs` 在该目录存在；
5. frontmatter 异常（临时文件缺 `name`）时抛错，不返回空列表。

全量回归：`node --test *.test.mjs`（现共 40+ 例，须全绿）。

**端到端验收**（重打包 + 重启后）：

1. 临时把 `~/.dsh/skills/{wiki-collect,wiki-mine,wiki-distill,wiki-init}` 挪走；
2. 新会话里 `skill wiki-collect` 可加载，Base directory 指向
   `.../node_modules/dsh-knj-obsidian/wiki-collect`；
3. catalog 里 5 个名字齐全；
4. `~/.dsh/skills/wiki-query`（rank 400）仍胜出包内 wiki-query ⇒ 证明 rank 600 的低优先级语义生效。

## 6. 部署与发布（宿主侧改动 = 必须重启）

1. **版本号按发布日取**：2026-09-22 → `2026.9.220`（同日第 2 次 `2026.9.221`）；同步 lock 文件；文件无 BOM。
2. `npm run build`（tsc → `lib/`）→ 打包 `dsh-knj-obsidian-<ver>.tgz` →
   `dsh plugin --profile web add ./<tgz>`（后台/无终端执行要 `< nul` 断 stdin，否则空等）→ **手动 `pnpm install`**（tgz 变化不会自动重装）。
3. **重启 `dsh web`**（会中断当前会话，挑时间做）。client bundle 改动才免重启，本次是宿主侧。
4. 双渠道发布：npm（202 异步 → 验收必须轮询 + 三证验证）与 awesome-dsh-plugin 收录；发布前
   `npm view dsh-knj-obsidian version` 确认线上最新号，避免撞号（本地 2026.9.212、线上 2026.9.201，中间号已被占）。
5. 发布后**删除 §1 末列出的 4 个用户根副本**，并各留一句说明。

## 7. 回滚与风险

- **回滚**：provider 注册失败只影响 skill 可见性，tools / routes / trigger 不受影响；细粒度=profile 里 patch 该行 disabled，
  粗粒度=注释掉 `ctx.inject(['skills'])` 那一段重打包。
- **风险 1**：自研 frontmatter 解析器只覆盖本包 5 个文件的写法，页内其他 YAML 概不解析 → §5 用测试锁死这 5 个文件解析成功。
- **风险 2**：`wiki-query` 存在三份同名副本（用户根 / `.agents` 根 / 包内）→ rank 决定优先级，README 写明"用户根副本优先"，
  避免后续误判"注册没生效"。
- **风险 3**：临时副本与包内版本长期并存会漂移 → 见 §1 末强制删除项与 §6.5。

## 8. 实施结果（2026-09-22）

**改动**：新增 `src/skill-provider.ts`（provider + 极简 frontmatter 解析 + 静默降级）、`src/index.ts` 加独立
`ctx.inject(['skills'])` 并把 dispose 并入清理函数、新增 `skill-provider.test.mjs`（9 例）与夹具
`test-fixtures/skill-bundles/`、README v9 段补「skill 注册」一条。未改任何 skill 正文，未新增依赖。

**红 → 绿证据链**

| 步骤 | 命令 | 结果 |
|---|---|---|
| 红 #1：行为根本没发布 | `node --test skill-provider.test.mjs` | `ERR_MODULE_NOT_FOUND: lib/skill-provider.js`；fail 1 / pass 0 |
| 红 #2：`apply()` 未接线 | 构建后重跑 | `AssertionError: apply 应注入一次 skills，实际注入：[["tools","webServer"]]`（0 !== 1）。同批还暴露 1 条**测试自身写错**：`扫描用 wiki_mine` 在 frontmatter 的 description 里、不在正文，已改断言为正文标记 `## 第 1 步：扫描 + 对账` |
| 绿：目标套件 | `node --test skill-provider.test.mjs` | **9/9 pass** |
| 绿：全量回归 | `node --test` | **384/384 pass, 0 fail**，1.9s（新用例标题已出现在全量输出中，确认被自动发现） |
| 产物 | `npm.cmd pack` | `dsh-knj-obsidian-2026.9.220.tgz`：**481,557 bytes / 102 文件**，shasum `98405f74…`，含 `lib/skill-provider.js`、`src/skill-provider.ts`、5 个 skill 目录与 `wiki-distill/extract-dsh-sessions.cjs` |
| 红 #3：#6 注销契约 | 改测试断言后重跑 | `AssertionError: dispose 必须调用 registerProvider 返回的注销函数`（8 pass / 1 fail）。**起因是对着真实 `@deepseek-ai/dsh-skill` 的类型定义核对**：`registerProvider(...) => () => void` 自己返回 disposer，原实现忽略了它 → 已改为捕获并在 dispose 时调用 |
| 绿 #2 | 构建 + 目标套件 + 全量 | 目标 **9/9**、全量 **384/384 pass, 0 fail**；新包内 `lib/skill-provider.js` 已含 `unregister` 逻辑 |
| **真实注册表端到端验证**（假 ctx 测不到的部分） | 起真 `@deepseek-ai/cordis` + 真 `SkillRegistry`，挂载本插件 provider 后读 catalog | ① warn **0** 条 → 5 个候选**通过注册表的候选/定义校验**；② catalog = `wiki-collect / wiki-distill / wiki-init / wiki-mine / wiki-query`，全部 `[bundled/dsh-knj-obsidian]`；③ `get('wiki-collect')` 的 resourceBase = `<repo>\wiki-collect`、content 无 frontmatter 且含「第 1 步：扫描 + 对账」；④ **rank 让位实测**：另注册一个 rank 400、同名 `wiki-query` 的 provider 后，胜者为 `[user-dsh/…]`、body 为它的内容（`rank 600 让位生效 = true`）——即本机 `~/.dsh/skills/wiki-query` 仍会赢；⑤ `dispose()` 后本插件条目归零（注销生效）。验证脚本为临时文件，跑完已删除 |

**复查说明（诚实记录）**：`review` 工具以 quick 深度调用后**超时**（1800s 未返回，无任何结论产出），因此本次交付
**没有**独立第三方 lens 的复查记录。替代证据是两条更硬的东西：① 逐字段对照真实 `@deepseek-ai/dsh-skill`
的 `lib/types/index.d.ts`（`SkillCandidate` / `SkillDefinition` / `SkillInvocationPolicy` / `BUNDLED_SKILL_RANK` /
`registerProvider` 返回值）——正是这条对照抓出了「注销 disposer 被忽略」这个真缺陷；② 上表的真实注册表端到端验证。
若需要第三方复查，建议在安装 + 重启之后再跑一次 `review`。

**版本与卫生**：`package.json` 2026.9.212 → **2026.9.220**；`package-lock.json` 2026.9.70（此前就与 package.json
不同步）→ 2026.9.220；两个 JSON 与全部新增/修改文件头三字节均非 BOM。

**仍未做（需择时，按序执行）**

1. 安装：`dsh plugin --profile web add ./dsh-knj-obsidian-2026.9.220.tgz < nul`（后台/无终端必须断 stdin）→ 手动 `pnpm install`；
2. **重启 `dsh web`**（宿主侧改动；会中断当前会话）；
3. 端到端验收：临时挪走 `~/.dsh/skills/{wiki-collect,wiki-mine,wiki-distill,wiki-init}` → 新会话 `skill wiki-collect`
   的 Base directory 应指向 `.../node_modules/dsh-knj-obsidian/wiki-collect`，catalog 含 5 个名字，
   且 `~/.dsh/skills/wiki-query`(400) 仍胜出包内 wiki-query(600)；
4. 验收通过后删除那 4 个用户根副本（副本目录内有 `_COPIED-FROM.txt` 写明拆除条件）；
5. npm / 市场发布（本次不做）。
