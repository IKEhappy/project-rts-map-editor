import { defaultsAtPath, featureSchemaForDocument, type FeatureSchema } from "./schema-templates.ts";
import type { ConfigFile, Entity, JsonValue } from "./types";

type Path = Array<string | number>;
interface MapSchemaSources {
  buildings?: ConfigFile;
  units?: ConfigFile;
  rules?: ConfigFile;
  toolTemplates?: ConfigFile;
}

const MAP_FIELDS: Entity = {
  version: 1, _note: "", name: "new_map", width: 48, height: 32,
  default_terrain: 0, seed: 1, renderer: "res://data/render/default.json",
  ground: { default_material: "grass" }, background: {},
  box_mode: [], terrain_patches: [], buildings: [], spawns: [], decor: [], init: {}, config: {},
};
// Placement overrides are a different contract from building definitions.
// In particular repair_rate/damage on a placement are not consumed by SimCore.
const BUILDING_FIELDS: Entity = {
  key: "mine", x: 0, y: 0, w: 1, h: 1, team: 0, hp: 500, level: 1,
  lines: [], unlocked_lines: 1, satellite: false, fog_mark: "reveal", fog_mark_capture: "keep",
};
const SPAWN_FIELDS: Entity = {
  kind: 0, x: 0, y: 0, team: 1, count: 1, fog_mark: "reveal", fog_mark_capture: "keep",
};

function object(value: JsonValue | undefined): Entity {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function put(target: Entity, key: string, value: JsonValue): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function pointer(path: Path): string {
  return path.filter((part): part is string => typeof part === "string")
    .map((part) => `/${part.replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");
}

interface ObservedFields {
  root: Entity;
  paths: Map<string, Entity>;
  hasObjectRows: boolean;
}

// Editing is immutable. An unchanged row/subtree has the same reference, so
// discover its future fields once rather than rescanning it on every keypress.
// These private observations retain input values; only detached clones are
// copied into a public schema below.
const observedFields = new WeakMap<object, ObservedFields>();

function mergeFields(target: Entity, source: Entity): void {
  for (const [key, value] of Object.entries(source)) {
    if (!Object.hasOwn(target, key)) put(target, key, value);
  }
}

function observe(node: Entity | JsonValue[]): ObservedFields {
  const previous = observedFields.get(node);
  if (previous) return previous;
  const result: ObservedFields = { root: {}, paths: new Map(), hasObjectRows: !Array.isArray(node) };
  const mergeChild = (path: string, child: ObservedFields) => {
    const fields = result.paths.get(path) ?? {};
    mergeFields(fields, child.root);
    result.paths.set(path, fields);
    for (const [suffix, nested] of child.paths) {
      const nestedPath = `${path}${suffix}`;
      const defaults = result.paths.get(nestedPath) ?? {};
      mergeFields(defaults, nested);
      result.paths.set(nestedPath, defaults);
    }
  };
  if (Array.isArray(node)) {
    for (const row of node) {
      if (row && typeof row === "object" && !Array.isArray(row)) {
        result.hasObjectRows = true;
        const child = observe(row);
        mergeFields(result.root, child.root);
        for (const [path, fields] of child.paths) {
          const defaults = result.paths.get(path) ?? {};
          mergeFields(defaults, fields);
          result.paths.set(path, defaults);
        }
      }
    }
  } else {
    for (const [key, value] of Object.entries(node)) {
      put(result.root, key, value);
      if (value && typeof value === "object") {
        const child = observe(value);
        if (child.hasObjectRows) mergeChild(pointer([key]), child);
      }
    }
  }
  observedFields.set(node, result);
  return result;
}

function scanObserved(schema: FeatureSchema, node: Entity): void {
  const observed = observe(node);
  const copyMissing = (target: Entity, source: Entity) => {
    for (const [key, value] of Object.entries(source)) {
      if (!Object.hasOwn(target, key)) put(target, key, clone(value));
    }
  };
  copyMissing(schema.root, observed.root);
  for (const [path, fields] of observed.paths) {
    copyMissing(schema.paths[path] ??= {}, fields);
  }
}

/** Collect future fields without introducing them into the edited document. */
function scan(schema: FeatureSchema, node: Entity, path: Path = [], overwrite = false): void {
  const target = path.length ? (schema.paths[pointer(path)] ??= {}) : schema.root;
  for (const [key, value] of Object.entries(node)) {
    if (overwrite || !Object.hasOwn(target, key)) put(target, key, clone(value));
    const childPath = [...path, key];
    if (Array.isArray(value)) {
      // Keep the first example of each field, rather than having the last line
      // in a definition silently replace its defaults.
      for (const child of value) if (child && typeof child === "object" && !Array.isArray(child)) scan(schema, child, childPath);
    } else if (value && typeof value === "object") scan(schema, value, childPath, overwrite);
  }
}

const absentSource: ConfigFile = {};
const definitionCache = new WeakMap<ConfigFile, Partial<Record<"buildings" | "units", Map<string, Entity>>>>();
const standardCache = new WeakMap<ConfigFile, WeakMap<ConfigFile, Partial<Record<"buildings" | "units", FeatureSchema>>>>();

function definitions(doc: ConfigFile | undefined, kind: "buildings" | "units"): Map<string, Entity> {
  const source = doc ?? absentSource;
  let cached = definitionCache.get(source);
  if (!cached) {
    cached = {};
    definitionCache.set(source, cached);
  }
  if (cached[kind]) return cached[kind];
  const rows = doc?.[kind];
  const result = new Map((Array.isArray(rows) ? rows : [])
    .filter((row): row is Entity => row !== null && typeof row === "object" && !Array.isArray(row) && typeof row.key === "string")
    .map((row) => [String(row.key), row]));
  cached[kind] = result;
  return result;
}

function standardSchema(kind: "buildings" | "units", doc?: ConfigFile, toolConfig?: ConfigFile): FeatureSchema {
  const source = doc ?? absentSource;
  const tool = toolConfig ?? absentSource;
  let tools = standardCache.get(source);
  if (!tools) {
    tools = new WeakMap();
    standardCache.set(source, tools);
  }
  let cached = tools.get(tool);
  if (!cached) {
    cached = {};
    tools.set(tool, cached);
  }
  return cached[kind] ??= featureSchemaForDocument(kind, doc, toolConfig);
}

/** Map config replaces arrays, including lines, rather than appending to them. */
function merge(base: Entity, override: Entity): Entity {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    put(result, key, value && typeof value === "object" && !Array.isArray(value)
      ? merge(object(base[key]), value) : value);
  }
  return result;
}

/** Standard defaults adapted to map placements and per-map config overrides. */
export function featureSchemaForMap(doc: ConfigFile, sources: MapSchemaSources = {}): FeatureSchema {
  let base: FeatureSchema | undefined;
  const getBase = (): FeatureSchema => {
    if (base) return base;
    base = { root: clone(MAP_FIELDS), paths: {
      "/buildings": clone(BUILDING_FIELDS), "/spawns": clone(SPAWN_FIELDS),
      "/terrain_patches": { x: 0, y: 0, w: 1, h: 1, terrain: 1 },
      "/box_mode": { start: { w: 0, h: 0 }, end: { w: 0, h: 0 }, access: 0, build: 0 },
      "/box_mode/start": { w: 0, h: 0 }, "/box_mode/end": { w: 0, h: 0 },
      "/decor": { kind: "tree", x: 0, y: 0 },
      "/background": { tilt: "", topdown: "", image: "" },
      "/config": { buildings: {}, units: {}, rules: {} },
    } };
    scanObserved(base, MAP_FIELDS);
    scanObserved(base, doc);
    return base;
  };
  const config = object(doc.config);
  const byKind = {
    buildings: definitions(sources.buildings, "buildings"),
    units: definitions(sources.units, "units"),
  };
  const cache = new Map<string, FeatureSchema>();
  const effectiveDefinition = (kind: "buildings" | "units", key: string) =>
    merge(byKind[kind].get(key) ?? {}, object(object(config[kind])[key]));
  const definitionSchema = (kind: "buildings" | "units", key: string): FeatureSchema => {
    const cacheKey = `${kind}/${key}`;
    const previous = cache.get(cacheKey);
    if (previous) return previous;
    const schema = clone(standardSchema(kind, sources[kind], sources.toolTemplates));
    const effective = effectiveDefinition(kind, key);
    scan(schema, effective, [], true);
    delete schema.root.id;
    delete schema.root.key;
    cache.set(cacheKey, schema);
    return schema;
  };
  return {
    get root() { return getBase().root; },
    get paths() { return getBase().paths; },
    resolvePath(path) {
      const fallback = defaultsAtPath(getBase(), path);
      if (path[0] === "buildings" && typeof path[1] === "number") {
        const rows = Array.isArray(doc.buildings) ? doc.buildings : [];
        const entry = object(rows[path[1]]);
        const key = String(entry.key ?? "");
        const schema = definitionSchema("buildings", key);
        if (path.length === 2) {
          const defaults = { ...fallback };
          const effective = effectiveDefinition("buildings", key);
          for (const field of Object.keys(BUILDING_FIELDS)) {
            if (field !== "key" && Object.hasOwn(effective, field)) defaults[field] = clone(effective[field]);
          }
          defaults.level = effective.init_level ?? BUILDING_FIELDS.level;
          defaults.lines = clone(effective.lines ?? schema.root.lines);
          return defaults;
        }
        return { ...fallback, ...defaultsAtPath(schema, path.slice(2)) };
      }
      if (path[0] === "config" && (path[1] === "buildings" || path[1] === "units")) {
        const kind = path[1];
        if (path.length === 2) return { ...fallback, ...Object.fromEntries([...byKind[kind].keys()].map((key) => [key, {}])) };
        if (typeof path[2] === "string") {
          const defaults = { ...fallback, ...defaultsAtPath(definitionSchema(kind, path[2]), path.slice(3)) };
          const def = byKind[kind].get(path[2]);
          // MatchConfig only permits a map to override fields present on this
          // definition. New capabilities belong in the config table first.
          if (path.length === 3 && def) return Object.fromEntries(Object.entries(defaults).filter(([key]) => Object.hasOwn(def, key) && key !== "id" && key !== "key"));
          return defaults;
        }
      }
      if (path.length === 2 && path[0] === "config" && path[1] === "rules") {
        return { ...fallback, ...Object.fromEntries(Object.entries(sources.rules ?? {}).filter(([key]) => key !== "version" && !key.startsWith("_"))) };
      }
      return fallback;
    },
  };
}
