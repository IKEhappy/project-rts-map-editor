import { ImagePlus, Layers, Trash2 } from "lucide-react";
import type { BackgroundInfo, ConfigFile } from "../types";
import type { BackgroundSlot, BackgroundView } from "../background-model";

interface Props {
  doc: ConfigFile;
  info: BackgroundInfo | null;
  view: BackgroundView;
  busy: boolean;
  imageMode: boolean;
  onMode(imageMode: boolean): void;
  onView(view: BackgroundView): void;
  onChange(doc: ConfigFile): void;
  onImport(slot: BackgroundSlot): void;
  onRemove(): void;
}

const SLOT_LABELS: Array<[BackgroundSlot, string]> = [["topdown", "正上方俯视"], ["tilt", "俯视倾角"], ["image", "通用回退"]];

export default function BackgroundInspector({ doc, info, view, busy, imageMode, onMode, onView, onChange, onImport, onRemove }: Props) {
  const hasMapBackground = Object.prototype.hasOwnProperty.call(doc, "background");
  return (
    <>
      <section className="map-inspector-section">
        <h3>地图属性</h3>
        <label className="map-field"><span>名称</span><input className="cell" disabled={busy} value={String(doc.name ?? "")} onChange={(event) => onChange({ ...doc, name: event.target.value })} /></label>
        <div className="map-field-pair">
          {(["width", "height"] as const).map((key) => (
            <label className="map-field" key={key}><span>{key === "width" ? "宽度 / 格" : "高度 / 格"}</span><input className="cell" disabled={busy} type="number" min={1} max={512} value={typeof doc[key] === "number" ? doc[key] : ""} onChange={(event) => onChange({ ...doc, [key]: event.target.value === "" ? "" : Number(event.target.value) })} /></label>
          ))}
        </div>
      </section>
      <section className="map-inspector-section" data-testid="background-inspector">
        <h3><Layers size={15} /> 地面表现</h3>
        <div className="map-segmented map-mode-selector" data-testid="map-ground-mode" aria-label="地面表现模式">
          <button type="button" className={!imageMode ? "active" : ""} data-testid="map-mode-tiles" disabled={busy} onClick={() => onMode(false)}>模式 1 · 瓦片</button>
          <button type="button" className={imageMode ? "active" : ""} data-testid="map-mode-image" disabled={busy} onClick={() => onMode(true)}>模式 2 · 整图</button>
        </div>
        <div className="map-source-line">来源 <b>{info?.source === "map" ? "本地图" : info?.source === "renderer" ? "渲染配置" : "瓦片配置"}</b></div>
        <label className="map-field"><span>渲染配置</span><input className="cell" disabled={busy} value={String(doc.renderer ?? "")} placeholder="res://data/render/…" onChange={(event) => onChange({ ...doc, renderer: event.target.value })} /></label>
        <div className="map-segmented" aria-label="背景视角">
          <button type="button" className={view === "topdown" ? "active" : ""} data-testid="map-view-topdown" onClick={() => onView("topdown")}>正上方俯视</button>
          <button type="button" className={view === "tilt" ? "active" : ""} data-testid="map-view-tilt" onClick={() => onView("tilt")}>俯视倾角</button>
        </div>
        {view === "tilt" ? <p className="map-inspector-note">倾角预览 · 只读</p> : null}
        <div className="map-background-slots">
          {SLOT_LABELS.map(([slot, label]) => {
            const image = info?.images[slot];
            return (
              <div className="map-background-slot" key={slot}>
                <div className="map-slot-head"><span>{label}</span><button type="button" className="map-icon-button" data-testid={`map-import-${slot}`} title={`导入${label} PNG / JPG`} aria-label={`导入${label} PNG / JPG`} disabled={busy} onClick={() => onImport(slot)}><ImagePlus size={16} /></button></div>
                <div className="map-resource-path" title={info?.background[slot]}>{info?.background[slot] || "未指定"}</div>
                {image?.width && image.height ? <span className="map-resource-size">{image.width} × {image.height} px</span> : null}
                {image?.error ? <div className="map-inline-error">{image.error}</div> : null}
              </div>
            );
          })}
        </div>
        {hasMapBackground ? <button type="button" className="btn slim map-remove-background" data-testid="map-remove-background" disabled={busy} onClick={onRemove}><Trash2 size={14} /> 移除本地图整图声明</button> : null}
        {info?.source === "renderer" ? <p className="map-inspector-note">渲染配置提供整图背景，移除地图声明后仍会使用该背景。</p> : null}
        {(info?.errors ?? []).length > 0 ? <ul className="map-background-errors" data-testid="map-background-errors">{info!.errors.map((error, index) => <li key={index}>{error}</li>)}</ul> : null}
      </section>
      <section className="map-inspector-section map-object-counts">
        <h3>地图内容</h3>
        <dl>{([["box_mode", "碰撞区域"], ["buildings", "建筑"], ["spawns", "出生点"], ["decor", "装饰"]] as const).map(([key, label]) => { const entries = doc[key]; return <div key={key}><dt>{label}</dt><dd>{Array.isArray(entries) ? entries.length : 0}</dd></div>; })}</dl>
      </section>
    </>
  );
}
