// 语义化 JSON 比对（T-164 R5：修复幻影脏标记）：
// "是否有修改"不能按文本逐字比对——units.json 含 "size_scale": 1.0（JS 再序列化为 1）、
// buildings.json 用 tab 缩进（工具序列化为 2 空格），文本比对会一打开就误报"有未保存修改"。
// canonicalJson 与游戏侧 MatchConfig.canonical 同口径：数字归一（1.0 ≡ 1）、键序无关、忽略空白。
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") return JSON.stringify(value); // String(1.0) === "1"，自动归一
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return "null";
}
