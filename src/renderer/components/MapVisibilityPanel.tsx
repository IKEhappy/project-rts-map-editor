import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { SlidersHorizontal } from "lucide-react";
import type { MapVisibility } from "../map-visibility";
import "../styles-map-visibility.css";

interface Props {
  value: MapVisibility;
  onChange(value: MapVisibility): void;
  active?: boolean;
}

interface VisibilityCheckboxProps {
  checked: boolean;
  testId: string;
  children: string;
  title: string;
  onChange(checked: boolean): void;
  indeterminate?: boolean;
}

function VisibilityCheckbox({ checked, testId, children, title, onChange, indeterminate = false }: VisibilityCheckboxProps) {
  const ref = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <label className="map-visibility-option" title={title}>
      <input
        ref={ref}
        type="checkbox"
        checked={checked}
        aria-checked={indeterminate ? "mixed" : checked}
        data-testid={`map-visibility-${testId}`}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span>{children}</span>
    </label>
  );
}

/** A view-only filter popover. Dismissing it consumes the outside gesture so
 * that a map drawing/moving tool cannot edit the map with the same click. */
export default function MapVisibilityPanel({ value, onChange, active = true }: Props) {
  const [open, setOpen] = useState(false);
  const [bounds, setBounds] = useState({ width: 600, height: 420 });
  const hostRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const openRef = useRef(false);
  const panelId = useId();

  function changeOpen(next: boolean) {
    openRef.current = next && active;
    setOpen(next && active);
  }

  useEffect(() => {
    if (active) return;
    openRef.current = false;
    setOpen(false);
  }, [active]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    const viewport = host?.closest(".map-canvas-viewport");
    if (!host || !viewport) return;
    const measure = () => {
      const hostRect = host.getBoundingClientRect();
      const viewportRect = viewport.getBoundingClientRect();
      setBounds({
        width: Math.max(0, Math.min(600, hostRect.left - viewportRect.left - 16)),
        height: Math.max(0, viewportRect.bottom - hostRect.top - 12),
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  useEffect(() => {
    // Keep the listeners mounted while the closing animation runs: pointerup
    // and click follow pointerdown after React has committed the closed state.
    let dismissed: { pointerId: number; until: number } | null = null;
    const consume = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    const close = () => {
      openRef.current = false;
      setOpen(false);
      buttonRef.current?.focus({ preventScroll: true });
    };
    const onPointerDown = (event: PointerEvent) => {
      dismissed = null;
      if (!openRef.current || hostRef.current?.contains(event.target as Node)) return;
      dismissed = { pointerId: event.pointerId, until: Date.now() + 1000 };
      consume(event);
      close();
    };
    const onPointerUp = (event: PointerEvent) => {
      if (dismissed?.pointerId === event.pointerId) {
        // A held click can outlive the initial deadline. Compatibility
        // mouseup/click still belong to the same consumed outside gesture.
        dismissed.until = Date.now() + 1000;
        consume(event);
      }
    };
    const onCompatibilityEvent = (event: Event) => {
      if (!dismissed || Date.now() > dismissed.until) return;
      consume(event);
      if (event.type === "click" || event.type === "contextmenu") dismissed = null;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!openRef.current || event.key !== "Escape") return;
      consume(event);
      close();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointerup", onPointerUp, true);
    document.addEventListener("mousedown", onCompatibilityEvent, true);
    document.addEventListener("mouseup", onCompatibilityEvent, true);
    document.addEventListener("click", onCompatibilityEvent, true);
    document.addEventListener("contextmenu", onCompatibilityEvent, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointerup", onPointerUp, true);
      document.removeEventListener("mousedown", onCompatibilityEvent, true);
      document.removeEventListener("mouseup", onCompatibilityEvent, true);
      document.removeEventListener("click", onCompatibilityEvent, true);
      document.removeEventListener("contextmenu", onCompatibilityEvent, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);

  const allTeams = value.teams.own && value.teams.enemy && value.teams.neutral;
  const anyTeams = value.teams.own || value.teams.enemy || value.teams.neutral;
  const shown = open && active;
  const team = (key: keyof MapVisibility["teams"], checked: boolean) => onChange({ ...value, teams: { ...value.teams, [key]: checked } });
  const kind = (key: keyof MapVisibility["kinds"], checked: boolean) => onChange({ ...value, kinds: { ...value.kinds, [key]: checked } });
  const style = {
    "--map-visibility-width": `${bounds.width}px`,
    "--map-visibility-max-height": `${bounds.height}px`,
  } as CSSProperties;

  return (
    <div className="map-visibility-control" ref={hostRef} style={style}>
      <button
        ref={buttonRef}
        type="button"
        className={`quick-sq map-visibility-toggle${shown ? " active" : ""}`}
        data-testid="map-visibility-toggle"
        aria-label="地图显示筛选"
        aria-controls={panelId}
        aria-expanded={shown}
        disabled={!active}
        title={shown ? "收起地图显示筛选" : "展开地图显示筛选（仅影响当前编辑器视图）"}
        onClick={() => changeOpen(!openRef.current)}
      >
        <SlidersHorizontal size={17} aria-hidden="true" />
      </button>
      <div
        id={panelId}
        role="dialog"
        aria-label="地图显示筛选"
        aria-hidden={!shown}
        inert={!shown}
        className={`map-visibility-panel${shown ? " is-open" : ""}`}
        data-testid="map-visibility-panel"
        data-open={shown}
      >
        <div className="map-visibility-heading">
          <strong>地图显示</strong>
          <span>仅影响编辑器视图</span>
        </div>
        <fieldset className="map-visibility-row" aria-label="队伍筛选">
          <legend>队伍</legend>
          <VisibilityCheckbox checked={allTeams} indeterminate={anyTeams && !allTeams} testId="all-teams" title="同时显示或隐藏所有队伍的游戏 Object。" onChange={(checked) => onChange({ ...value, teams: { own: checked, enemy: checked, neutral: checked } })}>显示全部Team</VisibilityCheckbox>
          <VisibilityCheckbox checked={value.teams.own} testId="own" title="显示 Team 1 的建筑、炮台和单位。" onChange={(checked) => team("own", checked)}>显示己方</VisibilityCheckbox>
          <VisibilityCheckbox checked={value.teams.enemy} testId="enemy" title="显示 Team 2 及以上队伍的建筑、炮台和单位。" onChange={(checked) => team("enemy", checked)}>显示敌方</VisibilityCheckbox>
          <VisibilityCheckbox checked={value.teams.neutral} testId="neutral" title="显示 Team 0 的建筑、炮台和单位。" onChange={(checked) => team("neutral", checked)}>显示中立</VisibilityCheckbox>
        </fieldset>
        <fieldset className="map-visibility-row" aria-label="对象类别筛选">
          <legend>对象</legend>
          <VisibilityCheckbox checked={value.kinds.buildings} testId="buildings" title="显示普通及功能建筑，不包含炮台；只显示上方已勾选队伍的对象。" onChange={(checked) => kind("buildings", checked)}>显示全部建筑</VisibilityCheckbox>
          <VisibilityCheckbox checked={value.kinds.turrets} testId="turrets" title="显示炮台；只显示上方已勾选队伍的对象。" onChange={(checked) => kind("turrets", checked)}>显示炮台</VisibilityCheckbox>
          <VisibilityCheckbox checked={value.kinds.units} testId="units" title="显示单位和飞碟；只显示上方已勾选队伍的对象。" onChange={(checked) => kind("units", checked)}>显示单位</VisibilityCheckbox>
        </fieldset>
        <fieldset className="map-visibility-row" aria-label="图层隐藏">
          <legend>隐藏</legend>
          <VisibilityCheckbox checked={value.hideBackground} testId="background" title="隐藏整图贴图或地形底图，保留其他图层。" onChange={(checked) => onChange({ ...value, hideBackground: checked })}>隐藏背景贴图</VisibilityCheckbox>
          <VisibilityCheckbox checked={value.hideRender} testId="render" title="隐藏 render 装饰等视觉效果，保留 box_mode 标记。" onChange={(checked) => onChange({ ...value, hideRender: checked })}>隐藏render</VisibilityCheckbox>
          <VisibilityCheckbox checked={value.hideObjects} testId="objects" title="统一隐藏单位、飞碟、建筑和炮台，优先于上方的队伍与类别筛选。" onChange={(checked) => onChange({ ...value, hideObjects: checked })}>隐藏游戏Object</VisibilityCheckbox>
          <VisibilityCheckbox checked={value.hideGrid} testId="grid" title="隐藏地图单位格的网格线。" onChange={(checked) => onChange({ ...value, hideGrid: checked })}>隐藏单位格</VisibilityCheckbox>
          <VisibilityCheckbox checked={value.hideBoxes} testId="boxes" title="隐藏 box_mode 的通行与禁建标记；隐藏时不能直接拖动或删除，位置提示仍显示实际配置。" onChange={(checked) => onChange({ ...value, hideBoxes: checked })}>隐藏 box_mode</VisibilityCheckbox>
        </fieldset>
      </div>
    </div>
  );
}
