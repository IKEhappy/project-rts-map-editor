import { useEffect, useMemo, useRef, useState } from "react";
import type { Entity } from "../types";
import type { TemplateDef } from "../templates";
import Dropdown from "./Dropdown";

interface Props {
  rows: Entity[];
  selectedKey: string;
  onSelect(key: string): void;
  templates: TemplateDef[];
  onCreateFromTemplate(tpl: TemplateDef): void;
  /** 右键删除（T-164 R10）：新实体可删；既有实体由上层拦截并提示 */
  onDelete(key: string): void;
}

function title(entity: Entity): string {
  const name = typeof entity.name_cn === "string" ? entity.name_cn : "";
  const key = typeof entity.key === "string" ? entity.key : "?";
  return name ? `${name}（${key}）` : key;
}

/** 左侧实体列表：搜索过滤（name_cn/key/id），点击选中进右侧字段树；底部可从模板新建；
 *  右键实体项弹出删除菜单（新实体可删，既有实体由上层拦截） */
export default function EntityList(props: Props) {
  const [search, setSearch] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; key: string } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenu(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

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
      <div className="entity-count">
        {filtered.length === props.rows.length ? `共 ${props.rows.length} 项` : `${filtered.length} / ${props.rows.length} 项`}
      </div>
      <div className="entity-items">
        {filtered.map((row) => (
          <button
            key={String(row.key)}
            data-testid="entity-item"
            className={`entity-item${row.key === props.selectedKey ? " active" : ""}`}
            onClick={() => props.onSelect(String(row.key))}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu({ x: event.clientX, y: event.clientY, key: String(row.key) });
            }}
          >
            <span className="entity-name">{title(row)}</span>
            {typeof row.id === "number" ? <span className="entity-id">#{row.id}</span> : null}
          </button>
        ))}
        {filtered.length === 0 ? <div className="empty">无匹配实体</div> : null}
      </div>
      {props.templates.length > 0 ? (
        <Dropdown
          value=""
          triggerLabel="＋ 从模板新建"
          options={props.templates.map((tpl) => ({
            value: tpl.key,
            label: `${tpl.name_cn}（${tpl.key}）`,
            title: tpl.note,
          }))}
          onChange={(tplKey) => {
            const tpl = props.templates.find((candidate) => candidate.key === tplKey);
            if (tpl) props.onCreateFromTemplate(tpl);
          }}
          testId="add-entity"
        />
      ) : null}
      {menu ? (
        <div className="ctx-menu" ref={menuRef} style={{ left: menu.x, top: menu.y }}>
          <button
            type="button"
            className="ctx-option danger"
            data-testid="ctx-delete"
            onClick={() => {
              setMenu(null);
              props.onDelete(menu.key);
            }}
          >
            删除该项
          </button>
        </div>
      ) : null}
    </aside>
  );
}
