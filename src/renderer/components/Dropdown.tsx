import { useEffect, useRef, useState } from "react";

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
}

/**
 * 自绘下拉（T-164 R9）：替换全部原生 <select>——Windows 下原生 select 弹层先白后黑
 * 的闪烁无 CSS 解，自绘即根治。深色主题、点击外部关闭、Escape 关闭。
 */
export default function Dropdown(props: Props) {
  const { value, options, onChange, testId, invalid, title, triggerLabel, alwaysRenderMenu } = props;
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // 展开方向：下方空间不足且上方更充裕时向上弹（T-164 R10：左栏底部"从模板新建"
  // 向下弹会溢出视口底，把页面撑出滚动条、把窗口控制钮划出可视区）
  const toggle = () => {
    if (!open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const estimated = Math.min(272, options.length * 30 + 16);
      setUp(spaceBelow < estimated && rect.top > spaceBelow);
    }
    setOpen((prev) => !prev);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
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
      {open || alwaysRenderMenu ? (
        <div className={`dd-menu${up ? " up" : ""}`} role="listbox" style={{ visibility: open ? "visible" : "hidden" }}>
          {options.map((option) => (
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
          {showFallback ? (
            <button type="button" className="dd-option selected" data-value={value} disabled>
              {value}（不在选项内）
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
