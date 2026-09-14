import { useState } from "react";
import type { JsonValue } from "../types";
import type { LabelsData } from "../labels";
import { RuleLabelView } from "./LabelBits";

interface Props {
  entries: Array<[string, JsonValue]>;
  original: Record<string, JsonValue>;
  labels: LabelsData;
  lightErrors: Map<string, string>;
  onValueChange(key: string, value: JsonValue): void;
}

function RuleNumberCell(props: { value: number; testId: string; onCommit(next: number): void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? String(props.value);
  const commit = () => {
    if (draft === null) return;
    const parsed = Number(draft);
    if (Number.isFinite(parsed) && parsed !== props.value) props.onCommit(parsed);
    setDraft(null);
  };
  return (
    <input
      className="cell num"
      data-testid={props.testId}
      type="number"
      value={text}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setDraft(null);
      }}
    />
  );
}

/** rules.json 扁平键值表（version/_note 由调用方过滤，不在此渲染） */
export default function RulesTable(props: Props) {
  return (
    <div className="table-wrap">
      <table className="grid rules">
        <thead>
          <tr>
            <th style={{ width: "360px" }}>规则键（中文）</th>
            <th>值</th>
          </tr>
        </thead>
        <tbody>
          {props.entries.map(([key, value]) => {
            const error = props.lightErrors.get(key);
            const dirty = JSON.stringify(value) !== JSON.stringify(props.original[key]);
            return (
              <tr key={key} className={dirty ? "row-dirty" : undefined}>
                <td className="identity" title={key}>
                  <RuleLabelView ruleKey={key} labels={props.labels} />
                </td>
                <td>
                  {typeof value === "boolean" ? (
                    <input
                      className="cell chk"
                      data-testid={`rule-input-${key}`}
                      type="checkbox"
                      checked={value}
                      onChange={(e) => props.onValueChange(key, e.target.checked)}
                    />
                  ) : typeof value === "number" ? (
                    <span className={error ? "rule-error" : undefined} title={error ?? undefined}>
                      <RuleNumberCell
                        value={value}
                        testId={`rule-input-${key}`}
                        onCommit={(next) => props.onValueChange(key, next)}
                      />
                    </span>
                  ) : (
                    <span className="readonly">{JSON.stringify(value)}（R1 只读）</span>
                  )}
                  {error ? <span className="rule-error-text">{error}</span> : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
