import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { Redo2, RotateCcw, Save, Undo2 } from "lucide-react";
import { api, serializeText } from "../api";
import { canonicalJson } from "../canonical";
import { DocHistory } from "../history";
import { validateEntityTree, validateRuleValue } from "../light-validation";
import { knownUnitKeys, summonLinesHint, unitSuggestionsFor } from "../suggest";
import { instantiateTemplate, type TemplateDef } from "../templates";
import { templatesForDocument, featureSchemaForDocument } from "../schema-templates";
import { removeAtPath } from "../field-path";
import type { LabelsData } from "../labels";
import type { ConfigFile, Entity, JsonValue, Kind, WorkspaceSession } from "../types";
import EntityList from "./EntityList";
import FieldTree from "./FieldTree";
import RulesTable from "./RulesTable";
import "../styles-configs.css";

const KINDS: Kind[] = ["units", "buildings", "rules"];
interface LoadState {
  kind: Kind;
  doc: ConfigFile;
  original: ConfigFile;
  text: string;
  hash: string;
  path: string;
}
type SaveState = { tone: "idle" } | { tone: "saving" } | { tone: "ok"; written: boolean } | { tone: "rejected"; code: string; errors: string[] };

export interface ConfigsPanelHandle {
  save(): Promise<boolean>;
  saveAll(): Promise<boolean>;
  undo(): void;
  redo(): void;
  reloadCurrent(): Promise<void>;
  flushPendingEdits(): void;
  isBusy(): boolean;
  getDirtyKinds(): Kind[];
  getFailedKind(): Kind | null;
}

interface Props {
  workspace: WorkspaceSession;
  kind: Kind;
  active: boolean;
  labelsData: LabelsData;
  handleRef?: Ref<ConfigsPanelHandle>;
  onDirtyChange?(count: number): void;
  onBusyChange?(busy: boolean): void;
  onSaved?(kind: Kind, data: ConfigFile): void;
}

function dirtyOf(state?: LoadState): boolean {
  return Boolean(state && canonicalJson(state.doc) !== canonicalJson(state.original));
}
function rowsOf(doc: ConfigFile | undefined, kind: Kind): Entity[] {
  const rows = doc?.[kind];
  return Array.isArray(rows) ? rows.filter((row): row is Entity => row !== null && typeof row === "object" && !Array.isArray(row)) : [];
}

/** 原配置工作台：三表常驻缓存、独立历史与原值，切地图/切表均不丢编辑。
 * 地图恢复只更改 workspace.generation；本面板仅按会话 id 重挂载，不以 generation 覆盖配置草稿。
 */
export default function ConfigsPanel({ workspace, kind, active, labelsData, handleRef, onDirtyChange, onBusyChange, onSaved }: Props) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [docs, setDocsState] = useState<Partial<Record<Kind, LoadState>>>({});
  const docsRef = useRef(docs);
  const setDocs = useCallback((next: Partial<Record<Kind, LoadState>>) => { docsRef.current = next; setDocsState(next); }, []);
  const [busy, setBusyState] = useState(false);
  const busyRef = useRef(false);
  const setBusy = useCallback((next: boolean) => { busyRef.current = next; setBusyState(next); }, []);
  const [errors, setErrors] = useState<Partial<Record<Kind, string>>>({});
  const [saveStates, setSaveStates] = useState<Partial<Record<Kind, SaveState>>>({});
  const [selectedKeys, setSelectedKeys] = useState<Partial<Record<Kind, string>>>({});
  const [toolTemplates, setToolTemplates] = useState<ConfigFile>();
  const [historyTick, setHistoryTick] = useState(0);
  const history = useRef(new DocHistory<ConfigFile>());
  const failedKind = useRef<Kind | null>(null);
  const kindRef = useRef(kind);
  kindRef.current = kind;
  const load = docs[kind];
  const saveState = saveStates[kind] ?? { tone: "idle" };
  const dirtyKinds = useMemo(() => KINDS.filter((candidate) => dirtyOf(docs[candidate])), [docs]);
  useEffect(() => { onDirtyChange?.(dirtyKinds.length); }, [dirtyKinds.length, onDirtyChange]);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useEffect(() => () => { onBusyChange?.(false); }, [onBusyChange]);
  useEffect(() => {
    let current = true;
    void api?.editorTemplates?.().then((result) => {
      if (current && result.ok && result.data) setToolTemplates(result.data);
    }).catch(() => { /* Optional config: RAM templates remain available. */ });
    return () => { current = false; };
  }, []);

  const setStatus = useCallback((target: Kind, state: SaveState) => {
    setSaveStates((previous) => ({ ...previous, [target]: state }));
  }, []);
  const commitFocusedInput = useCallback(() => {
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && panelRef.current?.contains(focused) && (focused.tagName === "INPUT" || focused.tagName === "TEXTAREA")) focused.blur();
  }, []);

  const readKind = useCallback(async (target: Kind, notify = false): Promise<boolean> => {
    setErrors((previous) => ({ ...previous, [target]: undefined }));
    try {
      const result = await api.readWorkspaceConfig(target);
      if (!result.ok || !result.data || !result.text || !result.hash || !result.path) throw new Error(result.error ?? `读取失败：${target}`);
      if (target !== "rules") {
        const raw = result.data[target];
        if (!Array.isArray(raw) || raw.some((row) => row === null || typeof row !== "object" || Array.isArray(row))) throw new Error(`${target}：须为对象数组，请先修复源文件`);
      }
      const state: LoadState = { kind: target, doc: result.data, original: result.data, text: result.text, hash: result.hash, path: result.path };
      setDocs({ ...docsRef.current, [target]: state });
      setStatus(target, { tone: "idle" });
      if (notify) onSaved?.(target, state.doc);
      return true;
    } catch (error) {
      setErrors((previous) => ({ ...previous, [target]: String(error) }));
      return false;
    }
  }, [onSaved, setDocs, setStatus]);

  useEffect(() => {
    if (!active || docsRef.current[kind] || busyRef.current || errors[kind]) return;
    setBusy(true);
    void (async () => {
      try {
        await readKind(kind);
        if (kind === "buildings" && !docsRef.current.units) await readKind("units");
      } finally { setBusy(false); }
    })();
  }, [active, kind, busy, errors, readKind, setBusy]);

  const rows = useMemo(() => rowsOf(load?.doc, kind), [load, kind]);
  const originalRows = useMemo(() => rowsOf(load?.original, kind), [load, kind]);
  const units = useMemo(() => docs.units ? rowsOf(docs.units.doc, "units") : null, [docs.units]);
  const selected = rows.find((row) => String(row.key) === selectedKeys[kind]) ?? rows[0];
  const selectedKey = selected ? String(selected.key) : "";
  const selectedOriginal = originalRows.find((row) => String(row.key) === selectedKey) ?? selected;
  const isNewEntity = useCallback((key: string) => !originalRows.some((row) => String(row.key) === key), [originalRows]);
  const templates = useMemo(() => {
    if (kind === "rules") return [];
    return templatesForDocument(kind, load?.doc, toolTemplates);
  }, [load, kind, toolTemplates]);
  const featureSchema = useMemo(
    () => kind === "units" || kind === "buildings" ? featureSchemaForDocument(kind, load?.doc, toolTemplates) : undefined,
    [kind, load?.doc, toolTemplates],
  );
  const suggestions = useMemo(() => kind === "buildings" && selected ? unitSuggestionsFor(selected, units, labelsData) : [], [kind, selected, units, labelsData]);
  const summonHint = useMemo(() => kind === "buildings" && selected ? summonLinesHint(selected, units) : null, [kind, selected, units]);
  const lightErrors = useMemo(() => {
    const result = new Map<string, string>();
    if (!load) return result;
    if (kind === "rules") {
      for (const [key, value] of Object.entries(load.doc)) {
        if (key === "version" || key === "_note") continue;
        const error = validateRuleValue(key, value);
        if (error) result.set(key, error);
      }
      return result;
    }
    return selected ? validateEntityTree(kind, selected, knownUnitKeys(kind === "units" ? rows : units)) : result;
  }, [load, kind, selected, rows, units]);

  const replaceDoc = useCallback((target: Kind, next: ConfigFile, tag: string, coalesce = 600) => {
    if (busyRef.current) return;
    const state = docsRef.current[target];
    if (!state || canonicalJson(state.doc) === canonicalJson(next)) return;
    history.current.commit(target, state.doc, tag, coalesce);
    setDocs({ ...docsRef.current, [target]: { ...state, doc: next } });
    setStatus(target, { tone: "idle" });
  }, [setDocs, setStatus]);

  const onEntityChange = useCallback((next: Entity, removeField = false) => {
    const state = docsRef.current[kind];
    if (!state || !selected || busyRef.current) return;
    const index = rowsOf(state.doc, kind).findIndex((row) => String(row.key) === selectedKey);
    if (index < 0) return;
    const nextRows = [...rowsOf(state.doc, kind)];
    nextRows[index] = next;
    replaceDoc(kind, { ...state.doc, [kind]: nextRows }, removeField ? "delete-field" : "field", removeField ? 0 : 600);
    if (String(next.key) !== selectedKey) setSelectedKeys((previous) => ({ ...previous, [kind]: String(next.key) }));
  }, [kind, selected, selectedKey, replaceDoc]);

  const deleteEntity = useCallback((key: string) => {
    if (busyRef.current) return;
    if (!isNewEntity(key)) {
      setStatus(kind, { tone: "rejected", code: "usage", errors: [`既有实体（${key}）删除仍被禁止：其他配置可能引用它，引用完整性无法校验；如确需删除请直接编辑数据文件`] });
      return;
    }
    const state = docsRef.current[kind];
    if (!state) return;
    replaceDoc(kind, { ...state.doc, [kind]: rowsOf(state.doc, kind).filter((row) => String(row.key) !== key) }, "delete", 0);
    setSelectedKeys((previous) => ({ ...previous, [kind]: "" }));
  }, [kind, isNewEntity, replaceDoc, setStatus]);

  const createFromTemplate = useCallback((template: TemplateDef) => {
    const state = docsRef.current[kind];
    if (!state || busyRef.current || kind === "rules") return;
    const currentRows = rowsOf(state.doc, kind);
    const entity = instantiateTemplate(template, currentRows);
    replaceDoc(kind, { ...state.doc, [kind]: [...currentRows, entity] }, "template", 0);
    setSelectedKeys((previous) => ({ ...previous, [kind]: String(entity.key) }));
  }, [kind, replaceDoc]);

  const onRuleChange = useCallback((key: string, value: JsonValue) => {
    const state = docsRef.current.rules;
    if (state) replaceDoc("rules", { ...state.doc, [key]: value }, "field");
  }, [replaceDoc]);

  const onRuleRemove = useCallback((key: string) => {
    const state = docsRef.current.rules;
    if (state) replaceDoc("rules", removeAtPath(state.doc, [key]), "delete-field", 0);
  }, [replaceDoc]);

  const undoRedo = useCallback((direction: -1 | 1) => {
    if (busyRef.current) return;
    commitFocusedInput();
    const target = kindRef.current;
    const state = docsRef.current[target];
    if (!state || busyRef.current) return;
    const next = direction === -1 ? history.current.undoFor(target, state.doc) : history.current.redoFor(target, state.doc);
    if (next === null) return;
    setDocs({ ...docsRef.current, [target]: { ...state, doc: next } });
    setStatus(target, { tone: "idle" });
    setHistoryTick((tick) => tick + 1);
  }, [setDocs, setStatus, commitFocusedInput]);
  void historyTick;

  const saveKind = useCallback(async (target: Kind): Promise<boolean> => {
    const state = docsRef.current[target];
    if (!state || !dirtyOf(state)) { setStatus(target, { tone: "ok", written: false }); return true; }
    setStatus(target, { tone: "saving" });
    try {
      const savedDoc: ConfigFile = target === "rules" ? state.doc : {
        ...state.doc,
        templates: templatesForDocument(target, state.doc, toolTemplates) as unknown as JsonValue,
      };
      const result = await api.save({ kind: target, data: savedDoc, baseHash: state.hash, workspaceId: workspace.id });
      if (!result.ok) {
        failedKind.current = target;
        setStatus(target, { tone: "rejected", code: result.code ?? "error", errors: result.errors ?? ["未知错误"] });
        return false;
      }
      setDocs({ ...docsRef.current, [target]: { ...state, doc: savedDoc, text: serializeText(savedDoc), hash: result.hash ?? state.hash, original: savedDoc } });
      setStatus(target, { tone: "ok", written: Boolean(result.written) });
      failedKind.current = null;
      onSaved?.(target, savedDoc);
      return true;
    } catch (error) {
      failedKind.current = target;
      setStatus(target, { tone: "rejected", code: "io", errors: [String(error)] });
      return false;
    }
  }, [workspace.id, onSaved, setDocs, setStatus, toolTemplates]);

  const save = useCallback(async (): Promise<boolean> => {
    if (busyRef.current) return false;
    commitFocusedInput();
    setBusy(true);
    try { return await saveKind(kindRef.current); }
    finally { setBusy(false); }
  }, [saveKind, setBusy, commitFocusedInput]);
  const saveAll = useCallback(async (): Promise<boolean> => {
    if (busyRef.current) return false;
    commitFocusedInput();
    setBusy(true);
    try {
      for (const target of KINDS) if (dirtyOf(docsRef.current[target]) && !await saveKind(target)) return false;
      return true;
    } finally { setBusy(false); }
  }, [saveKind, setBusy, commitFocusedInput]);
  const reload = useCallback(async () => {
    if (busyRef.current) return;
    commitFocusedInput();
    const target = kindRef.current;
    if (dirtyOf(docsRef.current[target]) && !window.confirm("当前表有未保存修改，重新加载将丢弃，确认？")) return;
    setBusy(true);
    try { if (await readKind(target, true)) history.current.clear(target); }
    finally { setBusy(false); }
  }, [readKind, setBusy, commitFocusedInput]);

  useImperativeHandle(handleRef, () => ({
    save,
    saveAll,
    undo: () => undoRedo(-1),
    redo: () => undoRedo(1),
    reloadCurrent: reload,
    flushPendingEdits: commitFocusedInput,
    isBusy: () => busyRef.current,
    getDirtyKinds: () => KINDS.filter((target) => dirtyOf(docsRef.current[target])),
    getFailedKind: () => failedKind.current,
  }), [save, saveAll, undoRedo, reload, commitFocusedInput]);

  return <div className="configs-panel" data-testid="configs-panel" data-kind={kind} aria-busy={busy} ref={panelRef}>
    <div className="configs-toolbar">
      <button className="btn slim" data-testid="config-undo-btn" title="撤销（Ctrl+Z）" aria-label="撤销" disabled={busy || !history.current.canUndo(kind)} onClick={() => undoRedo(-1)}><Undo2 size={15} /></button>
      <button className="btn slim" data-testid="config-redo-btn" title="重做（Ctrl+Y）" aria-label="重做" disabled={busy || !history.current.canRedo(kind)} onClick={() => undoRedo(1)}><Redo2 size={15} /></button>
      <button className="btn slim" data-testid="config-reload-btn" disabled={busy} onClick={() => void reload()}><RotateCcw size={14} />重新加载</button>
      <span className="configs-current-file" title={load?.path}>{kind}.json</span>
      <span className={dirtyOf(load) ? "chip dirty" : "chip"} data-testid="config-dirty-chip">{dirtyOf(load) ? "未保存" : "已同步"}</span>
      <button className="btn primary" data-testid="config-save-btn" disabled={busy || !load || !dirtyOf(load)} onClick={() => void save()}><Save size={14} />保存</button>
    </div>
    {errors[kind] ? <div className="banner error" data-testid="config-read-error">读取失败：{errors[kind]}</div> : null}
    {saveState.tone === "saving" ? <div className="banner info">Godot 门禁校验中…</div> : null}
    {saveState.tone === "ok" ? <div className="banner ok" data-testid="save-ok">{saveState.written ? "已保存（旧文件备份为 .bak）" : "无改动，未写盘"}</div> : null}
    {saveState.tone === "rejected" ? <div className="banner error" data-testid="save-errors"><strong>{saveState.code === "conflict" ? "文件冲突" : saveState.code === "gate" ? "Godot 门禁拒绝（文件未改动）" : "保存失败"}：</strong><ul>{saveState.errors.map((error, index) => <li key={index}>{error}</li>)}</ul></div> : null}
    <div className="configs-editor" inert={!active || busy}>
      {load && kind !== "rules" ? <div className="master-detail" key={kind}>
        <EntityList rows={rows} selectedKey={selectedKey} onSelect={(key) => setSelectedKeys((previous) => ({ ...previous, [kind]: key }))} templates={templates} onCreateFromTemplate={createFromTemplate} onDelete={deleteEntity} />
        <section className="detail">
          {summonHint ? <div className="banner warn compact">{summonHint}</div> : null}
          {selected ? <FieldTree entity={selected} original={selectedOriginal} labels={labelsData} lightErrors={lightErrors} unitSuggestions={suggestions} identityEditable={isNewEntity(selectedKey)} featureSchema={featureSchema} onChange={onEntityChange} onRemoveField={(next) => onEntityChange(next, true)} /> : <div className="empty">（空表——可从左下「＋ 从模板新建」创建实体）</div>}
        </section>
      </div> : null}
      {load && kind === "rules" ? <RulesTable entries={Object.entries(load.doc).filter(([key]) => key !== "version" && key !== "_note")} original={load.original} labels={labelsData} lightErrors={lightErrors} onValueChange={onRuleChange} onRemove={onRuleRemove} /> : null}
      {!load && !errors[kind] ? <div className="empty">加载中…</div> : null}
    </div>
    <div className="configs-status"><span>{selected && kind !== "rules" ? `${selectedKey} · ` : ""}轻校验告警 {lightErrors.size} 处</span><span title={load?.path}>{load?.path}</span></div>
  </div>;
}
