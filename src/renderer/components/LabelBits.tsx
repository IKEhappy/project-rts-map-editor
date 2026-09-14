import type { LabelsData } from "../labels";

// markdown 风格标签（T-164 R2.3）：英文原字段 = 行内代码样式，中文注释 = 普通文本。
// 纯显示层：落盘永远英文原键。
export function FieldLabelView(props: { field: string; labels: LabelsData }) {
  const zh = props.labels.fields?.[props.field];
  return (
    <span className="label-view">
      <code className="md-code">{props.field}</code>
      {zh ? <span className="zh-note">{zh}</span> : null}
    </span>
  );
}

export function RuleLabelView(props: { ruleKey: string; labels: LabelsData }) {
  const zh = props.labels.rules?.[props.ruleKey];
  return (
    <span className="label-view">
      <code className="md-code">{props.ruleKey}</code>
      {zh ? <span className="zh-note">{zh}</span> : null}
    </span>
  );
}
