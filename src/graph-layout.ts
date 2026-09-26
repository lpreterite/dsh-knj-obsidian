// src/graph-layout.ts
// 图谱「面板空间利用」的三步几何修正（纯函数；客户端与 Node 测试共用）。
//
// 为什么需要（2026-09-21 实测）：
//   力导向布局的云团尺寸由力平衡决定、与面板无关——1180px 面板里节点横向只跨 68%、宽屏 1600px
//   里只有 49%（纵向 91%，因为被硬夹到上下边缘）。另有两处真问题：
//     ① 布局只夹「圆心」，标签向右伸 GAP+文字宽没人管 → 溢出面板被静默裁掉
//        （实测最长标签 513px，右端超出面板 130px）；
//     ② 窄面板（边栏 336px）标签集体溢出 → 内容被撑成 2 倍宽 → viewBox meet 把整体缩到 0.47×
//        → 高度只用了 43%。注意：早先「全屏占 95%」是假象——它把被裁掉的标签也算作已用空间。
//
// 三步（只动坐标与标签文案；圆半径 r=8、字号 11px 全程不变 → 无变形）：
//   ① placeLabels  —— 按两侧空余选边；放不下则按该侧**可用宽度**截断（不是全局上限）
//   ② spreadToFill  —— 布局结束后把节点坐标按轴铺进可用区（限幅 [MIN_SPREAD, MAX_SPREAD]）
//   ③ viewBox 保持面板尺寸（不做等比缩放，否则字号会被缩小）
//
// 为什么不「等比适配」：错配的是**宽高比**而非比例——实测等比适配只能让全屏 68%→71%，
// 而按轴铺开坐标可到 87%；后者不动图形与字号，所以既填满又不扭曲。

/** 画布内边距。 */
export const GRAPH_PAD = 16
/** 节点圆半径（与 CSS/绘制处一致；布局留边要用它）。 */
export const NODE_R = 8
/** 标签与圆心之间的水平间距。 */
export const LABEL_GAP = 12
/** 铺开限幅：与现状相比最多铺开/收拢到这个倍数，避免极端面板把图拉散或压扁。 */
export const MAX_SPREAD = 1.8
export const MIN_SPREAD = 0.6
/** 少于这个宽度就不再画标签（仅为保证「绝不越界」这条不变量）。 */
const MIN_LABEL_ROOM = 16

export type LabelSide = 'left' | 'right'

export interface PlacedNode {
  title: string
  x: number
  y: number
  /** 可能被截断的实际绘制文案（未给时视为 title）。 */
  label?: string
  side?: LabelSide
}

/**
 * 文本宽度估算（无 DOM 环境用；浏览器里应传入 canvas measureText 的精确实现）。
 * 口径：CJK 每字 ≈ 11px（字号 11px），其余字符 ≈ 6.2px。
 */
export function labelWidth(text: string): number {
  let w = 0
  for (const ch of String(text ?? '')) {
    w += /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(ch) ? 11 : 6.2
  }
  return w
}

/** 截断到不超过 maxW（末尾加 …）；保证「截断后一定 ≤ maxW」这条不变量。 */
export function truncateTo(text: string, maxW: number, measure: (t: string) => number = labelWidth): string {
  if (maxW < MIN_LABEL_ROOM) return ''
  if (measure(text) <= maxW) return text
  const chars = [...text]
  for (let n = chars.length - 1; n >= 1; n -= 1) {
    const candidate = chars.slice(0, n).join('') + '…'
    if (measure(candidate) <= maxW) return candidate
  }
  return '…'
}

/**
 * ① 标签选边 + 按该侧可用宽度截断。
 * 返回被截断的条数（供 UI/测试观察）。
 */
export function placeLabels<T extends PlacedNode>(
  nodes: readonly T[],
  width: number,
  height: number,
  measure: (t: string) => number = labelWidth,
): { truncated: number } {
  let truncated = 0
  for (const n of nodes) {
    const rightRoom = width - GRAPH_PAD - (n.x + LABEL_GAP)
    const leftRoom = (n.x - LABEL_GAP) - GRAPH_PAD
    const side: LabelSide = rightRoom >= leftRoom ? 'right' : 'left'
    const room = Math.max(0, side === 'right' ? rightRoom : leftRoom)
    n.side = side
    if (measure(n.title) <= room) {
      n.label = n.title
      continue
    }
    n.label = truncateTo(n.title, room, measure)
    truncated += 1
  }
  return { truncated }
}

/** 标签的水平占位区间（供不变量断言与命中测试）。 */
export function labelBounds(n: PlacedNode, measure: (t: string) => number = labelWidth): { left: number; right: number } {
  const w = measure(n.label ?? n.title)
  return n.side === 'left'
    ? { left: n.x - LABEL_GAP - w, right: n.x - LABEL_GAP }
    : { left: n.x + LABEL_GAP, right: n.x + LABEL_GAP + w }
}

/**
 * ② 把节点坐标按轴铺进可用矩形（只改坐标；限幅 [MIN_SPREAD, MAX_SPREAD]）。
 * 面板本来就填满时应返回 1（不做无谓抖动）；空数组/零跨度安全返回 1。
 */
export function spreadToFill<T extends PlacedNode>(
  nodes: readonly T[],
  width: number,
  height: number,
): { kx: number; ky: number } {
  if (nodes.length === 0) return { kx: 1, ky: 1 }
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
  for (const n of nodes) {
    x0 = Math.min(x0, n.x); x1 = Math.max(x1, n.x)
    y0 = Math.min(y0, n.y); y1 = Math.max(y1, n.y)
  }
  const spanX = x1 - x0, spanY = y1 - y0
  const availW = width - GRAPH_PAD * 2 - NODE_R * 2
  const availH = height - GRAPH_PAD * 2 - NODE_R * 2
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2
  const kx = spanX > 1 ? Math.max(MIN_SPREAD, Math.min(MAX_SPREAD, availW / spanX)) : 1
  const ky = spanY > 1 ? Math.max(MIN_SPREAD, Math.min(MAX_SPREAD, availH / spanY)) : 1
  for (const n of nodes) {
    n.x = cx + (n.x - cx) * kx
    n.y = cy + (n.y - cy) * ky
    // 铺开后仍可能贴边（浮点/限幅），统一夹回面板内
    n.x = Math.max(GRAPH_PAD + NODE_R, Math.min(width - GRAPH_PAD - NODE_R, n.x))
    n.y = Math.max(GRAPH_PAD + NODE_R, Math.min(height - GRAPH_PAD - NODE_R, n.y))
  }
  return { kx, ky }
}
