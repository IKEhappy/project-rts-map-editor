// 单位建议集（T-164 R2.1，2026-09-14 用户裁定：按 role 分组——super→超级工厂系、
// vehicle→战车工厂系、summon→雷达）。解析当前建筑自身的引用（lines/produce_options）
// 推导所属 role 组，给出该组单位作为 datalist 建议；推导不出时回退全部单位。
// 建议式可自由输入：非法键由轻校验标红、保存时 Godot gate 拒绝（双层把关）。
import type { Entity } from "./types";
import type { LabelsData } from "./labels";

export interface UnitSuggestion {
  key: string;
  label: string;
}

function roleZh(labels: LabelsData, role: string): string {
  return labels.values?.role?.[role] ?? role;
}

/** 建议集：优先 = 当前建筑引用单位所属 role 组；无引用时 = 全部单位 */
export function unitSuggestionsFor(building: Entity, allUnits: Entity[] | null, labels: LabelsData): UnitSuggestion[] {
  if (!allUnits || allUnits.length === 0) return [];
  const referencedKeys = new Set<string>();
  const lines: unknown = building.lines;
  if (Array.isArray(lines)) {
    for (const row of lines) {
      if (row !== null && typeof row === "object" && !Array.isArray(row)) {
        const unit = (row as Record<string, unknown>).unit;
        if (typeof unit === "string") referencedKeys.add(unit);
      }
    }
  }
  const produceOptions: unknown = building.produce_options;
  if (Array.isArray(produceOptions)) {
    for (const id of produceOptions) {
      const unit = allUnits.find((candidate) => Number(candidate.id) === Number(id));
      if (unit) referencedKeys.add(String(unit.key));
    }
  }
  const roles = new Set<string>();
  for (const key of referencedKeys) {
    const unit = allUnits.find((candidate) => String(candidate.key) === key);
    if (unit && typeof unit.role === "string") roles.add(unit.role);
  }
  const pool =
    roles.size > 0 ? allUnits.filter((unit) => typeof unit.role === "string" && roles.has(unit.role)) : allUnits;
  return pool.map((unit) => ({
    key: String(unit.key),
    label: `${typeof unit.name_cn === "string" ? unit.name_cn : unit.key}（${roleZh(labels, String(unit.role ?? ""))}）`,
  }));
}

/** 已知单位键集合（轻校验用）；units 表编辑中用当前文档，其他表用缓存 */
export function knownUnitKeys(rows: Entity[] | null): Set<string> | null {
  if (!rows) return null;
  return new Set(rows.map((row) => String(row.key)));
}

/** summon 与 lines 引用一致性提示（不联动，仅提示——2026-09-14 用户裁定） */
export function summonLinesHint(building: Entity, allUnits: Entity[] | null): string | null {
  const summon: unknown = building.summon;
  const lines: unknown = building.lines;
  if (!Array.isArray(summon) || !Array.isArray(lines)) return null;
  const keyById = new Map<number, string>();
  for (const unit of allUnits ?? []) {
    keyById.set(Number(unit.id), String(unit.key));
  }
  const summonKeys = new Set<string>();
  for (const id of summon) {
    summonKeys.add(keyById.get(Number(id)) ?? `id:${String(id)}`);
  }
  const lineKeys = new Set<string>();
  for (const row of lines) {
    if (row !== null && typeof row === "object" && !Array.isArray(row)) {
      const unit = (row as Record<string, unknown>).unit;
      if (typeof unit === "string") lineKeys.add(unit);
    }
  }
  const onlySummon = [...summonKeys].filter((key) => !lineKeys.has(key));
  const onlyLines = [...lineKeys].filter((key) => !summonKeys.has(key));
  if (onlySummon.length === 0 && onlyLines.length === 0) return null;
  const parts: string[] = [];
  if (onlySummon.length > 0) parts.push(`summon 独有：${onlySummon.join(", ")}`);
  if (onlyLines.length > 0) parts.push(`lines 独有：${onlyLines.join(", ")}`);
  return `提示：summon 与 lines 引用的单位集不一致（工具不联动，仅提示）——${parts.join("；")}`;
}
