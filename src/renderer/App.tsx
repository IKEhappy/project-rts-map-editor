import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, serializeText } from "./api";
import { canonicalJson } from "./canonical";
import EntityList from "./components/EntityList";
import FieldTree from "./components/FieldTree";
import RulesTable from "./components/RulesTable";
import type { LabelsData } from "./labels";
import { validateEntityTree, validateRuleValue } from "./light-validation";
import { knownUnitKeys, summonLinesHint, unitSuggestionsFor } from "./suggest";
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

  const load = docs[activeKind] ?? null;
  const dirty = dirtyOf(load);
  const anyDirty = ALL_KINDS.some((kind) => dirtyOf(docs[kind]));

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

  const onEntityChange = useCallback(
    (next: Entity) => {
      updateActiveDoc((state) => {
        const nextRows = (Array.isArray(state.doc[state.kind]) ? (state.doc[state.kind] as Entity[]) : []).map((row) =>
          String(row.key) === String(next.key) ? next : row,
        );
        return { ...state, doc: { ...state.doc, [state.kind]: nextRows } };
      });
    },
    [updateActiveDoc],
  );

  const onRuleChange = useCallback(
    (key: string, value: JsonValue) => {
      updateActiveDoc((state) => ({ ...state, doc: { ...state.doc, [key]: value } }));
    },
    [updateActiveDoc],
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
    if (dirty && !window.confirm("当前表有未保存修改，重新加载将丢弃，确认？")) return;
    setLabelsToken((token) => token + 1);
    loadKind(activeKind, dataDirOverride, true);
  }, [dirty, activeKind, dataDirOverride, loadKind]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (dirty) save();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dirty, save]);

  // 选项卡切换（T-164 R6 用户裁定）：不弹窗不丢编辑——每表工作副本常驻，回来还在
  const switchKind = (kind: Kind) => {
    loadKind(kind);
  };

  /** 切换数据目录：先探测可读，若有任一表未保存则确认丢弃，随后整组工作副本重置 */
  const applyDataDir = useCallback(
    async (dir: string | null) => {
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
      if (anyDirty && !window.confirm("有未保存修改，切换数据目录将丢弃全部，确认？")) return;
      setDataDirOverride(dir);
      setSelectedKeys({ units: "", buildings: "" });
      setDocs({});
      loadKind(activeKind, dir, true);
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

  // 退出流程（T-164 R6 用户裁定）：关闭时若有未保存 → 询问"保存全部并退出/留在工具"
  const closeRef = useRef<() => void>(() => {});
  closeRef.current = () => {
    void (async () => {
      if (anyDirty) {
        const saveAll = window.confirm("有未保存的修改：确定 = 全部保存并退出，取消 = 留在工具");
        if (!saveAll) return;
        const ok = await saveAllDirty();
        if (!ok) return; // 保存失败（如 gate 拒绝）留在工具，横幅已显示原因
      }
      await windowCtlSafe("close-now");
    })();
  };

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
            className={`tab${activeKind === kind ? " active" : ""}`}
            onClick={() => switchKind(kind)}
          >
            {label}
            {dirtyOf(docs[kind]) ? <span className="tab-dirty" title="有未保存修改" /> : null}
          </button>
        ))}
        <button className="tab disabled" disabled title="地图编辑（规划中，T-164 R7+）">
          地图（规划中）
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
        {load && activeKind !== "rules" ? (
          <div className="master-detail" key={activeKind}>
            <EntityList
              rows={rows}
              selectedKey={String(selected?.key ?? "")}
              onSelect={(key) => setSelectedKeys((keys) => ({ ...keys, [activeKind]: key }))}
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
                  onChange={onEntityChange}
                />
              ) : (
                <div className="empty">（空表——R1 不支持增删实体）</div>
              )}
            </section>
          </div>
        ) : null}
        {load && activeKind === "rules" ? (
          <RulesTable entries={ruleEntries} original={originalRules} labels={labelsData} lightErrors={lightErrors} onValueChange={onRuleChange} />
        ) : null}
        {!load && !loadingError ? <div className="empty">加载中…</div> : null}
      </main>

      <footer className="statusbar">
        <span>
          {anyDirty ? `${ALL_KINDS.filter((kind) => dirtyOf(docs[kind])).length} 张表有未保存修改 · ` : ""}
          {selected ? `${selectedKey} · ` : ""}轻校验告警 {lightErrors.size} 处（仅提示，语义以 Godot 门禁为准）
        </span>
        <span>{meta ? `data: ${meta.dataDir} · gate: ${meta.gateScript}` : ""}</span>
      </footer>
    </div>
  );
}
