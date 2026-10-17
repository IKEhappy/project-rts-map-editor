import { Fragment, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { api, serializeText } from "../api";
import { canonicalJson } from "../canonical";
import { DocHistory } from "../history";
import {
  DEFAULT_TOOL_STATE,
  addBox,
  addBuilding,
  addSpawn,
  addTree,
  buildingDefsOf,
  buildingAbbreviationsOf,
  deleteAt,
  footprintFor,
  moveBox,
  moveDecor,
  moveEntry,
  moveTerrainPatch,
  paintTerrain,
  sanitizeFileBase,
  unitOptionsOf,
  type BuildingDefLike,
  type ToolState,
} from "../map-edit-ops";
import { validateMapTree } from "../light-validation";
import type { BackgroundInfo, ConfigFile, Entity, MapsListResult, MapSaveResult, WorkspaceSession } from "../types";
import { backgroundForView, withBackgroundSlot, withoutBackground, type BackgroundSlot, type BackgroundView } from "../background-model";
import { Braces, Eraser, FilePlus2, Flower2, FolderInput, Landmark, MapPin, MousePointer2, Move, Paintbrush, Redo2, RotateCcw, Save, ScanLine, Shapes, SquareDashed, Trash2, Trees, Undo2 } from "lucide-react";
import type { LabelsData } from "../labels";
import Dropdown from "./Dropdown";
import FieldTree from "./FieldTree";
import MapCanvas from "./MapCanvas";
import BackgroundInspector from "./BackgroundInspector";

/** Unit choices used by a map's buildings.lines editor.  The map document is
 * deliberately not a unit-config document, so FieldTree cannot derive the
 * role pool from the selected building here.  Supplying the complete unit
 * list still makes a newly-added line immediately editable (rather than an
 * empty, apparently locked dropdown); the configuration editor applies the
 * narrower role-aware list when editing buildings.json itself. */
function mapUnitSuggestions(units: Entity[] | null | undefined, labels: LabelsData) {
  return (units ?? []).map((unit) => {
    const key = String(unit.key ?? "");
    const name = typeof unit.name_cn === "string" ? unit.name_cn : key;
    const role = String(unit.role ?? "");
    const roleLabel = labels.values?.role?.[role] ?? role;
    return { key, label: role ? `${name}（${roleLabel}）` : name };
  }).filter((option) => option.key.length > 0);
}

/** Map placement picker groups the definitions in the same order as the
 * editor's visual inventory: regular structures, defensive turrets, then
 * explicitly marked test/debug structures. The data file remains the source
 * of truth; this is presentation metadata only. */
function buildingGroup(key: string, name: string): "建筑" | "炮台" | "测试建筑" {
  if (key.startsWith("turret_")) return "炮台";
  if (name.startsWith("内测") || key.startsWith("test_") || key.startsWith("debug_")) return "测试建筑";
  return "建筑";
}

function buildingOption(def: BuildingDefLike) {
  const name = def.name_cn?.trim() || def.key;
  const size = `${def.w ?? 1}×${def.h ?? 1}`;
  const label = `${def.key} - ${name} [${size}]`;
  return { value: def.key, label, title: label, group: buildingGroup(def.key, name) };
}

// 地图面板（T-164 R7/R8/R9）：dev-2d data/maps/*.json 编辑——左列表（含新建）/中字段树/
// 右 2D 画布（视口化：滚轮缩放/拖动平移；直编：地形笔刷/擦除、box_mode 画框、建筑/树/
// 出生点放置、删除工具）。画布与字段树共用同一 doc 状态，双向实时同步；全部编辑进
// 撤销/重做历史（画布离散、字段树 600ms 合并，Ctrl+Z/Y 全局路由见 App）。
// 写入纪律与三表一致：哈希守卫、无改动不写盘、先过 Godot 地图门禁再原子写。

export interface MapDocState {
  name: string; // 磁盘文件名（新图在首次保存前为空串）
  doc: ConfigFile;
  text: string;
  hash: string;
  path: string;
  isNew: boolean;
  /** R31：磁盘原文的一次性解析结果（脏判定与"原值"对照共用，免去每次渲染重复 JSON.parse） */
  original: ConfigFile;
}

export interface MapsPanelHandle {
  /** 关闭前保存询问用：保存全部脏地图，全部成功才返回 true */
  saveAll(): Promise<boolean>;
  isAnyDirty(): boolean;
  isBusy(): boolean;
  /** 撤销/重做当前激活地图（App 全局快捷键路由） */
  undo(): void;
  redo(): void;
  /** 保存当前地图（App 的 Ctrl+S 在地图页路由到此） */
  save(): void;
  /** 丢弃未保存编辑重读当前地图（脏则确认；App 顶栏「重新加载」在地图页路由到此） */
  reloadCurrent(): Promise<void>;
}

interface Props {
  workspace: WorkspaceSession;
  labelsData: LabelsData;
  handleRef?: Ref<MapsPanelHandle>;
  onDirtyChange?(dirtyCount: number): void;
  onBusyChange?(busy: boolean): void;
  unitsCache?: Entity[] | null;
  /** 地图页当前激活（参数热键只在激活时接管数字键/字母 B） */
  active?: boolean;
  /** buildings.json 在工具内保存的版本号（R14：占地/血量默认实时更新） */
  buildingsVersion?: number;
}

type SaveState =
  | { tone: "idle" }
  | { tone: "saving" }
  | { tone: "ok"; written: boolean; label: string }
  | { tone: "rejected"; code: string; errors: string[] };

/** 语义脏判定。R31：读 state.original（读取/保存时已解析好），不再每次 JSON.parse(state.text)。 */
function dirtyOf(state?: MapDocState | null): boolean {
  if (!state) return false;
  if (state.isNew) return true;
  try {
    return canonicalJson(state.doc) !== canonicalJson(state.original);
  } catch {
    return true;
  }
}

/** 新建地图骨架：可过门禁的最小合法图 + 常用渲染默认（renderer/ground 与 shipped 一致） */
function newMapSkeleton(index: number): Entity {
  return {
    version: 1,
    _note: "map-editor 新建地图（左列表选中后于字段树编辑，画布实时预览；保存须过 Godot 门禁）",
    name: `new_map_${index}`,
    width: 48,
    height: 32,
    default_terrain: 0,
    seed: 1,
    renderer: "res://data/render/default.json",
    ground: { default_material: "grass" },
    box_mode: [],
    terrain_patches: [],
    buildings: [],
    spawns: [],
    decor: [],
    init: {},
  };
}

function fileNameFor(docName: unknown, fallback: string): string {
  const base = sanitizeFileBase(String(docName ?? ""));
  const safe = base.length > 0 ? base : fallback;
  return safe.endsWith(".json") ? safe : `${safe}.json`;
}

// 工具参数选项（与 labels.json 同口径，UI 直用中文短标签）
const TERRAIN_OPTIONS: Array<[string, string]> = [
  ["0", "0 可通行"],
  ["1", "1 阻挡（墙）"],
  ["2", "2 山体"],
  ["3", "3 水面"],
  ["4", "4 可通行禁建"],
];
const ACCESS_OPTIONS: Array<[string, string]> = [
  ["0", "通行 0 全通行"],
  ["1", "通行 1 禁地面"],
  ["2", "通行 2 禁飞碟"],
  ["3", "通行 3 禁所有"],
];
const BUILD_OPTIONS: Array<[string, string]> = [
  ["0", "建造 0 可建"],
  ["1", "建造 1 禁建"],
];
const TEAM_OPTIONS: Array<[string, string]> = [
  ["0", "中立"],
  ["1", "己方（队1）"],
  ["2", "敌方（队2）"],
];

const toOptions = (pairs: Array<[string, string]>): Array<{ value: string; label: string }> =>
  pairs.map(([value, label]) => ({ value, label }));

const TOOL_HINTS: Record<ToolState["tool"], string> = {
  none: "预览模式：点按已放置对象选中；**Shift+点按可多选，主键盘 1~9 批量切换队伍**（Esc 取消选中）；空白处拖动平移、滚轮缩放；右键对象出调参菜单。",
  terrain: "地形笔刷：**数字键 0~4 直切地形码**（或工具栏下拉）；画布拖矩形整块刷入，刷过已有配置即覆盖。**右键=取消工具回预览**。",
  erase: "擦除地形：拖矩形把覆盖格恢复为 default_terrain（只减补丁不新增）；数字键 0~4 可改目标码（同码=擦除）。",
  box: "画 box_mode 范围：拖矩形追加 L2 标注。**数字键 0~3 切通行维度、B 键切禁建**（或工具栏两个下拉）；新范围刷过旧范围=覆盖（旧条目保留未重叠部分）。**右键=取消工具回预览**。",
  building: "放建筑：点**空格**放置（占地见幽灵预览）；**按住已放置建筑拖动=移动**（越界/重叠拒绝）。",
  tree: "放树：点格子放 decor 树（纯视觉不阻挡）。",
  spawn: "放出生点：点**空格**放置（单位/队伍/数量在工具栏）；**按住已有出生点拖动=移动**。",
  delete: "删除：点画布删除命中的元素——优先级建筑 → box 范围 → 树 → 出生点（后放的先删）。",
  "move-unit": "移动·游戏单位：按住建筑/炮台/出生点单位拖动即可移动；**Shift+点按多选后拖动可等距移动**（越界/占位冲突拒绝）。主键盘 1~9 可给悬停对象切换队伍。",
  "move-shape": "移动·地形图形：按住地形补丁或 box 范围拖动整体平移（钳图界）。补丁优先于 box。",
  "move-render": "移动·渲染内容：按住 decor 树拖动到新格。水等地面贴图属性走 render 配置文件不在画布移动。",
};
const TOOL_ICONS = { none: MousePointer2, terrain: Paintbrush, erase: Eraser, box: SquareDashed, building: Landmark, tree: Trees, spawn: MapPin, delete: Trash2, "move-unit": Move, "move-shape": Shapes, "move-render": Flower2 };

export default function MapsPanel({ workspace, labelsData, handleRef, onDirtyChange, onBusyChange, unitsCache = null, active = false, buildingsVersion = 0 }: Props) {
  const [list, setList] = useState<MapsListResult | null>(null);
  const [docs, setDocs] = useState<Record<string, MapDocState>>({}); // key: 文件名或 "@new/<name>"
  const [activeKey, setActiveKey] = useState<string>("");
  const [saveState, setSaveState] = useState<SaveState>({ tone: "idle" });
  const [busy, setBusyState] = useState(false);
  const busyRef = useRef(false);
  const setBusy = useCallback((next: boolean) => { busyRef.current = next; setBusyState(next); }, []);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useEffect(() => () => { onBusyChange?.(false); }, [onBusyChange]);
  const newCounter = useRef(0);
  const historyRef = useRef(new DocHistory<ConfigFile>());
  const [historyTick, setHistoryTick] = useState(0); // 撤销/重做后驱动按钮可用态刷新
  // R8 画布直编：工具态 + 建筑配置表（占地/血量默认来源；随工具内保存的 buildings.json 实时刷新）
  const [toolState, setToolState] = useState<ToolState>(DEFAULT_TOOL_STATE);
  const [buildingDefs, setBuildingDefs] = useState<BuildingDefLike[]>([]);
  const buildingAbbreviations = useMemo(() => buildingAbbreviationsOf(buildingDefs), [buildingDefs]);
  // R12：JSON 字段树默认折叠（研发入口），悬浮按钮开合底层抽屉
  const [jsonOpen, setJsonOpen] = useState(false);
  // R31：底部图例/提示默认折叠——常驻三段说明在 720p 下会显著挤压画布
  const [notesOpen, setNotesOpen] = useState(false);
  // R14/R20：右键调参菜单（建筑或出生点；命中索引 + 屏幕坐标）
  const [ctxMenu, setCtxMenu] = useState<{ kind: "building" | "spawn"; index: number; x: number; y: number } | null>(null);
  // R17：文件列表右键菜单 + 重命名弹窗
  const [listMenu, setListMenu] = useState<{ name: string; x: number; y: number } | null>(null);
  const [renameModal, setRenameModal] = useState<{ from: string; value: string; error?: string } | null>(null);
  // R22：选中对象（预览点按已放置对象→选中并切对应模式；拖动移动）
  const [selectedObject, setSelectedObject] = useState<{ kind: "building" | "spawn"; index: number } | null>(null);
  const [selectedObjects, setSelectedObjects] = useState<Array<{ kind: "building" | "spawn"; index: number }>>([]);
  const [backgroundInfo, setBackgroundInfo] = useState<BackgroundInfo | null>(null);
  const [backgroundView, setBackgroundView] = useState<BackgroundView>("topdown");
  const [imageModeRequested, setImageModeRequested] = useState(false);
  const [backgroundRevision, setBackgroundRevision] = useState(0);
  const [externalChanges, setExternalChanges] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    api
      .readWorkspaceConfig("buildings")
      .then((result) => {
        if (!cancelled && result.ok && result.data) {
          // 占地三级解析：配置已给（实时）→ 用户裁定表 → sim 3×3 回退
          const defs = buildingDefsOf(result.data).map((def) => {
            const fp = footprintFor(def.key, def.w, def.h);
            return { ...def, w: fp.w, h: fp.h };
          });
          setBuildingDefs(defs);
          setToolState((prev) => (prev.buildingKey === "" && defs.length > 0 ? { ...prev, buildingKey: defs[0].key } : prev));
        }
      })
      .catch(() => {
        /* 建筑下拉降级为空（放置工具不可用，字段树不受影响） */
      });
    return () => {
      cancelled = true;
    };
  }, [buildingsVersion, workspace.id, workspace.generation]);

  // 当前选中建筑的放置占地 → 工具态（画布幽灵与放置同源）
  useEffect(() => {
    const def = buildingDefs.find((d) => d.key === toolState.buildingKey);
    if (def) {
      const w = Math.max(1, def.w ?? 1);
      const h = Math.max(1, def.h ?? 1);
      setToolState((prev) => (prev.footprintW === w && prev.footprintH === h ? prev : { ...prev, footprintW: w, footprintH: h }));
    }
  }, [buildingDefs, toolState.buildingKey]);

  const load = activeKey ? docs[activeKey] ?? null : null;
  const dirty = dirtyOf(load);
  const dirtyCount = useMemo(() => Object.values(docs).filter(dirtyOf).length, [docs]);
  const backgroundKey = JSON.stringify([load?.doc.background, load?.doc.renderer]);
  useEffect(() => {
    let cancelled = false;
    if (!load) {
      setBackgroundInfo(null);
      return () => { cancelled = true; };
    }
    // Keep the previous decoded background while the new metadata is being
    // resolved. Clearing it first causes MapCanvas to paint the green terrain
    // fallback for one frame, which is visible as a flash in whole-image mode.
    api.backgroundInfo(load.doc).then((info) => { if (!cancelled) setBackgroundInfo(info); }).catch((error: unknown) => {
      if (!cancelled) setBackgroundInfo({ ok: false, source: "none", background: {}, images: {}, errors: [String(error)] });
    });
    return () => { cancelled = true; };
  }, [activeKey, backgroundKey, backgroundRevision, workspace.id, workspace.generation]);
  useEffect(() => {
    setSelectedObject(null);
    setSelectedObjects([]);
    setCtxMenu(null);
    setImageModeRequested(false);
    setBackgroundView("topdown");
  }, [activeKey]);
  const ownBackground = load?.doc.background;
  const hasOwnBackground = ownBackground != null && (typeof ownBackground !== "object" || Array.isArray(ownBackground) || Object.keys(ownBackground).length > 0);
  const wholeImageMode = imageModeRequested || hasOwnBackground || (backgroundInfo != null && backgroundInfo.source !== "none");
  const previewImage = backgroundForView(backgroundInfo, backgroundView);
  useEffect(() => {
    if (wholeImageMode) setToolState((prev) => prev.tool === "terrain" || prev.tool === "erase" ? { ...prev, tool: "box" } : prev);
  }, [wholeImageMode]);

  useEffect(() => {
    onDirtyChange?.(dirtyCount);
  }, [dirtyCount, onDirtyChange]);

  const refreshList = useCallback(async () => {
    const result = await api.listMaps();
    setList(result);
    return result;
  }, []);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  const refreshWorkspace = useCallback(async () => {
    if (busy) return;
    try {
      setBackgroundRevision((value) => value + 1);
      await refreshList();
      const opened = Object.values(docs).filter((state) => !state.isNew);
      const changed = await Promise.all(opened.map(async (state) => {
        try {
          const result = await api.readMap(state.name);
          return !result.ok || result.hash !== state.hash ? state.name : null;
        } catch { return state.name; }
      }));
      setExternalChanges(changed.filter((name): name is string => name !== null));
    } catch (error) { setSaveState({ tone: "rejected", code: "read", errors: [String(error)] }); }
  }, [busy, docs, refreshList]);

  useEffect(() => {
    const onFocus = () => { void refreshWorkspace(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshWorkspace]);

  const openMap = useCallback(
    async (name: string) => {
      if (docs[name]) {
        setActiveKey(name);
        return;
      }
      setBusy(true);
      setSaveState({ tone: "idle" });
      try {
        const result = await api.readMap(name);
        if (!result.ok || !result.data || !result.text || !result.hash || !result.path) {
          setSaveState({ tone: "rejected", code: "read", errors: [result.error ?? `读取失败：${name}`] });
        } else {
          setDocs((prev) => ({
            ...prev,
            [name]: { name, doc: result.data!, text: result.text!, hash: result.hash!, path: result.path!, isNew: false, original: result.data! },
          }));
          setActiveKey(name);
        }
      } catch (error) { setSaveState({ tone: "rejected", code: "read", errors: [String(error)] }); }
      finally { setBusy(false); }
    },
    [docs],
  );

  const createMap = useCallback(() => {
    // 默认名防撞（R15）：跳过磁盘已有文件与在编辑副本，避免"保存被已存在拒绝"
    let index = newCounter.current;
    const taken = new Set<string>();
    for (const meta of list?.maps ?? []) taken.add(meta.name);
    for (const state of Object.values(docs)) taken.add(fileNameFor(state.doc.name, ""));
    let name = "";
    for (let guard = 0; guard < 500; guard += 1) {
      index += 1;
      name = `new_map_${index}`;
      if (!taken.has(`${name}.json`) && !docs[`@new/${name}`]) break;
    }
    newCounter.current = index;
    const skeleton = newMapSkeleton(0);
    skeleton.name = name;
    const key = `@new/${name}`;
    setDocs((prev) => ({
      ...prev,
      [key]: {
        name: "",
        doc: skeleton,
        text: `${JSON.stringify(skeleton, null, 2)}\n`,
        hash: "",
        path: "（新地图——保存时按文档 name 字段落盘）",
        isNew: true,
        // 新图无磁盘源：original 取骨架自身（初始即"未脏"，与旧行为一致）
        original: skeleton,
      },
    }));
    setActiveKey(key);
    setSaveState({ tone: "idle" });
  }, [list, docs]);

  const updateDoc = useCallback(
    (next: Entity) => {
      if (!load || busyRef.current) return;
      historyRef.current.commit(activeKey, load.doc, "field");
      setDocs((prev) => ({ ...prev, [activeKey]: { ...load, doc: next as ConfigFile } }));
    },
    [load, activeKey, busy],
  );

  // —— R8 画布直编：语义回调 → map-edit-ops 纯函数变换 doc（字段树同帧可见） ——
  const applyDoc = useCallback(
    (next: ConfigFile, tag: string) => {
      if (!load) return;
      historyRef.current.commit(activeKey, load.doc, tag, 0); // 画布操作离散：不合并不窗
      setDocs((prev) => ({ ...prev, [activeKey]: { ...load, doc: next } }));
    },
    [load, activeKey],
  );

  const importBackground = useCallback(async (slot: BackgroundSlot) => {
    if (!load || busyRef.current) return;
    const key = activeKey;
    setBusy(true);
    try {
      const result = await api.importImage({ mapId: load.isNew ? fileNameFor(load.doc.name, "new_map") : load.name, view: slot });
      if (!result.ok || !result.path) {
        if (result.error) setSaveState({ tone: "rejected", code: "import", errors: [result.error] });
        return;
      }
      const base = backgroundInfo?.source === "renderer" ? { ...load.doc, background: { ...backgroundInfo.background } } : load.doc;
      const next = withBackgroundSlot(base, slot, result.path);
      historyRef.current.commit(key, load.doc, "import-background", 0);
      setDocs((prev) => ({ ...prev, [key]: { ...load, doc: next } }));
      setImageModeRequested(false);
      setBackgroundView(slot === "tilt" ? "tilt" : "topdown");
      setSaveState({ tone: "idle" });
    } catch (error) {
      setSaveState({ tone: "rejected", code: "import", errors: [String(error)] });
    } finally { setBusy(false); }
  }, [load, activeKey, busy, backgroundInfo]);

  const importMap = useCallback(async () => {
    if (busyRef.current) return;
    setBusy(true);
    try {
      const result = await api.importMap();
      if (result.ok && result.name) {
        await refreshList();
        await openMap(result.name);
      } else if (result.errors?.length) setSaveState({ tone: "rejected", code: "import", errors: result.errors });
    } catch (error) {
      setSaveState({ tone: "rejected", code: "import", errors: [String(error)] });
    } finally { setBusy(false); }
  }, [busy, refreshList, openMap]);

  const removeBackground = useCallback(() => {
    if (!load) return;
    if (!window.confirm("移除本地图的 background 声明？渲染配置若带有整图背景，仍会继续生效。")) return;
    applyDoc(withoutBackground(load.doc), "remove-background");
    setImageModeRequested(false);
  }, [load, applyDoc]);

  const switchGroundMode = useCallback(async (imageMode: boolean) => {
    if (imageMode || !load) { setImageModeRequested(imageMode); return; }
    if (backgroundInfo?.source === "none" && !Object.prototype.hasOwnProperty.call(load.doc, "background")) { setImageModeRequested(false); return; }
    setBusy(true);
    try {
      const candidate = withoutBackground(load.doc);
      const fallback = await api.backgroundInfo(candidate);
      const removesRenderer = fallback.source === "renderer";
      if (!window.confirm(removesRenderer ? "切换为瓦片模式将移除本地图 background 声明和提供整图的 renderer 引用。已导入的图片文件会保留。确认切换？" : "切换为瓦片模式将移除本地图 background 声明。已导入的图片文件会保留。确认切换？")) return;
      if (removesRenderer) delete candidate.renderer;
      applyDoc(candidate, "switch-tile-mode");
      setImageModeRequested(false);
      setBackgroundView("topdown");
    } catch (error) {
      setSaveState({ tone: "rejected", code: "background", errors: [String(error)] });
    } finally { setBusy(false); }
  }, [load, backgroundInfo, applyDoc]);

  /** 撤销(-1)/重做(+1)：换 doc 并驱动按钮态刷新 */
  const undoRedo = useCallback(
    (dir: -1 | 1) => {
      if (!load || busyRef.current) return;
      const next = dir < 0 ? historyRef.current.undoFor(activeKey, load.doc) : historyRef.current.redoFor(activeKey, load.doc);
      if (next === null) return;
      setDocs((prev) => ({ ...prev, [activeKey]: { ...load, doc: next } }));
      setHistoryTick((tick) => tick + 1);
    },
    [load, activeKey, busy],
  );
  void historyTick; // 仅驱动重渲染（canUndo/canRedo 即时读历史栈）

  /** 丢弃未保存编辑重读当前地图（脏则确认） */
  const reloadActive = useCallback(async () => {
    if (!load || busyRef.current) return;
    if (dirtyOf(load) && !window.confirm("当前地图有未保存修改，重新加载将丢弃，确认？")) return;
    if (!load.isNew) {
      setBusy(true);
      try {
        const result = await api.readMap(load.name);
        if (result.ok && result.data && result.text && result.hash && result.path) {
          historyRef.current.clear(activeKey);
          setDocs((prev) => ({
            ...prev,
            [load.name]: { name: load.name, doc: result.data!, text: result.text!, hash: result.hash!, path: result.path!, isNew: false, original: result.data! },
          }));
          setActiveKey(load.name);
          setExternalChanges((prev) => prev.filter((name) => name !== load.name));
          setSaveState({ tone: "idle" });
          return;
        }
        setSaveState({ tone: "rejected", code: "read", errors: [result.error ?? `重新读取失败：${load.name}`] });
      } catch (error) { setSaveState({ tone: "rejected", code: "read", errors: [String(error)] }); }
      finally { setBusy(false); }
      return;
    }
    // 新建未落盘地图：无磁盘源，等效撤销全部
    setSaveState({ tone: "rejected", code: "usage", errors: ["新建地图尚未保存，无磁盘版本可重载——可用 Ctrl+Z 逐步撤销"] });
  }, [load, activeKey, setBusy]);

  const onTerrainRect = useCallback(
    (rect: { x: number; y: number; w: number; h: number }) => {
      if (!load) return;
      applyDoc(paintTerrain(load.doc, rect, toolState.tool === "erase" ? null : toolState.terrain), "canvas-terrain");
    },
    [load, applyDoc, toolState],
  );

  const onBoxAdd = useCallback(
    (x0: number, y0: number, x1: number, y1: number) => {
      if (!load) return;
      applyDoc(addBox(load.doc, x0, y0, x1, y1, toolState.access, toolState.build), "canvas-box");
    },
    [load, applyDoc, toolState],
  );

  /** R28：预览点按已放置对象 → 仅选中高亮（不切工具——防建筑幽灵误触，移动须显式切移动模式） */
  const onSelectObject = useCallback(
    (sel: { kind: "building" | "spawn"; index: number } | null) => {
      setSelectedObject(sel);
      setSelectedObjects(sel ? [sel] : []);
    },
    [],
  );

  const onSelectObjects = useCallback((sels: Array<{ kind: "building" | "spawn"; index: number }>) => {
    setSelectedObjects(sels);
    setSelectedObject(sels.at(-1) ?? null);
  }, []);

  /** R29：画布主键盘 1~9 给悬停建筑/炮台/单位切换队伍；仍保留右键 JSON 调参路径。 */
  const onChangeObjectsTeam = useCallback(
    (sels: Array<{ kind: "building" | "spawn"; index: number }>, team: number) => {
      if (!load || !Number.isInteger(team) || team < 1 || team > 9 || sels.length === 0) return;
      const buildings = Array.isArray(load.doc.buildings) ? [...(load.doc.buildings as Entity[])] : [];
      const spawns = Array.isArray(load.doc.spawns) ? [...(load.doc.spawns as Entity[])] : [];
      let changed = false;
      for (const target of sels) {
        const list = target.kind === "building" ? buildings : spawns;
        const raw = list[target.index];
        if (raw !== null && typeof raw === "object" && !Array.isArray(raw) && Number(raw.team ?? 0) !== team) {
          list[target.index] = { ...raw, team };
          changed = true;
        }
      }
      if (!changed) return;
      applyDoc({ ...load.doc, buildings, spawns }, "canvas-team");
      setSelectedObjects(sels);
      setSelectedObject(sels.at(-1) ?? null);
    },
    [load, applyDoc],
  );

  const onChangeObjectTeam = useCallback(
    (sel: { kind: "building" | "spawn"; index: number }, team: number) => onChangeObjectsTeam(selectedObjects.length > 0 ? selectedObjects : [sel], team),
    [onChangeObjectsTeam, selectedObjects],
  );

  const onMoveObjects = useCallback((moves: Array<{ kind: "building" | "spawn"; index: number; x: number; y: number }>) => {
    if (!load || moves.length === 0) return;
    const width = Number(load.doc.width ?? 0);
    const height = Number(load.doc.height ?? 0);
    const buildings = Array.isArray(load.doc.buildings) ? [...(load.doc.buildings as Entity[])] : [];
    const spawns = Array.isArray(load.doc.spawns) ? [...(load.doc.spawns as Entity[])] : [];
    const fail = (message: string) => setSaveState({ tone: "rejected", code: "usage", errors: [`批量移动拒绝：${message}`] });
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      fail("地图尺寸无效");
      return;
    }
    const seen = new Set<string>();
    for (const move of moves) {
      if ((move.kind !== "building" && move.kind !== "spawn") || !Number.isInteger(move.index) || move.index < 0 || !Number.isFinite(move.x) || !Number.isFinite(move.y)) {
        fail("对象索引或坐标无效");
        return;
      }
      const identity = `${move.kind}:${move.index}`;
      if (seen.has(identity)) {
        fail("同一对象被重复提交");
        return;
      }
      seen.add(identity);
      const list = move.kind === "building" ? buildings : spawns;
      const raw = list[move.index];
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        fail("对象已不存在");
        return;
      }
    }
    const moved = moves.some((move) => {
      const original = move.kind === "building" ? load.doc.buildings : load.doc.spawns;
      const raw = Array.isArray(original) ? original[move.index] : null;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
      const row = raw as Entity;
      return Number(row.x) !== Math.round(move.x) || Number(row.y) !== Math.round(move.y);
    });
    // 原地松手不落历史，避免 Shift 选中后未拖动产生无意义脏标记。
    if (!moved) return;
    for (const move of moves) {
      const list = move.kind === "building" ? buildings : spawns;
      const raw = list[move.index];
      list[move.index] = { ...raw, x: Math.round(move.x), y: Math.round(move.y) };
    }
    for (let i = 0; i < buildings.length; i += 1) {
      const a = buildings[i];
      if (!a || typeof a !== "object" || Array.isArray(a)) continue;
      const ax = Number(a.x); const ay = Number(a.y); const aw = Math.max(1, Number(a.w ?? 1)); const ah = Math.max(1, Number(a.h ?? 1));
      if (![ax, ay, aw, ah].every(Number.isFinite) || ax < 0 || ay < 0 || ax + aw > width || ay + ah > height) { fail(`建筑 ${String(a.key ?? "?")} 越界`); return; }
      for (let j = i + 1; j < buildings.length; j += 1) {
        const b = buildings[j]; if (!b || typeof b !== "object" || Array.isArray(b)) continue;
        const bx = Number(b.x); const by = Number(b.y); const bw = Math.max(1, Number(b.w ?? 1)); const bh = Math.max(1, Number(b.h ?? 1));
        if (ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah) { fail(`建筑 ${String(a.key ?? "?")} 与 ${String(b.key ?? "?")} 占位重叠`); return; }
      }
      for (const sp of spawns) {
        if (!sp || typeof sp !== "object" || Array.isArray(sp)) continue;
        const sx = Number(sp.x); const sy = Number(sp.y);
        if (sx >= ax && sy >= ay && sx < ax + aw && sy < ay + ah) { fail(`出生点（${sx},${sy}）落在建筑 ${String(a.key ?? "?")} 内`); return; }
      }
    }
    for (let i = 0; i < spawns.length; i += 1) {
      const a = spawns[i]; if (!a || typeof a !== "object" || Array.isArray(a)) continue;
      const ax = Number(a.x); const ay = Number(a.y);
      if (![ax, ay].every(Number.isFinite) || ax < 0 || ay < 0 || ax >= width || ay >= height) { fail(`出生点（${ax},${ay}）越界`); return; }
      for (let j = i + 1; j < spawns.length; j += 1) {
        const b = spawns[j]; if (b && typeof b === "object" && !Array.isArray(b) && Number(b.x) === ax && Number(b.y) === ay) { fail(`出生点（${ax},${ay}）重复`); return; }
      }
    }
    applyDoc({ ...load.doc, buildings, spawns }, "canvas-move-batch");
  }, [load, applyDoc]);

  /** R28：移动对象松手——单位类走边界/占位校验；图形/渲染类直接应用（均已钳图界） */
  const onMoveObject = useCallback(
    (kind: "building" | "spawn" | "patch" | "box" | "decor", index: number, x: number, y: number) => {
      if (!load) return;
      if (kind === "patch") {
        const patches = Array.isArray(load.doc.terrain_patches) ? (load.doc.terrain_patches as Array<Entity>) : [];
        const entry = patches[index];
        if (!entry) return;
        applyDoc(moveTerrainPatch(load.doc, index, x - Number(entry.x ?? 0), y - Number(entry.y ?? 0)), "canvas-move");
        return;
      }
      if (kind === "box") {
        const boxes = Array.isArray(load.doc.box_mode) ? (load.doc.box_mode as Array<Entity>) : [];
        const entry = boxes[index];
        if (!entry) return;
        const st = entry.start as Entity | undefined;
        if (!st) return;
        applyDoc(moveBox(load.doc, index, x - Number(st.w ?? 0), y - Number(st.h ?? 0)), "canvas-move");
        return;
      }
      if (kind === "decor") {
        applyDoc(moveDecor(load.doc, index, x, y), "canvas-move");
        return;
      }
      const buildings = Array.isArray(load.doc.buildings) ? (load.doc.buildings as Array<Entity>) : [];
      const spawns = Array.isArray(load.doc.spawns) ? (load.doc.spawns as Array<Entity>) : [];
      if (kind === "building") {
        const entry = buildings[index];
        if (!entry) return;
        const w = Math.max(1, Number(entry.w ?? 1));
        const h = Math.max(1, Number(entry.h ?? 1));
        if (x + w > Number(load.doc.width ?? 0) || y + h > Number(load.doc.height ?? 0)) {
          setSaveState({ tone: "rejected", code: "usage", errors: [`移动越界：建筑（${x},${y} ${w}×${h}）超出地图边界`] });
          return;
        }
        for (let i = 0; i < buildings.length; i += 1) {
          if (i === index) continue;
          const b = buildings[i];
          const bx = Number(b.x);
          const by = Number(b.y);
          const bw = Number(b.w ?? 1);
          const bh = Number(b.h ?? 1);
          if (x < bx + bw && bx < x + w && y < by + bh && by < y + h) {
            setSaveState({ tone: "rejected", code: "usage", errors: [`移动重叠：与建筑 ${String(b.key ?? "?")}（${bx},${by}）占位冲突`] });
            return;
          }
        }
        for (const sp of spawns) {
          const sx2 = Number(sp.x);
          const sy2 = Number(sp.y);
          if (sx2 >= x && sy2 >= y && sx2 < x + w && sy2 < y + h) {
            setSaveState({ tone: "rejected", code: "usage", errors: [`移动重叠：出生点（${sx2},${sy2}）在该建筑占位内`] });
            return;
          }
        }
      } else {
        const entry = spawns[index];
        if (!entry) return;
        for (let i = 0; i < buildings.length; i += 1) {
          const b = buildings[i];
          const bx = Number(b.x);
          const by = Number(b.y);
          const bw = Number(b.w ?? 1);
          const bh = Number(b.h ?? 1);
          if (x >= bx && y >= by && x < bx + bw && y < by + bh) {
            setSaveState({ tone: "rejected", code: "usage", errors: [`移动重叠：出生点（${x},${y}）落在建筑 ${String(b.key ?? "?")} 占位内`] });
            return;
          }
        }
        for (let i = 0; i < spawns.length; i += 1) {
          if (i === index) continue;
          if (Number(spawns[i].x) === x && Number(spawns[i].y) === y) {
            setSaveState({ tone: "rejected", code: "usage", errors: [`移动重叠：出生点（${x},${y}）已被占用`] });
            return;
          }
        }
      }
      if (
        kind === "building"
          ? Number((load.doc.buildings as Array<Entity>)[index]?.x) === x && Number((load.doc.buildings as Array<Entity>)[index]?.y) === y
          : Number((load.doc.spawns as Array<Entity>)[index]?.x) === x && Number((load.doc.spawns as Array<Entity>)[index]?.y) === y
      ) {
        return; // 原地松手=仅选中，不算修改
      }
      applyDoc(moveEntry(load.doc, kind === "building" ? "buildings" : "spawns", index, x, y), "canvas-move");
    },
    [load, applyDoc],
  );

  // 文档变更后选中索引越界即清（删除对象等场景）
  useEffect(() => {
    const valid = selectedObjects.filter((sel) => {
      const list = sel.kind === "building" ? load?.doc.buildings : load?.doc.spawns;
      return Array.isArray(list) && sel.index >= 0 && sel.index < list.length;
    });
    if (valid.length !== selectedObjects.length) setSelectedObjects(valid);
    const activeIsValid = selectedObject
      && valid.some((sel) => sel.kind === selectedObject.kind && sel.index === selectedObject.index);
    const nextActive = activeIsValid ? selectedObject : (valid.at(-1) ?? null);
    if (nextActive?.kind !== selectedObject?.kind || nextActive?.index !== selectedObject?.index) setSelectedObject(nextActive);
  }, [load, selectedObject, selectedObjects]);

  /** R20：占位冲突检测——建筑/单位/炮台任意两者不得重合（开局触发召唤物点位=允许覆盖，
   *  不在任何占位表中，天然可放）。返回 null=可放，否则返回冲突描述。 */
  const placementConflict = useCallback(
    (kind: "building" | "spawn", x: number, y: number, w: number, h: number): string | null => {
      if (!load) return null;
      const buildings = Array.isArray(load.doc.buildings) ? (load.doc.buildings as Array<Entity>) : [];
      const spawns = Array.isArray(load.doc.spawns) ? (load.doc.spawns as Array<Entity>) : [];
      if (kind === "building") {
        for (const b of buildings) {
          const bx = Number(b.x);
          const by = Number(b.y);
          const bw = Number(b.w ?? 1);
          const bh = Number(b.h ?? 1);
          if (x < bx + bw && bx < x + w && y < by + bh && by < y + h) {
            return `放置重叠：与建筑 ${String(b.key ?? "?")}（${bx},${by} ${bw}×${bh}）占位冲突`;
          }
        }
        for (const sp of spawns) {
          const sx2 = Number(sp.x);
          const sy2 = Number(sp.y);
          if (sx2 >= x && sy2 >= y && sx2 < x + w && sy2 < y + h) {
            return `放置重叠：出生点（${sx2},${sy2}）在该建筑占位内`;
          }
        }
      } else {
        for (const b of buildings) {
          const bx = Number(b.x);
          const by = Number(b.y);
          const bw = Number(b.w ?? 1);
          const bh = Number(b.h ?? 1);
          if (x >= bx && y >= by && x < bx + bw && y < by + bh) {
            return `放置重叠：出生点落在建筑 ${String(b.key ?? "?")}（${bx},${by} ${bw}×${bh}）占位内`;
          }
        }
        for (const sp of spawns) {
          if (Number(sp.x) === x && Number(sp.y) === y) {
            return `放置重叠：出生点（${x},${y}）已存在`;
          }
        }
      }
      return null;
    },
    [load],
  );

  const onPlaceAt = useCallback(
    (x: number, y: number) => {
      if (!load) return;
      if (toolState.tool === "building") {
        const def = buildingDefs.find((d) => d.key === toolState.buildingKey);
        if (!def) return;
        const fp = footprintFor(def.key, def.w, def.h);
        const conflict = placementConflict("building", x, y, fp.w, fp.h);
        if (conflict) {
          setSaveState({ tone: "rejected", code: "usage", errors: [`${conflict}——建筑/单位/炮台不可互相覆盖（触发召唤物点位除外）`] });
          return;
        }
        applyDoc(addBuilding(load.doc, x, y, def, toolState.team), "canvas-building");
      } else if (toolState.tool === "tree") {
        applyDoc(addTree(load.doc, x, y), "canvas-tree");
      } else if (toolState.tool === "spawn") {
        const conflict = placementConflict("spawn", x, y, 1, 1);
        if (conflict) {
          setSaveState({ tone: "rejected", code: "usage", errors: [`${conflict}——建筑/单位/炮台不可互相覆盖（触发召唤物点位除外）`] });
          return;
        }
        applyDoc(addSpawn(load.doc, x, y, toolState.spawnKind, toolState.spawnTeam, toolState.spawnCount), "canvas-spawn");
      }
    },
    [load, applyDoc, toolState, buildingDefs, placementConflict],
  );

  const onDeleteAt = useCallback(
    (x: number, y: number) => {
      if (!load) return;
      applyDoc(deleteAt(load.doc, x, y), "canvas-delete");
    },
    [load, applyDoc],
  );

  /** R16：右键取消当前工具回预览（编辑器惯例；预览态右键建筑仍出调参菜单） */
  const onToolCancel = useCallback(() => {
    setToolState((prev) => (prev.tool === "none" ? prev : { ...prev, tool: "none" }));
  }, []);

  /** R17：一键地图边界——四边一圈 禁通行(3)+禁建(1) box（走覆盖语义，单步撤销） */
  const onBorderBoxes = useCallback(() => {
    if (!load) return;
    const w = Number(load.doc.width ?? 0);
    const h = Number(load.doc.height ?? 0);
    if (!(Number.isInteger(w) && w > 0 && Number.isInteger(h) && h > 0)) return;
    let next = load.doc;
    next = addBox(next, 0, 0, w - 1, 0, 3, 1);
    next = addBox(next, 0, h - 1, w - 1, h - 1, 3, 1);
    next = addBox(next, 0, 0, 0, h - 1, 3, 1);
    next = addBox(next, w - 1, 0, w - 1, h - 1, 3, 1);
    applyDoc(next, "canvas-border");
  }, [load, applyDoc]);

  /** R17：执行文件重命名（含 .bak 跟随；已打开副本换键保留编辑态） */
  const doRename = useCallback(
    async (from: string, to: string) => {
      if (busyRef.current) return;
      setBusy(true);
      try {
        let baseHash = docs[from]?.hash;
        if (!baseHash) {
          const read = await api.readMap(from);
          if (!read.ok || !read.hash) throw new Error(read.error ?? "重命名前读取地图失败");
          baseHash = read.hash;
        }
        const result = await api.renameMap({ from, to, baseHash });
        if (!result.ok) throw new Error((result.errors ?? ["重命名失败"])[0]);
        const newName = result.name ?? to;
        setRenameModal(null);
        setDocs((prev) => {
          const next = { ...prev };
          const open = next[from];
          if (open) {
            delete next[from];
            next[newName] = { ...open, name: newName, path: result.path ?? open.path };
          }
          return next;
        });
        setActiveKey((key) => (key === from ? newName : key));
        setExternalChanges((prev) => prev.filter((name) => name !== from));
        historyRef.current.clear(from);
        await refreshList();
      } catch (error) {
        setRenameModal((prev) => (prev ? { ...prev, error: String(error) } : prev));
      } finally {
        setBusy(false);
      }
    },
    [docs, refreshList, setBusy],
  );

  // —— R14/R20 右键调参（建筑 + 出生点）：菜单 → 确保字段存在 → 展开 JSON 抽屉 → 定位 ——
  const onEntityContext = useCallback(
    (hit: { kind: "building" | "spawn"; index: number; cell: { x: number; y: number } }, screen: { x: number; y: number }) => {
      if (!load) return;
      if (hit.kind === "building") {
        if (!Array.isArray(load.doc.buildings)) return;
        const list = load.doc.buildings as Array<Entity>;
        const b = list[hit.index];
        if (!b) return;
        setCtxMenu({ kind: "building", index: hit.index, x: screen.x, y: screen.y });
      } else {
        if (!Array.isArray(load.doc.spawns)) return;
        if (!(load.doc.spawns as Array<Entity>)[hit.index]) return;
        setCtxMenu({ kind: "spawn", index: hit.index, x: screen.x, y: screen.y });
      }
    },
    [load],
  );

  /** 通用字段跳转（R20）：basePath 为数组字段名，field 缺省时按 default 创建后定位 */
  const focusArrayField = useCallback(
    (basePath: "buildings" | "spawns", index: number, field: string | null) => {
      if (!load) return;
      setCtxMenu(null);
      setJsonOpen(true);
      let doc = load.doc;
      if (field !== null) {
        const list = Array.isArray(doc[basePath]) ? [...((doc as Record<string, unknown>)[basePath] as Array<Entity>)] : [];
        const entry: Entity = { ...(list[index] as Entity) };
        if (entry && !(field in entry)) {
          if (basePath === "buildings") {
            const def = buildingDefs.find((d) => d.key === String(entry.key ?? ""));
            if (field === "level") entry.level = 1;
            else if (field === "hp") entry.hp = def?.hp ?? 500;
            else if (field === "team") entry.team = entry.team ?? 1;
            else if (field === "lines") entry.lines = [];
            else if (field === "unlocked_lines") entry.unlocked_lines = 1;
          } else {
            if (field === "count") entry.count = 1;
            else if (field === "team") entry.team = entry.team ?? 1;
            else if (field === "kind") entry.kind = entry.kind ?? 0;
          }
          list[index] = entry;
          doc = { ...doc, [basePath]: list };
          historyRef.current.commit(activeKey, load.doc, "ctx-add-field", 0);
          setDocs((prev) => ({ ...prev, [activeKey]: { ...load, doc } }));
        }
      }
      const testId = field === null ? `field-${basePath}-${index}-${basePath === "buildings" ? "key" : "kind"}` : `field-${basePath}-${index}-${field}`;
      window.setTimeout(() => {
        const el = document.querySelector(`[data-testid="${testId}"]`);
        if (el) {
          el.scrollIntoView({ block: "center", behavior: "smooth" });
          el.classList.add("flash-focus");
          window.setTimeout(() => el.classList.remove("flash-focus"), 1800);
        }
      }, 80);
    },
    [load, buildingDefs, activeKey],
  );

  /** 菜单项 → 打开抽屉并跳到 buildings-<i>[-field]；字段缺失则先按默认值创建（进撤销历史） */
  const focusBuildingField = useCallback(
    (index: number, field: "team" | "level" | "hp" | null) => {
      if (!load) return;
      setCtxMenu(null);
      setJsonOpen(true);
      let doc = load.doc;
      if (field !== null) {
        const list = Array.isArray(doc.buildings) ? [...(doc.buildings as Array<Entity>)] : [];
        const entry: Entity = { ...(list[index] as Entity) };
        if (entry !== null && !(field in entry)) {
          const def = buildingDefs.find((d) => d.key === String(entry.key ?? ""));
          if (field === "level") entry.level = 1;
          else if (field === "hp") entry.hp = def?.hp ?? 500;
          // team 恒存在，仅防御
          else entry.team = entry.team ?? 1;
          list[index] = entry;
          doc = { ...doc, buildings: list };
          historyRef.current.commit(activeKey, load.doc, "ctx-add-field", 0);
          setDocs((prev) => ({ ...prev, [activeKey]: { ...load, doc } }));
        }
      }
      const testId = field === null ? `field-buildings-${index}-key` : `field-buildings-${index}-${field}`;
      window.setTimeout(() => {
        const el = document.querySelector(`[data-testid="${testId}"]`);
        if (el) {
          el.scrollIntoView({ block: "center", behavior: "smooth" });
          el.classList.add("flash-focus");
          window.setTimeout(() => el.classList.remove("flash-focus"), 1800);
        }
      }, 80);
    },
    [load, buildingDefs, activeKey],
  );

  const saveDoc = useCallback(
    async (key: string): Promise<boolean> => {
      if (busyRef.current) return false;
      const state = docs[key];
      if (!state || !dirtyOf(state)) return true;
      setSaveState({ tone: "saving" });
      setBusy(true);
      try {
        const targetName = state.isNew ? fileNameFor(state.doc.name, `new_map_${Date.now()}`) : state.name;
        const result: MapSaveResult = await api.saveMap({
          name: targetName,
          data: state.doc,
          baseHash: state.hash,
          expectCreate: state.isNew,
        });
        if (result.ok) {
          const text = serializeText(state.doc);
          const hash = result.hash ?? state.hash;
          setDocs((prev) => {
            const next = { ...prev };
            delete next[key];
            next[targetName] = { name: targetName, doc: state.doc, text, hash, path: result.path ?? state.path, isNew: false, original: state.doc };
            return next;
          });
          setActiveKey(targetName);
          setExternalChanges((prev) => prev.filter((name) => name !== targetName));
          setSaveState({
            tone: "ok",
            written: Boolean(result.written),
            label: state.isNew ? `已创建：${targetName}` : targetName,
          });
          await refreshList();
          return true;
        }
        setSaveState({ tone: "rejected", code: result.code ?? "error", errors: result.errors ?? ["未知错误"] });
        return false;
      } catch (error) {
        setSaveState({ tone: "rejected", code: "io", errors: [String(error)] });
        return false;
      } finally {
        setBusy(false);
      }
    },
    [docs, refreshList],
  );

  const save = useCallback(() => {
    if (!load || busyRef.current) return;
    void saveDoc(activeKey);
  }, [load, busy, activeKey, saveDoc]);

  useImperativeHandle(
    handleRef,
    () => ({
      async saveAll(): Promise<boolean> {
        if (busyRef.current) return false;
        for (const key of Object.keys(docs)) {
          if (dirtyOf(docs[key])) {
            const ok = await saveDoc(key);
            if (!ok) return false;
          }
        }
        return true;
      },
      isAnyDirty(): boolean {
        return Object.values(docs).some(dirtyOf);
      },
      isBusy(): boolean { return busyRef.current; },
      undo(): void {
        undoRedo(-1);
      },
      redo(): void {
        undoRedo(1);
      },
      save(): void {
        // R18：无改动也给反馈（此前静默无反应，观感即"Ctrl+S 没用"）
        if (!load) return;
        if (!dirtyOf(load)) {
          setSaveState({ tone: "ok", written: false, label: load.isNew ? "（新地图，未落盘）" : load.name });
          return;
        }
        save();
      },
      async reloadCurrent(): Promise<void> {
        await reloadActive();
      },
    }),
    // 依赖涵盖全部被引用回调，避免"先建句柄后声明"的 TDZ 隐患
    [docs, activeKey, load, saveDoc, save, undoRedo, reloadActive],
  );

  // R20：弹出层外部点击关闭（调参菜单 / 列表右键菜单 / 地图选择器）
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (ctxMenu && !target.closest(".ctx-menu")) setCtxMenu(null);
      if (listMenu && !target.closest(".ctx-menu")) setListMenu(null);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [ctxMenu, listMenu]);

  useEffect(() => {
    if (!active) return;
    // 参数热键（R11）：地形笔刷/擦除 = 数字键 0..4 直切地形码；box = 数字键 0..3 切
    // 通行维度、B 键切禁建。输入框/下拉聚焦时不接管；Ctrl/Cmd/Alt 组合不接管。
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (/^[0-9]$/.test(event.key)) {
        const n = Number(event.key);
        if (toolState.tool === "terrain" || toolState.tool === "erase") {
          if (n <= 4) {
            setToolState((prev) => ({ ...prev, terrain: n }));
            event.preventDefault();
          }
        } else if (toolState.tool === "box" && n <= 3) {
          setToolState((prev) => ({ ...prev, access: n }));
          event.preventDefault();
        }
      } else if (event.key.toLowerCase() === "b" && toolState.tool === "box") {
        setToolState((prev) => ({ ...prev, build: prev.build === 1 ? 0 : 1 }));
        event.preventDefault();
      } else if (event.key === "Escape") {
        setSelectedObject(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, toolState.tool]);

  // Ctrl+S/Ctrl+Z/Ctrl+Y 由 App 全局监听统一路由到本面板句柄（隐藏时不响应——
  // 面板常驻挂载，自带 window 监听会在配置页误触发，R9 收口）。

  const lightErrors = useMemo(() => (load ? validateMapTree(load.doc as Entity) : new Map<string, string>()), [load]);
  const invalidCanvasFields = useMemo(() => {
    if (!load) return [];
    return ["buildings", "spawns", "box_mode", "terrain_patches", "decor"].filter((key) => {
      const value = load.doc[key];
      return value !== undefined && (!Array.isArray(value) || value.some((entry) => entry === null || typeof entry !== "object" || Array.isArray(entry)));
    });
  }, [load]);

  const original = useMemo(() => {
    if (!load) return {} as Entity;
    // R31：用缓存的 original（读取/保存时解析好）——旧版每次渲染都 JSON.parse(load.text)
    return load.original as Entity;
  }, [load]);

  const lineUnitSuggestions = useMemo(
    () => mapUnitSuggestions(unitsCache, labelsData),
    [unitsCache, labelsData],
  );

  const fileNames = useMemo(() => new Set(Object.keys(docs)), [docs]);

  return (
    <div className="maps-panel">
      <div className="maps-toolbar">
        <button className="btn slim" data-testid="map-new-btn" onClick={createMap} disabled={busy}>
          <FilePlus2 size={14} /> 新建
        </button>
        <button className="btn slim" data-testid="map-import-btn" onClick={() => void importMap()} disabled={busy}><FolderInput size={14} /> 导入地图</button>
        <button className="btn slim" data-testid="map-reload-btn" title="刷新地图列表、图片和外部修改状态" onClick={() => void refreshWorkspace()} disabled={busy}>
          <RotateCcw size={14} /> 刷新
        </button>
        <button
          className="btn slim"
          data-testid="map-undo-btn"
          onClick={() => undoRedo(-1)}
          disabled={busy || !load || !historyRef.current.canUndo(activeKey)}
          title="撤销（Ctrl+Z）——画布操作逐步、字段树输入合并"
        >
          <Undo2 size={14} />
        </button>
        <button
          className="btn slim"
          data-testid="map-redo-btn"
          onClick={() => undoRedo(1)}
          disabled={busy || !load || !historyRef.current.canRedo(activeKey)}
          title="重做（Ctrl+Y / Ctrl+Shift+Z）"
        >
          <Redo2 size={14} />
        </button>
        <button
          className="btn slim"
          data-testid="map-reload-doc-btn"
          onClick={() => void reloadActive()}
          disabled={busy || !load}
          title="丢弃未保存修改，从磁盘重读当前地图"
        >
          <RotateCcw size={14} /> 重载
        </button>
        <span className="tool-group">
          {(
            [
              ["none", "预览"],
              ["terrain", "地形笔刷"],
              ["erase", "擦除地形"],
              ["box", "画 box 范围"],
              ["building", "放建筑"],
              ["tree", "放树"],
              ["spawn", "放出生点"],
              ["delete", "删除"],
              ["move-unit", "移动·单位"],
              ["move-shape", "移动·地形"],
              ["move-render", "移动·渲染"],
            ] as Array<[ToolState["tool"], string]>
          ).map(([value, label], index) => (
            <Fragment key={value}>
              {/* R31：按 查看/绘制/放置 三段分组，段间插分隔线（分组只影响观感，不改工具语义与 testid） */}
              {index === 1 || index === 4 || index === 8 ? <span className="tool-sep" aria-hidden="true" /> : null}
              <button
                className={`btn slim tool${toolState.tool === value ? " active" : ""}`}
                data-testid={`map-tool-${value}`}
                title={label}
                aria-label={label}
                disabled={busy || ((backgroundView === "tilt" || invalidCanvasFields.length > 0) && value !== "none") || (wholeImageMode && ["terrain", "erase"].includes(value))}
                onClick={() => setToolState((prev) => ({ ...prev, tool: value }))}
              >
                {(() => { const Icon = TOOL_ICONS[value]; return <Icon size={16} />; })()}
              </button>
            </Fragment>
          ))}
        </span>
        {toolState.tool === "terrain" ? (
          <Dropdown value={String(toolState.terrain)} options={toOptions(TERRAIN_OPTIONS)} onChange={(v) => setToolState((prev) => ({ ...prev, terrain: Number(v) }))} testId="map-select-terrain" />
        ) : null}
        {toolState.tool === "box" ? (
          <>
            <Dropdown value={String(toolState.access)} options={toOptions(ACCESS_OPTIONS)} onChange={(v) => setToolState((prev) => ({ ...prev, access: Number(v) }))} testId="map-select-access" />
            <Dropdown value={String(toolState.build)} options={toOptions(BUILD_OPTIONS)} onChange={(v) => setToolState((prev) => ({ ...prev, build: Number(v) }))} testId="map-select-build" />
          </>
        ) : null}
        {toolState.tool === "building" ? (
          <>
            <Dropdown value={String(toolState.buildingKey)} options={buildingDefs.map(buildingOption)} onChange={(v) => setToolState((prev) => ({ ...prev, buildingKey: v }))} testId="map-select-building" />
            <Dropdown value={String(toolState.team)} options={toOptions(TEAM_OPTIONS)} onChange={(v) => setToolState((prev) => ({ ...prev, team: Number(v) }))} testId="map-select-team" />
          </>
        ) : null}
        {toolState.tool === "spawn" ? (
          <>
            <Dropdown value={String(toolState.spawnKind)} options={unitOptionsOf(unitsCache).map((u) => ({ value: String(u.id), label: `${u.id}（${u.key}）` }))} onChange={(v) => setToolState((prev) => ({ ...prev, spawnKind: Number(v) }))} testId="map-select-spawn-kind" />
            <Dropdown value={String(toolState.spawnTeam)} options={toOptions(TEAM_OPTIONS)} onChange={(v) => setToolState((prev) => ({ ...prev, spawnTeam: Number(v) }))} testId="map-select-spawn-team" />
            <input
              className="cell num"
              data-testid="map-input-spawn-count"
              type="number"
              min={1}
              value={toolState.spawnCount}
              onChange={(e) => setToolState((prev) => ({ ...prev, spawnCount: Math.max(1, Number(e.target.value) || 1) }))}
            />
          </>
        ) : null}
        <span className="chip map-count-chip" data-testid="map-count-chip" title={list?.mapsDir ?? ""}>
          {list?.ok ? (
            <>
              <b>{list.maps?.length ?? 0}</b> 张
              <span className="chip-text">{list.mapsDir}</span>
            </>
          ) : (
            (list?.error ?? "…")
          )}
        </span>
        <span
          className={`chip${dirty ? " dirty" : ""}`}
          data-testid="map-dirty-chip"
          title={dirty ? "当前地图有未保存修改" : "无改动"}
        >
          {dirty ? "未保存" : "已同步"}
        </span>
        <button
          className="btn primary"
          data-testid="map-save-btn"
          onClick={save}
          disabled={busy || !load || !dirty}
        >
          <Save size={14} /> 保存
        </button>
      </div>

      {saveState.tone === "saving" ? <div className="banner info">Godot 地图门禁校验中…</div> : null}
      {externalChanges.length > 0 ? <div className="banner warn" data-testid="map-external-changes">磁盘地图已变化：{externalChanges.join("、")}。当前编辑副本已保留，保存时会核对文件版本。</div> : null}
      {invalidCanvasFields.length > 0 ? <div className="banner error" data-testid="map-structure-errors">{invalidCanvasFields.join("、")}：须为对象数组。画布编辑已暂停，原始字段保留在 JSON 编辑器中。</div> : null}
      {saveState.tone === "ok" ? (
        <div className="banner ok" data-testid="map-save-ok">
          {saveState.written ? `已保存：${saveState.label}（旧文件备份为 .bak）` : "无改动，未写盘"}
        </div>
      ) : null}
      {saveState.tone === "rejected" ? (
        <div className="banner error" data-testid="map-save-errors">
          <strong>{saveState.code === "gate" ? "Godot 门禁拒绝（文件未改动）" : saveState.code === "conflict" ? "文件冲突" : "保存失败"}：</strong>
          <ul>
            {saveState.errors.map((error, index) => (
              <li key={index}>{error}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="maps-body">
        <aside className="map-list" data-testid="map-list">
          <div className="map-list-heading"><span>地图</span><span>{list?.maps?.length ?? 0}</span></div>
          {(list?.maps ?? []).map((meta) => (
            <button
              key={meta.name}
              className={`map-item${activeKey === meta.name ? " active" : ""}`}
              data-testid={`map-item-${meta.name.replace(/\./g, "-")}`}
              disabled={busy}
              onClick={() => void openMap(meta.name)}
              onContextMenu={(event) => {
                event.preventDefault();
                setListMenu({ name: meta.name, x: event.clientX, y: event.clientY });
              }}
            >
              {meta.name}
              {dirtyOf(docs[meta.name]) ? <span className="tab-dirty" title="有未保存修改" /> : null}
            </button>
          ))}
          {Object.entries(docs)
            .filter(([key]) => key.startsWith("@new/") && !fileNames.has(key.slice(5)))
            .map(([key, state]) => (
              <button
                key={key}
                className={`map-item new${activeKey === key ? " active" : ""}`}
                data-testid="map-item-new"
                disabled={busy}
                onClick={() => setActiveKey(key)}
              >
                ＊ {String(state.doc.name ?? "新地图")}（未保存）
                {dirtyOf(state) ? <span className="tab-dirty" title="有未保存修改" /> : null}
              </button>
            ))}
        </aside>

        <section className="map-workarea">
          {/* R20 布局：文件列表改画布左上悬浮选择器（红框标注=画布满幅，右缘快捷钮、底部备注） */}
          {/* 主区 = 画布铺满 + 悬浮 JSON 按钮（研发入口）。字段树（JSON）默认折叠，
              点按钮弹出底层抽屉覆盖地图下半区——上地图/下 JSON，画布不因开合重排 */}
          <MapCanvas
            doc={(load?.doc as Entity) ?? null}
            tool={toolState}
            backgroundUrl={previewImage?.dataUrl}
            projection={backgroundView}
            readOnly={backgroundView === "tilt" || busy || invalidCanvasFields.length > 0}
            onTerrainRect={onTerrainRect}
            onBoxAdd={onBoxAdd}
            onPlaceAt={onPlaceAt}
            onDeleteAt={onDeleteAt}
            onEntityContext={onEntityContext}
            onToolCancel={onToolCancel}
            selected={selectedObject}
            selectedObjects={selectedObjects}
            buildingAbbreviations={buildingAbbreviations}
            onSelectObject={onSelectObject}
            onSelectObjects={onSelectObjects}
            onChangeObjectTeam={onChangeObjectTeam}
            onChangeObjectsTeam={onChangeObjectsTeam}
            onMoveObject={onMoveObject}
            onMoveObjects={onMoveObjects}
            overlayBar={
              <>
                <button
                  className="quick-sq"
                  data-testid="map-border-btn"
                  onClick={onBorderBoxes}
                  disabled={busy || !load || invalidCanvasFields.length > 0}
                  title="一键设置地图边界：四边边缘放一圈 禁通行+禁建 的 box_mode（覆盖语义，可 Ctrl+Z 撤销）"
                >
                  <ScanLine size={17} />
                </button>
                <button
                  className="quick-sq"
                  data-testid="map-revert-btn"
                  onClick={() => void reloadActive()}
                  disabled={busy || !load || load.isNew}
                  title="一键取消编辑：丢弃当前地图全部未保存修改，回到上次保存（脏则确认）"
                >
                  <RotateCcw size={17} />
                </button>
              </>
            }
          />

          <button
            className="map-json-fab"
            data-testid="map-json-toggle"
            title={jsonOpen ? "折叠 JSON 字段树（研发用）" : "展开 JSON 字段树（研发用——普通地图设计用画布工具即可）"}
            onClick={() => setJsonOpen((open) => !open)}
          >
            <Braces size={17} />
          </button>
          {jsonOpen ? (
            <div className="map-json-drawer" data-testid="map-json-drawer">
              <div className="map-json-head">
                <span>
                  {load?.isNew ? (
                    <span className="json-target-name" data-testid="json-target-name">
                      首次保存将落盘为 <b>{fileNameFor(load.doc.name, `map_${Date.now()}`)}</b>（随 name 字段实时变）
                    </span>
                  ) : null}
                  JSON 字段树（研发用；数值编辑后保存仍须过 Godot 门禁）
                </span>
                <button className="btn slim" onClick={() => setJsonOpen(false)}>
                  收起
                </button>
              </div>
              <div className="map-json-tree">
                {load ? (
                  <FieldTree
                    entity={load.doc as Entity}
                    original={original}
                    labels={labelsData}
                    lightErrors={lightErrors}
                    unitSuggestions={lineUnitSuggestions}
                    onChange={updateDoc}
                  />
                ) : (
                  <div className="empty">选择左侧地图，或「＋ 新建地图」。</div>
                )}
              </div>
            </div>
          ) : null}
          <div className="map-notes" data-testid="map-notes">
            {/* R31：图例/提示默认收起——三段说明常驻会吃掉画布垂直空间；
                data-testid="map-notes" 保留在容器上（探针断言不断），内容展开后仍在。 */}
            <button
              className="map-notes-toggle"
              data-testid="map-notes-toggle"
              onClick={() => setNotesOpen((open) => !open)}
              title={notesOpen ? "收起图例与提示" : "展开图例与提示"}
            >
              {notesOpen ? "▾" : "▸"} 图例与提示
              {lightErrors.size > 0 ? ` · 告警 ${lightErrors.size}` : ""}
            </button>
            {notesOpen ? (
              <>
                <div className="map-hint">{TOOL_HINTS[toolState.tool]}</div>
                <div className="map-hint legend-line">
                  <span className="lg">框：</span>
                  <span className="lg"><span className="legend-swatch" style={{ background: "#E5484D" }} />红=禁建</span>
                  <span className="lg"><span className="legend-swatch" style={{ background: "transparent", border: "1px dashed #8b919c" }} />无框=可建</span>
                  <span className="lg vsep" />
                  <span className="lg">X：</span>
                  <span className="lg"><span className="legend-swatch" style={{ background: "#E5B567" }} />黄=仅禁地面</span>
                  <span className="lg"><span className="legend-swatch" style={{ background: "#3E9BE8" }} />蓝=仅禁飞碟</span>
                  <span className="lg"><span className="legend-swatch" style={{ background: "#E5484D" }} />红=禁所有单位</span>
                  <span className="lg"><span className="legend-swatch" style={{ background: "transparent", border: "1px dashed #8b919c" }} />无X=全通行</span>
                </div>
                <div className="map-hint">
                  轻校验告警 {lightErrors.size} 处（仅提示，语义以 Godot 门禁为准）。地形码：0 可通行 / 1 阻挡 / 2 山体 / 3 水面 / 4 可通行禁建。占位规则：建筑/单位/炮台互不重叠，触发召唤物点位可覆盖。
                </div>
              </>
            ) : null}
          </div>
          {ctxMenu && load ? (
            ctxMenu.kind === "building" && Array.isArray(load.doc.buildings) ? (
              <div
                className="ctx-menu"
                data-testid="building-ctx-menu"
                style={{ left: Math.min(ctxMenu.x, window.innerWidth - 200), top: Math.min(ctxMenu.y, window.innerHeight - 190) }}
              >
                <div className="ctx-title">
                  {String(((load.doc.buildings as Array<Entity>)[ctxMenu.index] ?? {}).key ?? "?")}
                  <span className="ctx-sub">（仅本图调参，不改 buildings.json）</span>
                </div>
                <button className="ctx-item" data-testid="ctx-field-team" onClick={() => focusArrayField("buildings", ctxMenu.index, "team")}>
                  队伍 team
                </button>
                <button className="ctx-item" data-testid="ctx-field-level" onClick={() => focusArrayField("buildings", ctxMenu.index, "level")}>
                  等级 level（新建默认 1）
                </button>
                <button className="ctx-item" data-testid="ctx-field-hp" onClick={() => focusArrayField("buildings", ctxMenu.index, "hp")}>
                  血量 hp（新建默认取配置表）
                </button>
                <button className="ctx-item" data-testid="ctx-field-lines" onClick={() => focusArrayField("buildings", ctxMenu.index, "lines")}>
                  产线 lines（新建空数组→字段树「＋ 添加」逐线配置）
                </button>
                <button className="ctx-item" data-testid="ctx-field-unlocked" onClick={() => focusArrayField("buildings", ctxMenu.index, "unlocked_lines")}>
                  解锁线数 unlocked_lines（新建默认 1）
                </button>
                <button className="ctx-item" onClick={() => focusArrayField("buildings", ctxMenu.index, null)}>
                  定位 JSON（整条目）
                </button>
                <button
                  className="ctx-item danger-item"
                  data-testid="ctx-delete-building"
                  onClick={() => {
                    if (!load) return;
                    const list = Array.isArray(load.doc.buildings) ? [...(load.doc.buildings as Array<Entity>)] : [];
                    if (ctxMenu.index < list.length) {
                      applyDoc({ ...load.doc, buildings: list.filter((_, i) => i !== ctxMenu.index) }, "ctx-delete");
                    }
                    setCtxMenu(null);
                    setSelectedObject(null);
                  }}
                >
                  删除此建筑
                </button>
                <button className="ctx-item cancel" onClick={() => setCtxMenu(null)}>
                  取消
                </button>
              </div>
            ) : ctxMenu.kind === "spawn" && Array.isArray(load.doc.spawns) ? (
              <div
                className="ctx-menu"
                data-testid="spawn-ctx-menu"
                style={{ left: Math.min(ctxMenu.x, window.innerWidth - 200), top: Math.min(ctxMenu.y, window.innerHeight - 190) }}
              >
                <div className="ctx-title">
                  出生点 #{ctxMenu.index}
                  <span className="ctx-sub">（仅本图调参）</span>
                </div>
                <button className="ctx-item" data-testid="spawn-ctx-kind" onClick={() => focusArrayField("spawns", ctxMenu.index, "kind")}>
                  单位 kind
                </button>
                <button className="ctx-item" data-testid="spawn-ctx-team" onClick={() => focusArrayField("spawns", ctxMenu.index, "team")}>
                  队伍 team
                </button>
                <button className="ctx-item" data-testid="spawn-ctx-count" onClick={() => focusArrayField("spawns", ctxMenu.index, "count")}>
                  数量 count
                </button>
                <button className="ctx-item" onClick={() => focusArrayField("spawns", ctxMenu.index, null)}>
                  定位 JSON（整条目）
                </button>
                <button
                  className="ctx-item danger-item"
                  data-testid="ctx-delete-spawn"
                  onClick={() => {
                    if (!load) return;
                    const list = Array.isArray(load.doc.spawns) ? [...(load.doc.spawns as Array<Entity>)] : [];
                    if (ctxMenu.index < list.length) {
                      applyDoc({ ...load.doc, spawns: list.filter((_, i) => i !== ctxMenu.index) }, "ctx-delete");
                    }
                    setCtxMenu(null);
                    setSelectedObject(null);
                  }}
                >
                  删除此出生点
                </button>
                <button className="ctx-item cancel" onClick={() => setCtxMenu(null)}>
                  取消
                </button>
              </div>
            ) : null
          ) : null}
          {listMenu ? (
            <div
              className="ctx-menu"
              data-testid="list-ctx-menu"
              style={{ left: Math.min(listMenu.x, window.innerWidth - 190), top: Math.min(listMenu.y, window.innerHeight - 160) }}
            >
              <div className="ctx-title">
                {listMenu.name}
              </div>
              <button
                className="ctx-item"
                data-testid="list-ctx-rename"
                onClick={() => {
                  const base = listMenu.name.replace(/\.json$/, "");
                  setRenameModal({ from: listMenu.name, value: base });
                  setListMenu(null);
                }}
              >
                重命名…
              </button>
              <button
                className="ctx-item"
                data-testid="list-ctx-open-file"
                onClick={() => {
                  void api.openMapFile(listMenu.name);
                  setListMenu(null);
                }}
              >
                打开文件（默认程序）
              </button>
              <button
                className="ctx-item"
                data-testid="list-ctx-open-folder"
                onClick={() => {
                  void api.openMapFolder(listMenu.name);
                  setListMenu(null);
                }}
              >
                打开所在文件夹
              </button>
              <button className="ctx-item cancel" onClick={() => setListMenu(null)}>
                取消
              </button>
            </div>
          ) : null}
          {renameModal ? (
            <div className="modal-mask" data-testid="rename-modal" onClick={(event) => { if (event.target === event.currentTarget) setRenameModal(null); }}>
              <div className="modal" onClick={(event) => event.stopPropagation()}>
                <div className="modal-title">重命名地图文件</div>
                <div className="modal-body">
                  <input
                    className="cell rename-input"
                    data-testid="rename-input"
                    autoFocus
                    defaultValue={renameModal.value}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        const target = document.querySelector<HTMLInputElement>('[data-testid="rename-input"]');
                        void doRename(renameModal.from, `${(target?.value ?? "").trim()}.json`);
                      }
                    }}
                  />
                  <div className="modal-hint">
                    {renameModal.from} → 输入新文件名（不含 .json）；中文可用。已打开的编辑副本会跟随换名，内容与未保存修改保留。
                  </div>
                  {renameModal.error ? <div className="map-hint" style={{ color: "#ff6b6b" }}>{renameModal.error}</div> : null}
                </div>
                <div className="modal-actions">
                  <button
                    className="btn primary"
                    data-testid="rename-ok"
                    onClick={() => {
                      const target = document.querySelector<HTMLInputElement>('[data-testid="rename-input"]');
                      void doRename(renameModal.from, `${(target?.value ?? "").trim()}.json`);
                    }}
                  >
                    重命名
                  </button>
                  <button className="btn" data-testid="rename-cancel" onClick={() => setRenameModal(null)}>
                    取消
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </section>
        <aside className="map-inspector" data-testid="map-inspector">
          <div className="map-inspector-title">属性</div>
          {load ? <BackgroundInspector doc={load.doc} info={backgroundInfo} view={backgroundView} busy={busy} imageMode={wholeImageMode} onMode={(imageMode) => void switchGroundMode(imageMode)} onView={setBackgroundView} onChange={updateDoc} onImport={(slot) => void importBackground(slot)} onRemove={removeBackground} /> : <div className="empty">未选择地图</div>}
          {load && selectedObject ? (() => {
            const key = selectedObject.kind === "building" ? "buildings" : "spawns";
            const entries = load.doc[key];
            const raw = Array.isArray(entries) ? entries[selectedObject.index] : null;
            if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
            return <section className="map-inspector-section" data-testid="map-selected-inspector"><h3>{selectedObject.kind === "building" ? "选中建筑" : "选中出生点"}</h3>{Object.entries(raw).filter(([, value]) => typeof value === "number" || typeof value === "string").map(([field, value]) => <label className="map-field" key={field}><span>{field}</span><input className="cell" type={typeof value === "number" ? "number" : "text"} value={String(value)} disabled={busy || field === "key" || field === "kind"} onChange={(event) => { const next = [...entries as Entity[]]; next[selectedObject.index] = { ...raw, [field]: typeof value === "number" ? Number(event.target.value) : event.target.value }; updateDoc({ ...load.doc, [key]: next }); }} /></label>)}</section>;
          })() : null}
        </aside>
      </div>
    </div>
  );
}
