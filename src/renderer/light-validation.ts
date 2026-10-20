// TS 轻校验（UX 层，T-164）：仅做键入时即时反馈，语义边界以 Godot gate
// （war-of-state/src/data/match_config.gd MatchConfig.validate）为准——冲突时以 gate 拒绝为准。
// 规则对照移植自 match_config.gd validate()，禁止在此扩展语义（防第二权威漂移）。
// R2：嵌套走全树（数组元素/三档子行/产线行），错误键为 path（如 "hp"、"flags-0"、"tiers-1-hp"）。

import type { Entity, JsonValue } from "./types";
import { buildingCapacityError } from "./map-limits.ts";

export interface FieldRule {
  kind: "int" | "float" | "enum";
  min?: number;
  max?: number;
  values?: readonly string[];
}

export const FX_KINDS: readonly string[] = ["line", "laser", "beam", "missile", "flame", "flak"];
export const AUTO_TARGET_CLASSES: readonly string[] = ["units", "turrets", "buildings"];

const UNIT_FIELDS: Record<string, FieldRule> = {
  id: { kind: "int", min: 0 },
  hp: { kind: "int", min: 1 },
  speed: { kind: "int", min: 1, max: 1000 },
  range: { kind: "int", min: 0, max: 512 },
  min_range: { kind: "int", min: 0, max: 512 },
  damage: { kind: "int", min: 0 },
  armor: { kind: "int", min: 0 },
  attack_period: { kind: "int", min: 1 },
  respawn_seconds: { kind: "int", min: 0 },
  blast_interval_ticks: { kind: "int", min: 1, max: 255 },
  size_scale: { kind: "float", min: 0.25, max: 4 },
  attack_fx: { kind: "enum", values: FX_KINDS },
};

const BUILDING_FIELDS: Record<string, FieldRule> = {
  hp: { kind: "int", min: 1 },
  income: { kind: "int", min: 0 },
  repair_rate: { kind: "int", min: 0 },
  cost: { kind: "int", min: 0 },
  max_level: { kind: "int", min: 1, max: 255 },
  upgrade_tier_max: { kind: "int", min: 0, max: 2 },
  upgrade_ticks: { kind: "int", min: 1 },
  w: { kind: "int", min: 1, max: 512 },
  h: { kind: "int", min: 1, max: 512 },
  z: { kind: "int", min: 1, max: 512 },
  range: { kind: "int", min: 0, max: 512 },
  min_range: { kind: "int", min: 0, max: 512 },
  attack_period: { kind: "int", min: 1 },
  damage: { kind: "int", min: 0 },
  unlocked_lines: { kind: "int", min: 0 },
  produce_default: { kind: "int", min: 0 },
  speed_up: { kind: "int", min: 0 },
  attack_fx: { kind: "enum", values: FX_KINDS },
};

// match_config.gd validate()：正数间隔/预算键（0 非法）
const POSITIVE_RULES: readonly string[] = [
  "aggro_scan_period",
  "economy_div",
  "attack_period",
  "produce_period",
  "produce_min_period",
  "ai_period",
  "field_cache_max",
];

// match_config.gd validate()：防死循环上限
const RULES_CAPS: Record<string, number> = {
  field_cache_max: 256,
  field_build_budget: 256,
  sep_visit_cap: 4096,
  build_spot_range: 512,
  ai_air_threat_range: 512,
  ai_ground_defense_range: 512,
  advancers_per_hq: 4096,
  transport_deploy: 4096,
  wind_speed_up_limit: 100,
  stuck_ticks: 255,
  logan_lock_ticks: 255,
  neutral_start_hp_percent: 100,
};

type Path = Array<string | number>;

function pathKey(path: Path): string {
  return path.map(String).join("-");
}

function lastFieldName(path: Path): string | null {
  for (let i = path.length - 1; i >= 0; i -= 1) {
    if (typeof path[i] === "string") return path[i] as string;
  }
  return null;
}

function checkScalar(
  table: Record<string, FieldRule>,
  field: string,
  value: JsonValue,
  path: Path,
  errors: Map<string, string>,
): void {
  const rule = table[field];
  if (!rule) return;
  const key = pathKey(path);
  if (rule.kind === "enum") {
    if (typeof value === "string" && !rule.values!.includes(value)) {
      errors.set(key, `${field}：枚举值须为 ${rule.values!.join("/")}`);
    }
    return;
  }
  if (typeof value !== "number") return; // 类型翻转交给 gate 的 config_shape 拒绝
  if (!Number.isFinite(value)) {
    errors.set(key, `${field}：不是有限数字`);
    return;
  }
  if (rule.kind === "int" && !Number.isInteger(value)) {
    errors.set(key, `${field}：须为整数`);
    return;
  }
  if (rule.min !== undefined && value < rule.min) errors.set(key, `${field}：须 ≥ ${rule.min}`);
  else if (rule.max !== undefined && value > rule.max) errors.set(key, `${field}：须 ≤ ${rule.max}`);
}

/** 数组级规则（对照 match_config.gd 的 blast_radii_cells / auto_attack_targets / color） */
function checkArray(field: string, values: JsonValue[], path: Path, errors: Map<string, string>): void {
  if (field === "blast_radii_cells") {
    if (values.length < 1 || values.length > 8) {
      errors.set(pathKey(path), "blast_radii_cells：须 1..8 段");
    }
    let prev = 0;
    values.forEach((value, index) => {
      const key = pathKey([...path, index]);
      if (typeof value !== "number" || !Number.isInteger(value) || value <= prev || value > 512) {
        errors.set(key, "blast_radii_cells：须为 1..512 的严格递增整数");
      } else {
        prev = value;
      }
    });
    return;
  }
  if (field === "auto_attack_targets") {
    const seen = new Set<string>();
    values.forEach((value, index) => {
      const key = pathKey([...path, index]);
      if (typeof value !== "string" || !AUTO_TARGET_CLASSES.includes(value)) {
        errors.set(key, "auto_attack_targets：须为 units/turrets/buildings 子集");
      } else if (seen.has(value)) {
        errors.set(key, "auto_attack_targets：重复项");
      } else {
        seen.add(value);
      }
    });
    return;
  }
  if (field === "color") {
    if (values.length !== 3) {
      errors.set(pathKey(path), "color：须为 [r,g,b] 三元组");
    }
    values.forEach((value, index) => {
      if (typeof value !== "number" || value < 0 || value > 1) {
        errors.set(pathKey([...path, index]), "color：通道须在 0..1");
      }
    });
    return;
  }
  if (field === "produce_options") {
    values.forEach((value, index) => {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        errors.set(pathKey([...path, index]), "produce_options：须为非负整数（单位 id）");
      }
    });
  }
}

/** 实体全树轻校验；返回 path → 错误文案。knownUnitKeys 用于 lines.unit 未定义键提示（UX 层）。 */
export function validateEntityTree(
  entityKind: "units" | "buildings",
  entity: Entity,
  knownUnitKeys: Set<string> | null = null,
): Map<string, string> {
  const table = entityKind === "units" ? UNIT_FIELDS : BUILDING_FIELDS;
  const errors = new Map<string, string>();

  const walk = (node: JsonValue, path: Path): void => {
    if (Array.isArray(node)) {
      const field = lastFieldName(path);
      if (field) checkArray(field, node, path, errors);
      node.forEach((element, index) => walk(element, [...path, index]));
      return;
    }
    if (node !== null && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        walk(value, [...path, key]);
      }
      return;
    }
    const field = lastFieldName(path);
    if (field) {
      checkScalar(table, field, node, path, errors);
      if (field === "unit" && knownUnitKeys !== null && typeof node === "string" && !knownUnitKeys.has(node)) {
        errors.set(pathKey(path), `未定义单位键：${node}（不在单位表，保存时以 Godot 门禁为准）`);
      }
    }
  };

  walk(entity, []);
  return errors;
}

/** rules.json 键轻校验；返回 null = 通过 */
export function validateRuleValue(key: string, value: unknown): string | null {
  if (typeof value === "boolean") return null;
  if (typeof value !== "number") return `rules.${key}：须为非负整数或布尔`;
  if (!Number.isInteger(value) || value < 0) return `rules.${key}：须为非负整数`;
  if (POSITIVE_RULES.includes(key) && value === 0) return `rules.${key}：须为正数（间隔/预算）`;
  const cap = RULES_CAPS[key];
  if (cap !== undefined && value > cap) return `rules.${key}：超出支持上限 ${cap}`;
  if (key === "neutral_start_hp_percent" && value < 1) return "rules.neutral_start_hp_percent：须在 1..100";
  return null;
}

// —— 地图轻校验（T-164 R7）：仅键入时提示；语义以 map_gate.gd 真实构建链路为准 ——
// 规则对照移植自 dev-2d 契约：地形码 0..4（4=可通行禁建）、box_mode access 0..3 / build 0..1
// （start/end 闭区间格坐标，w=列 x、h=行 y）。错误键与实体树同口径（"-" 连接路径）。

const TERRAIN_CODES: readonly number[] = [0, 1, 2, 3, 4];
const ACCESS_CODES: readonly number[] = [0, 1, 2, 3];
const BUILD_CODES: readonly number[] = [0, 1];

function isIndex(value: unknown, min: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min;
}

type ObjectRow = [number, Record<string, unknown>];
interface BuildingGeometry { index: number; x: number; y: number; w: number; h: number; key: string }
interface SpawnGeometry { index: number; x: number; y: number }

const buildingGeometryCache = new WeakMap<unknown[], BuildingGeometry[]>();
const spawnGeometryCache = new WeakMap<unknown[], SpawnGeometry[]>();
const noBuildingGeometry: BuildingGeometry[] = [];
const noSpawnGeometry: SpawnGeometry[] = [];
let lastBuildingGeometry = noBuildingGeometry;
let lastSpawnGeometry = noSpawnGeometry;

function buildingGeometry(raw: unknown, rows: ObjectRow[]): BuildingGeometry[] {
  if (!Array.isArray(raw)) return noBuildingGeometry;
  const previous = buildingGeometryCache.get(raw);
  if (previous) return lastBuildingGeometry = previous;
  const projected = rows.map(([index, row]) => ({
    index, x: Number(row.x), y: Number(row.y), w: Number(row.w ?? 1), h: Number(row.h ?? 1), key: String(row.key ?? "?"),
  }));
  // A changed hp/team/production line is a new document row but has the same
  // collision geometry. Reuse the projection identity in that case as well.
  const same = projected.length === lastBuildingGeometry.length && projected.every((row, index) => {
    const old = lastBuildingGeometry[index];
    return row.index === old.index && row.key === old.key && Object.is(row.x, old.x) && Object.is(row.y, old.y)
      && Object.is(row.w, old.w) && Object.is(row.h, old.h);
  });
  const result = same ? lastBuildingGeometry : projected;
  buildingGeometryCache.set(raw, result);
  return lastBuildingGeometry = result;
}

function spawnGeometry(raw: unknown, rows: ObjectRow[]): SpawnGeometry[] {
  if (!Array.isArray(raw)) return noSpawnGeometry;
  const previous = spawnGeometryCache.get(raw);
  if (previous) return lastSpawnGeometry = previous;
  const projected = rows.map(([index, row]) => ({ index, x: Number(row.x), y: Number(row.y) }));
  const same = projected.length === lastSpawnGeometry.length && projected.every((row, index) => {
    const old = lastSpawnGeometry[index];
    return row.index === old.index && Object.is(row.x, old.x) && Object.is(row.y, old.y);
  });
  const result = same ? lastSpawnGeometry : projected;
  spawnGeometryCache.set(raw, result);
  return lastSpawnGeometry = result;
}

const collisionCache = new WeakMap<BuildingGeometry[], WeakMap<SpawnGeometry[], Map<string, string>>>();

function collisionErrors(buildings: BuildingGeometry[], spawns: SpawnGeometry[]): Map<string, string> {
  let bySpawns = collisionCache.get(buildings);
  if (!bySpawns) {
    bySpawns = new WeakMap();
    collisionCache.set(buildings, bySpawns);
  }
  const previous = bySpawns.get(spawns);
  if (previous) return previous;
  const errors = new Map<string, string>();
  for (let i = 0; i < buildings.length; i += 1) {
    const a = buildings[i];
    for (let j = i + 1; j < buildings.length; j += 1) {
      const b = buildings[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
        errors.set(`buildings-${a.index}-overlap`, `建筑占位重叠：${a.key} 与 ${b.key}（地图内理论不可重合，请挪开）`);
      }
    }
  }
  for (let i = 0; i < spawns.length; i += 1) {
    const spawn = spawns[i];
    for (const b of buildings) {
      if (spawn.x >= b.x && spawn.y >= b.y && spawn.x < b.x + b.w && spawn.y < b.y + b.h) {
        errors.set(`spawns-${spawn.index}-overlap`, `出生点（${spawn.x},${spawn.y}）落在建筑 ${b.key} 占位内（不可重合）`);
        break;
      }
    }
    for (let j = i + 1; j < spawns.length; j += 1) {
      if (spawns[j].x === spawn.x && spawns[j].y === spawn.y) {
        errors.set(`spawns-${spawn.index}-dup`, `出生点重复占格：（${spawn.x},${spawn.y}）出现多次（不可重合）`);
      }
    }
  }
  bySpawns.set(spawns, errors);
  return errors;
}

/**
 * Validate the semantic contract for a map-level building `lines` override.
 * The game accepts either a unit production row or a functional row carrying
 * at least one positive effect.  Keeping this check in the map feedback layer
 * prevents an empty line (the old "unit: \"\"" insertion default) from
 * reaching the Godot gate and gives the editor a precise field path.
 *
 * `knownUnitKeys` is optional because the map panel can be opened before the
 * units table has finished loading.  Shape/effect validation remains useful in
 * that state; when the set is available we also mirror SimCore's unknown-unit
 * rejection.
 */
export function validateMapLines(
  doc: Entity,
  knownUnitKeys: Set<string> | null = null,
): Map<string, string> {
  const errors = new Map<string, string>();
  if (!Array.isArray(doc.buildings)) return errors;
  doc.buildings.forEach((rawBuilding, buildingIndex) => {
    if (rawBuilding === null || typeof rawBuilding !== "object" || Array.isArray(rawBuilding)) return;
    const building = rawBuilding as Entity;
    if (!Object.hasOwn(building, "lines")) return;
    const lines = building.lines;
    const base = `buildings-${buildingIndex}-lines`;
    if (!Array.isArray(lines)) {
      errors.set(base, "lines：地图覆盖须为数组");
      return;
    }
    lines.forEach((rawLine, lineIndex) => {
      const path = `${base}-${lineIndex}`;
      if (rawLine === null || typeof rawLine !== "object" || Array.isArray(rawLine)) {
        errors.set(path, "产线行：须为对象");
        return;
      }
      const line = rawLine as Entity;
      const unit = line.unit;
      const hasUnit = typeof unit === "string" && unit.trim().length > 0;
      if (unit !== undefined && typeof unit !== "string") {
        errors.set(`${path}-unit`, "unit：须为单位 key 字符串");
      } else if (hasUnit && knownUnitKeys && !knownUnitKeys.has(unit as string)) {
        errors.set(`${path}-unit`, `未定义单位键：${unit}`);
      }
      // SimCore only reads tier for unit rows; functional resource rows are
      // identified by their effect and deliberately do not require a tier.
      if (hasUnit && line.tier !== undefined && (typeof line.tier !== "number" || !Number.isInteger(line.tier) || line.tier < 1 || line.tier > 3)) {
        errors.set(`${path}-tier`, "tier：须为 1..3 的整数");
      }
      for (const ticksKey of ["ticks", "produce_ticks"]) {
        const ticks = line[ticksKey];
        if (ticks !== undefined && (typeof ticks !== "number" || !Number.isFinite(ticks) || !Number.isInteger(ticks) || ticks < 1)) {
          errors.set(`${path}-${ticksKey}`, `${ticksKey}：须为 ≥1 的整数`);
        }
      }
      let hasEffect = false;
      for (const effect of ["income", "research", "speed_up"]) {
        const value = line[effect];
        if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 1)) {
          errors.set(`${path}-${effect}`, `${effect}：须为 ≥1 的数值`);
        }
        if (typeof value === "number" && Number.isFinite(value) && value >= 1) hasEffect = true;
      }
      if (!hasUnit && !hasEffect) {
        errors.set(path, "产线行：须包含有效 unit，或至少一个 ≥1 的 income/research/speed_up");
      }
    });
  });
  return errors;
}

export function validateMapTree(doc: Entity, knownUnitKeys: Set<string> | null = null): Map<string, string> {
  const errors = new Map<string, string>();
  for (const [path, message] of validateMapLines(doc, knownUnitKeys)) errors.set(path, message);
  if (doc.background !== undefined && doc.background !== null) {
    const background = doc.background;
    if (typeof background !== "object" || Array.isArray(background)) {
      errors.set("background", "background：须为对象 {tilt?,topdown?,image?}，错误声明不会回退渲染配置");
    } else {
      for (const [key, value] of Object.entries(background)) {
        if (!["tilt", "topdown", "image"].includes(key)) errors.set(`background-${key}`, `background：未知视角 ${key}`);
        else if (typeof value !== "string") errors.set(`background-${key}`, `${key}：须为 PNG/JPG 资源路径字符串`);
        else if (value !== "" && (!value.startsWith("res://") || !/\.(?:png|jpe?g)$/i.test(value) || value.slice(6).split("/").some((part) => !part || part === "." || part === "..") || /[\\\x00-\x1f\x7f]/.test(value))) errors.set(`background-${key}`, `${key}：须为项目内 res:// PNG/JPG 资源路径`);
      }
    }
  }
  const width = doc.width;
  const height = doc.height;
  if (!isIndex(width, 1) || width > 512) errors.set("width", "width：须为 1..512 的整数（格）");
  if (!isIndex(height, 1) || height > 512) errors.set("height", "height：须为 1..512 的整数（格）");

  const patches: unknown = doc.terrain_patches;
  if (patches !== undefined && !Array.isArray(patches)) errors.set("terrain_patches", "terrain_patches：须为对象数组");
  if (Array.isArray(patches)) {
    patches.forEach((patch, index) => {
      const base = `terrain_patches-${index}`;
      if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
        errors.set(base, "terrain_patches：元素须为对象 {x,y,w,h,terrain}");
        return;
      }
      const p = patch as Record<string, unknown>;
      if (!isIndex(p.x, 0)) errors.set(`${base}-x`, "x：须为 ≥0 整数");
      if (!isIndex(p.y, 0)) errors.set(`${base}-y`, "y：须为 ≥0 整数");
      if (!isIndex(p.w, 1)) errors.set(`${base}-w`, "w：须为 ≥1 整数");
      if (!isIndex(p.h, 1)) errors.set(`${base}-h`, "h：须为 ≥1 整数");
      if (typeof p.terrain !== "number" || !TERRAIN_CODES.includes(p.terrain)) {
        errors.set(`${base}-terrain`, "terrain：须为 0..4（0 可通行/1 阻挡/2 山体/3 水面/4 可通行禁建）");
      }
      if (isIndex(p.x, 0) && p.x > 512) errors.set(`${base}-x`, "x：超出 512 上限（疑似误输入）");
      if (isIndex(p.y, 0) && p.y > 512) errors.set(`${base}-y`, "y：超出 512 上限（疑似误输入）");
      if (isIndex(p.w, 1) && p.w > 512) errors.set(`${base}-w`, "w：超出 512 上限（画布会按图界钳制渲染，保存前请修正）");
      if (isIndex(p.h, 1) && p.h > 512) errors.set(`${base}-h`, "h：超出 512 上限（画布会按图界钳制渲染，保存前请修正）");
      if (isIndex(p.x, 0) && isIndex(width, 1) && p.x >= width) errors.set(`${base}-x`, `x：越界（图宽 ${width}）`);
      if (isIndex(p.y, 0) && isIndex(height, 1) && p.y >= height) errors.set(`${base}-y`, `y：越界（图高 ${height}）`);
    });
  }

  // R20：占位冲突警告——建筑/单位/炮台任意两者不得重合（触发召唤物点位不占位、可覆盖）
  const objectRows = (key: "buildings" | "spawns" | "decor"): ObjectRow[] => {
    const raw = doc[key];
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) { errors.set(key, `${key}：须为对象数组`); return []; }
    const rows: ObjectRow[] = [];
    raw.forEach((value, index) => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) errors.set(`${key}-${index}`, `${key}：元素须为对象`);
      else rows.push([index, value]);
    });
    return rows;
  };
  const blds = objectRows("buildings");
  if (Array.isArray(doc.buildings)) {
    const capacityError = buildingCapacityError(doc.buildings.length);
    if (capacityError) errors.set("buildings", capacityError);
  }
  objectRows("decor");
  const spawnRows = objectRows("spawns");
  for (const [path, message] of collisionErrors(buildingGeometry(doc.buildings, blds), spawnGeometry(doc.spawns, spawnRows))) errors.set(path, message);

  const boxes: unknown = doc.box_mode;
  if (boxes !== undefined && !Array.isArray(boxes)) errors.set("box_mode", "box_mode：须为对象数组");
  if (Array.isArray(boxes)) {
    boxes.forEach((box, index) => {
      const base = `box_mode-${index}`;
      if (box === null || typeof box !== "object" || Array.isArray(box)) {
        errors.set(base, "box_mode：元素须为对象 {start,end,access,build}");
        return;
      }
      const b = box as Record<string, unknown>;
      const pt = (name: string): Record<string, unknown> | null => {
        const value = b[name];
        if (value === null || typeof value !== "object") {
          errors.set(`${base}-${name}`, `${name}：须为对象 {w,h}（w=列 x、h=行 y）`);
          return null;
        }
        return value as Record<string, unknown>;
      };
      const start = pt("start");
      const end = pt("end");
      if (start) {
        if (!isIndex(start.w, 0)) errors.set(`${base}-start-w`, "start.w：须为 ≥0 整数");
        if (!isIndex(start.h, 0)) errors.set(`${base}-start-h`, "start.h：须为 ≥0 整数");
      }
      if (end && start) {
        if (!isIndex(end.w, 0)) errors.set(`${base}-end-w`, "end.w：须为 ≥0 整数");
        if (!isIndex(end.h, 0)) errors.set(`${base}-end-h`, "end.h：须为 ≥0 整数");
        if (isIndex(end.w, 0) && isIndex(start.w, 0) && end.w < start.w) {
          errors.set(`${base}-end-w`, "end.w：须 ≥ start.w（左上→右下闭区间）");
        }
        if (isIndex(end.h, 0) && isIndex(start.h, 0) && end.h < start.h) {
          errors.set(`${base}-end-h`, "end.h：须 ≥ start.h（左上→右下闭区间）");
        }
        if (isIndex(end.w, 0) && isIndex(width, 1) && end.w >= width) errors.set(`${base}-end-w`, `end.w：越界（图宽 ${width}）`);
        if (isIndex(end.h, 0) && isIndex(height, 1) && end.h >= height) errors.set(`${base}-end-h`, `end.h：越界（图高 ${height}）`);
      }
      if (typeof b.access !== "number" || !ACCESS_CODES.includes(b.access)) {
        errors.set(`${base}-access`, "access：须为 0..3（0 全通行/1 禁地面/2 禁飞碟/3 禁所有）");
      }
      if (typeof b.build !== "number" || !BUILD_CODES.includes(b.build)) {
        errors.set(`${base}-build`, "build：须为 0 或 1（0 可建/1 禁建）");
      }
    });
  }
  return errors;
}
