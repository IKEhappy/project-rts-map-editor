import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, serializeText } from "./api";
import { canonicalJson } from "./canonical";
import { DocHistory } from "./history";
import EntityList from "./components/EntityList";
import FieldTree from "./components/FieldTree";
import MapsPanel, { type MapsPanelHandle } from "./components/MapsPanel";
import RulesTable from "./components/RulesTable";
import type { LabelsData } from "./labels";
import { validateEntityTree, validateRuleValue } from "./light-validation";
import { knownUnitKeys, summonLinesHint, unitSuggestionsFor } from "./suggest";
import { instantiateTemplate, templatesOf, type TemplateDef } from "./templates";
import type { ConfigFile, Entity, JsonValue, Kind, MetaResult, ReadResult, SaveResult } from "./types";

const ALL_KINDS: Kind[] = ["units", "buildings", "rules"];

const KIND_TABS: Array<{ kind: Kind; label: string }> = [
  { kind: "units", label: "单位表" },
  { kind: "buildings", label: "建筑表" },
  { kind: "rules", label: "规则表" },
];

interface LoadState {
  kind: Kind;
  doc: ConfigFile;
  text: string;
  hash: string;
  path: string;
}

type SaveState =
  | { tone: "idle" }
  | { tone: "saving" }
  | { tone: "ok"; written: boolean }
  | { tone: "rejected"; code: string; errors: string[] };

/** 语义脏判定（canonicalJson：数字归一/键序无关/忽略空白）——纯打开或格式差异不算脏 */
function dirtyOf(state?: LoadState | null): boolean {
  if (!state) return false;
  try {
    return canonicalJson(state.doc) !== canonicalJson(JSON.parse(state.text));
  } catch {
    return true;
  }
}

export default function App() {
  const [meta, setMeta] = useState<MetaResult | null>(null);
  // 每张表的工作副本常驻内存（T-164 R6）：切选项卡不重读不丢编辑，退出前统一询问保存
  const [docs, setDocs] = useState<Partial<Record<Kind, LoadState>>>({});
  const [activeKind, setActiveKind] = useState<Kind>("units");
  const [loadingError, setLoadingError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>({ tone: "idle" });
  const [busy, setBusy] = useState(false);
  const [labelsData, setLabelsData] = useState<LabelsData>({});
  const [labelsError, setLabelsError] = useState<string | null>(null);
  const [labelsToken, setLabelsToken] = useState(0);
  const [selectedKeys, setSelectedKeys] = useState<Record<string, string>>({ units: "", buildings: "" });
  // 数据目录覆盖（T-164 R4：导入外部 data 级文件夹；null = 默认路径）。localStorage 持久化。
  const [dataDirOverride, setDataDirOverride] = useState<string | null>(() => {
    try {
      return localStorage.getItem("me.dataDir") || null;
    } catch {
      return null;
    }
  });
  // 无框窗口（T-164 R5）：右上自绘控制按钮，最大化状态同步图标
  const [maximized, setMaximized] = useState(false);
  const [unitsCache, setUnitsCache] = useState<Entity[] | null>(null);
  // 地图编辑（T-164 R7）：面板常驻挂载（切选项卡不丢编辑）；脏计数供关闭守卫
  const [section, setSection] = useState<"configs" | "maps">("configs");
  const [mapsDirty, setMapsDirty] = useState(0);
  const mapsRef = useRef<MapsPanelHandle | null>(null);
  // 撤销/重做（R9）：三表共用一份历史（键=kind）；地图面板自持。Ctrl+Z/Y 全局路由。
  const historyRef = useRef(new DocHistory<ConfigFile>());
  const [historyTick, setHistoryTick] = useState(0);
  // 关闭三选（R9）：保存并退出 / 不保存退出 / 继续编辑——替代二选 confirm
  const [closePrompt, setClosePrompt] = useState(false);
  // R14：buildings.json 在工具内保存的版本（地图页占地/血量默认实时跟随）
  const [buildingsVersion, setBuildingsVersion] = useState(0);

  const load = docs[activeKind] ?? null;
  const dirty = dirtyOf(load);
  const anyDirty = ALL_KINDS.some((kind) => dirtyOf(docs[kind]));
  const anyDirtyAnywhere = anyDirty || mapsDirty > 0;

  useEffect(() => {
    api.onWindowState(setMaximized);
    api.onCloseRequest(() => closeRef.current());
  }, []);

  useEffect(() => {
    try {
      if (dataDirOverride) localStorage.setItem("me.dataDir", dataDirOverride);
      else localStorage.removeItem("me.dataDir");
    } catch {
      /* 持久化失败不影响功能 */
    }
  }, [dataDirOverride]);

  useEffect(() => {
    let cancelled = false;
    api
      .labels()
      .then((result) => {
        if (cancelled) return;
        if (result.ok) {
          setLabelsData(result.data ?? {});
          setLabelsError(null);
        } else {
          setLabelsError(result.error ?? "labels.json 解析失败");
        }
      })
      .catch((err) => {
        if (!cancelled) setLabelsError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [labelsToken]);

  useEffect(() => {
    let cancelled = false;
    api
      .read("units", dataDirOverride)
      .then((result) => {
        if (!cancelled && result.ok && result.data && Array.isArray(result.data.units)) {
          setUnitsCache(result.data.units as Entity[]);
        }
      })
      .catch(() => {
        /* 建议集降级为空 */
      });
    return () => {
      cancelled = true;
    };
  }, [dataDirOverride]);

  const loadKind = useCallback(
    async (kind: Kind, dir: string | null = dataDirOverride, force = false) => {
      if (!force && docs[kind]) {
        setActiveKind(kind);
        return;
      }
      setBusy(true);
      setSaveState({ tone: "idle" });
      setLoadingError(null);
      const result: ReadResult = await api.read(kind, dir);
      if (!result.ok || !result.data || !result.text || !result.hash || !result.path) {
        setLoadingError(result.error ?? `读取失败：${kind}`);
      } else {
        setDocs((prev) => ({
          ...prev,
          [kind]: { kind, doc: result.data!, text: result.text!, hash: result.hash!, path: result.path! },
        }));
        setActiveKind(kind);
      }
      setBusy(false);
    },
    [dataDirOverride, docs],
  );

  useEffect(() => {
    loadKind("units");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rows: Entity[] = useMemo(() => {
    if (!load || activeKind === "rules") return [];
    const value = load.doc[activeKind];
    return Array.isArray(value) ? (value as Entity[]) : [];
  }, [load, activeKind]);

  const originalRows: Entity[] = useMemo(() => {
    if (!load || activeKind === "rules") return [];
    const value = JSON.parse(load.text)[activeKind];
    return Array.isArray(value) ? (value as Entity[]) : [];
  }, [load, activeKind]);

  const selectedKey = activeKind !== "rules" ? selectedKeys[activeKind] || String(rows[0]?.key ?? "") : "";
  const selected = rows.find((row) => String(row.key) === selectedKey) ?? rows[0];
  const selectedOriginal = originalRows.find((row) => String(row.key) === selectedKey) ?? selected;

  const lightErrors = useMemo(() => {
    if (!load) return new Map<string, string>();
    if (activeKind === "rules") {
      const errors = new Map<string, string>();
      for (const key of Object.keys(load.doc)) {
        if (key === "version" || key === "_note") continue;
        const error = validateRuleValue(key, load.doc[key]);
        if (error) errors.set(key, error);
      }
      return errors;
    }
    if (!selected) return new Map<string, string>();
    const unitKeys = activeKind === "units" ? knownUnitKeys(rows) : knownUnitKeys(unitsCache);
    return validateEntityTree(activeKind, selected, unitKeys);
  }, [load, activeKind, selected, rows, unitsCache]);

  const unitSuggestions = useMemo(
    () => (activeKind === "buildings" && selected ? unitSuggestionsFor(selected, unitsCache, labelsData) : []),
    [activeKind, selected, unitsCache, labelsData],
  );
  const summonHint = useMemo(
    () => (activeKind === "buildings" && selected ? summonLinesHint(selected, unitsCache) : null),
    [activeKind, selected, unitsCache],
  );

  const ruleEntries = useMemo(() => {
    if (!load || activeKind !== "rules") return [] as Array<[string, JsonValue]>;
    return Object.entries(load.doc).filter(([key]) => key !== "version" && key !== "_note") as Array<[string, JsonValue]>;
  }, [load, activeKind]);

  // 模板库（T-164 R9）：当前类别的 "templates" 数组 → 新建下拉
  const templates: TemplateDef[] = useMemo(
    () => (load && activeKind !== "rules" ? templatesOf(load.doc) : []),
    [load, activeKind],
  );

  const originalRules = useMemo(() => {
    if (!load || activeKind !== "rules") return {} as Record<string, JsonValue>;
    return JSON.parse(load.text) as Record<string, JsonValue>;
  }, [load, activeKind]);

  const updateActiveDoc = useCallback(
    (mutate: (state: LoadState) => LoadState) => {
      setDocs((prev) => {
        const state = prev[activeKind];
        if (!state) return prev;
        return { ...prev, [activeKind]: mutate(state) };
      });
    },
    [activeKind],
  );

  /** 提交撤销快照：必须在 setDocs 更新器之外调用（更新器须纯——StrictMode 双调/
   *  并发渲染下副作用入更新器会重复提交或错序，R10 修正） */
  const commitHistory = useCallback(
    (tag: string) => {
      const state = docs[activeKind];
      if (state) historyRef.current.commit(activeKind, state.doc, tag);
    },
    [docs, activeKind],
  );

  /** 实体变更：以"当前选中实体"为锚替换（新实体改 key 后仍能命中），改名则跟随选中 */
  const onEntityChange = useCallback(
    (next: Entity) => {
      const anchorKey = selected ? String(selected.key) : null;
      if (anchorKey === null) return;
      commitHistory("field");
      updateActiveDoc((state) => {
        const nextRows = (Array.isArray(state.doc[state.kind]) ? (state.doc[state.kind] as Entity[]) : []).map((row) =>
          String(row.key) === anchorKey ? next : row,
        );
        return { ...state, doc: { ...state.doc, [state.kind]: nextRows } };
      });
      if (String(next.key) !== anchorKey) {
        setSelectedKeys((keys) => ({ ...keys, [activeKind]: String(next.key) }));
      }
    },
    [selected, activeKind, updateActiveDoc, commitHistory],
  );

  /** 新实体判定：key 不在已保存原文中（改名/删除的放行依据；既有实体删除仍禁） */
  const isNewEntity = useCallback(
    (key: string) => !originalRows.some((row) => String(row.key) === key),
    [originalRows],
  );

  const deleteEntity = useCallback(
    (key: string) => {
      if (!isNewEntity(key)) {
        setSaveState({
          tone: "rejected",
          code: "usage",
          errors: [`既有实体（${key}）删除仍被禁止：其他配置可能引用它，引用完整性无法校验；如确需删除请直接编辑数据文件`],
        });
        return;
      }
      commitHistory("delete");
      updateActiveDoc((state) => {
        const rowsNow = Array.isArray(state.doc[state.kind]) ? (state.doc[state.kind] as Entity[]) : [];
        return { ...state, doc: { ...state.doc, [state.kind]: rowsNow.filter((row) => String(row.key) !== key) } };
      });
      if (selectedKeys[activeKind] === key) {
        setSelectedKeys((keys) => ({ ...keys, [activeKind]: "" }));
      }
    },
    [isNewEntity, updateActiveDoc, selectedKeys, activeKind],
  );

  const onRuleChange = useCallback(
    (key: string, value: JsonValue) => {
      commitHistory("field");
      updateActiveDoc((state) => ({ ...state, doc: { ...state.doc, [key]: value } }));
    },
    [updateActiveDoc, commitHistory],
  );

  const createFromTemplate = useCallback(
    (tpl: TemplateDef) => {
      commitHistory("template");
      updateActiveDoc((state) => {
        const rowsNow = Array.isArray(state.doc[state.kind]) ? (state.doc[state.kind] as Entity[]) : [];
        const entity = instantiateTemplate(tpl, rowsNow);
        setSelectedKeys((keys) => ({ ...keys, [state.kind]: String(entity.key) }));
        return { ...state, doc: { ...state.doc, [state.kind]: [...rowsNow, entity] } };
      });
    },
    [updateActiveDoc, commitHistory],
  );

  const doSaveKind = useCallback(
    async (kind: Kind): Promise<boolean> => {
      const state = docs[kind];
      if (!state || !dirtyOf(state)) return true;
      setSaveState({ tone: "saving" });
      const result: SaveResult = await api.save({
        kind,
        data: state.doc,
        baseHash: state.hash,
        dataDir: dataDirOverride,
      });
      if (result.ok) {
        const text = serializeText(state.doc);
        const hash = result.hash ?? state.hash;
        setDocs((prev) => ({ ...prev, [kind]: { ...state, text, hash } }));
        setSaveState({ tone: "ok", written: Boolean(result.written) });
        if (kind === "buildings") setBuildingsVersion((version) => version + 1); // R14：地图页占地/血量默认实时刷新
        return true;
      }
      setSaveState({ tone: "rejected", code: result.code ?? "error", errors: result.errors ?? ["未知错误"] });
      return false;
    },
    [docs, dataDirOverride],
  );

  const save = useCallback(async () => {
    if (!load || busy) return;
    setBusy(true);
    await doSaveKind(activeKind);
    setBusy(false);
  }, [load, busy, activeKind, doSaveKind]);

  const saveAllDirty = useCallback(async (): Promise<boolean> => {
    for (const kind of ALL_KINDS) {
      if (dirtyOf(docs[kind])) {
        const ok = await doSaveKind(kind);
        if (!ok) {
          setActiveKind(kind);
          return false;
        }
      }
    }
    return true;
  }, [docs, doSaveKind]);

  const reload = useCallback(() => {
    if (section === "maps") {
      void mapsRef.current?.reloadCurrent();
      return;
    }
    if (dirty && !window.confirm("当前表有未保存修改，重新加载将丢弃，确认？")) return;
    setLabelsToken((token) => token + 1);
    historyRef.current.clear(activeKind);
    loadKind(activeKind, dataDirOverride, true);
  }, [dirty, activeKind, dataDirOverride, loadKind, section]);

  /** 配置表撤销/重做（R9）：当前 kind 的 doc 整体换回历史快照 */
  const undoRedoKind = useCallback(
    (dir: -1 | 1) => {
      const state = docs[activeKind];
      if (!state || section !== "configs") return;
      const next = dir < 0 ? historyRef.current.undoFor(activeKind, state.doc) : historyRef.current.redoFor(activeKind, state.doc);
      if (next === null) return;
      setDocs((prev) => ({ ...prev, [activeKind]: { ...state, doc: next } }));
      setHistoryTick((tick) => tick + 1);
    },
    [docs, activeKind, section],
  );
  void historyTick;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return;
      const key = event.key.toLowerCase();
      if (key === "s") {
        event.preventDefault();
        if (section === "maps") {
          mapsRef.current?.save();
          return;
        }
        if (dirty) save();
        return;
      }
      if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        if (section === "maps") mapsRef.current?.undo();
        else undoRedoKind(-1);
        return;
      }
      if (key === "y" || (key === "z" && event.shiftKey)) {
        event.preventDefault();
        if (section === "maps") mapsRef.current?.redo();
        else undoRedoKind(1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dirty, save, section, undoRedoKind]);

  // 选项卡切换（T-164 R6 用户裁定）：不弹窗不丢编辑——每表工作副本常驻，回来还在
  const switchKind = (kind: Kind) => {
    setSection("configs");
    loadKind(kind);
  };

  /** 切换数据目录：先探测可读，若有任一表未保存则确认丢弃，随后整组工作副本重置。
   *  幂等守卫：同目录切换在途时直接跳过（Enter + 按钮双触发会产生并发，清空/重载交错
   *  出现短暂无内容窗口，2026-09-14 冒烟实测抓到） */
  const applyingDirRef = useRef<string | null>(null);
  const applyDataDir = useCallback(
    async (dir: string | null) => {
      const token = dir ?? "__default__";
      if (applyingDirRef.current === token) return;
      applyingDirRef.current = token;
      try {
        if (dir !== null) {
          const probe: ReadResult = await api.read("units", dir);
          if (!probe.ok) {
            setSaveState({
              tone: "rejected",
              code: "usage",
              errors: [probe.error ?? "目录不可用（须同时含 units/buildings/rules.json）"],
            });
            return;
          }
        }
        if (anyDirtyAnywhere && !window.confirm("有未保存修改，切换数据目录将丢弃全部，确认？")) return;
        setDataDirOverride(dir);
        setSelectedKeys({ units: "", buildings: "" });
        setDocs({});
        loadKind(activeKind, dir, true);
      } finally {
        applyingDirRef.current = null;
      }
    },
    [anyDirty, activeKind, loadKind],
  );

  const browseDataDir = useCallback(async () => {
    const picked = await api.pickFolder();
    if (picked.ok && picked.path) applyDataDir(picked.path);
  }, [applyDataDir]);

  // 窗口控制失败要可见（老主进程无 handler 时静默失效最迷惑——提示重启 dev）
  const windowCtlSafe = useCallback(async (action: "minimize" | "maximize" | "close" | "close-now") => {
    try {
      await api.windowCtl(action);
    } catch (err) {
      setSaveState({
        tone: "rejected",
        code: "window",
        errors: [`窗口控制不可用（主进程未注册处理器——旧实例需重启：npm run dev 重新启动）${String(err).slice(0, 120)}`],
      });
    }
  }, []);

  // 退出流程（R9 三选弹窗）：有未保存 → 保存并退出 / 不保存退出 / 继续编辑
  const closeRef = useRef<() => void>(() => {});
  closeRef.current = () => {
    if (anyDirtyAnywhere) {
      setClosePrompt(true);
      return;
    }
    void windowCtlSafe("close-now");
  };
  const closeSaveAndExit = useCallback(() => {
    void (async () => {
      const okCfg = await saveAllDirty();
      if (!okCfg) {
        setClosePrompt(false);
        return; // 保存失败（如 gate 拒绝）留在工具，横幅已显示原因
      }
      const okMaps = (await mapsRef.current?.saveAll()) ?? true;
      if (!okMaps) {
        setClosePrompt(false);
        setSection("maps");
        return;
      }
      setClosePrompt(false);
      await windowCtlSafe("close-now");
    })();
  }, [saveAllDirty]);
  const closeDiscardAndExit = useCallback(() => {
    setClosePrompt(false);
    void windowCtlSafe("close-now");
  }, [windowCtlSafe]);

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">WarOfState · map-editor</span>
        <span className="file-path" title={load?.path ?? ""}>
          {load?.path ?? "…"}
        </span>
        <div className="top-actions">
          <input
            className="cell dir-input"
            data-testid="data-dir-input"
            type="text"
            placeholder="粘贴数据目录路径"
            defaultValue={dataDirOverride ?? ""}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                const value = (event.target as HTMLInputElement).value.trim();
                applyDataDir(value.length > 0 ? value : null);
              }
            }}
          />
          <button
            className="btn slim"
            data-testid="dir-apply-btn"
            onClick={() => {
              const input = document.querySelector<HTMLInputElement>('[data-testid="data-dir-input"]');
              const value = (input?.value ?? "").trim();
              applyDataDir(value.length > 0 ? value : null);
            }}
          >
            切换目录
          </button>
          <button className="btn slim" data-testid="dir-browse-btn" onClick={browseDataDir}>
            导入文件夹…
          </button>
          <button
            className="btn slim"
            data-testid="dir-reset-btn"
            onClick={() => applyDataDir(null)}
            disabled={!dataDirOverride}
            title="回到默认数据目录"
          >
            默认
          </button>
        </div>
        <span className="vsep" />
        <span className={`dirty-dot${dirty ? " on" : ""}`} title={dirty ? "当前表有未保存修改" : "无改动"}>
          ●
        </span>
        <button
          className="btn slim"
          data-testid="undo-btn"
          onClick={() => (section === "maps" ? mapsRef.current?.undo() : undoRedoKind(-1))}
          disabled={section !== "maps" && !historyRef.current.canUndo(activeKind)}
          title="撤销（Ctrl+Z）——地图页的可用态见地图工具栏"
        >
          ↶
        </button>
        <button
          className="btn slim"
          data-testid="redo-btn"
          onClick={() => (section === "maps" ? mapsRef.current?.redo() : undoRedoKind(1))}
          disabled={section !== "maps" && !historyRef.current.canRedo(activeKind)}
          title="重做（Ctrl+Y / Ctrl+Shift+Z）"
        >
          ↷
        </button>
        <button className="btn" data-testid="reload-btn" onClick={reload} disabled={busy || !load}>
          重新加载
        </button>
        <button className="btn primary" data-testid="save-btn" onClick={save} disabled={busy || !load || !dirty}>
          保存（过 Godot 门禁）
        </button>
      </header>

      <div className="win-controls">
        <button
          className="win-btn"
          data-testid="win-min-btn"
          title="最小化"
          onClick={() => void windowCtlSafe("minimize")}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="1" y="4.5" width="8" height="1" fill="currentColor" />
          </svg>
        </button>
        <button
          className="win-btn"
          data-testid="win-max-btn"
          data-maximized={maximized ? "true" : "false"}
          title={maximized ? "还原" : "最大化"}
          onClick={() => void windowCtlSafe("maximize")}
        >
          {maximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" />
              <path d="M2.5 2.5 V0.5 H9.5 V7.5 H7.5" fill="none" stroke="currentColor" strokeWidth="1" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" />
            </svg>
          )}
        </button>
        <button
          className="win-btn close"
          data-testid="win-close-btn"
          title="关闭"
          onClick={() => void windowCtlSafe("close")}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M1 1 L9 9 M9 1 L1 9" stroke="currentColor" strokeWidth="1.1" />
          </svg>
        </button>
      </div>

      <nav className="workspace-bar" data-testid="workspace-bar">
        {KIND_TABS.map(({ kind, label }) => (
          <button
            key={kind}
            data-testid={`tab-${kind}`}
            className={`tab${section === "configs" && activeKind === kind ? " active" : ""}`}
            onClick={() => switchKind(kind)}
          >
            {label}
            {dirtyOf(docs[kind]) ? <span className="tab-dirty" title="有未保存修改" /> : null}
          </button>
        ))}
        <button
          data-testid="tab-maps"
          className={`tab${section === "maps" ? " active" : ""}`}
          onClick={() => setSection("maps")}
          title="dev-2d data/maps 地图编辑（保存过 Godot 真实构建链路门禁）"
        >
          地图
          {mapsDirty > 0 ? <span className="tab-dirty" title={`${mapsDirty} 张地图有未保存修改`} /> : null}
        </button>
      </nav>

      {labelsError ? (
        <div className="banner warn">labels.json 加载失败（显示层降级为纯英文）：{labelsError}</div>
      ) : null}
      {loadingError ? <div className="banner error">读取失败：{loadingError}</div> : null}
      {saveState.tone === "saving" ? <div className="banner info">Godot 门禁校验中…</div> : null}
      {saveState.tone === "ok" ? (
        saveState.written ? (
          <div className="banner ok" data-testid="save-ok">
            已保存（旧文件备份为 .bak）
          </div>
        ) : (
          <div className="banner ok" data-testid="save-ok">
            无改动，未写盘
          </div>
        )
      ) : null}
      {saveState.tone === "rejected" ? (
        <div className="banner error" data-testid="save-errors">
          <strong>
            {saveState.code === "conflict"
              ? "文件冲突"
              : saveState.code === "gate"
                ? "Godot 门禁拒绝（文件未改动）"
                : saveState.code === "window"
                  ? "窗口控制"
                  : "保存失败"}
            ：
          </strong>
          <ul>
            {saveState.errors.map((error, index) => (
              <li key={index}>{error}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <main className="content">
        <div className={section === "configs" ? "configs-mount" : "configs-mount hidden"}>
          {load && activeKind !== "rules" ? (
            <div className="master-detail" key={activeKind}>
              <EntityList
                rows={rows}
                selectedKey={String(selected?.key ?? "")}
                onSelect={(key) => setSelectedKeys((keys) => ({ ...keys, [activeKind]: key }))}
                templates={templates}
                onCreateFromTemplate={createFromTemplate}
                onDelete={deleteEntity}
              />
              <section className="detail">
                {summonHint ? <div className="banner warn compact">{summonHint}</div> : null}
                {selected ? (
                  <FieldTree
                    entity={selected}
                    original={selectedOriginal}
                    labels={labelsData}
                    lightErrors={lightErrors}
                    unitSuggestions={unitSuggestions}
                    identityEditable={isNewEntity(String(selected.key))}
                    onChange={onEntityChange}
                  />
                ) : (
                  <div className="empty">（空表——可从左下「＋ 从模板新建」创建实体；删除仍不支持）</div>
                )}
              </section>
            </div>
          ) : null}
          {load && activeKind === "rules" ? (
            <RulesTable entries={ruleEntries} original={originalRules} labels={labelsData} lightErrors={lightErrors} onValueChange={onRuleChange} />
          ) : null}
          {!load && !loadingError ? <div className="empty">加载中…</div> : null}
        </div>
        <div className={section === "maps" ? "maps-mount" : "maps-mount hidden"}>
          <MapsPanel
            handleRef={mapsRef}
            labelsData={labelsData}
            onDirtyChange={setMapsDirty}
            unitsCache={unitsCache}
            active={section === "maps"}
            buildingsVersion={buildingsVersion}
          />
        </div>
      </main>

      <footer className="statusbar">
        <span>
          {anyDirtyAnywhere
            ? `${ALL_KINDS.filter((kind) => dirtyOf(docs[kind])).length + (mapsDirty > 0 ? mapsDirty : 0)} 项有未保存修改 · `
            : ""}
          {selected && section === "configs" ? `${selectedKey} · ` : ""}
          轻校验告警 {section === "maps" ? "（见地图面板）" : `${lightErrors.size} 处`}（仅提示，语义以 Godot 门禁为准）
        </span>
        <span>{meta ? `data: ${meta.dataDir} · gate: ${meta.gateScript} · maps: ${meta.mapsDir}` : ""}</span>
      </footer>

      {closePrompt ? (
        <div className="modal-mask" data-testid="close-modal">
          <div className="modal">
            <div className="modal-title">有未保存的修改</div>
            <div className="modal-body">
              关闭前如何处理？
              <div className="modal-hint">「保存并退出」会依次通过 Godot 门禁写盘；被拒绝时会留在工具并显示原因。</div>
            </div>
            <div className="modal-actions">
              <button className="btn primary" data-testid="close-save-btn" onClick={closeSaveAndExit}>
                保存并退出
              </button>
              <button className="btn danger" data-testid="close-discard-btn" onClick={closeDiscardAndExit}>
                不保存退出
              </button>
              <button className="btn" data-testid="close-cancel-btn" onClick={() => setClosePrompt(false)}>
                继续编辑
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
