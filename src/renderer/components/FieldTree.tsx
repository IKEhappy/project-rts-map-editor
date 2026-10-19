import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import type { Entity, JsonValue } from "../types";
import { enumOptions, type LabelsData } from "../labels";
import Dropdown, { type DropdownOption } from "./Dropdown";
import { FieldLabelView } from "./LabelBits";
import type { UnitSuggestion } from "../suggest";
import { FIELD_CREATABLE } from "../field-defaults";
import { defaultsAtPath, type FeatureSchema } from "../schema-templates";
import { removeAtPath, setAtPath } from "../field-path";
import { equalFieldValue } from "../field-value-equality";
import { currentNumberDraft, parseNumberText, type NumberDraft } from "../number-input-state";
import "../styles-tree.css";

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
  /** Deletion is a discrete history step rather than part of typed input. */
  onRemoveField?(next: Entity): void;
  /** Union schema from the current document plus the RAM fallback. */
  featureSchema?: FeatureSchema;
  /** 展开路径沿途的数组并在分页后定位字段；相同路径可递增 request id 重复定位。 */
  focusPath?: Path;
  focusRequestId?: number;
}

const IDENTITY_FIELDS = new Set(["id", "key"]);

/** 数组元素添加时的缺省值（克隆末行优先，空数组用此表兜底） */
const ARRAY_DEFAULTS: Record<string, JsonValue> = {
  flags: "",
  auto_attack_targets: "units",
  blast_radii_cells: 1,
  color: 0,
  targets: 0,
  produce_options: 0,
  summon: 0,
};

/** 锁定增删的对象数组：tiers 固定 3 行（MatchConfig 校验器锁死） */
const LOCKED_ARRAYS = new Set(["tiers"]);

const ARRAY_PAGE_SIZE = 50;

function pathKey(path: Path): string {
  return path.map(String).join("-");
}

function deepClone<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function NumberInput(props: { value: number; testId: string; onCommit(next: number): void }) {
  const [draft, setDraft] = useState<NumberDraft | null>(null);
  const activeDraft = currentNumberDraft(draft, props.value);
  const text = activeDraft?.text ?? String(props.value);
  const invalidDraft = activeDraft !== null && parseNumberText(activeDraft.text) === null;
  const live = useRef({ value: props.value, onCommit: props.onCommit, draft: activeDraft });
  live.current = { value: props.value, onCommit: props.onCommit, draft: activeDraft };
  useEffect(() => {
    // Derive the displayed value synchronously above, then discard the stale
    // draft so redo cannot resurrect a discarded incomplete number.
    setDraft((previous) => currentNumberDraft(previous, props.value));
  }, [props.value]);
  // R13：数字可解析即提交（点步进/逐键即时落文档——旧版只在 blur/回车提交，点 +/- 后
  // 画布与文档"没反应"即此因）；非法中间态（空串/首 "-"）留在草稿等 blur 丢弃。
  const commitText = (raw: string | null) => {
    if (raw === null) return;
    const parsed = parseNumberText(raw);
    if (parsed !== null && parsed !== live.current.value) live.current.onCommit(parsed);
  };
  const commit = () => {
    commitText(live.current.draft?.text ?? null);
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
    const state = live.current;
    const base = state.draft ? parseNumberText(state.draft.text) ?? state.value : state.value;
    const next = Math.round((base + dir) * 1e6) / 1e6;
    setDraft(null);
    if (Number.isFinite(next) && next !== state.value) {
      // Timer callbacks read this ref rather than the pointer-down render's
      // closed-over value, and advance even before React paints the next step.
      live.current = { ...state, value: next, draft: null };
      state.onCommit(next);
    }
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
        className={`cell num${invalidDraft ? " invalid" : ""}`}
        data-testid={props.testId}
        type="text"
        inputMode="decimal"
        role="spinbutton"
        aria-valuenow={props.value}
        aria-invalid={invalidDraft || undefined}
        title={invalidDraft ? "数字尚未完成或格式无效；继续输入，或按 Esc 还原" : undefined}
        value={text}
        onChange={(e) => {
          const raw = e.target.value;
          const parsed = parseNumberText(raw);
          const nextDraft = { text: raw, value: parsed ?? live.current.value };
          live.current = { ...live.current, draft: nextDraft };
          setDraft(nextDraft);
          commitText(raw);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setDraft(null);
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            stepBy(e.key === "ArrowUp" ? 1 : -1);
          }
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

/** 给对象加字段。组件类型保持稳定，父树更新不重置展开状态/输入草稿。 */
function AddFieldButton({ path, node, featureSchema, onAdd }: {
  path: Path;
  node: Record<string, JsonValue>;
  featureSchema?: FeatureSchema;
  onAdd(path: Path, field: string, value: JsonValue): void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [valueType, setValueType] = useState("string");
  const token = JSON.stringify(path);
  // Closed controls must not resolve a schema for every map row on every
  // keystroke. Resolve only while the picker is visible; keep the result
  // while its local name/type draft changes.
  const schemaDefaults = useMemo(() => open
    ? featureSchema ? defaultsAtPath(featureSchema, path) : FIELD_CREATABLE
    : {}, [open, featureSchema, token]);
  const existing = new Set(Object.keys(node));
  const candidates = Object.keys(schemaDefaults).filter((key) => !existing.has(key));
  const commit = (fieldName: string) => {
    if (!fieldName || existing.has(fieldName)) return;
    const customValue: JsonValue = valueType === "number" ? 0 : valueType === "boolean" ? false : valueType === "object" ? {} : valueType === "array" ? [] : "";
    onAdd(path, fieldName, Object.hasOwn(schemaDefaults, fieldName) ? schemaDefaults[fieldName] : customValue);
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
          <select className="cell" aria-label="新字段类型" data-testid={`add-field-type-${pathKey(path)}`} value={valueType} onChange={(event) => setValueType(event.target.value)}>
            <option value="string">文本</option>
            <option value="number">数值</option>
            <option value="boolean">布尔</option>
            <option value="object">对象</option>
            <option value="array">数组</option>
          </select>
          {candidates.length > 0 ? (
            <select
              className="cell"
              data-testid={`add-field-select-${pathKey(path)}`}
              value=""
              onChange={(e) => {
                if (e.target.value) commit(e.target.value);
              }}
            >
              <option value="">标准字段…</option>
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
}

/** 选中实体的字段树：标量行内编辑；标量数组逐元素增删/排序；对象数组（tiers/lines）嵌套展开。 */
function FieldTree(props: Props) {
  const { entity, original, labels, lightErrors, unitSuggestions, identityEditable, onChange, featureSchema } = props;
  const [collapsed, setCollapsed] = useState<Map<string, boolean>>(new Map());
  const [arrayPages, setArrayPages] = useState<Record<string, number>>({});
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // 顶层字段拖拽排序（T-164 R10：三横杠手柄拖动调整字段顺序，写回 JSON 键序）
  const [dragField, setDragField] = useState<string | null>(null);
  const [dropField, setDropField] = useState<string | null>(null);
  const [arrayTypes, setArrayTypes] = useState<Record<string, string>>({});

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
    // R31：路径写（结构共享）替代旧的整棵 deepClone——O(路径深度) 而非 O(实体大小)，并保住 memo
    onChange(setAtPath(entity, path, value));
  };

  const arrayAt = (path: Path): JsonValue[] => {
    let cursor: JsonValue = entity;
    for (const segment of path) cursor = getAt(cursor as Record<string, JsonValue> | JsonValue[], segment);
    return cursor as JsonValue[];
  };

  const removeElement = (path: Path) => {
    const arrayPath = path.slice(0, -1);
    const index = path[path.length - 1] as number;
    update(arrayPath, arrayAt(arrayPath).filter((_, at) => at !== index));
  };

  const moveElement = (path: Path, delta: number) => {
    const arrayPath = path.slice(0, -1);
    const index = path[path.length - 1] as number;
    const target = index + delta;
    const arr = arrayAt(arrayPath).slice();
    if (target < 0 || target >= arr.length) return;
    const [moved] = arr.splice(index, 1);
    arr.splice(target, 0, moved);
    update(arrayPath, arr);
  };

  const addElement = (arrayPath: Path, field: string) => {
    const arr = arrayAt(arrayPath);
    const last = arr[arr.length - 1];
    const options = enumOptions(labels, field);
    const defaults = featureSchema ? defaultsAtPath(featureSchema, arrayPath.slice(0, -1))[field] : undefined;
    let element: JsonValue;
    if (last !== undefined) {
      element = deepClone(last);
    } else if (arrayTypes[pathKey(arrayPath)]) {
      const type = arrayTypes[pathKey(arrayPath)];
      element = type === "number" ? 0 : type === "boolean" ? false : type === "string" ? "" : {};
    } else if (Array.isArray(defaults) && defaults.length > 0) {
      element = deepClone(defaults[0]);
    } else if (field in ARRAY_DEFAULTS) {
      element = deepClone(ARRAY_DEFAULTS[field]);
    } else if (options && options.length > 0) {
      element = options[0][0];
    } else if (field === "lines") {
      element = { unit: "", tier: 1, ticks: 60 };
    } else {
      element = {};
    }
    update(arrayPath, [...arr, element]);
    const stateKey = JSON.stringify(arrayPath);
    // Inserting the 51st element must not change a previously expanded array
    // into the default-collapsed large-array state.
    setCollapsed((previous) => new Map(previous).set(stateKey, false));
    setArrayPages((previous) => ({ ...previous, [stateKey]: Math.floor(arr.length / ARRAY_PAGE_SIZE) }));
    setPendingFocus(JSON.stringify([...arrayPath, arr.length]));
  };

  const addField = (path: Path, field: string, value: JsonValue) => {
    update([...path, field], deepClone(value));
  };

  const removeField = (path: Path) => {
    (props.onRemoveField ?? onChange)(removeAtPath(entity, path));
  };

  const toggleCollapse = (key: string, isCollapsed: boolean) => {
    setCollapsed((prev) => new Map(prev).set(key, !isCollapsed));
  };

  const focusToken = props.focusPath ? JSON.stringify(props.focusPath) : null;
  // Resolve the path against the current immutable document once per request.
  // Pagination and expansion settle before the layout effect queries the DOM.
  useEffect(() => {
    if (!focusToken) return;
    const path = JSON.parse(focusToken) as Path;
    const expanded: Array<[string, boolean]> = [];
    const pages: Record<string, number> = {};
    let node: JsonValue = entity;
    const ancestor: Path = [];
    for (const segment of path) {
      if (Array.isArray(node)) {
        const key = JSON.stringify(ancestor);
        expanded.push([key, false]);
        if (typeof segment === "number") pages[key] = Math.floor(segment / ARRAY_PAGE_SIZE);
      }
      if (node === null || typeof node !== "object") break;
      node = Array.isArray(node) ? node[segment as number] : node[String(segment)];
      ancestor.push(segment);
    }
    // Context actions target the array itself (for example ["lines"]), so
    // expand that final node as well as its array ancestors.
    if (Array.isArray(node)) expanded.push([JSON.stringify(ancestor), false]);
    setCollapsed((previous) => new Map([...previous, ...expanded]));
    setArrayPages((previous) => ({ ...previous, ...pages }));
    setPendingFocus(focusToken);
  }, [focusToken, props.focusRequestId]);

  useLayoutEffect(() => {
    if (!pendingFocus || !rootRef.current) return;
    const element = Array.from(rootRef.current.querySelectorAll<HTMLElement>("[data-field-path]"))
      .find((candidate) => candidate.dataset.fieldPath === pendingFocus);
    if (!element) return;
    element.scrollIntoView({ block: "nearest", inline: "nearest" });
    const control = element.querySelector<HTMLElement>("input, select") ?? element.querySelector<HTMLElement>("button");
    control?.focus({ preventScroll: true });
    setPendingFocus(null);
  }, [pendingFocus, collapsed, arrayPages]);

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
      // Config entities use ["lines", index, "unit"], while a map JSON
      // entity uses ["buildings", buildingIndex, "lines", index, "unit"].
      // Match the semantic production-line segment in either tree shape so
      // newly-added map lines receive the same editable unit picker.
      if (field === "unit" && path.includes("lines") && unitSuggestions.length > 0) {
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
    const stateKey = JSON.stringify(path);
    const isCollapsed = collapsed.get(stateKey) ?? values.length > ARRAY_PAGE_SIZE;
    const pageCount = Math.max(1, Math.ceil(values.length / ARRAY_PAGE_SIZE));
    const page = Math.min(arrayPages[stateKey] ?? 0, pageCount - 1);
    const start = page * ARRAY_PAGE_SIZE;
    const locked = LOCKED_ARRAYS.has(field);
    const visible = isCollapsed ? [] : values.slice(start, start + ARRAY_PAGE_SIZE);
    const objectRows = !isCollapsed && values.length > 0 && values.every((v) => v !== null && typeof v === "object" && !Array.isArray(v));
    return (
      <div className="tree-node">
        <button className="collapse-btn" onClick={() => toggleCollapse(stateKey, isCollapsed)} title={isCollapsed ? "展开" : "折叠"}>
          {isCollapsed ? "▸" : "▾"}
        </button>
        <span className="node-title">
          {values.length} 项{locked ? "（固定行数，禁增删）" : ""}
        </span>
        {!isCollapsed ? (
          <div className="tree-children">
            {visible.map((element, offset) => {
              const index = start + offset;
              return objectRows ? (
                <div className="tree-row-box" key={index} data-field-path={JSON.stringify([...path, index])}>
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
                        <button className="mini danger" data-testid={`array-remove-${pathKey([...path, index])}`} title="删除" onClick={() => removeElement([...path, index])}>
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
                  {featureSchema ? <AddFieldButton path={[...path, index]} node={element as Record<string, JsonValue>} featureSchema={featureSchema} onAdd={addField} /> : null}
                </div>
              ) : (
                <div className="tree-row" key={index} data-field-path={JSON.stringify([...path, index])}>
                  <span className="row-index">{index}</span>
                  {renderScalar(field, element, [...path, index], `field-${pathKey([...path, index])}`)}
                  <span className="row-ops">
                    <button className="mini" title="上移" onClick={() => moveElement([...path, index], -1)} disabled={index === 0}>
                      ↑
                    </button>
                    <button className="mini" title="下移" onClick={() => moveElement([...path, index], 1)} disabled={index === values.length - 1}>
                      ↓
                    </button>
                    <button className="mini danger" data-testid={`array-remove-${pathKey([...path, index])}`} title="删除" onClick={() => removeElement([...path, index])}>
                      ✕
                    </button>
                  </span>
                </div>
              );
            })}
            {pageCount > 1 ? (
              <div className="add-field-row" data-testid={`array-pages-${key}`}>
                <button className="mini" title="上一页" disabled={page === 0} onClick={() => setArrayPages((previous) => ({ ...previous, [stateKey]: page - 1 }))}>上一页</button>
                <span className="row-index">{start + 1}–{Math.min(start + ARRAY_PAGE_SIZE, values.length)} / {values.length}</span>
                <button className="mini" title="下一页" disabled={page === pageCount - 1} onClick={() => setArrayPages((previous) => ({ ...previous, [stateKey]: page + 1 }))}>下一页</button>
              </div>
            ) : null}
            {!locked ? (
              <div className="add-field-row">
                <button className="mini add" data-testid={`array-add-${key}`} onClick={() => addElement(path, field)}>＋ 添加</button>
                {values.length === 0 && !(field in ARRAY_DEFAULTS) && field !== "lines" ? <select
                  className="cell"
                  aria-label="数组元素类型"
                  value={arrayTypes[key] ?? "object"}
                  onChange={(event) => setArrayTypes((previous) => ({ ...previous, [key]: event.target.value }))}
                >
                  <option value="object">对象</option><option value="string">文本</option><option value="number">数值</option><option value="boolean">布尔</option>
                </select> : null}
              </div>
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
    const dirty = !equalFieldValue(value, originalValue);
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
          <AddFieldButton path={path} node={value as Record<string, JsonValue>} featureSchema={featureSchema} onAdd={addField} />
        </div>
      );
    } else {
      editor = renderScalar(field, value, path, testId);
    }
    return (
      <div
        className={`field-row${dirty ? " dirty" : ""}${topLevel && dragField === field ? " dragging" : ""}${topLevel && dropField === field ? " drop-target" : ""}`}
        key={field}
        data-field-path={JSON.stringify(path)}
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
          <span className="field-label-content"><FieldLabelView field={field} labels={labels} /></span>
          <button
            className="mini danger field-remove"
            type="button"
            data-testid={`field-remove-${pathKey(path)}`}
            aria-label={`删除字段 ${field}`}
            title={identity ? "身份字段不能删除" : `删除字段 ${field}（可撤销；必填字段需补齐后才能保存）`}
            disabled={identity}
            onClick={() => removeField(path)}
          ><Trash2 size={13} aria-hidden="true" /></button>
        </div>
        <div className="field-editor">{editor}</div>
      </div>
    );
  };

  return (
    <div className="field-tree" ref={rootRef}>
      {Object.entries(entity).map(([field, value]) =>
        renderFieldRow(field, value, (original as Record<string, JsonValue>)[field], [field], IDENTITY_FIELDS.has(field), true),
      )}
      {featureSchema ? <AddFieldButton path={[]} node={entity} featureSchema={featureSchema} onAdd={addField} /> : null}
    </div>
  );
}

// Canvas hover/pan state does not change the immutable document. Keep these
// parent updates from rebuilding the JSON controls while the drawer is open.
export default memo(FieldTree);

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
