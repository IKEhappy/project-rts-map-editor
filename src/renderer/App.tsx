import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, FolderOpen, GitCompareArrows, Minus, Moon, Palette, RotateCcw, Save, Square, Sun, X } from "lucide-react";
import { api } from "./api";
import { canonicalJson } from "./canonical";
import MapsPanel, { type MapsPanelHandle } from "./components/MapsPanel";
import ConfigsPanel, { type ConfigsPanelHandle } from "./components/ConfigsPanel";
import type { LabelsData } from "./labels";
import type { CompareResult, ConfigFile, Entity, Kind, WorkspaceSession } from "./types";

export default function App() {
  const [workspace, setWorkspace] = useState<WorkspaceSession | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [directory, setDirectory] = useState(() => localStorage.getItem("me.mapsPath") || "");
  const [projectRoot, setProjectRoot] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusyState] = useState(false);
  const busyRef = useRef(false);
  const setBusy = useCallback((value: boolean) => { busyRef.current = value; setBusyState(value); }, []);
  const [mapBusy, setMapBusy] = useState(false);
  const [dirty, setDirty] = useState(0);
  const [configBusy, setConfigBusy] = useState(false);
  const [configDirty, setConfigDirty] = useState(0);
  const [configVersion, setConfigVersion] = useState(0);
  const [labels, setLabels] = useState<LabelsData>({});
  const [units, setUnits] = useState<Entity[] | null>(null);
  const [section, setSection] = useState<"maps" | Kind>("maps");
  const [configKind, setConfigKind] = useState<Kind>("units");
  const [diff, setDiff] = useState<CompareResult | null>(null);
  const [diffDetail, setDiffDetail] = useState<{ path: string; before: string; after: string } | null>(null);
  const [dialog, setDialog] = useState<"compare" | "restore" | "close" | null>(null);
  const [maximized, setMaximized] = useState(false);
  const [themeChoice, setThemeChoice] = useState<"system" | "light" | "dark">(() => {
    const saved = localStorage.getItem("me.theme");
    return saved === "light" || saved === "dark" ? saved : "system";
  });
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const maps = useRef<MapsPanelHandle | null>(null);
  const configs = useRef<ConfigsPanelHandle | null>(null);
  const closeRef = useRef<() => void>(() => {});
  const isWorking = () => busyRef.current || Boolean(maps.current?.isBusy()) || Boolean(configs.current?.isBusy());
  const selectSection = (next: "maps" | Kind) => {
    if (isWorking()) return;
    if (next !== "maps") setConfigKind(next);
    setSection(next);
  };
  const configSaved = useCallback((kind: Kind, data: ConfigFile) => {
    if (kind === "units") setUnits(Array.isArray(data.units) ? data.units as Entity[] : null);
    if (kind === "buildings") setConfigVersion((value) => value + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.getWorkspace().then((result) => {
      if (!cancelled && result.ok && result.workspace) setWorkspace(result.workspace);
    }).catch((failure) => { if (!cancelled) setError(String(failure)); }).finally(() => { if (!cancelled) setInitializing(false); });
    api.labels().then((result) => { if (!cancelled && result.ok) setLabels(result.data || {}); });
    const offState = api.onWindowState(setMaximized);
    const offClose = api.onCloseRequest(() => closeRef.current());
    return () => { cancelled = true; offState(); offClose(); };
  }, []);

  useEffect(() => {
    if (!dialog) return;
    const previous = document.activeElement as HTMLElement | null;
    const modal = document.querySelector<HTMLElement>('.workspace-modal');
    modal?.querySelector<HTMLButtonElement>('button')?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !modal) return;
      const buttons = [...modal.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]')];
      const first = buttons[0];
      const last = buttons.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', trap);
    return () => { document.removeEventListener('keydown', trap); previous?.focus(); };
  }, [dialog]);

  useEffect(() => {
    if (!workspace) return;
    let cancelled = false;
    api.readWorkspaceConfig("units").then((result) => {
      if (!cancelled) setUnits(result.ok && Array.isArray(result.data?.units) ? result.data.units as Entity[] : null);
    });
    return () => { cancelled = true; };
  }, [workspace?.id, workspace?.generation]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isWorking()) setDialog(null);
      if (!workspace || dialog || isWorking() || !(event.ctrlKey || event.metaKey)) return;
      const editor = section === "maps" ? maps.current : configs.current;
      const key = event.key.toLowerCase();
      if (["s", "z", "y"].includes(key)) event.preventDefault();
      if (key === "s") void editor?.save();
      if (key === "z" && !event.shiftKey) editor?.undo();
      if (key === "y" || key === "z" && event.shiftKey) editor?.redo();
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [workspace, dialog, busy, section, mapBusy, configBusy]);

  const open = async (browse = false) => {
    if (isWorking()) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.openWorkspace({ path: browse ? undefined : directory.trim(), projectRoot: projectRoot.trim() || undefined });
      if (!result.ok || !result.workspace) { setError(result.error || "工作区打开失败"); return; }
      setWorkspace(result.workspace);
      setDirectory(result.workspace.root);
      localStorage.setItem("me.mapsPath", result.workspace.root);
      setDirty(0);
      setConfigDirty(0);
      setConfigBusy(false);
      setConfigVersion(0);
      setSection("maps");
      setDiff(null);
    } catch (failure) { setError(String(failure)); }
    finally { setBusy(false); }
  };

  const showDiff = async (mode: "compare" | "restore") => {
    if (isWorking()) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.compareWorkspace();
      if (!result.ok) { setError(result.error || "目录对比失败"); return; }
      setDiff(result);
      setDiffDetail(null);
      setDialog(mode);
    } catch (failure) { setError(String(failure)); }
    finally { setBusy(false); }
  };

  const restore = async () => {
    if (isWorking()) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.restoreWorkspace();
      if (!result.ok || !result.workspace) { setError(result.error || "恢复失败"); return; }
      setWorkspace(result.workspace);
      setDirty(0);
      setDiff(null);
      setDialog(null);
      setSection("maps");
    } catch (failure) { setError(String(failure)); }
    finally { setBusy(false); }
  };

  const reselect = async () => {
    if (isWorking()) return;
    configs.current?.flushPendingEdits();
    if ((dirty || configs.current?.getDirtyKinds().length) && !window.confirm("有未保存的地图或配置修改，返回目录选择将丢弃，确认？")) return;
    setBusy(true);
    try {
      const result = await api.closeWorkspace();
      if (!result.ok) { setError(result.error || "工作区关闭失败"); return; }
      setWorkspace(null);
      setDirty(0);
      setConfigDirty(0);
      setMapBusy(false);
      setConfigBusy(false);
      setUnits(null);
      setError("");
    } catch (failure) { setError(String(failure)); }
    finally { setBusy(false); }
  };

  const windowControl = useCallback(async (action: "minimize" | "maximize" | "close" | "close-now") => {
    try { await api.windowCtl(action); } catch (failure) { setError(String(failure)); }
  }, []);
  closeRef.current = () => {
    if (isWorking()) return;
    configs.current?.flushPendingEdits();
    if (dirty || configs.current?.getDirtyKinds().length) setDialog("close"); else void windowControl("close-now");
  };

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const apply = () => {
      const resolved = themeChoice === "system" ? (media.matches ? "light" : "dark") : themeChoice;
      document.documentElement.dataset.theme = resolved;
    };
    apply();
    const listener = () => { if (themeChoice === "system") apply(); };
    media.addEventListener?.("change", listener);
    return () => media.removeEventListener?.("change", listener);
  }, [themeChoice]);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!document.querySelector("[data-testid=theme-control]")?.contains(target)) setThemeMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const chooseTheme = (choice: "system" | "light" | "dark") => {
    setThemeChoice(choice);
    if (choice === "system") localStorage.removeItem("me.theme");
    else localStorage.setItem("me.theme", choice);
    setThemeMenuOpen(false);
  };

  const saveAndClose = async () => {
    if (isWorking()) return;
    setBusy(true);
    try {
      if (!await configs.current?.saveAll()) {
        const failedKind = configs.current?.getFailedKind();
        if (failedKind) { setConfigKind(failedKind); setSection(failedKind); }
        setDialog(null);
        return;
      }
      if (!await maps.current?.saveAll()) { setSection("maps"); setDialog(null); return; }
      await windowControl("close-now");
    } catch (failure) { setError(String(failure)); setDialog(null); }
    finally { setBusy(false); }
  };

  const changed = diff?.entries?.filter((entry) => entry.status !== "unchanged") || [];
  let changedFields: string[] = [];
  if (diffDetail) {
    try {
      const before = JSON.parse(diffDetail.before || '{}');
      const after = JSON.parse(diffDetail.after || '{}');
      changedFields = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((key) => canonicalJson(before[key] ?? null) !== canonicalJson(after[key] ?? null));
    } catch { changedFields = ['JSON 解析失败，显示原始文件内容']; }
  }
  const statusLabel = { added: "新增", removed: "删除", changed: "修改", unchanged: "相同" };

  return <div className="app workspace-app" aria-busy={busy}>
    <header className="topbar workspace-titlebar">
      <span className="brand">Them: Pixel Front <span className="brand-sub">地图编辑器</span></span>
      <span className="file-path" title={workspace?.root}>{workspace?.root || "未打开地图目录"}</span>
    </header>
    <div className="theme-control" data-testid="theme-control">
      <button className="theme-trigger" data-testid="theme-trigger" title="切换主题" aria-label="切换主题" aria-expanded={themeMenuOpen} onClick={() => setThemeMenuOpen((open) => !open)}>
        {themeChoice === "light" ? <Sun size={16} /> : themeChoice === "dark" ? <Moon size={16} /> : <Palette size={16} />}
      </button>
      {themeMenuOpen ? <div className="theme-menu" role="menu" data-testid="theme-menu">
        {([["system", "跟随系统", Palette], ["light", "白天模式", Sun], ["dark", "夜间模式", Moon]] as const).map(([choice, label, Icon]) => <button key={choice} role="menuitemradio" aria-checked={themeChoice === choice} className={`theme-option${themeChoice === choice ? " selected" : ""}`} data-testid={`theme-${choice}`} onClick={() => chooseTheme(choice)}><Icon size={15} />{label}<span className="theme-check">{themeChoice === choice ? "✓" : ""}</span></button>)}
      </div> : null}
    </div>
    <div className="win-controls">
      <button className="win-btn" title="最小化" data-testid="win-min-btn" onClick={() => void windowControl("minimize")}><Minus size={14} /></button>
      <button className="win-btn" title={maximized ? "还原" : "最大化"} data-testid="win-max-btn" onClick={() => void windowControl("maximize")}><Square size={12} /></button>
      <button className="win-btn close" title="关闭" data-testid="win-close-btn" onClick={() => void windowControl("close")}><X size={16} /></button>
    </div>
    {error && <div className="banner error workspace-error" role="alert">{error}<button className="btn icon-btn" title="关闭提示" onClick={() => setError("")}><X size={14} /></button></div>}
    {!workspace ? <main className="workspace-start" data-testid="workspace-start">
      <div className="workspace-open">
        <FolderOpen size={32} className="workspace-mark" />
        <h1>打开地图目录</h1>
        <form onSubmit={(event) => { event.preventDefault(); void open(); }}>
          <label htmlFor="maps-path">Maps 文件夹</label>
          <div className="workspace-path-row">
            <input id="maps-path" data-testid="workspace-path" value={directory} onChange={(event) => setDirectory(event.target.value)} placeholder="D:\…\project-rts\data\maps" disabled={busy || initializing} />
            <button type="button" className="btn" data-testid="workspace-browse" disabled={busy || initializing} onClick={() => void open(true)}><FolderOpen size={16} />浏览</button>
          </div>
          <label htmlFor="project-root">Godot 工程目录（目录外地图可指定）</label>
          <input id="project-root" data-testid="workspace-project" value={projectRoot} onChange={(event) => setProjectRoot(event.target.value)} placeholder="自动识别 / 使用随工具提供的校验工程" disabled={busy || initializing} />
          <button className="btn primary workspace-open-button" data-testid="workspace-open" disabled={busy || initializing || !directory.trim()} type="submit"><FolderOpen size={16} />{busy ? "正在校验目录并创建备份…" : "打开并备份"}</button>
        </form>
      </div>
    </main> : <>
      <div className="workspace-toolbar" data-testid="workspace-bar">
        <button className="btn icon-btn" title="重新选择地图目录" data-testid="workspace-reselect" onClick={() => void reselect()} disabled={busy || mapBusy || configBusy}><ArrowLeft size={16} /></button>
        <div className="workspace-location"><strong title={workspace.root}>{workspace.root}</strong><span title={workspace.baseline.zipPath}>本次备份 {new Date(workspace.baseline.createdAt).toLocaleString()} · {workspace.baseline.fileCount} 文件 · {(workspace.baseline.totalBytes / 1024 / 1024).toFixed(1)} MiB{workspace.offline ? " · 离线地图目录" : ""}</span></div>
        <button className="btn" data-testid="workspace-compare" disabled={busy || mapBusy || configBusy} onClick={() => void showDiff("compare")}><GitCompareArrows size={16} />地图目录对比</button>
        <button className="btn danger" data-testid="workspace-restore" disabled={busy || mapBusy || configBusy} onClick={() => void showDiff("restore")}><RotateCcw size={16} />地图完全恢复</button>
        <button className="btn primary" data-testid="save-btn" title={section === "maps" ? "保存当前地图" : `保存 ${section}.json`} disabled={busy || mapBusy || configBusy} onClick={() => { if (isWorking()) return; void (section === "maps" ? maps.current?.save() : configs.current?.save()); }}><Save size={16} />保存</button>
      </div>
      <nav className="workspace-bar workspace-tabs">
        <button className={`tab${section === "maps" ? " active" : ""}`} data-testid="tab-maps" disabled={busy || mapBusy || configBusy} onClick={() => selectSection("maps")}>地图{dirty > 0 ? ` · ${dirty}` : ""}</button>
        {([ ["units", "单位表"], ["buildings", "建筑表"], ["rules", "规则表"] ] as const).map(([kind, label]) => <button key={kind} className={`tab${section === kind ? " active" : ""}`} data-testid={`tab-${kind}`} disabled={busy || mapBusy || configBusy} onClick={() => selectSection(kind)}>{label}{configs.current?.getDirtyKinds().includes(kind) ? <span className="tab-dirty" title="有未保存修改" /> : null}</button>)}
      </nav>
      <main className="content" inert={dialog !== null || busy}>
        <div className={section === "maps" ? "maps-mount" : "maps-mount hidden"}>
          <MapsPanel key={`${workspace.id}:${workspace.generation}`} workspace={workspace} handleRef={maps} labelsData={labels} onDirtyChange={setDirty} onBusyChange={setMapBusy} unitsCache={units} active={section === "maps"} buildingsVersion={workspace.generation + configVersion} />
        </div>
        <div className={section !== "maps" ? "configs-mount" : "configs-mount hidden"}>
          <ConfigsPanel key={workspace.id} workspace={workspace} kind={configKind} active={section !== "maps"} labelsData={labels} handleRef={configs} onDirtyChange={setConfigDirty} onBusyChange={setConfigBusy} onSaved={configSaved} />
        </div>
      </main>
      <footer className="statusbar"><span>{dirty + configDirty ? `${dirty} 张地图 · ${configDirty} 张配置表有未保存修改` : "地图与配置工作区"}</span><span title={section === "maps" ? workspace.projectRoot : workspace.dataDir}>{section === "maps" ? `${workspace.resPrefix} · ${workspace.projectRoot}` : `${configKind}.json · ${workspace.dataDir}`}</span></footer>
    </>}
    {dialog && <div className="modal-mask workspace-modal-mask" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setDialog(null); }}>
      <section className="modal workspace-modal" data-testid={dialog === "close" ? "close-modal" : undefined} role="dialog" aria-modal="true" aria-label={dialog === "close" ? "未保存修改" : dialog === "restore" ? "完全恢复" : "目录对比"}>
        <div className="workspace-modal-header"><h2>{dialog === "close" ? "有未保存的修改" : dialog === "restore" ? "恢复到本次打开时" : "目录对比"}</h2><button className="btn icon-btn" title="关闭" disabled={busy} onClick={() => setDialog(null)}><X size={16} /></button></div>
        {dialog === "close" ? <div className="modal-actions"><button className="btn primary" data-testid="close-save-btn" disabled={busy || mapBusy || configBusy} onClick={() => void saveAndClose()}>保存并退出</button><button className="btn danger" data-testid="close-discard-btn" disabled={busy || mapBusy || configBusy} onClick={() => void windowControl("close-now")}>不保存退出</button><button className="btn" data-testid="close-cancel-btn" disabled={busy || mapBusy || configBusy} onClick={() => setDialog(null)}>继续编辑</button></div> : <>
          <div className="workspace-diff-summary">新增 {diff?.counts?.added || 0} · 删除 {diff?.counts?.removed || 0} · 修改 {diff?.counts?.changed || 0}</div>
          {dialog === "restore" && <div className="banner warn">地图目录中的新增文件将删除，修改和删除的文件将恢复；未保存的地图编辑将丢弃。单位、建筑、规则表使用独立保存，不在此恢复范围。</div>}
          <div className="workspace-diff" data-testid="workspace-diff">{changed.length ? changed.map((entry) => <div className={`workspace-diff-row ${entry.status}`} key={entry.path}><span>{statusLabel[entry.status]}</span>{entry.kind === 'file' && entry.path.endsWith('.json') ? <button className="workspace-file-diff" onClick={async () => { const result = await api.diffFile(entry.path); if (result.ok) setDiffDetail({ path: entry.path, before: result.before || '', after: result.after || '' }); else setError(result.error || '对比读取失败'); }}>{entry.path}</button> : <code>{entry.path}</code>}</div>) : <div className="empty">目录与本次备份一致</div>}</div>
          {diffDetail && <div className="workspace-json-diff"><div className="workspace-diff-summary">{diffDetail.path} · {changedFields.length ? changedFields.join(', ') : '仅文件格式变化'}</div><div className="workspace-json-columns"><div><b>本次打开时</b><pre tabIndex={0}>{diffDetail.before || '文件不存在'}</pre></div><div><b>当前磁盘</b><pre tabIndex={0}>{diffDetail.after || '文件不存在'}</pre></div></div></div>}
          <div className="modal-actions"><button className="btn" disabled={busy} onClick={() => setDialog(null)}>关闭</button>{dialog === "restore" && <button className="btn danger" data-testid="workspace-restore-confirm" disabled={busy} onClick={() => void restore()}><RotateCcw size={16} />{busy ? "正在恢复…" : "确认完全恢复"}</button>}</div>
        </>}
      </section>
    </div>}
  </div>;
}
