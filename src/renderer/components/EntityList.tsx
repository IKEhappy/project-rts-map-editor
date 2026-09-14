import { useMemo, useState } from "react";
import type { Entity } from "../types";

interface Props {
  rows: Entity[];
  selectedKey: string;
  onSelect(key: string): void;
}

function title(entity: Entity): string {
  const name = typeof entity.name_cn === "string" ? entity.name_cn : "";
  const key = typeof entity.key === "string" ? entity.key : "?";
  return name ? `${name}（${key}）` : key;
}

/** 左侧实体列表：搜索过滤（name_cn/key/id），点击选中进右侧字段树 */
export default function EntityList(props: Props) {
  const [search, setSearch] = useState("");
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return props.rows;
    return props.rows.filter((row) => {
      const key = typeof row.key === "string" ? row.key : "";
      const name = typeof row.name_cn === "string" ? row.name_cn : "";
      const id = typeof row.id === "number" ? String(row.id) : "";
      return (
        key.toLowerCase().includes(needle) ||
        name.toLowerCase().includes(needle) ||
        id.includes(needle)
      );
    });
  }, [props.rows, search]);

  return (
    <aside className="entity-list">
      <input
        className="cell search"
        data-testid="entity-search"
        type="search"
        placeholder="搜索：名称 / key / id"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="entity-items">
        {filtered.map((row) => (
          <button
            key={String(row.key)}
            data-testid="entity-item"
            className={`entity-item${row.key === props.selectedKey ? " active" : ""}`}
            onClick={() => props.onSelect(String(row.key))}
          >
            <span className="entity-name">{title(row)}</span>
            {typeof row.id === "number" ? <span className="entity-id">#{row.id}</span> : null}
          </button>
        ))}
        {filtered.length === 0 ? <div className="empty">无匹配实体</div> : null}
      </div>
    </aside>
  );
}
