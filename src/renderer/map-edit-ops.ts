// 地图画布直编操作层（T-164 R8，2026-09-17）：画布语义意图 → 地图 JSON 文档的纯函数变换。
// 全部为纯函数（返回新数组/新文档，不原地改）；字段树与画布共用同一 doc 状态，天然双向。
// 地形笔刷策略：先从既有 patches 减去笔刷矩形（矩形差分 → 至多 4 片），目标码 ≠ 默认码
// 时再追加一片——保留作者手写结构、不整表重写；目标码 = 默认码即"擦除"（只减不加）。

import type { ConfigFile, Entity, JsonValue } from "./types";

type Patch = Record<string, JsonValue>;

export interface CellRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function rectKey(a: CellRect, b: CellRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** 矩形差分：target 减去 hole → 至多 4 个不相交子矩形（上下条 + 左右中段） */
export function subtractRect(target: CellRect, hole: CellRect): CellRect[] {
  if (!rectKey(target, hole)) return [target];
  const out: CellRect[] = [];
  const x1 = Math.max(target.x, hole.x);
  const y1 = Math.max(target.y, hole.y);
  const x2 = Math.min(target.x + target.w, hole.x + hole.w);
  const y2 = Math.min(target.y + target.h, hole.y + hole.h);
  if (y1 > target.y) out.push({ x: target.x, y: target.y, w: target.w, h: y1 - target.y });
  if (y2 < target.y + target.h) out.push({ x: target.x, y: y2, w: target.w, h: target.y + target.h - y2 });
  if (x1 > target.x) out.push({ x: target.x, y: y1, w: x1 - target.x, h: y2 - y1 });
  if (x2 < target.x + target.w) out.push({ x: x2, y: y1, w: target.x + target.w - x2, h: y2 - y1 });
  return out.filter((r) => r.w > 0 && r.h > 0);
}

function cellRectOf(p: Patch): CellRect | null {
  const x = Number(p.x);
  const y = Number(p.y);
  const w = Number(p.w);
  const h = Number(p.h);
  if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(w) || !Number.isInteger(h)) return null;
  if (w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

/** 地形笔刷/擦除：目标码 = null 或等于默认码 → 擦除（只减不加）；否则减去后追加一片 */
export function paintTerrain(doc: ConfigFile, rect: CellRect, code: number | null): ConfigFile {
  const patches = Array.isArray(doc.terrain_patches) ? (doc.terrain_patches as Patch[]) : [];
  const next: Patch[] = [];
  for (const entry of patches) {
    if (entry === null || typeof entry !== "object") continue;
    const target = cellRectOf(entry);
    if (!target) {
      next.push(entry);
      continue;
    }
    for (const piece of subtractRect(target, rect)) {
      next.push({ x: piece.x, y: piece.y, w: piece.w, h: piece.h, terrain: entry.terrain });
    }
  }
  const fallback = Number(doc.default_terrain ?? 0);
  const effective = code === null ? fallback : code;
  if (effective !== fallback) {
    next.push({ x: rect.x, y: rect.y, w: rect.w, h: rect.h, terrain: effective });
  }
  return { ...doc, terrain_patches: next };
}

/** box_mode：追加范围（闭区间端点坐标 → start/end），越界钳制到图内。
 *  覆盖语义（R11 用户裁定）：新范围先从**所有**既有范围减去（矩形差分）再追加——
 *  被刷到的格子归属唯一（新配置覆盖旧配置），与游戏 L2"首个范围优先"的取值口径
 *  一致（旧条目不再声明这些格），编辑器所见即游戏所得。 */
export function addBox(doc: ConfigFile, x0: number, y0: number, x1: number, y1: number, access: number, build: number): ConfigFile {
  const width = Number(doc.width ?? 0);
  const height = Number(doc.height ?? 0);
  if (!(width > 0 && height > 0)) return doc;
  const sx = Math.max(0, Math.min(x0, x1));
  const sy = Math.max(0, Math.min(y0, y1));
  const ex = Math.min(width - 1, Math.max(x0, x1));
  const ey = Math.min(height - 1, Math.max(y0, y1));
  const hole: CellRect = { x: sx, y: sy, w: ex - sx + 1, h: ey - sy + 1 };
  const existing = Array.isArray(doc.box_mode) ? (doc.box_mode as Patch[]) : [];
  const next: Patch[] = [];
  for (const entry of existing) {
    if (entry === null || typeof entry !== "object") continue;
    const start = entry.start as Patch | undefined;
    const end = entry.end as Patch | undefined;
    if (!start || !end) {
      next.push(entry);
      continue;
    }
    const bx0 = Number(start.w ?? 0);
    const by0 = Number(start.h ?? 0);
    const bx1 = Number(end.w ?? bx0);
    const by1 = Number(end.h ?? by0);
    const target: CellRect = { x: bx0, y: by0, w: bx1 - bx0 + 1, h: by1 - by0 + 1 };
    for (const piece of subtractRect(target, hole)) {
      next.push({
        start: { w: piece.x, h: piece.y },
        end: { w: piece.x + piece.w - 1, h: piece.y + piece.h - 1 },
        access: entry.access,
        build: entry.build,
      });
    }
  }
  next.push({ start: { w: sx, h: sy }, end: { w: ex, h: ey }, access, build });
  return { ...doc, box_mode: next };
}

export interface BuildingDefLike {
  key: string;
  w?: number;
  h?: number;
  hp?: number;
}

/** 建筑放置：占地走统一解析链（配置已给 > 裁定表 > 3×3），出界不放 */
export function addBuilding(doc: ConfigFile, x: number, y: number, def: BuildingDefLike, team: number): ConfigFile {
  const width = Number(doc.width ?? 0);
  const height = Number(doc.height ?? 0);
  if (!(width > 0 && height > 0)) return doc;
  const fp = footprintFor(def.key, def.w, def.h);
  const w = fp.w;
  const h = fp.h;
  if (x < 0 || y < 0 || x + w > width || y + h > height) return doc; // 出界不放（画布内点击天然在界内）
  const list = Array.isArray(doc.buildings) ? [...(doc.buildings as Patch[])] : [];
  list.push({ key: def.key, x, y, w, h, team });
  return { ...doc, buildings: list };
}

/** R28：移动地形补丁（矩形平移，钳图界） */
export function moveTerrainPatch(doc: ConfigFile, index: number, dx: number, dy: number): ConfigFile {
  const patches = Array.isArray(doc.terrain_patches) ? [...(doc.terrain_patches as Patch[])] : [];
  const entry = patches[index];
  if (!entry || typeof entry !== "object") return doc;
  const x = Math.max(0, Number(entry.x ?? 0) + dx);
  const y = Math.max(0, Number(entry.y ?? 0) + dy);
  const w = Math.max(1, Number(entry.w ?? 1));
  const h = Math.max(1, Number(entry.h ?? 1));
  patches[index] = { ...entry, x: Math.min(x, Math.max(0, Number(doc.width ?? 0) - w)), y: Math.min(y, Math.max(0, Number(doc.height ?? 0) - h)) };
  return { ...doc, terrain_patches: patches };
}

/** R28：移动 box 范围（start/end 同步平移，钳图界） */
export function moveBox(doc: ConfigFile, index: number, dx: number, dy: number): ConfigFile {
  const boxes = Array.isArray(doc.box_mode) ? [...(doc.box_mode as Patch[])] : [];
  const entry = boxes[index];
  if (!entry || typeof entry !== "object") return doc;
  const start = entry.start as Patch | undefined;
  const end = entry.end as Patch | undefined;
  if (!start || !end) return doc;
  const sx = Number(start.w ?? 0);
  const sy = Number(start.h ?? 0);
  const ex = Number(end.w ?? sx);
  const ey = Number(end.h ?? sy);
  const w = ex - sx;
  const h = ey - sy;
  const maxX = Math.max(0, Number(doc.width ?? 0) - 1 - w);
  const maxY = Math.max(0, Number(doc.height ?? 0) - 1 - h);
  const nsx = Math.max(0, Math.min(maxX, sx + dx));
  const nsy = Math.max(0, Math.min(maxY, sy + dy));
  boxes[index] = { ...entry, start: { w: nsx, h: nsy }, end: { w: nsx + w, h: nsy + h } };
  return { ...doc, box_mode: boxes };
}

/** R28：移动 decor 树 */
export function moveDecor(doc: ConfigFile, index: number, x: number, y: number): ConfigFile {
  const list = Array.isArray(doc.decor) ? [...(doc.decor as Patch[])] : [];
  const entry = list[index];
  if (!entry || typeof entry !== "object") return doc;
  list[index] = { ...entry, x, y };
  return { ...doc, decor: list };
}

/** R22：移动已放置对象（建筑/出生点）——仅改 x/y，其余字段原样保留 */
export function moveEntry(doc: ConfigFile, basePath: "buildings" | "spawns", index: number, x: number, y: number): ConfigFile {
  const list = Array.isArray(doc[basePath]) ? [...((doc as Record<string, unknown>)[basePath] as Array<Patch>)] : [];
  const entry = list[index];
  if (entry === null || typeof entry !== "object") return doc;
  list[index] = { ...(entry as Patch), x, y };
  return { ...doc, [basePath]: list };
}

export function addTree(doc: ConfigFile, x: number, y: number): ConfigFile {
  const list = Array.isArray(doc.decor) ? [...(doc.decor as Patch[])] : [];
  list.push({ kind: "tree", x, y });
  return { ...doc, decor: list };
}

export function addSpawn(doc: ConfigFile, x: number, y: number, kind: number, team: number, count = 1): ConfigFile {
  const list = Array.isArray(doc.spawns) ? [...(doc.spawns as Patch[])] : [];
  list.push({ kind, team, x, y, count });
  return { ...doc, spawns: list };
}

function cellInRect(cx: number, cy: number, x: number, y: number, w: number, h: number): boolean {
  return cx >= x && cy >= y && cx < x + w && cy < y + h;
}

/** 删除工具命中链（逆序=后放先删）：建筑 → box 范围 → decor → 出生点；命中即删并返回新 doc */
export function deleteAt(doc: ConfigFile, cx: number, cy: number): ConfigFile {
  const buildings = Array.isArray(doc.buildings) ? (doc.buildings as Patch[]) : null;
  if (buildings) {
    for (let i = buildings.length - 1; i >= 0; i -= 1) {
      const b = buildings[i];
      if (cellInRect(cx, cy, Number(b.x ?? 0), Number(b.y ?? 0), Number(b.w ?? 1), Number(b.h ?? 1))) {
        return { ...doc, buildings: buildings.filter((_, index) => index !== i) };
      }
    }
  }
  const boxes = Array.isArray(doc.box_mode) ? (doc.box_mode as Patch[]) : null;
  if (boxes) {
    for (let i = boxes.length - 1; i >= 0; i -= 1) {
      const box = boxes[i];
      const start = box.start as Patch | undefined;
      const end = box.end as Patch | undefined;
      if (!start || !end) continue;
      if (cx >= Number(start.w) && cy >= Number(start.h) && cx <= Number(end.w) && cy <= Number(end.h)) {
        return { ...doc, box_mode: boxes.filter((_, index) => index !== i) };
      }
    }
  }
  const decor = Array.isArray(doc.decor) ? (doc.decor as Patch[]) : null;
  if (decor) {
    for (let i = decor.length - 1; i >= 0; i -= 1) {
      if (Number(decor[i].x) === cx && Number(decor[i].y) === cy) {
        return { ...doc, decor: decor.filter((_, index) => index !== i) };
      }
    }
  }
  const spawns = Array.isArray(doc.spawns) ? (doc.spawns as Patch[]) : null;
  if (spawns) {
    for (let i = spawns.length - 1; i >= 0; i -= 1) {
      if (Number(spawns[i].x) === cx && Number(spawns[i].y) === cy) {
        return { ...doc, spawns: spawns.filter((_, index) => index !== i) };
      }
    }
  }
  return doc;
}

/** 工具态（画布交互语义）：none=仅预览；footprintW/H=建筑工具悬停幽灵与放置占地预览 */
export type CanvasTool =
  | "none"
  | "terrain"
  | "erase"
  | "box"
  | "building"
  | "tree"
  | "spawn"
  | "delete"
  | "move-unit" // R28 移动模式·游戏单位（建筑/炮台/出生点单位）
  | "move-shape" // R28 移动模式·地形图形（terrain 补丁/box 范围）
  | "move-render"; // R28 移动模式·渲染内容（decor 树等）

export interface ToolState {
  tool: CanvasTool;
  terrain: number;
  access: number;
  build: number;
  buildingKey: string;
  team: number;
  spawnKind: number;
  spawnTeam: number;
  spawnCount: number;
  footprintW: number;
  footprintH: number;
}

export const DEFAULT_TOOL_STATE: ToolState = {
  tool: "none",
  terrain: 4,
  access: 3,
  build: 1,
  buildingKey: "",
  team: 1,
  spawnKind: 0,
  spawnTeam: 1,
  spawnCount: 1,
  footprintW: 1,
  footprintH: 1,
};

export function buildingDefsOf(file: unknown): BuildingDefLike[] {
  if (file === null || typeof file !== "object") return [];
  const rows = (file as Record<string, unknown>).buildings;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row): row is Record<string, unknown> => row !== null && typeof row === "object")
    .map((row) => ({
      key: String(row.key ?? ""),
      // 缺省保持 undefined（不得强转 1）——占地解析链：配置已给 > 裁定表 > 3×3
      w: Number.isInteger(row.w) && (row.w as number) >= 1 ? (row.w as number) : undefined,
      h: Number.isInteger(row.h) && (row.h as number) >= 1 ? (row.h as number) : undefined,
      hp: Number.isFinite(Number(row.hp)) ? Number(row.hp) : undefined,
    }))
    .filter((def) => def.key.length > 0);
}

/** 文件名清洗（R15）：保留中文/CJK（Windows 与 Godot 资源路径均可），仅剔除路径
 *  非法字符与空白；防空串/点开头回退。与 store.cjs safeMapName 同口径。 */
export function sanitizeFileBase(name: string): string {
  const cleaned = String(name ?? "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/^\.+/, "");
  if (cleaned.length === 0 || cleaned === "." || cleaned === "..") return "";
  return cleaned;
}

/** 占地裁定表（2026-09-18 用户裁定，编辑器放置默认）：
 *  工厂类 小2×2 / 中3×3 / 大4×4；超级工厂 3×3；雷达/金矿/风电站 2×2；总部 4×4；科研中心 3×3。
 *  解析优先级：buildings.json 已保存的 w/h（实时，现仅莱德风暴/集束炮塔带 1×2）→ 本表 →
 *  sim 同款 3×3 回退（_load_buildings_from_map 的 bd.get("w", 3) 口径）。 */
export const FOOTPRINT_RULING: Record<string, { w: number; h: number }> = {
  tank_factory: { w: 2, h: 2 },
  tank_factory_m: { w: 3, h: 3 },
  tank_factory_l: { w: 4, h: 4 },
  tank_plant_s: { w: 2, h: 2 },
  tank_plant_m: { w: 3, h: 3 },
  tank_plant_l: { w: 4, h: 4 },
  super_factory: { w: 3, h: 3 },
  super_plant: { w: 3, h: 3 },
  radar: { w: 2, h: 2 },
  mine: { w: 2, h: 2 },
  wind_farm: { w: 2, h: 2 },
  hq: { w: 4, h: 4 },
  research_establishment: { w: 3, h: 3 },
};

/** 占地解析：配置已给 > 裁定表 > 3×3（sim 回退口径） */
export function footprintFor(key: string, configW?: number, configH?: number): { w: number; h: number } {
  if (Number.isInteger(configW) && Number.isInteger(configH) && (configW ?? 0) >= 1 && (configH ?? 0) >= 1) {
    return { w: configW as number, h: configH as number };
  }
  return FOOTPRINT_RULING[key] ?? { w: 3, h: 3 };
}

/** 出生点下拉用：单位 id → key（地图 spawns.kind 存的是单位 id） */
export function unitOptionsOf(rows: Entity[] | null): Array<{ id: number; key: string }> {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row) => Number.isInteger(Number(row.id)))
    .map((row) => ({ id: Number(row.id), key: String(row.key ?? "?") }));
}
