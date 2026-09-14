// TS 轻校验（UX 层，T-164）：仅做键入时即时反馈，语义边界以 Godot gate
// （war-of-state/src/data/match_config.gd MatchConfig.validate）为准——冲突时以 gate 拒绝为准。
// 规则对照移植自 match_config.gd validate()，禁止在此扩展语义（防第二权威漂移）。
// R2：嵌套走全树（数组元素/三档子行/产线行），错误键为 path（如 "hp"、"flags-0"、"tiers-1-hp"）。

import type { Entity, JsonValue } from "./types";

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
