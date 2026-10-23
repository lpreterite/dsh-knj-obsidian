// src/index.ts
import type { Context } from '@deepseek-ai/cordis'
import { homedir } from 'node:os'
import { join } from 'node:path'
// 类型增强：0.2.0 设置契约（ctx.settings / loader/volatile-update 事件类型）
import '@deepseek-ai/cordis-plugin-loader'
import '@deepseek-ai/dsh-settings'
import { VaultManager } from './vault-manager.ts'
import { mountTools } from './tools.ts'
import { mountWikiRoutes, type WikiHost } from './routes.ts'
import { installTrigger, type TriggerHost } from './trigger.ts'
import { mountSkillProvider } from './skill-provider.ts'
import { KnjConfigSchema, resolveKnjConfig, setResolvedConfig, mountSettingsHttp, type KnjConfig } from './settings.ts'
import { disposeSemanticRuntimes } from './semantic-hits.ts'

export const name = 'dsh-knj-obsidian'

/**
 * 0.2.0 设置模型：本 schema 即设置页（命名空间 = profile 条目 id = dsh-knj-obsidian）。
 * semantic 组整体 .volatile()——设置页保存时 Loader 把新值原地提交进运行 fiber 并派发
 * loader/volatile-update（不重挂条目），apply() 内监听该事件热应用（换嵌入后端即重建语义运行时缓存）。
 * vaultRegistryFile 保持普通字段：改动走整条目重挂载，语义正确。
 *
 * **优先级铁律：env 覆盖 > 设置面板 > 内置默认**（见 src/settings.ts）。
 */
export const Config = KnjConfigSchema

/** 宿主工作区注册表（防御性读取；无此服务时回退 cwd 单库）。 */
interface WorkspaceRegistryLike {
  list(): Array<{ path: string; title?: string }>
}

function defaultRegistryPath(): string {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(dshHome, 'knj-obsidian', 'vaults.json')
}

export function apply(ctx: Context, rawConfig?: unknown): void {
  // ⓪ volatile 配置解包：volatile 字段以引用（{ get(): value }）形式提交进运行 fiber，
  //    这里统一解成普通值；loader/volatile-update 时重新解析并热应用。
  let config: KnjConfig = resolveKnjConfig(rawConfig)
  setResolvedConfig(config)
  // 防御式注册：宿主必有 ctx.on，但测试夹具的 ctx 可能只有 inject——没有 on 就跳过热应用（不影响挂载）
  const withOn = ctx as unknown as { on?: (event: string, listener: () => void) => unknown }
  if (typeof withOn.on === 'function') {
    withOn.on('loader/volatile-update', () => {
      config = resolveKnjConfig(rawConfig)
      setResolvedConfig(config)
      // 后端/开关可能已变：清掉按库缓存的语义运行时，下一次使用按新配置重建（local↔remote↔off 热切换）
      disposeSemanticRuntimes()
    })
  }

  // skill 注册：包内 6 个 skill 只有注册过才进模型 catalog（详见 src/skill-provider.ts）。
  // 刻意用**独立的** ctx.inject(['skills'])：'skills' 绝不并入下面那支 inject——
  // 硬依赖缺失会让该 entry 置 INACTIVE，连带 tools/routes/trigger 一起静默失效；
  // 独立注入最坏只是 skill 不可见（provider 内部还会吞掉异常）。
  const disposeSkills = mountSkillProvider(ctx)
  // ⚠️ workspaceRegistry 是「可选」依赖，绝不能写进 inject 数组：cordis 对硬依赖缺失的
  // entry 置 INACTIVE，回调永不执行——routes 和 tools 会整体静默失效（宿主改名/移除该服务时）。
  // tools/webServer 由官方 base bundles 保证提供，是安全的核心依赖。
  ctx.inject(['tools', 'webServer'], (hostCtx: Context) => {
    const host = hostCtx as unknown as WikiHost
    // 防御性读取 workspaceRegistry：注入后容忍服务异常/缺失，失败仅回退 cwd 单库
    let workspaceRoots: Array<{ path: string; title?: string }> = []
    try {
      const withGet = hostCtx as unknown as { workspaceRegistry?: WorkspaceRegistryLike; get?: (name: string) => unknown }
      const registry = withGet.workspaceRegistry
        ?? (typeof withGet.get === 'function' ? withGet.get('workspaceRegistry') as WorkspaceRegistryLike | undefined : undefined)
      workspaceRoots = registry?.list() ?? []
    } catch {
      // 宿主未提供 workspaceRegistry：仅 cwd 种子，不阻塞启动
    }
    const manager = new VaultManager({
      registryFile: config.vaultRegistryFile?.trim() || defaultRegistryPath(),
      cwdRoot: process.cwd(),
      workspaceRoots,
    })
    const disposeTools = mountTools(hostCtx, manager)
    const disposeRoutes = mountWikiRoutes(host, manager)
    // 任务级知识触发（L0/L1/L3）+ 可选闸门：只读、不阻断，KNJ_OBSIDIAN_TRIGGER=off 可关。
    const disposeTrigger = installTrigger(hostCtx as unknown as TriggerHost, manager)
    return () => {
      disposeTools()
      disposeRoutes()
      disposeTrigger()
      disposeSkills()
      setResolvedConfig(undefined)
    }
  })
  // 设置 HTTP 通道：**独立 inject 片段**，且 'settings' 必须显式声明——
  // p7 实机踩坑：动态回调里对未声明服务的防御式读取（host.settings / host.get('settings')）
  // 拿不到 cordis 0.2.0 的 settings 服务（未声明即不可见），路由静默不注册 →
  // /api/obsidian-wiki/config 404。声明式注入后与 dsh-self-improved 同构。
  // 该 fragment 若失败（极端裁剪宿主无 settings）只损失 HTTP 通道，不牵连 tools/routes/skills。
  ctx.inject(['settings', 'webServer'], (svcCtx: Context) => {
    mountSettingsHttp(ctx, svcCtx)
  })
}
