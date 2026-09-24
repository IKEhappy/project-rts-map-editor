// 显示层标签：labels.json（fields/values/rules），缺标签回退纯英文。
// 铁律：中文只出现在 UI，落盘 JSON 永远是英文键与英文值。
import type { JsonValue } from "./types";

export interface LabelsData {
  fields?: Record<string, string>;
  values?: Record<string, Record<string, string>>;
  rules?: Record<string, string>;
}

export interface LabelsReadResult {
  ok: boolean;
  data?: LabelsData;
  error?: string;
  path?: string;
}

export interface Labels {
  data: LabelsData;
}

/** 字段名显示：`attack_period（攻击间隔）`，无标签时纯英文 */
export function fieldLabel(labels: LabelsData, field: string): string {
  const zh = labels.fields?.[field];
  return zh ? `${field}（${zh}）` : field;
}

/** 枚举值显示：`line（直线高速）`，无标签时原值 */
export function valueLabel(labels: LabelsData, field: string, value: string): string {
  const zh = labels.values?.[field]?.[value];
  return zh ? `${value}（${zh}）` : value;
}

/**
 * 该字段是否有枚举值映射（决定用下拉还是文本框）。
 * R31：加一层按 (labels 身份, field) 的记忆化——FieldTree 每个字段行都调它，而一次渲染里
 * 同一 field 会被问很多次（buildings[] 展开 + lines[] 嵌套时尤为明显），且 labels 在会话内
 * 基本不变。缓存以 labels 对象为 WeakMap 键，labels 换了（重新加载）自然失效。
 */
const enumCache = new WeakMap<LabelsData, Map<string, Array<[string, string]> | null>>();

export function enumOptions(labels: LabelsData, field: string): Array<[string, string]> | null {
  let perLabels = enumCache.get(labels);
  if (!perLabels) {
    perLabels = new Map();
    enumCache.set(labels, perLabels);
  }
  const cached = perLabels.get(field);
  if (cached !== undefined) return cached;
  const map = labels.values?.[field];
  const computed = map ? Object.entries(map).map(([value, zh]) => [value, `${value}（${zh}）`] as [string, string]) : null;
  perLabels.set(field, computed);
  return computed;
}

/** 规则键显示 */
export function ruleLabel(labels: LabelsData, key: string): string {
  const zh = labels.rules?.[key];
  return zh ? `${key}（${zh}）` : key;
}

/** 实体显示名：name_cn（key） */
export function entityTitle(entity: Record<string, JsonValue>): string {
  const name = typeof entity.name_cn === "string" ? entity.name_cn : "";
  const key = typeof entity.key === "string" ? entity.key : "?";
  return name ? `${name}（${key}）` : key;
}
