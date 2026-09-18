import { useEffect, useRef, useState } from "react";
import type { Entity, JsonValue } from "../types";
import { enumOptions, fieldLabel, type LabelsData } from "../labels";
import Dropdown, { type DropdownOption } from "./Dropdown";
import { FieldLabelView } from "./LabelBits";
import type { UnitSuggestion } from "../suggest";

type Path = Array<string | number>;

interface Props {
  entity: Entity;
  original: Entity;
  labels: LabelsData;
  lightErrors: Map<string, string>;
  unitSuggestions: UnitSuggestion[];
  /** 新实体（未存在于已保存文件）：key/id 可编辑（T-164 R10，保存后锁定） */
  identityEditable?: boolean;
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

/** R30：对象字段可创建默认值——地图条目初始缺 lines/unlocked_lines 等字段时"＋ 新增字段"用 */
const FIELD_CREATABLE: Record<string, JsonValue> = {
  lines: [], // 数组：创建空数组后即可"＋ 添加"行
  unlocked_lines: 1,
  income: 1,
  research: 1,
  speed_up: 1,
  level: 1,
  hp: 500,
  team: 1,
  count: 1,
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
  // R13：数字可解析即提交（点步进/逐键即时落文档——旧版只在 blur/回车提交，点 +/- 后
  // 画布与文档"没反应"即此因）；非法中间态（空串/首 "-"）留在草稿等 blur 丢弃。
  const commitText = (raw: string | null) => {
    if (raw === null) return;
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed !== props.value) props.onCommit(parsed);
  };
  const commit = () => {
    commitText(draft);
    setDraft(null);
  };
  // 自绘步进（原生 spinner 步进 1 且无加速，大跨度要长按很久）：单击 ±1，
  // 按住 400ms 后自动重复并逐步加速（间隔 400→50ms），松开/离开即停
  const holdRef = useRef<{ timer: number | null; delay: number } | null>(null);
  const stopHold = () => {
    const state = holdRef.current;
    if (state && state.timer !== null) window.clearTimeout(state.timer);
    holdRef.current = null;
  };
  useEffect(() => stopHold, []);
  const stepBy = (dir: number) => {
    const base = draft !== null && Number.isFinite(Number(draft)) ? Number(draft) : props.value;
    const next = Math.round((base + dir) * 1e6) / 1e6;
    setDraft(null);
    if (Number.isFinite(next) && next !== props.value) props.onCommit(next);
  };
  const startHold = (dir: number) => (event: React.PointerEvent) => {
    event.preventDefault();
    stopHold();
    stepBy(dir);
    const state = { timer: null as number | null, delay: 400 };
    holdRef.current = state;
    const tick = () => {
      stepBy(dir);
      state.delay = Math.max(50, state.delay / 1.4);
      state.timer = window.setTimeout(tick, state.delay);
    };
    state.timer = window.setTimeout(tick, state.delay);
  };
  return (
    <div className="num-cell">
      <button
        className="step-btn"
        data-testid={`${props.testId}-step-down`}
        title="减（按住加速）"
        onPointerDown={startHold(-1)}
        onPointerUp={stopHold}
        onPointerLeave={stopHold}
      >
        −
      </button>
      <input
        className="cell num"
        data-testid={props.testId}
        type="number"
        value={text}
        onChange={(e) => {
          setDraft(e.target.value);
          commitText(e.target.value);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setDraft(null);
        }}
      />
      <button
        className="step-btn"
        data-testid={`${props.testId}-step-up`}
        title="加（按住加速）"
        onPointerDown={startHold(1)}
        onPointerUp={stopHold}
        onPointerLeave={stopHold}
      >
        ＋
      </button>
    </div>
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
  const { entity, original, labels, lightErrors, unitSuggestions, identityEditable, onChange } = props;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // 顶层字段拖拽排序（T-164 R10：三横杠手柄拖动调整字段顺序，写回 JSON 键序）
  const [dragField, setDragField] = useState<string | null>(null);
  const [dropField, setDropField] = useState<string | null>(null);

  const moveField = (from: string, to: string) => {
    if (from === to) return;
    const keys = Object.keys(entity);
    const fromIndex = keys.indexOf(from);
    const toIndex = keys.indexOf(to);
    if (fromIndex < 0 || toIndex < 0) return;
    keys.splice(toIndex, 0, keys.splice(fromIndex, 1)[0]);
    const next: Entity = {};
    for (const key of keys) next[key] = entity[key];
    onChange(next);
  };

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

  /** R30：给对象加字段——下拉选 FIELD_CREATABLE 中未存在的键，或输入自定义键名 */
  const AddFieldButton = ({ path }: { path: Path }) => {
    const [open, setOpen] = useState(false);
    const [name, setName] = useState("");
    const existing = new Set<string>();
    let cursor: JsonValue = entity;
    for (const seg of path) cursor = getAt(cursor as Record<string, JsonValue> | JsonValue[], seg);
    if (cursor && typeof cursor === "object" && !Array.isArray(cursor)) {
      for (const k of Object.keys(cursor as Record<string, JsonValue>)) existing.add(k);
    }
    const candidates = Object.keys(FIELD_CREATABLE).filter((k) => !existing.has(k));
    const commit = (fieldName: string) => {
      if (!fieldName || existing.has(fieldName)) return;
      const next = deepClone(entity);
      let cur: Record<string, JsonValue> | JsonValue[] = next;
      for (const seg of path) cur = getAt(cur, seg);
      (cur as Record<string, JsonValue>)[fieldName] = deepClone(FIELD_CREATABLE[fieldName] ?? "");
      onChange(next);
      setOpen(false);
      setName("");
    };
    return (
      <div className="add-field-row">
        {open ? (
          <>
            <input
              className="cell str"
              data-testid={`add-field-input-${pathKey(path)}`}
              type="text"
              placeholder="字段名…"
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit(name.trim());
                if (e.key === "Escape") setOpen(false);
              }}
            />
            <button className="mini" data-testid={`add-field-ok-${pathKey(path)}`} title="创建" onClick={() => commit(name.trim())}>✓</button>
            {candidates.length > 0 ? (
              <select
                className="cell"
                data-testid={`add-field-select-${pathKey(path)}`}
                value=""
                onChange={(e) => {
                  if (e.target.value) commit(e.target.value);
                }}
              >
                <option value="">常用字段…</option>
                {candidates.map((k) => (
                  <option key={k} value={k}>{k}</option>
                ))}
              </select>
            ) : null}
            <button className="mini" title="取消" onClick={() => setOpen(false)}>✕</button>
          </>
        ) : (
          <button className="mini add" data-testid={`add-field-btn-${pathKey(path)}`} onClick={() => setOpen(true)}>
            ＋ 新增字段
          </button>
        )}
      </div>
    );
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
    // R27：数字字段若在 labels.values 有枚举组（access/build/terrain 等）→ 优先渲染
    // 自绘 Dropdown（数字值匹配选项 value），不再落到 NumberInput——此前 access=3 在
    // 抽屉里显示为步进输入框且被工具栏 flex 挤压变形（即用户反复报的"下拉折叠"）。
    const enumOpts = enumOptions(labels, field);
    if (typeof value === "number" && enumOpts) {
      return (
        <Dropdown
          value={String(value)}
          options={enumOpts.map(([v, label]) => ({ value: v, label }))}
          onChange={(next) => update(path, Number(next))}
          testId={testId}
          invalid={Boolean(error)}
          title={error ?? undefined}
        />
      );
    }
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
      // 组外现存值保留为带警示的兜底选项（数据不静默丢失），不在选项内即不可选。
      // R9：原生 select 换自绘 Dropdown（根治 Windows 弹层先白后黑闪烁）
      if (field === "unit" && path[0] === "lines" && unitSuggestions.length > 0) {
        const options: DropdownOption[] = unitSuggestions.map((suggestion) => ({
          value: suggestion.key,
          label: suggestion.label,
        }));
        return (
          <Dropdown
            value={value}
            options={options}
            onChange={(next) => update(path, next)}
            testId={testId}
            title={error}
          />
        );
      }
      const options = enumOptions(labels, field);
      if (options) {
        return (
          <Dropdown
            value={value}
            options={options.map(([v, label]) => ({ value: v, label }))}
            onChange={(next) => update(path, next)}
            testId={testId}
            invalid={Boolean(error)}
            title={error ?? undefined}
          />
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
    topLevel = false,
  ): React.ReactNode => {
    const dirty = JSON.stringify(value) !== JSON.stringify(originalValue);
    const testId = `field-${pathKey(path)}`;
    let editor: React.ReactNode;
    if (identity) {
      if (identityEditable && field === "key" && typeof value === "string") {
        editor = (
          <input
            className="cell str"
            data-testid={testId}
            type="text"
            value={value}
            title="新实体可修改 key（保存后锁定）"
            onChange={(e) => update(path, e.target.value)}
          />
        );
      } else if (identityEditable && field === "id" && typeof value === "number") {
        editor = (
          <NumberInput value={value} testId={testId} onCommit={(next) => update(path, next)} />
        );
      } else {
        editor = (
          <span className="identity" data-testid={testId} title="身份字段，已保存实体不可改">
            {String(value)}
          </span>
        );
      }
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
          <AddFieldButton path={path} />
        </div>
      );
    } else {
      editor = renderScalar(field, value, path, testId);
    }
    return (
      <div
        className={`field-row${dirty ? " dirty" : ""}${topLevel && dragField === field ? " dragging" : ""}${topLevel && dropField === field ? " drop-target" : ""}`}
        key={field}
        onDragOver={
          topLevel && dragField !== null && dragField !== field
            ? (event) => {
                event.preventDefault();
                setDropField(field);
              }
            : undefined
        }
        onDragLeave={topLevel ? () => setDropField((prev) => (prev === field ? null : prev)) : undefined}
        onDrop={
          topLevel
            ? (event) => {
                event.preventDefault();
                if (dragField !== null) moveField(dragField, field);
                setDragField(null);
                setDropField(null);
              }
            : undefined
        }
        onDragEnd={topLevel ? () => { setDragField(null); setDropField(null); } : undefined}
      >
        {topLevel ? (
          <span className="drag-grip" title="拖动调整字段顺序" draggable onDragStart={() => setDragField(field)}>
            <svg width="8" height="12" viewBox="0 0 8 12" aria-hidden="true">
              <circle cx="2" cy="2" r="1" fill="currentColor" />
              <circle cx="6" cy="2" r="1" fill="currentColor" />
              <circle cx="2" cy="6" r="1" fill="currentColor" />
              <circle cx="6" cy="6" r="1" fill="currentColor" />
              <circle cx="2" cy="10" r="1" fill="currentColor" />
              <circle cx="6" cy="10" r="1" fill="currentColor" />
            </svg>
          </span>
        ) : null}
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
        renderFieldRow(field, value, (original as Record<string, JsonValue>)[field], [field], IDENTITY_FIELDS.has(field), true),
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
