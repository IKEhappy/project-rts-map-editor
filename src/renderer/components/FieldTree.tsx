import { useState } from "react";
import type { Entity, JsonValue } from "../types";
import { enumOptions, type LabelsData } from "../labels";
import { FieldLabelView } from "./LabelBits";
import type { UnitSuggestion } from "../suggest";

type Path = Array<string | number>;

interface Props {
  entity: Entity;
  original: Entity;
  labels: LabelsData;
  lightErrors: Map<string, string>;
  unitSuggestions: UnitSuggestion[];
  onChange(next: Entity): void;
}

const IDENTITY_FIELDS = new Set(["id", "key"]);

/** 数组元素添加时的缺省值（克隆末行优先，空数组用此表兜底） */
const ARRAY_DEFAULTS: Record<string, JsonValue> = {
  flags: "",
  auto_attack_targets: "units",
  blast_radii_cells: 1,
  color: 0,
};

/** 锁定增删的对象数组：tiers 固定 3 行（MatchConfig 校验器锁死） */
const LOCKED_ARRAYS = new Set(["tiers"]);

function pathKey(path: Path): string {
  return path.map(String).join("-");
}

function deepClone<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function NumberInput(props: { value: number; testId: string; onCommit(next: number): void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? String(props.value);
  const commit = () => {
    if (draft === null) return;
    const parsed = Number(draft);
    if (Number.isFinite(parsed) && parsed !== props.value) props.onCommit(parsed);
    setDraft(null);
  };
  return (
    <input
      className="cell num"
      data-testid={props.testId}
      type="number"
      value={text}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setDraft(null);
      }}
    />
  );
}

/** 路径游标：路径按构造保证 字符串段索引对象、数字段索引数组 */
function getAt(container: Record<string, JsonValue> | JsonValue[], seg: string | number): Record<string, JsonValue> | JsonValue[] {
  if (typeof seg === "number") {
    return (container as JsonValue[])[seg] as Record<string, JsonValue> | JsonValue[];
  }
  return (container as Record<string, JsonValue>)[seg] as Record<string, JsonValue> | JsonValue[];
}

function parentAt(root: Entity, path: Path): Record<string, JsonValue> | JsonValue[] {
  let cursor: Record<string, JsonValue> | JsonValue[] = root;
  for (let i = 0; i < path.length - 1; i += 1) {
    cursor = getAt(cursor, path[i]);
  }
  return cursor;
}

/** 选中实体的字段树：标量行内编辑；标量数组逐元素增删/排序；对象数组（tiers/lines）嵌套展开。 */
export default function FieldTree(props: Props) {
  const { entity, original, labels, lightErrors, unitSuggestions, onChange } = props;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const update = (path: Path, value: JsonValue) => {
    const next = deepClone(entity);
    const parent = parentAt(next, path);
    (parent as Record<string, JsonValue>)[path[path.length - 1] as string] = value;
    onChange(next);
  };

  const removeElement = (path: Path) => {
    const next = deepClone(entity);
    const parent = parentAt(next, path);
    (parent as JsonValue[]).splice(path[path.length - 1] as number, 1);
    onChange(next);
  };

  const moveElement = (path: Path, delta: number) => {
    const index = path[path.length - 1] as number;
    const target = index + delta;
    const next = deepClone(entity);
    const arr = parentAt(next, path) as JsonValue[];
    if (target < 0 || target >= arr.length) return;
    const [moved] = arr.splice(index, 1);
    arr.splice(target, 0, moved);
    onChange(next);
  };

  const addElement = (arrayPath: Path, field: string) => {
    const next = deepClone(entity);
    let cursor: Record<string, JsonValue> | JsonValue[] = next;
    for (const seg of arrayPath) {
      cursor = getAt(cursor, seg);
    }
    const arr = cursor as JsonValue[];
    const last = arr[arr.length - 1];
    const options = enumOptions(labels, field);
    let element: JsonValue;
    if (last !== undefined) {
      element = deepClone(last);
    } else if (field in ARRAY_DEFAULTS) {
      element = deepClone(ARRAY_DEFAULTS[field]);
    } else if (options && options.length > 0) {
      element = options[0][0];
    } else if (field === "lines") {
      element = { unit: "", tier: 1, ticks: 60 };
    } else {
      element = {};
    }
    arr.push(element);
    onChange(next);
  };

  const toggleCollapse = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const renderScalar = (field: string, value: JsonValue, path: Path, testId: string): React.ReactNode => {
    const error = lightErrors.get(pathKey(path));
    if (typeof value === "number") {
      return (
        <span className={error ? "rule-error" : undefined} title={error ?? undefined}>
          <NumberInput value={value} testId={testId} onCommit={(next) => update(path, next)} />
        </span>
      );
    }
    if (typeof value === "boolean") {
      return <input className="cell chk" data-testid={testId} type="checkbox" checked={value} onChange={(e) => update(path, e.target.checked)} />;
    }
    if (typeof value === "string") {
      const error = lightErrors.get(pathKey(path));
      // lines[].unit：固定下拉（T-164 R2.2 用户改裁定）——只能选本建筑 role 组内单位，
      // 组外现存值保留为带警示的兜底选项（数据不静默丢失），不在选项内即不可选
      if (field === "unit" && path[0] === "lines" && unitSuggestions.length > 0) {
        const inGroup = unitSuggestions.some((suggestion) => suggestion.key === value);
        return (
          <select
            className="cell select"
            data-testid={testId}
            data-error={error}
            value={value}
            title={error}
            onChange={(e) => update(path, e.target.value)}
          >
            {unitSuggestions.map((suggestion) => (
              <option key={suggestion.key} value={suggestion.key}>
                {suggestion.label}
              </option>
            ))}
            {!inGroup ? <option value={value}>{value}（不在本建筑 role 组）</option> : null}
          </select>
        );
      }
      const options = enumOptions(labels, field);
      if (options) {
        const known = options.some(([v]) => v === value);
        return (
          <select className="cell select" data-testid={testId} value={value} onChange={(e) => update(path, e.target.value)}>
            {options.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
            {!known ? (
              <option value={value}>{value}</option>
            ) : null}
          </select>
        );
      }
      return (
        <input
          className={`cell str${error ? " invalid" : ""}`}
          data-testid={testId}
          data-error={error}
          type="text"
          value={value}
          title={error}
          onChange={(e) => update(path, e.target.value)}
        />
      );
    }
    return <span className="readonly">{JSON.stringify(value)}</span>;
  };

  const renderArray = (field: string, values: JsonValue[], originalValues: JsonValue[] | undefined, path: Path): React.ReactNode => {
    const key = pathKey(path);
    const isCollapsed = collapsed.has(key);
    const locked = LOCKED_ARRAYS.has(field);
    const objectRows = values.length > 0 && values.every((v) => v !== null && typeof v === "object" && !Array.isArray(v));
    return (
      <div className="tree-node">
        <button className="collapse-btn" onClick={() => toggleCollapse(key)} title={isCollapsed ? "展开" : "折叠"}>
          {isCollapsed ? "▸" : "▾"}
        </button>
        <span className="node-title">
          {values.length} 项{locked ? "（固定行数，禁增删）" : ""}
        </span>
        {!isCollapsed ? (
          <div className="tree-children">
            {values.map((element, index) =>
              objectRows ? (
                <div className="tree-row-box" key={index}>
                  <div className="tree-row-head">
                    <span className="row-index">#{index}</span>
                    {!locked ? (
                      <span className="row-ops">
                        <button className="mini" title="上移" onClick={() => moveElement([...path, index], -1)} disabled={index === 0}>
                          ↑
                        </button>
                        <button className="mini" title="下移" onClick={() => moveElement([...path, index], 1)} disabled={index === values.length - 1}>
                          ↓
                        </button>
                        <button className="mini danger" title="删除" onClick={() => removeElement([...path, index])}>
                          ✕
                        </button>
                      </span>
                    ) : null}
                  </div>
                  <FieldRows
                    node={element as Record<string, JsonValue>}
                    originalNode={(originalValues?.[index] ?? {}) as Record<string, JsonValue>}
                    path={path}
                    index={index}
                    renderField={(childField, childValue, originalChild, childPath) =>
                      renderFieldRow(childField, childValue, originalChild, childPath, false)
                    }
                  />
                </div>
              ) : (
                <div className="tree-row" key={index}>
                  <span className="row-index">{index}</span>
                  {renderScalar(field, element, [...path, index], `field-${pathKey([...path, index])}`)}
                  <span className="row-ops">
                    <button className="mini" title="上移" onClick={() => moveElement([...path, index], -1)} disabled={index === 0}>
                      ↑
                    </button>
                    <button className="mini" title="下移" onClick={() => moveElement([...path, index], 1)} disabled={index === values.length - 1}>
                      ↓
                    </button>
                    <button className="mini danger" title="删除" onClick={() => removeElement([...path, index])}>
                      ✕
                    </button>
                  </span>
                </div>
              ),
            )}
            {!locked ? (
              <button className="mini add" onClick={() => addElement(path, field)}>
                ＋ 添加
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  };

  const renderFieldRow = (
    field: string,
    value: JsonValue,
    originalValue: JsonValue | undefined,
    path: Path,
    identity: boolean,
  ): React.ReactNode => {
    const dirty = JSON.stringify(value) !== JSON.stringify(originalValue);
    const testId = `field-${pathKey(path)}`;
    let editor: React.ReactNode;
    if (identity) {
      editor = <span className="identity">{String(value)}</span>;
    } else if (Array.isArray(value)) {
      editor = renderArray(field, value, Array.isArray(originalValue) ? originalValue : undefined, path);
    } else if (value !== null && typeof value === "object") {
      editor = (
        <div className="tree-box">
          <FieldRows
            node={value as Record<string, JsonValue>}
            originalNode={(originalValue ?? {}) as Record<string, JsonValue>}
            path={path}
            renderField={(childField, childValue, originalChild, childPath) =>
              renderFieldRow(childField, childValue, originalChild, childPath, false)
            }
          />
        </div>
      );
    } else {
      editor = renderScalar(field, value, path, testId);
    }
    return (
      <div className={`field-row${dirty ? " dirty" : ""}`} key={field}>
        <div className="field-label" title={field}>
          <FieldLabelView field={field} labels={labels} />
        </div>
        <div className="field-editor">{editor}</div>
      </div>
    );
  };

  return (
    <div className="field-tree">
      {Object.entries(entity).map(([field, value]) =>
        renderFieldRow(field, value, (original as Record<string, JsonValue>)[field], [field], IDENTITY_FIELDS.has(field)),
      )}
    </div>
  );
}

/** 树中一层字段列表（实体本体与嵌套对象/对象数组行共用） */
function FieldRows(props: {
  node: Record<string, JsonValue>;
  originalNode: Record<string, JsonValue>;
  path: Path;
  index?: number;
  renderField(field: string, value: JsonValue, original: JsonValue | undefined, path: Path): React.ReactNode;
}) {
  const { node, originalNode, path, index, renderField } = props;
  return (
    <>
      {Object.entries(node).map(([field, value]) => {
        const childPath: Path = index === undefined ? [...path, field] : [...path, index, field];
        return renderField(field, value, originalNode[field], childPath);
      })}
    </>
  );
}
