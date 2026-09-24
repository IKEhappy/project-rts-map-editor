// 画布缩放的整数像素阶梯（T-164 R31，2026-09-24）。
//
// 为什么不用连续缩放（旧实现 zoom *= 1.15）：像素编辑器的格线在非整数设备像素下会产生
// 摩尔纹与半像素接缝，`image-rendering: pixelated` 也救不了。旧实现还存在一个单调性缺陷——
// 笔刷/擦除按「ppc 小 → 看到更多格」的直觉工作，但 baseCell 随图尺寸变化（48 宽图 =10、
// 64 宽 =7、96 宽 =5），同一份 zoom 序列在不同图上算出的 ppc 步长不等，baseCell=16 时
// zoom 0.35→0.5 会让 ppc 从 5.6 升到 8，**缩小反而变大**。
//
// 改法：以「每格 CSS 像素数 ppc」为唯一真相，缩放即在整数阶梯上前后移动一格，zoom 反推
// （zoom = ladder[zn] / baseCell）。阶梯已按 baseCell 归一化，故对任意 baseCell 都单调。

/** 每格 CSS 像素的候选档位：一次滚轮在相邻两档间移动。 */
const PPC_LADDER = [3, 4, 5, 6, 7, 8, 10, 12, 14, 18, 22, 28, 36, 44, 56, 72, 96];

/** 旧实现的 zoom 边界（0.35 .. 14），保留以维持既有手感与探针口径。 */
export const MIN_ZOOM = 0.35;
export const MAX_ZOOM = 14;

export interface ZoomLike {
  ox: number;
  oy: number;
  zoom: number;
}

/** 在阶梯上定位最接近给定 ppc 的档位索引（钳到两端）。 */
export function ladderIndexForPpc(ppc: number): number {
  if (!Number.isFinite(ppc)) return 0;
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < PPC_LADDER.length; i += 1) {
    const dist = Math.abs(PPC_LADDER[i] - ppc);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

/**
 * 按当前 baseCell 归一化阶梯——保证对任意 baseCell 单调（这是旧实现的缺陷所在）。
 * baseCell 巨大时（小图）下界可能超过 MIN_ZOOM 对应的 ppc，那是正确的：小图本就该放大显示。
 */
function indexPathForBase(baseCell: number): number[] {
  // 用 zoom = ppc / baseCell 反推，再把越界档位剔掉；保留 0.35..14 的既有 zoom 边界。
  const path: number[] = [];
  for (let i = 0; i < PPC_LADDER.length; i += 1) {
    const zoom = PPC_LADDER[i] / baseCell;
    if (zoom < MIN_ZOOM * 0.999 || zoom > MAX_ZOOM * 1.001) continue;
    path.push(i);
  }
  return path.length > 0 ? path : [ladderIndexForPpc(baseCell)];
}

/** 当前 ppc（含钳制），供画布与探针共用，避免两处各算一套。 */
export function ppcOf(baseCell: number, zoom: number): number {
  const safeZoom = Number.isFinite(zoom) ? zoom : 1;
  return Math.max(3, Math.min(96, baseCell * safeZoom));
}

/**
 * 下一次缩放：dir<0 = 放大（滚轮上/向前），dir>0 = 缩小。
 * 返回新 zoom（1 = 恰好 baseCell 像素/格）。已到端部则原样返回 zoom。
 */
export function stepZoom(baseCell: number, zoom: number, dir: number): number {
  if (!(baseCell > 0)) return 1;
  const path = indexPathForBase(baseCell);
  const currentPpc = ppcOf(baseCell, zoom);
  let at = 0;
  let bestDist = Infinity;
  for (let i = 0; i < path.length; i += 1) {
    const dist = Math.abs(PPC_LADDER[path[i]] - currentPpc);
    if (dist < bestDist) {
      bestDist = dist;
      at = i;
    }
  }
  const nextAt = Math.max(0, Math.min(path.length - 1, at + (dir < 0 ? 1 : -1)));
  if (nextAt === at) return zoom;
  return PPC_LADDER[path[nextAt]] / baseCell;
}

/**
 * 滚轮 → 方向：兼容像素/行/页三种 deltaMode（触控板与鼠标滚轮差异巨大），
 * 并吸收惯性滚动产生的连续小 delta（阈值以下不切档，避免一格滚出十几档）。
 */
export function wheelDirection(event: { deltaY: number; deltaMode?: number }): -1 | 0 | 1 {
  const mode = event.deltaMode ?? 0;
  // deltaMode: 0=像素 1=行 2=页——按行/页给来的值远小于像素值，先归一到像素量级
  const unit = mode === 1 ? 16 : mode === 2 ? 400 : 1;
  const delta = (event.deltaY ?? 0) * unit;
  if (Math.abs(delta) < 24) return 0; // 触控板细碎惯性：不切档
  return delta < 0 ? -1 : 1;
}
