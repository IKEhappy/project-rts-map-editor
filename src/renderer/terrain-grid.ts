// 地形栅格（T-164 R31，2026-09-24）：从 terrain_patches 合成「每格地形码」的 Int8Array。
//
// 旧实现挂在 MapCanvas 的 useMemo 里，每次 doc 变化都 new Int8Array(w*h) + 遍历全部补丁
// 逐格覆写。31 张图里最大的 encounter_big 是 128×128 = 16384 格，而画布交互期 doc 变更
// 频繁（拖刷、拖动对象、字段树逐键输入），全量重建是白白浪费。
//
// 改法：缓存上一份栅格与补丁快照，尺寸不变时只重刷「变化的补丁」覆盖到的矩形。抽成纯函数
// 模块以便单测（tests/unit/terrain-grid.test.mjs）。

import type { JsonValue } from "./types";

export type TerrainGrid = Int8Array;

/** 归一化后的补丁（字段名与 JSON 不同，避免每次 diff 都重复 Number()）。 */
export interface Patch {
  x: number;
  y: number;
  w: number;
  h: number;
  terrain: number;
}

export interface GridCache {
  w: number;
  h: number;
  defaultTerrain: number;
  patches: Patch[];
  grid: TerrainGrid;
}

/** 把 JSON 里的 terrain_patches 归一化为 Patch[]：钳界 + 跳过非有限值（字段树误输入巨值不再拖死渲染线程）。 */
export function normalizePatches(raw: JsonValue | undefined, mapW: number, mapH: number): Patch[] {
  const out: Patch[] = [];
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const p = entry as Record<string, JsonValue>;
    const x = Number(p.x);
    const y = Number(p.y);
    const w = Number(p.w);
    const h = Number(p.h);
    const t = Number(p.terrain ?? 0);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) continue;
    // 钳制到图界（负坐标/0 尺寸的补丁在游戏侧被拒，这里只是不让渲染线程死循环）
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(mapW, Math.ceil(x + w));
    const y1 = Math.min(mapH, Math.ceil(y + h));
    if (x1 <= x0 || y1 <= y0) continue;
    if (!Number.isFinite(t)) continue;
    out.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, terrain: t });
  }
  return out;
}

function patchEquals(a: Patch, b: Patch): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h && a.terrain === b.terrain;
}

function fillRect(grid: TerrainGrid, mapW: number, mapH: number, p: Patch, value: number): void {
  const y1 = Math.min(mapH, p.y + p.h);
  const x1 = Math.min(mapW, p.x + p.w);
  for (let yy = Math.max(0, p.y); yy < y1; yy += 1) {
    const row = yy * mapW;
    for (let xx = Math.max(0, p.x); xx < x1; xx += 1) {
      grid[row + xx] = value;
    }
  }
}

/** 补丁叠加顺序：后写覆盖先写（与旧实现、与游戏 L2「首个范围优先」的取值口径一致）。 */
function buildGrid(mapW: number, mapH: number, defaultTerrain: number, patches: Patch[]): TerrainGrid {
  const grid = new Int8Array(Math.max(0, mapW * mapH));
  if (mapW <= 0 || mapH <= 0) return grid;
  grid.fill(defaultTerrain);
  for (const p of patches) fillRect(grid, mapW, mapH, p, p.terrain);
  return grid;
}

/**
 * 增量求栅格：尺寸或 default_terrain 变化 → 全量重建；否则只重刷与上一份快照不同的补丁。
 *
 * 重刷策略（正确性问题）：某条补丁变了，不能只刷它的新矩形——**旧矩形**也要处理，因为
 * 它可能已经不再覆盖那些格（补丁被挪走/缩小）。稳妥做法是把「旧矩形并集」恢复为
 * default_terrain 再叠加「除本条外的全部补丁」，但那会退化成 O(补丁数²)。
 * 折中：记录每条补丁的旧矩形，先把它回落到 default，再刷新矩形；若同格还有更高优先级的
 * 后续补丁，由「后续补丁重新刷一遍」保证——只对**变化的补丁之后**的那些补丁重刷。
 * 补丁数在实图里是 9~26 条量级，这个成本可以接受，且远低于全量重建。
 */
export function nextGrid(cache: GridCache | null, mapW: number, mapH: number, defaultTerrain: number, rawPatches: JsonValue | undefined): GridCache {
  const patches = normalizePatches(rawPatches, mapW, mapH);
  if (cache && cache.w === mapW && cache.h === mapH && cache.defaultTerrain === defaultTerrain) {
    // —— 逐条 diff，找第一个变化点 ——
    let firstChanged = -1;
    const max = Math.max(cache.patches.length, patches.length);
    for (let i = 0; i < max; i += 1) {
      const a = cache.patches[i];
      const b = patches[i];
      if (a === undefined || b === undefined || !patchEquals(a, b)) {
        firstChanged = i;
        break;
      }
    }
    if (firstChanged === -1) return cache; // 补丁语义未变：连格子都不用碰

    const grid = cache.grid;
    // 1) 把「变化点及其后」的全部旧补丁矩形回落到 default（旧的新增/偏移都要抹掉）
    for (let i = firstChanged; i < cache.patches.length; i += 1) {
      fillRect(grid, mapW, mapH, cache.patches[i], defaultTerrain);
    }
    // 2) 从变化点起重放新补丁（保持后写覆盖先写的顺序）
    for (let i = firstChanged; i < patches.length; i += 1) {
      fillRect(grid, mapW, mapH, patches[i], patches[i].terrain);
    }
    return { w: mapW, h: mapH, defaultTerrain, patches, grid };
  }
  return { w: mapW, h: mapH, defaultTerrain, patches, grid: buildGrid(mapW, mapH, defaultTerrain, patches) };
}
