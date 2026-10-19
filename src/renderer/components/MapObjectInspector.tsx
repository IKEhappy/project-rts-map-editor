import { useMemo } from "react";
import type { Entity } from "../types";
import type { LabelsData } from "../labels";
import type { UnitSuggestion } from "../suggest";
import { defaultsAtPath, type FeatureSchema } from "../schema-templates";
import FieldTree from "./FieldTree";
import "../styles-map-object.css";

export interface MapObjectInspectorProps {
  entity: Entity | null;
  original?: Entity;
  labels: LabelsData;
  /** The map's full schema; paths are rebased to the selected placement. */
  featureSchema?: FeatureSchema;
  /** Map-level error paths are rebased to FieldTree's local field paths. */
  lightErrors?: Map<string, string>;
  unitSuggestions?: UnitSuggestion[];
  path: Array<string | number>;
  onChange(next: Entity): void;
  onRemoveField?(next: Entity): void;
  selectionLabel?: string;
  readOnly?: boolean;
  focusPath?: Array<string | number>;
  focusRequestId?: number;
}

const EMPTY_ERRORS = new Map<string, string>();
const EMPTY_SUGGESTIONS: UnitSuggestion[] = [];

/** Property-grid presentation of one placement. Only the selected subtree is
 * mounted; editing retains the shared Tree's nested arrays and template UI. */
export default function MapObjectInspector({
  entity, original, labels, featureSchema, lightErrors = EMPTY_ERRORS,
  unitSuggestions = EMPTY_SUGGESTIONS, path, onChange, onRemoveField, selectionLabel,
  readOnly = false, focusPath, focusRequestId,
}: MapObjectInspectorProps) {
  const pathKey = path.map(String).join("-");
  const localSchema = useMemo<FeatureSchema>(() => ({
    root: featureSchema ? defaultsAtPath(featureSchema, path) : {},
    paths: {},
    resolvePath: (localPath) => featureSchema ? defaultsAtPath(featureSchema, [...path, ...localPath]) : {},
  }), [featureSchema, pathKey]);
  const localErrors = useMemo(() => {
    const prefix = pathKey ? `${pathKey}-` : "";
    return new Map([...lightErrors].filter(([key]) => key === pathKey || key.startsWith(prefix))
      .map(([key, value]) => [key === pathKey ? "" : key.slice(prefix.length), value]));
  }, [lightErrors, pathKey]);
  const errors = [...new Set(localErrors.values())];

  return (
    <section className="map-object-inspector" data-testid="map-object-inspector" data-object-path={pathKey} aria-label="Object 属性">
      {entity ? <>
        <div className="map-object-summary">
          <strong data-testid="map-object-title">{selectionLabel || "选中 Object"}</strong>
          <span className="map-object-source">修改当前地图中的摆放配置</span>
        </div>
        {errors.length > 0 ? <div className="map-object-errors" role="status" data-testid="map-object-errors">
          {errors.map((message) => <div key={message}>{message}</div>)}
        </div> : null}
        <div className="map-object-table-head" aria-hidden="true"><span>属性</span><span>值</span></div>
        <fieldset className="map-object-fields" disabled={readOnly} aria-label="选中 Object 的配置字段">
          <FieldTree
            key={pathKey}
            entity={entity}
            original={original ?? {}}
            labels={labels}
            lightErrors={localErrors}
            unitSuggestions={unitSuggestions}
            identityEditable
            featureSchema={localSchema}
            focusPath={focusPath}
            focusRequestId={focusRequestId}
            onChange={(next) => { if (!readOnly) onChange(next); }}
            onRemoveField={(next) => { if (!readOnly) (onRemoveField ?? onChange)(next); }}
          />
        </fieldset>
      </> : <div className="map-object-empty" data-testid="map-object-empty">
        <strong>未选择 Object</strong>
        <span>在地图上点击建筑、炮台或单位，查看并编辑其属性。</span>
      </div>}
    </section>
  );
}
