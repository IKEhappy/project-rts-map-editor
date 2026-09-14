// 模板实例化（T-164 R9）：数据文件内 "templates" 数组 → 新实体（唯一 id/key/name_cn）。
import type { Entity } from "./types";

export interface TemplateDef {
  key: string;
  name_cn: string;
  note?: string;
  key_prefix?: string;
  entity: Entity;
}

export function templatesOf(file: unknown): TemplateDef[] {
  if (!file || typeof file !== "object") return [];
  const templates = (file as Record<string, unknown>).templates;
  if (!Array.isArray(templates)) return [];
  return templates.filter(
    (tpl): tpl is TemplateDef =>
      tpl !== null && typeof tpl === "object" && !Array.isArray(tpl) &&
      typeof (tpl as Record<string, unknown>).key === "string" &&
      (tpl as Record<string, unknown>).entity !== null &&
      typeof (tpl as Record<string, unknown>).entity === "object",
  );
}

function deepClone<T extends Entity>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 从模板生成新实体：id/key 置于字段序首（与既有实体展示一致），key/name_cn 加序号保证唯一 */
export function instantiateTemplate(tpl: TemplateDef, rows: Entity[]): Entity {
  const entity = deepClone(tpl.entity);
  const prefix = tpl.key_prefix || `new_${tpl.key}`;
  const keys = new Set(rows.map((row) => String(row.key)));
  let index = 1;
  while (keys.has(`${prefix}_${index}`)) index += 1;
  const ids = rows.map((row) => Number(row.id)).filter((id) => Number.isFinite(id));
  const nextId = ids.length > 0 ? Math.max(...ids) + 1 : undefined;
  // 显式按 id、key、其余模板字段的顺序组装（模板本身已按既有实体的字段序编写）
  const ordered: Entity = {};
  if (nextId !== undefined || entity.id !== undefined) ordered.id = nextId ?? Number(entity.id ?? 0);
  ordered.key = `${prefix}_${index}`;
  for (const field of Object.keys(entity)) {
    if (field === "id" || field === "key") continue;
    ordered[field] = entity[field];
  }
  ordered.name_cn =
    typeof tpl.entity.name_cn === "string" ? `${tpl.entity.name_cn}${index > 1 ? index : ""}` : prefix;
  return ordered;
}
