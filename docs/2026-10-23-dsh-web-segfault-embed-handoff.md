# dsh-web 段错误 × GGUF 推理排查交接（2026-10-23）

> 供下一个会话接手。当日背景：上午部署了 dsh-knj-obsidian p6（文档蒸馏），其间 dsh-web 反复段错误，
> 排查已中止、复现进程已清理。本文记录已核实事实、未闭环的疑点与下一步清单。

## 〇、现况速览（2026-10-23 10:17）

- 现役进程 **09:56:38 启动，已在跑 p6**（p6 于 09:51 / 09:55 两步装入 profile，09:56:32 崩溃后自动拉起恰好加载新包）
- 至 10:17 **无新崩溃**（20 分钟；注意语义栈是懒加载，没触发 embed 不代表健康）
- 「文档蒸馏」选项应已生效：浏览器强刷（Ctrl+Shift+R）即可见；回滚包 `~/.dsh/local-plugins/dsh-knj-obsidian-2026.10.140-p5.tgz`

## 一、崩溃事实（已核实）

- **当日共崩 6 次**：`08:36:27 / 08:38:43 / 08:41:23 / 08:56:11 / 09:43:05 / 09:56:32`，
  全部 `Segmentation fault`（退出码 139，`Failed with result 'exit-code'`），NRestarts 累计 13
- **拿不到原生栈**：无 systemd-coredump，`/var/lib/systemd/coredump/` 为空，dmesg 无对应记录 → 只能靠复现
- 崩的都是 entry.sh 里 node 主进程本身（`dsh web` 前台进程）

## 二、GGUF 推理栈现况（组件本身完好）

| 组件 | 状态 |
|---|---|
| `@tobilu/qmd` v2.8.3 | ✅ 在位（`~/.dsh/profiles/web/node_modules/`） |
| `node-llama-cpp` 3.20.0 | ✅ 在位，`llama-addon.node` + 全套 `libllama/libggml*.so` 完整（28M） |
| GGUF 模型 `embeddinggemma-300M-Q8_0.gguf`（319M，10-16 落盘） | ✅ 在 `~/.dsh/qmd/models/` |
| CPU | i5-7300U（Kaby Lake），**仅 AVX2、无 AVX-512**；Node v22.21.0 |

## 三、架构关键点（为什么一崩全崩）

- 集成方是 dsh-knj-obsidian 插件，`lib/semantic-index.js:311` 用**进程内动态 `import('@tobilu/qmd')`**——
  llama 原生 addon 直接加载进 dsh-web 主进程，原生层一崩整个宿主跟着崩
- **懒加载**：当前活着的 dsh 进程（查过 `/proc/PID/maps`）没有映射任何 llama 库，只有语义检索/索引被触发时才加载

## 四、索引库证据（最硬的一条）

`~/.dsh/qmd/index.sqlite`：

- FTS 关键词侧正常：3 篇文档（全是 10-16 bili-mcp wiki 的）
- **`content_vectors = 0`、`vectors_vec_chunks = 0`、`llm_cache = 0`——向量侧从未成功写入过任何一条嵌入**
- 库文件 mtime = **08:54:52**，在 crash#4（08:56:11）前 79 秒——qmd 当时正活跃写库

## 五、崩溃与会话活动的关联

- crash#1/#2（08:36/08:38）：会话 8361affc 刚做完 wiki-docs skill（约 5 分钟前写了 skill 文件）
- crash#4（08:56）：同一会话在批量 git 提交（含 `.wiki/` 脚手架）→ `.wiki` 变更触发语义刷新 → embed → 崩
- **crash#6（09:56）已独立归因**：09:51:28 pnpm 把整个 .pnpm 树（含 @node-llama-cpp 原生库）重链接了一遍而服务器没重启——
  运行中原生库被替换，mmap 页失效致段错误（与 embed 无关的运维事故）
- crash#3/#5（08:41/09:43）：前 10 分钟无可观测会话活动（可能是后台定时刷新或超出观测窗口）

## 六、隔离复现结果（未闭环）

独立 node 进程（临时库，不碰真实索引）跑最小复现：

- import qmd ✅ / createStore ✅ / addCollection+update ✅（1 篇文档待嵌入）
- **`store.embed({force:true})` 启动后挂死，4 分钟无返回**（240s 超时被杀，退出码 124）
- ⚠️ 隔离进程表现为**挂死**而非段错误——300M Q8 模型 CPU 加载+嵌入不该这么久。
  挂死与宿主段错误是同一底层问题的两种表现，还是模型加载慢+宿主另有死因，**尚未分辨**
  （原计划：后台跑复现 + 抓线程级 CPU/wchan 判断卡在自旋还是等待，被中止）

## 七、下一步清单（给接手会话）

1. **后台跑 `/tmp/qmd-repro2.mjs`**，同时抓 `top -H -p PID` 线程 CPU 和 `/proc/PID/task/*/wchan`——
   区分「模型加载自旋」还是「死锁等待」
2. 绕过 qmd，用**裸 node-llama-cpp 3.20.0 直接 load 这颗 GGUF**，定位问题在 llama.cpp 层还是 qmd 层
3. 换一颗小模型或用 CPU 派发开关试试（排查 ggml CPU variant 在 Kaby Lake 上的已知问题）
4. 短期止血：把语义嵌入**移出主进程**（子进程隔离），或先禁用 in-process embed，止住崩溃循环
   （插件侧开关：`KNJ_OBSIDIAN_AUTO_REFRESH=off` 关自动刷新、`KNJ_OBSIDIAN_DRILL=off` 关下钻；
   彻底关就 `KNJ_OBSIDIAN_TRIGGER=off` + 从 profile 卸 `@tobilu/qmd`）
5. **运维规矩（crash#6 教训，已确认）**：`pnpm install` / 插件安装 / 原生模块升级后**必须重启 dsh-web**——
   运行中的原生 .so 被替换会导致 mmap 失效段错误

## 附：排查用命令

```bash
systemctl show dsh-web -p NRestarts -p ExecMainStartTimestamp
sudo journalctl -u dsh-web --since '07:00' --no-pager | grep -E 'Failed|Started|Segmentation'
sudo tail -50 /tmp/dsh-web.log        # 应用日志（每次启动被截断，只含当前进程）
sqlite3 ~/.dsh/qmd/index.sqlite 'select count(*) from content_vectors;'
```
