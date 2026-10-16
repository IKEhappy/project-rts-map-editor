import type { ConfigFile, Entity, JsonValue, Kind } from "./types";
import { templatesOf, type TemplateDef } from "./templates.ts";

/**
 * The editor schema is deliberately separate from the runtime entity.
 * Several Godot systems use `has("lines")`, `has("damage")`, and similar
 * checks as capability flags. Putting every optional key on a new entity
 * would therefore create an unintended factory, turret, or summon unit.
 * `entity` contains only the safe base; `fields` contains complete defaults
 * offered by the Tree's "+ 新增字段" control.
 */
const UNIT_ENTITY: Entity = {
  id: 0,
  key: "new_unit",
  name_cn: "新单位",
  role: "vehicle",
  hp: 100,
  speed: 3,
  range: 3,
  damage: 5,
  armor: 0,
  attack_period: 20,
  flags: [],
  attack_fx: "line",
  auto_attack_targets: ["units", "turrets", "buildings"],
};

const BUILDING_ENTITY: Entity = {
  key: "new_building",
  name_cn: "新建筑",
  hp: 500,
  w: 1,
  h: 1,
  sim_height: 1,
  repair_rate: 5,
  upgrade_ticks: 200,
  max_level: 1,
  upgrade_tier_max: 0,
  unlocked_lines: 0,
};

const UNIT_TIER_DEFAULTS: Record<string, JsonValue> = {
  name_cn: "新规格",
  size_scale: 1,
  hp: 100,
  damage: 5,
  attack_period: 20,
  speed: 3,
  range: 3,
};

const LINE_DEFAULTS: Record<string, JsonValue> = {
  unit: "cougar",
  tier: 1,
  ticks: 60,
};

const FEATURE_DEFAULTS: Record<"units" | "buildings", Record<string, JsonValue>> = {
  units: {
    min_range: 0,
    vision: 0,
    attackable: true,
    respawn_seconds: 0,
    blast_radii_cells: [1],
    blast_interval_ticks: 5,
    tiers: [
      { ...UNIT_TIER_DEFAULTS },
      { ...UNIT_TIER_DEFAULTS, name_cn: "新规格 II", size_scale: 1.25, hp: 150, damage: 7 },
      { ...UNIT_TIER_DEFAULTS, name_cn: "新规格 III", size_scale: 1.5, hp: 200, damage: 9 },
    ],
    laser: { targets: [], range: 6, period: 45, damage: 25 },
    strike: { line_cells: 7, bombs_per_cell: 1, fall_ticks: 15, bomb_radius: 1 },
    chain: {
      strike_interval_ticks: 10,
      land_delay_ticks: 10,
      ring_diameter_cells: 4,
      ring_width_cells: 0.5,
      hex_radius_cells: 4,
      triangle_side_cells: 4,
    },
    meteor: {
      radius_cells: 6,
      window_ticks: 200,
      fall_ticks: 40,
      counts: { meteor_l: 4, meteor_m: 6, meteor_s: 10 },
    },
    warp: {
      charge_ticks: 40,
      interval_ticks: 12,
      arrive_delay_ticks: 6,
      templates: [{ weight: 1, slots: {} }],
    },
  },
  buildings: {
    init_level: 1,
    income: [0, 1],
    research: [0, 1],
    speed_up: [0, 1],
    warp_kill_radius: 0,
    cost: 0,
    vision: 0,
    is_hq: false,
    satellite: false,
    targets: "ground",
    damage: 3,
    range: 6,
    min_range: 1,
    attack_period: 25,
    attack_fx: "line",
    produce_default: 0,
    produce_options: [0],
    produce_lines: 1,
    summon: [0],
    // A production line must be non-empty and contain either a unit or an
    // effect. The editor keeps this valid example instead of inserting [].
    lines: [{ ...LINE_DEFAULTS }],
  },
};

const NESTED_DEFAULTS: Record<string, Record<string, JsonValue>> = {
  tiers: { ...UNIT_TIER_DEFAULTS, color: [1, 1, 1], texture: "" },
  lines: { ...LINE_DEFAULTS, upgrade: true, produce_ticks: 60, income: 1, research: 1, speed_up: 1 },
  laser: { targets: [], range: 6, period: 45, damage: 25 },
  strike: { line_cells: 7, bombs_per_cell: 1, fall_ticks: 15, bomb_radius: 1 },
  chain: {
    strike_interval_ticks: 10,
    land_delay_ticks: 10,
    ring_diameter_cells: 4,
    ring_width_cells: 0.5,
    hex_radius_cells: 4,
    triangle_side_cells: 4,
  },
  meteor: { radius_cells: 6, window_ticks: 200, fall_ticks: 40, counts: { meteor_l: 4, meteor_m: 6, meteor_s: 10 } },
  warp: { charge_ticks: 40, interval_ticks: 12, arrive_delay_ticks: 6, templates: [{ weight: 1, slots: {} }] },
};

const NESTED_FIELDS: Record<"units" | "buildings", Record<string, Entity>> = {
  units: { "/tiers": { color: [1, 1, 1], texture: "" } },
  buildings: { "/lines": { upgrade: true, produce_ticks: 60, income: 1, research: 1, speed_up: 1 } },
};

export interface FeatureSchema {
  root: Record<string, JsonValue>;
  /** Object defaults keyed by a logical tree path (array indexes omitted). */
  paths: Record<string, Record<string, JsonValue>>;
}

function clone<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function makeTemplate(kind: "units" | "buildings"): TemplateDef {
  return {
    key: "standard",
    name_cn: kind === "units" ? "通用单位" : "通用建筑",
    note: "map-editor 内置标准参数模板；实体只包含安全基础字段，其他能力从字段树按需添加",
    key_prefix: kind === "units" ? "new_unit" : "new_building",
    entity: clone(kind === "units" ? UNIT_ENTITY : BUILDING_ENTITY),
    fields: clone(FEATURE_DEFAULTS[kind]),
    nested_fields: clone(NESTED_FIELDS[kind]),
  };
}

/** Immutable-in-practice RAM templates. Every call returns a deep clone. */
export function builtinTemplate(kind: "units" | "buildings"): TemplateDef {
  return makeTemplate(kind);
}

export function builtinTemplates(kind: Kind): TemplateDef[] {
  return kind === "units" || kind === "buildings" ? [builtinTemplate(kind)] : [];
}

function templateLayers(kind: "units" | "buildings", doc?: ConfigFile, toolConfig?: ConfigFile): TemplateDef[][] {
  const toolRows = toolConfig?.[kind];
  return [
    builtinTemplates(kind),
    templatesOf({ templates: toolRows }),
    templatesOf(doc),
  ];
}

/** Project metadata wins over the optional tool config and the RAM baseline. */
export function templatesForDocument(kind: "units" | "buildings", doc?: ConfigFile, toolConfig?: ConfigFile): TemplateDef[] {
  const byKey = new Map<string, TemplateDef>();
  for (const layer of templateLayers(kind, doc, toolConfig)) {
    for (const template of layer) {
      const previous = byKey.get(template.key);
      const nestedFields: Record<string, Entity> = { ...previous?.nested_fields };
      for (const [path, fields] of Object.entries(template.nested_fields ?? {})) {
        if (fields && typeof fields === "object" && !Array.isArray(fields)) {
          nestedFields[path] = { ...nestedFields[path], ...fields };
        }
      }
      byKey.set(template.key, { ...template, fields: { ...previous?.fields, ...template.fields }, nested_fields: nestedFields });
    }
  }
  return [...byKey.values()];
}

/** Defaults for the object currently opened by FieldTree's add-field picker. */
export function featureDefaultsForPath(kind: "units" | "buildings", path: Array<string | number>): Record<string, JsonValue> {
  const root = path.length === 0 ? FEATURE_DEFAULTS[kind] : NESTED_DEFAULTS[String(path[0])] ?? {};
  return Object.fromEntries(Object.entries(root).map(([key, value]) => [key, clone(value)]));
}

export function featureDefaults(kind: "units" | "buildings"): Record<string, JsonValue> {
  return featureDefaultsForPath(kind, []);
}

function isObject(value: JsonValue): value is Entity {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pointerPart(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * Extend the built-in schema with keys found in the loaded document. This is
 * what keeps an older editor useful when the game adds a field first: the
 * editor can expose the key and copy a real value from the current data even
 * before the RAM schema is updated.
 */
export function featureSchemaForDocument(kind: "units" | "buildings", doc?: ConfigFile, toolConfig?: ConfigFile): FeatureSchema {
  const schema: FeatureSchema = { root: featureDefaults(kind), paths: {} };
  for (const [key, defaults] of Object.entries(NESTED_DEFAULTS)) schema.paths[`/${pointerPart(key)}`] = Object.fromEntries(Object.entries(defaults).map(([k, v]) => [k, clone(v)]));
  const addObject = (node: Entity, logicalPath: string, target: Record<string, JsonValue>, overwrite = false) => {
    for (const [key, value] of Object.entries(node)) {
      if (!logicalPath && (key === "id" || key === "key")) continue;
      if (overwrite || target[key] === undefined) target[key] = clone(value);
      const nextPath = `${logicalPath}/${pointerPart(key)}`;
      if (isObject(value)) {
        const next = schema.paths[nextPath] ?? (schema.paths[nextPath] = {});
        addObject(value, nextPath, next, overwrite);
      } else if (Array.isArray(value)) {
        for (const element of value) {
          if (isObject(element)) {
            const next = schema.paths[nextPath] ?? (schema.paths[nextPath] = {});
            addObject(element, nextPath, next, overwrite);
          }
        }
      }
    }
  };
  const rows = doc?.[kind];
  if (Array.isArray(rows)) for (const row of rows) if (isObject(row)) addObject(row, "", schema.root);
  // Explicit schema is authoritative, including fields not used by any entity
  // yet. Do not require a renderer update just to add a game parameter.
  for (const template of templateLayers(kind, doc, toolConfig).flat()) {
    for (const block of [template.entity, template.fields]) {
      if (block && isObject(block)) {
        addObject(block, "", schema.root, true);
      }
    }
    for (const [path, fields] of Object.entries(template.nested_fields ?? {})) {
      if (path.startsWith("/") && fields && isObject(fields)) {
        addObject(fields, path, schema.paths[path] ?? (schema.paths[path] = {}), true);
      }
    }
  }
  return schema;
}

export function defaultsAtPath(schema: FeatureSchema, path: Array<string | number>): Record<string, JsonValue> {
  if (path.length === 0) return schema.root;
  const logicalPath = path.filter((part): part is string => typeof part === "string").map((part) => `/${pointerPart(part)}`).join("");
  return schema.paths[logicalPath] ?? {};
}

