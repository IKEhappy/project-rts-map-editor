import { useCallback, useEffect, useMemo, useState } from "react";
import { api, serializeText } from "./api";
import EntityList from "./components/EntityList";
import FieldTree from "./components/FieldTree";
import RulesTable from "./components/RulesTable";
import type { LabelsData } from "./labels";
import { validateEntityTree, validateRuleValue } from "./light-validation";
import { knownUnitKeys, summonLinesHint, unitSuggestionsFor } from "./suggest";
import type { ConfigFile, Entity, JsonValue, Kind, MetaResult, ReadResult, SaveResult } from "./types";

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

export default function App() {
  const [meta, setMeta] = useState<MetaResult | null>(null);
  const [load, setLoad] = useState<LoadState | null>(null);
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
  // 单位表缓存：建筑表编辑时用于 lines.unit 建议集与 summon/lines 一致性提示（T-164 R2.1）
  const [unitsCache, setUnitsCache] = useState<Entity[] | null>(null);

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
      .read("units", dataDirOverride)
      .then((result) => {
        if (!cancelled && result.ok && result.data && Array.isArray(result.data.units)) {
          setUnitsCache(result.data.units as Entity[]);
        }
      })
      .catch(() => {
        /* 建议集降级为空，自由输入不受影响 */
      });
    return () => {
      cancelled = true;
    };
  }, [dataDirOverride]);

  useEffect(() => {
    api.meta().then(setMeta).catch((err) => setLoadingError(String(err)));
  }, []);

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

  const loadKind = useCallback(
    async (kind: Kind, dir: string | null = dataDirOverride) => {
      setBusy(true);
      setSaveState({ tone: "idle" });
      setLoadingError(null);
      const result: ReadResult = await api.read(kind, dir);
      if (!result.ok || !result.data || !result.text || !result.hash || !result.path) {
        setLoadingError(result.error ?? `读取失败：${kind}`);
      } else {
        setLoad({ kind, doc: result.data, text: result.text, hash: result.hash, path: result.path });
      }
      setBusy(false);
    },
    [dataDirOverride],
  );

  useEffect(() => {
    loadKind("units");
  }, [loadKind]);

  const dirty = load !== null && serializeText(load.doc) !== load.text;

  const rows: Entity[] = useMemo(() => {
    if (!load || load.kind === "rules") return [];
    const value = load.doc[load.kind];
    return Array.isArray(value) ? (value as Entity[]) : [];
  }, [load]);

  const originalRows: Entity[] = useMemo(() => {
    if (!load || load.kind === "rules") return [];
    const value = JSON.parse(load.text)[load.kind];
    return Array.isArray(value) ? (value as Entity[]) : [];
  }, [load]);

  const selectedKey = load && load.kind !== "rules" ? selectedKeys[load.kind] || String(rows[0]?.key ?? "") : "";
  const selected = rows.find((row) => String(row.key) === selectedKey) ?? rows[0];
  const selectedOriginal = originalRows.find((row) => String(row.key) === selectedKey) ?? selected;

  const lightErrors = useMemo(() => {
    if (!load) return new Map<string, string>();
    if (load.kind === "rules") {
      const errors = new Map<string, string>();
      for (const key of Object.keys(load.doc)) {
        if (key === "version" || key === "_note") continue;
        const error = validateRuleValue(key, load.doc[key]);
        if (error) errors.set(key, error);
      }
      return errors;
    }
    if (!selected) return new Map<string, string>();
    // units 表编辑中用当前文档键集（改名即时生效）；buildings 表用单位表缓存
    const unitKeys = load.kind === "units" ? knownUnitKeys(rows) : knownUnitKeys(unitsCache);
    return validateEntityTree(load.kind, selected, unitKeys);
  }, [load, selected, rows, unitsCache]);

  // lines.unit 建议集（role 组推导）与 summon/lines 一致性提示
  const unitSuggestions = useMemo(
    () => (load && load.kind === "buildings" && selected ? unitSuggestionsFor(selected, unitsCache, labelsData) : []),
    [load, selected, unitsCache, labelsData],
  );
  const summonHint = useMemo(
    () => (load && load.kind === "buildings" && selected ? summonLinesHint(selected, unitsCache) : null),
    [load, selected, unitsCache],
  );

  const ruleEntries = useMemo(() => {
    if (!load || load.kind !== "rules") return [] as Array<[string, JsonValue]>;
    return Object.entries(load.doc).filter(([key]) => key !== "version" && key !== "_note") as Array<[string, JsonValue]>;
  }, [load]);

  const originalRules = useMemo(() => {
    if (!load || load.kind !== "rules") return {} as Record<string, JsonValue>;
    return JSON.parse(load.text) as Record<string, JsonValue>;
  }, [load]);

  const onEntityChange = useCallback((next: Entity) => {
    setLoad((prev) => {
      if (!prev || prev.kind === "rules") return prev;
      const nextRows = (Array.isArray(prev.doc[prev.kind]) ? (prev.doc[prev.kind] as Entity[]) : []).map((row) =>
        String(row.key) === String(next.key) ? next : row,
      );
      return { ...prev, doc: { ...prev.doc, [prev.kind]: nextRows } };
    });
  }, []);

  const onRuleChange = useCallback((key: string, value: JsonValue) => {
    setLoad((prev) => (prev ? { ...prev, doc: { ...prev.doc, [key]: value } } : prev));
  }, []);

  const save = useCallback(async () => {
    if (!load || busy) return;
    setBusy(true);
    setSaveState({ tone: "saving" });
    const result: SaveResult = await api.save({
      kind: load.kind,
      data: load.doc,
      baseHash: load.hash,
      dataDir: dataDirOverride,
    });
    if (result.ok) {
      const text = serializeText(load.doc);
      const hash = result.hash ?? load.hash;
      setLoad((prev) => (prev ? { ...prev, text, hash } : prev));
      setSaveState({ tone: "ok", written: Boolean(result.written) });
    } else {
      setSaveState({ tone: "rejected", code: result.code ?? "error", errors: result.errors ?? ["未知错误"] });
    }
    setBusy(false);
  }, [load, busy, dataDirOverride]);

  const reload = useCallback(() => {
    if (load && dirty && !window.confirm("有未保存修改，确认丢弃并重新加载？")) return;
    setLabelsToken((token) => token + 1);
    if (load) loadKind(load.kind);
  }, [load, dirty, loadKind]);

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

  const switchKind = (kind: Kind) => {
    if (dirty && !window.confirm("有未保存修改，切换将丢弃，确认？")) return;
    if (!load || load.kind !== kind) loadKind(kind);
  };

  /** 切换数据目录：先探测可读（含三文件校验），再脏确认，最后落覆盖并重载当前表 */
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
      if (dirty && !window.confirm("有未保存修改，切换数据目录将丢弃，确认？")) return;
      setDataDirOverride(dir);
      setSelectedKeys({ units: "", buildings: "" });
      loadKind(load ? load.kind : "units", dir);
    },
    [dirty, load, loadKind],
  );

  const browseDataDir = useCallback(async () => {
    const picked = await api.pickFolder();
    if (picked.ok && picked.path) applyDataDir(picked.path);
  }, [applyDataDir]);

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">WarOfState · map-editor</span>
        <nav className="tabs">
          {KIND_TABS.map(({ kind, label }) => (
            <button
              key={kind}
              data-testid={`tab-${kind}`}
              className={`tab${load?.kind === kind ? " active" : ""}`}
              onClick={() => switchKind(kind)}
            >
              {label}
            </button>
          ))}
        </nav>
        <span className="file-path" title={load?.path ?? ""}>
          {load?.path ?? "…"}
        </span>
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
        <button className="btn slim" data-testid="dir-apply-btn" onClick={() => {
          const input = document.querySelector<HTMLInputElement>('[data-testid="data-dir-input"]');
          const value = (input?.value ?? "").trim();
          applyDataDir(value.length > 0 ? value : null);
        }}>
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
        <span className={`dirty-dot${dirty ? " on" : ""}`} title={dirty ? "有未保存修改" : "无改动"}>
          ●
        </span>
        <button className="btn" data-testid="reload-btn" onClick={reload} disabled={busy || !load}>
          重新加载
        </button>
        <button className="btn primary" data-testid="save-btn" onClick={save} disabled={busy || !load || !dirty}>
          保存（过 Godot 门禁）
        </button>
      </header>

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
            {saveState.code === "conflict" ? "文件冲突" : saveState.code === "gate" ? "Godot 门禁拒绝（文件未改动）" : "保存失败"}
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
        {load && load.kind !== "rules" ? (
          <div className="master-detail">
            <EntityList
              rows={rows}
              selectedKey={String(selected?.key ?? "")}
              onSelect={(key) =>
                setLoad((prev) => {
                  if (prev) setSelectedKeys((keys) => ({ ...keys, [prev.kind]: key }));
                  return prev;
                })
              }
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
        {load && load.kind === "rules" ? (
          <RulesTable entries={ruleEntries} original={originalRules} labels={labelsData} lightErrors={lightErrors} onValueChange={onRuleChange} />
        ) : null}
        {!load && !loadingError ? <div className="empty">加载中…</div> : null}
      </main>

      <footer className="statusbar">
        <span>
          {selected ? `${selectedKey} · ` : ""}轻校验告警 {lightErrors.size} 处（仅提示，语义以 Godot 门禁为准）
        </span>
        <span>{meta ? `data: ${meta.dataDir} · gate: ${meta.gateScript}` : ""}</span>
      </footer>
    </div>
  );
}
