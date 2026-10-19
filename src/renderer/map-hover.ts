import type { BackgroundInfo, ConfigFile, Entity, JsonValue } from "./types";

export interface HoverSources {
  buildings?: ConfigFile;
  units?: ConfigFile;
  renderConfig?: BackgroundInfo["renderConfig"];
  backgroundPath?: string;
}

export interface MapHoverDetails {
  texture: string[];
  effects: string[];
  objects: string[];
  box: string;
}

function object(value: JsonValue | undefined): Entity {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function rows(value: JsonValue | undefined): Entity[] {
  return Array.isArray(value) ? value.filter((v): v is Entity => v !== null && typeof v === "object" && !Array.isArray(v)) : [];
}
function text(value: JsonValue | undefined): string { return typeof value === "string" ? value : ""; }
function inRect(row: Entity, x: number, y: number): boolean {
  return x >= Number(row.x ?? 0) && y >= Number(row.y ?? 0) && x < Number(row.x ?? 0) + Number(row.w) && y < Number(row.y ?? 0) + Number(row.h);
}
function materialAt(ground: Entity, x: number, y: number): string {
  let material = text(ground.default_material);
  for (const patch of rows(ground.patches)) if (inRect(patch, x, y)) material = text(patch.material);
  return material;
}
function hash32(x: number, y: number, salt: number): number {
  // RenderConfig.hash32 v2: unsigned multiplication must retain all low 32 bits.
  let u = (Math.imul(x, 0x9e3779b1) ^ Math.imul(y, 0x85ebca77) ^ salt) >>> 0;
  u = Math.imul(u ^ (u >>> 16), 0x7feb352d) >>> 0;
  u = Math.imul(u ^ (u >>> 15), 0x846ca68b) >>> 0;
  return (u ^ (u >>> 16)) >>> 0;
}

const TERRAIN_NAMES: Record<number, string> = { 0: "普通地面", 1: "墙", 2: "悬崖", 3: "水面", 4: "普通地面" };
const ACCESS_NAMES = ["全部可通行", "禁止地面通行", "禁止飞碟通行", "禁止全部通行"];

/** Read-only inspection of a cell. Never changes map data or rebuilds canvas layers. */
export function mapHoverDetails(doc: Entity, x: number, y: number, terrain: number, sources: HoverSources = {}): MapHoverDetails {
  const result: MapHoverDetails = { texture: [], effects: [], objects: [], box: "" };
  const config = object(doc.config);
  const buildingDefs = rows(sources.buildings?.buildings);
  const unitDefs = rows(sources.units?.units);
  for (const row of rows(doc.buildings)) {
    if (!inRect(row, x, y)) continue;
    const key = text(row.key);
    const def = { ...buildingDefs.find((def) => def.key === key), ...object(object(config.buildings)[key]) };
    const name = text(def.name_cn) || text(row.name_cn) || "名称未配置";
    result.objects.push(`${key.startsWith("turret_") ? "炮台" : "建筑"} ${key || "key 未配置"} - ${name}`);
  }
  // Both lists are drawn by MapCanvas; keep their inspection visible too.
  const spawnLists: Array<[Entity[], string]> = [[rows(doc.spawns), "spawns"], [rows(object(doc.init).spawns), "init.spawns"]];
  for (const [list, source] of spawnLists) for (const row of list) {
    if (Math.floor(Number(row.x)) !== x || Math.floor(Number(row.y)) !== y) continue;
    const base = unitDefs.find((def) => def.id === row.kind || (typeof row.kind === "string" && def.key === row.kind));
    const key = text(base?.key) || text(row.key);
    const def = { ...base, ...object(object(config.units)[key]) };
    const name = text(def.name_cn) || text(row.name_cn) || "名称未配置";
    result.objects.push(`${key === "advancer" ? "飞碟" : "单位"} ${key || `kind=${String(row.kind ?? "未配置")}`} - ${name}（${source}）`);
  }
  const ground = object(doc.ground);
  const rc = sources.renderConfig;
  const material = materialAt(ground, x, y);
  const mat = material ? rc?.materials?.[material] : undefined;
  const weather = object(doc.weather);
  const intensity = Number(weather.intensity ?? 1);
  const weatherType = text(weather.type);
  const weatherActive = Number.isFinite(intensity) && intensity >= 0 && intensity <= 1 && rc?.weather?.includes(weatherType);
  if (sources.backgroundPath) {
    const extension = sources.backgroundPath.split(".").pop()?.toUpperCase();
    result.texture.push(`整图 ${extension || "图片"} · ${sources.backgroundPath}`);
  } else {
    result.texture.push(`地形 ${terrain} · ${TERRAIN_NAMES[terrain] ?? "未知类型"}`);
    if (material) result.texture.push(`材质 ${material}${mat ? "" : "（未解析）"}`);
    if (terrain === 2) result.effects.push(`悬崖${mat?.cliff ? ` · ${mat.cliff}` : "（程序绘制）"}`);
    if (terrain === 3) result.effects.push(`水面${mat?.water ? ` · ${mat.water}` : "（程序绘制）"}`);
    if ((terrain === 0 || terrain === 3 || terrain === 4) && mat) {
      const neighbor = [[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1]]
        .map(([dx,dy]) => [x + dx, y + dy])
        .filter(([nx,ny]) => nx >= 0 && ny >= 0 && nx < Number(doc.width) && ny < Number(doc.height))
        .map(([nx,ny]) => materialAt(ground, nx, ny)).find((id) => id !== material);
      if (neighbor && mat.transition?.[neighbor]) result.effects.push(`材质过渡 ${material} → ${neighbor} · ${mat.transition[neighbor]}`);
      const inRegion = terrain !== 3 && rows(ground.scatter_regions).some((r) => inRect(r, x, y)) && !rows(ground.scatter_exclude).some((r) => inRect(r, x, y));
      if (inRegion) for (const [id, scatter] of Object.entries(rc?.scatter ?? {})) {
        const salt = scatter.hash_salt ?? 0;
        const variants = scatter.variants ?? 1;
        if (!scatter.materials_on?.includes(material) || hash32(x, y, salt) / 4294967296 >= (scatter.density ?? 0)) continue;
        if (weatherType === "snow" && scatter.hide_when_snow && weatherActive) continue;
        if (!Number.isInteger(variants) || variants < 1) continue;
        // Keep inspection bounded for unvalidated external configurations.
        if (variants > 256) { result.effects.push(`散布配置 ${scatter.kind || id}（${variants} 个变体）`); continue; }
        if (!Array.from({ length: variants }, (_, v) => v).some((v) => hash32(x, y, salt + v + 1) % variants === v)) continue;
        result.effects.push(`散布 ${scatter.kind || id}`);
      }
    }
  }
  if (weatherActive) result.effects.push(`天气 ${weatherType}`);
  for (const row of rows(doc.decor)) if (Math.floor(Number(row.x)) === x && Math.floor(Number(row.y)) === y) result.effects.push(`装饰 ${text(row.kind) || "tree"}`);
  let access = 0, build = 0, index = -1;
  (Array.isArray(doc.box_mode) ? doc.box_mode : []).forEach((raw, i) => {
    const row = object(raw);
    const start = object(row.start), end = object(row.end);
    const values = [start.w, start.h, end.w, end.h, row.access, row.build].map((v) => typeof v === "number" ? v : NaN);
    if (!values.every(Number.isInteger)) return;
    const [sx, sy, ex, ey, acc, bld] = values;
    if (sx < 0 || sy < 0 || ex < sx || ey < sy || ex >= Number(doc.width) || ey >= Number(doc.height) || acc < 0 || acc > 3 || bld < 0 || bld > 1) return;
    if (x >= sx && y >= sy && x <= ex && y <= ey) {
      access = acc; build = bld; index = i;
    }
  });
  result.box = `box_mode${index >= 0 ? `[${index}]` : "（默认）"} · access=${access} ${ACCESS_NAMES[access] ?? "未知"} · build=${build} ${build === 1 ? "禁止建造" : build === 0 ? "允许建造" : "未知"}`;
  return result;
}
