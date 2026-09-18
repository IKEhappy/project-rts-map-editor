import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface DropdownOption {
  value: string;
  label: string;
  title?: string;
}

interface Props {
  value: string;
  options: DropdownOption[];
  onChange(next: string): void;
  testId: string;
  invalid?: boolean;
  title?: string;
  /** 恒定显示的触发器文案（如新建菜单的"＋ 从模板新建"）；缺省显示当前值标签 */
  triggerLabel?: string;
  /** 菜单未打开时也渲染隐藏项（供测试枚举选项），默认 false */
  alwaysRenderMenu?: boolean;
  /** R23：选项超过阈值（默认 8）时菜单顶部显示搜索框，按 label/value 过滤 */
  searchThreshold?: number;
}

/**
 * 自绘下拉（T-164 R9）：替换全部原生 <select>——Windows 下原生 select 弹层先白后黑
 * 的闪烁无 CSS 解，自绘即根治。深色主题、点击外部关闭、Escape 关闭。
 */
export default function Dropdown(props: Props) {
  const { value, options, onChange, testId, invalid, title, triggerLabel, alwaysRenderMenu, searchThreshold = 8 } = props;
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const [query, setQuery] = useState("");
  // R26：菜单 Portal 到 body——突破 JSON 抽屉 .map-json-tree overflow:auto 对 absolute
  // 子元素的裁剪（"下拉折叠"根因）；fixed 定位按触发器 rect 实时计算。
  const [menuPos, setMenuPos] = useState<{ left: number; top: number; minWidth: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null); // R29：Portal 菜单节点（outside-close 需同时检查）
  const triggerRef = useRef<HTMLButtonElement>(null);

  // 展开方向：下方空间不足且上方更充裕时向上弹（T-164 R10：左栏底部"从模板新建"
  // 向下弹会溢出视口底，把页面撑出滚动条、把窗口控制钮划出可视区）
  const toggle = () => {
    if (!open) setQuery("");
    if (!open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const estimated = Math.min(330, options.length * 30 + 16 + (options.length > searchThreshold ? 30 : 0));
      const willUp = spaceBelow < estimated && rect.top > spaceBelow;
      setUp(willUp);
      setMenuPos({
        left: rect.left,
        top: willUp ? Math.max(8, rect.top - estimated - 3) : rect.bottom + 3,
        minWidth: rect.width,
      });
    }
    setOpen((prev) => !prev);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      // R29：菜单在 body Portal 上——触发器容器和菜单节点都不含目标时才算外部点击
      const insideTrigger = rootRef.current?.contains(target) ?? false;
      const insideMenu = menuRef.current?.contains(target) ?? false;
      if (!insideTrigger && !insideMenu) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = options.find((option) => option.value === value);
  const label = triggerLabel ?? (current ? current.label : value);
  const showFallback = !current && !triggerLabel;
  const searchable = options.length > searchThreshold;
  const filtered = searchable && query.trim().length > 0
    ? options.filter((option) => {
        const q = query.trim().toLowerCase();
        return option.label.toLowerCase().includes(q) || option.value.toLowerCase().includes(q);
      })
    : options;

  return (
    <div className={`dropdown${open ? " open" : ""}`} ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className={`cell dd-trigger${invalid ? " invalid" : ""}`}
        data-testid={testId}
        data-value={value}
        title={title ?? label}
        onClick={toggle}
      >
        <span className="dd-label">{label}</span>
        <svg width="8" height="5" viewBox="0 0 8 5" aria-hidden="true" className={`dd-chevron${up ? " up" : ""}`}>
          <path d="M0.5 0.5 L4 4 L7.5 0.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </button>
      {open || alwaysRenderMenu
        ? createPortal(
            <div
              ref={menuRef}
              className={`dd-menu${up ? " up" : ""}`}
              role="listbox"
              style={
                menuPos
                  ? { position: "fixed", left: menuPos.left, top: menuPos.top, minWidth: menuPos.minWidth, visibility: open ? "visible" : "hidden" }
                  : { visibility: open ? "visible" : "hidden" }
              }
            >
          {open && searchable ? (
            <input
              className="cell dd-search"
              data-testid={`${testId}-search`}
              type="text"
              autoFocus
              placeholder={`搜索 ${options.length} 项…`}
              value={query}
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  setOpen(false);
                }
              }}
            />
          ) : null}
          {filtered.map((option) => (
            <button
              type="button"
              key={option.value}
              className={`dd-option${option.value === value ? " selected" : ""}`}
              data-testid={`${testId}-opt-${option.value}`}
              data-value={option.value}
              title={option.title ?? option.label}
              onClick={() => {
                setOpen(false);
                if (option.value !== value) onChange(option.value);
              }}
            >
              {option.label}
            </button>
          ))}
          {open && searchable && filtered.length === 0 ? (
            <div className="dd-empty">无匹配项</div>
          ) : null}
              {showFallback ? (
                <button type="button" className="dd-option selected" data-value={value} disabled>
                  {value}（不在选项内）
                </button>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
