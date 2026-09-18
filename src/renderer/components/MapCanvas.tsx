import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../api";
import type { Entity, JsonValue } from "../types";
import type { ToolState } from "../map-edit-ops";

// 地图画布（T-164 R7 预览 / R8 直编 / R9 视口化 / R10 性能与健壮性）。
// —— 渲染管线（R10 修黑屏事故的 GPU 风暴嫌疑）：静态层（地形/网格/建筑/出生点/box 逐格
//    图标）绘入离屏 canvas，仅随 doc/视口/尺寸重建；每帧合成 = drawImage + 悬停/拖拽
//    动态层。悬停仅在同格变化时 setState（去抖鼠标移动风暴）。
// —— 健壮性：宽高取整；补丁循环钳制到图界并跳过非有限值（字段树误输入巨值不再死循环）。
// —— 视口（R9）：滚轮缩放（光标锚定）、中键拖动或「预览」工具左键拖动平移、重置视图。
// —— 表现对齐 godot：格子常显；box_mode 逐格四角括号（建造红）+中心 X（通行色）。
// —— 编辑（R8）：地形/擦除/box=拖矩形；建筑/树/出生点/删除=点击。回调上抛改 doc。

const TERRAIN_COLORS: Record<number, string> = {
  0: "#3f6b3a", // 可通行（草地基调）
  1: "#6f7480", // 阻挡（墙）
  2: "#5a4632", // 山体（禁所有）
  3: "#2f5f8f", // 水面（禁地面）
  4: "#9c7b33", // 可通行禁建（L2 黄格语义）
};
const FRAME_NO_BUILD = "#e5484d";
const ACCESS_COLORS: Record<number, string | null> = {
  0: null,
  1: "#e5b567",
  2: "#3e9be8",
  3: "#e5484d",
};
const TEAM_COLORS: Record<number, string> = { 0: "#8d8d96", 1: "#5abfef", 2: "#ff7359", 3: "#8ee06e", 4: "#f2d35c" };

interface Props {
  doc: Entity | null;
  tool: ToolState;
  onTerrainRect?(rect: { x: number; y: number; w: number; h: number }): void;
  onBoxAdd?(x0: number, y0: number, x1: number, y1: number): void;
  onPlaceAt?(x: number, y: number): void;
  onDeleteAt?(x: number, y: number): void;
  /** 右键命中建筑/出生点（R20 调参菜单，仅预览态）：命中类型+索引+格与屏幕坐标 */
  onEntityContext?(hit: { kind: "building" | "spawn"; index: number; cell: { x: number; y: number } }, screen: { x: number; y: number }): void;
  /** 右键取消当前工具回预览（R16 用户裁定：右键≠左键效果） */
  onToolCancel?(): void;
  /** 右侧竖向快捷栏宿主（R19：与画布等高、z 低于 JSON 抽屉被其覆盖） */
  overlayBar?: ReactNode;
  /** R22：当前选中对象（建筑/出生点），静态层高亮 */
  selected?: { kind: "building" | "spawn"; index: number } | null;
  /** R22：预览模式点按已放置对象 → 选中（面板负责切换对应模式） */
  onSelectObject?(sel: { kind: "building" | "spawn"; index: number } | null): void;
  /** R28：拖动移动对象松手（建筑/出生点给新锚点；补丁/box 给位移 delta；decor 给新格） */
  onMoveObject?(kind: "building" | "spawn" | "patch" | "box" | "decor", index: number, x: number, y: number): void;
}

interface HoverInfo {
  x: number;
  y: number;
  terrain: number;
}

interface Viewport {
  ox: number;
  oy: number;
  zoom: number;
}

type DragState = { x0: number; y0: number; x1: number; y1: number } | null;

const DRAG_TOOLS = new Set(["terrain", "erase", "box"]);
const CLICK_TOOLS = new Set(["building", "tree", "spawn", "delete"]);
const MOVE_UNIT_TOOLS = new Set(["move-unit", "none"]); // R28：预览点击选中也不自动切（防幽灵误触）
const MOVE_TOOLS = new Set(["move-unit", "move-shape", "move-render"]);

function clampView(value: number, dim: number, visible: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-8, Math.min(dim + 8 - Math.max(1, visible), value));
}

export default function MapCanvas({ doc, tool, onTerrainRect, onBoxAdd, onPlaceAt, onDeleteAt, onEntityContext, onToolCancel, overlayBar, selected, onSelectObject, onMoveObject }: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const offscreenRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({ w: 560, h: 480 });
  const [viewport, setViewport] = useState<Viewport>({ ox: 0, oy: 0, zoom: 1 });
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [staticTick, setStaticTick] = useState(0);
  const dragRef = useRef<DragState>(null);
  const [dragPreview, setDragPreview] = useState<DragState>(null);
  // R22 对象拖动：抓取偏移保留（grabDX/Y = 按下格 - 对象锚点），目标锚点 = 当前格 - 偏移
  const objectDragRef = useRef<{ kind: "building" | "spawn" | "patch" | "box" | "decor"; index: number; grabDX: number; grabDY: number; x: number; y: number; w: number; h: number } | null>(null);
  const [objectGhost, setObjectGhost] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const panRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  const mapW = typeof doc?.width === "number" && Number.isFinite(doc.width) && doc.width >= 1 ? Math.floor(Math.min(doc.width, 512)) : 0;
  const mapH = typeof doc?.height === "number" && Number.isFinite(doc.height) && doc.height >= 1 ? Math.floor(Math.min(doc.height, 512)) : 0;
  const baseCell = useMemo(
    () => (mapW > 0 && mapH > 0 ? Math.max(4, Math.min(16, Math.floor(480 / Math.max(mapW, mapH)))) : 8),
    [mapW, mapH],
  );
  const ppc = Math.max(3, Math.min(96, baseCell * (Number.isFinite(viewport.zoom) ? viewport.zoom : 1)));

  // —— R19：box_mode 与游戏同款标志——读游戏侧 box-type.svg（currentColor=框/currentColor2=X），
  // 按 (build,access) 组合替换双色后转位图缓存；加载失败回退程序绘制的四角括号+X。
  const ICON_FRAME = "#E5484D";
  const ICON_ACCESS: Record<number, string | null> = { 0: null, 1: "#E5B567", 2: "#3E9BE8", 3: "#E5484D" };
  const iconCacheRef = useRef<Record<string, HTMLImageElement>>({});
  const [iconTick, setIconTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    api
      .readIcon("box-type")
      .then((result) => {
        if (cancelled || !result.ok || typeof result.text !== "string") return;
        const combos: Array<[string, string | null, string | null]> = [];
        for (const build of [1, 0]) {
          for (const access of [0, 1, 2, 3]) {
            if (build === 0 && access === 0) continue; // 无可见部件
            combos.push([`b${build}a${access}`, build === 1 ? ICON_FRAME : null, ICON_ACCESS[access]]);
          }
        }
        let pending = combos.length;
        const done = () => {
          pending -= 1;
          if (pending === 0) setIconTick((tick) => tick + 1);
        };
        for (const [key, frame, xColor] of combos) {
          let svg = result.text as string;
          svg = svg.replace(/fill="currentColor"/g, frame ? `fill="${frame}"` : 'fill="none"');
          svg = svg.replace(/fill="currentColor2"/g, xColor ? `fill="${xColor}"` : 'fill="none"');
          const img = new Image();
          img.onload = done;
          img.onerror = done;
          img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
          iconCacheRef.current[key] = img;
        }
      })
      .catch(() => {
        /* 图标不可用：保持程序绘制回退 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 容器尺寸自适应（R21 修早退：doc 无效期组件提前 return empty、viewport 未渲染，
  // effect[] 首跑时 wrapRef 为 null 直接返回——observer 从未挂上，canvas 永远停在
  // 560×480 初始兜底尺寸，即"画布框太小"根因。改为随 canvasReady 重挂。）
  const canvasReady = doc != null && mapW > 0 && mapH > 0;
  useEffect(() => {
    if (!canvasReady) return;
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 40 && rect.height > 40) setSize({ w: Math.floor(rect.width), h: Math.floor(rect.height) });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [canvasReady]);

  const terrainAt = useMemo(() => {
    const grid = new Int8Array(Math.max(0, mapW * mapH));
    if (doc && mapW > 0 && mapH > 0) {
      grid.fill(typeof doc.default_terrain === "number" ? doc.default_terrain : 0);
      const patches = Array.isArray(doc.terrain_patches) ? doc.terrain_patches : [];
      for (const patch of patches) {
        if (patch === null || typeof patch !== "object") continue;
        const p = patch as Record<string, JsonValue>;
        const x = Number(p.x);
        const y = Number(p.y);
        const w = Number(p.w);
        const h = Number(p.h);
        const t = Number(p.terrain ?? 0);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) continue;
        // 循环钳制到图界：字段树误输入巨值（如 1e9）不再拖死渲染线程
        const x0 = Math.max(0, Math.floor(x));
        const y0 = Math.max(0, Math.floor(y));
        const x1 = Math.min(mapW, Math.ceil(x + w));
        const y1 = Math.min(mapH, Math.ceil(y + h));
        for (let yy = y0; yy < y1; yy++) {
          for (let xx = x0; xx < x1; xx++) {
            grid[yy * mapW + xx] = t;
          }
        }
      }
    }
    return grid;
  }, [doc, mapW, mapH]);

  // —— 静态层：地形/网格/边框/decor/建筑/出生点/box 逐格图标 → 离屏 canvas ——
  const rebuildStatic = useCallback(() => {
    if (mapW === 0 || mapH === 0) return;
    if (offscreenRef.current === null) offscreenRef.current = document.createElement("canvas");
    const off = offscreenRef.current;
    off.width = size.w;
    off.height = size.h;
    const ctx = off.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#14171d";
    ctx.fillRect(0, 0, size.w, size.h);

    const sx = (cx: number) => (cx - viewport.ox) * ppc;
    const sy = (cy: number) => (cy - viewport.oy) * ppc;
    const cx0 = Math.max(0, Math.floor(viewport.ox));
    const cy0 = Math.max(0, Math.floor(viewport.oy));
    const cx1 = Math.min(mapW - 1, Math.ceil(viewport.ox + size.w / ppc));
    const cy1 = Math.min(mapH - 1, Math.ceil(viewport.oy + size.h / ppc));

    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        ctx.fillStyle = TERRAIN_COLORS[terrainAt[cy * mapW + cx]] ?? "#c0392b";
        ctx.fillRect(Math.floor(sx(cx)), Math.floor(sy(cy)), Math.ceil(ppc) + 1, Math.ceil(ppc) + 1);
      }
    }
    const minor = ppc >= 5;
    for (let cx = cx0; cx <= cx1 + 1; cx++) {
      const major = cx % 8 === 0;
      if (!minor && !major) continue;
      ctx.strokeStyle = major ? "rgba(0,0,0,0.4)" : "rgba(0,0,0,0.16)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.floor(sx(cx)) + 0.5, Math.max(0, sy(0)));
      ctx.lineTo(Math.floor(sx(cx)) + 0.5, Math.min(size.h, sy(mapH)));
      ctx.stroke();
    }
    for (let cy = cy0; cy <= cy1 + 1; cy++) {
      const major = cy % 8 === 0;
      if (!minor && !major) continue;
      ctx.strokeStyle = major ? "rgba(0,0,0,0.4)" : "rgba(0,0,0,0.16)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.max(0, sx(0)), Math.floor(sy(cy)) + 0.5);
      ctx.lineTo(Math.min(size.w, sx(mapW)), Math.floor(sy(cy)) + 0.5);
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(sx(0), sy(0), mapW * ppc, mapH * ppc);
    // R22：选中对象高亮（建筑=加粗光圈描边；出生点=光圈菱形）
    if (selected && doc) {
      ctx.save();
      ctx.strokeStyle = "#5aabff";
      ctx.lineWidth = Math.max(2, ppc * 0.09);
      if (selected.kind === "building" && Array.isArray(doc.buildings)) {
        const raw = (doc.buildings as Array<Record<string, JsonValue>>)[selected.index];
        if (raw && typeof raw === "object") {
          const bx = Number(raw.x);
          const by = Number(raw.y);
          const bw = Math.max(1, Number(raw.w ?? 1));
          const bh = Math.max(1, Number(raw.h ?? 1));
          ctx.strokeRect(sx(bx) - 2, sy(by) - 2, bw * ppc + 4, bh * ppc + 4);
        }
      } else if (selected.kind === "spawn" && Array.isArray(doc.spawns)) {
        const raw = (doc.spawns as Array<Record<string, JsonValue>>)[selected.index];
        if (raw && typeof raw === "object") {
          const px2 = sx(Number(raw.x) + 0.5);
          const py2 = sy(Number(raw.y) + 0.5);
          const r = Math.max(5, ppc * 0.62);
          ctx.beginPath();
          ctx.moveTo(px2, py2 - r);
          ctx.lineTo(px2 + r, py2);
          ctx.lineTo(px2, py2 + r);
          ctx.lineTo(px2 - r, py2);
          ctx.closePath();
          ctx.stroke();
        }
      }
      ctx.restore();
    }

    if (doc && Array.isArray(doc.decor)) {
      ctx.fillStyle = "#1f5c25";
      for (const entry of doc.decor) {
        if (entry === null || typeof entry !== "object") continue;
        const d = entry as Record<string, JsonValue>;
        const x = Number(d.x);
        const y = Number(d.y);
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < cx0 - 1 || x > cx1 + 1 || y < cy0 - 1 || y > cy1 + 1) continue;
        ctx.beginPath();
        ctx.arc(sx(x + 0.5), sy(y + 0.5), ppc * 0.32, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (doc && Array.isArray(doc.buildings)) {
      ctx.font = `bold ${Math.max(8, ppc - 2)}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (const entry of doc.buildings) {
        if (entry === null || typeof entry !== "object") continue;
        const b = entry as Record<string, JsonValue>;
        const x = Number(b.x);
        const y = Number(b.y);
        const w = Number(b.w);
        const h = Number(b.h);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) continue;
        if (x > cx1 + 1 || y > cy1 + 1 || x + w < cx0 - 1 || y + h < cy0 - 1) continue;
        const team = Number(b.team ?? 0);
        const color = TEAM_COLORS[team] ?? "#c9c9d4";
        ctx.fillStyle = `${color}55`;
        ctx.fillRect(sx(x), sy(y), w * ppc, h * ppc);
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(1, ppc * 0.06);
        ctx.strokeRect(sx(x) + 0.75, sy(y) + 0.75, w * ppc - 1.5, h * ppc - 1.5);
        if (ppc >= 12) {
          const key = typeof b.key === "string" ? b.key.slice(0, 2) : "?";
          ctx.fillStyle = "#ffffff";
          ctx.fillText(key, sx(x + w / 2), sy(y + h / 2));
        }
      }
    }
    const spawnLists: Array<[Array<unknown>, string]> = [];
    if (doc && Array.isArray(doc.spawns)) spawnLists.push([doc.spawns as Array<unknown>, "#ffffff"]);
    if (doc && doc.init !== null && typeof doc.init === "object" && Array.isArray((doc.init as Entity).spawns)) {
      spawnLists.push([(doc.init as Entity).spawns as Array<unknown>, "#ffe9a8"]);
    }
    for (const [list, color] of spawnLists) {
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1, ppc * 0.06);
      for (const entry of list) {
        if (entry === null || typeof entry !== "object") continue;
        const s = entry as Record<string, JsonValue>;
        const x = Number(s.x);
        const y = Number(s.y);
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= mapW || y >= mapH) continue;
        const px = sx(x + 0.5);
        const py = sy(y + 0.5);
        const r = Math.max(3, ppc * 0.4);
        ctx.beginPath();
        ctx.moveTo(px, py - r);
        ctx.lineTo(px + r, py);
        ctx.lineTo(px, py + r);
        ctx.lineTo(px - r, py);
        ctx.closePath();
        ctx.stroke();
      }
    }
    if (doc && Array.isArray(doc.box_mode)) {
      for (const entry of doc.box_mode) {
        if (entry === null || typeof entry !== "object") continue;
        const b = entry as Record<string, JsonValue>;
        const start = b.start as Record<string, JsonValue> | undefined;
        const end = b.end as Record<string, JsonValue> | undefined;
        if (!start || !end) continue;
        const bx0 = Math.max(0, Math.floor(Number(start.w ?? 0)));
        const by0 = Math.max(0, Math.floor(Number(start.h ?? 0)));
        const bx1 = Math.min(mapW - 1, Math.ceil(Number(end.w ?? bx0)));
        const by1 = Math.min(mapH - 1, Math.ceil(Number(end.h ?? by0)));
        const showFrame = Number(b.build ?? 0) === 1;
        const access = Number(b.access ?? 0);
        const xColor = ACCESS_COLORS[access];
        const inset = ppc * 0.28;
        const arm = ppc * 0.22;
        const lw = Math.max(1, ppc * 0.055);
        for (let cy = by0; cy <= by1; cy++) {
          for (let cx = bx0; cx <= bx1; cx++) {
            if (cx < cx0 || cx > cx1 || cy < cy0 || cy > cy1) continue;
            const left = sx(cx);
            const top = sy(cy);
            const right = left + ppc;
            const bottom = top + ppc;
            const icon = iconCacheRef.current[`b${showFrame ? 1 : 0}a${access}`];
            if (icon && icon.complete && icon.naturalWidth > 0) {
              // 与游戏同款 box-type.svg（双色调色后），整格铺满（游戏顶视角呈方形）
              ctx.drawImage(icon, left, top, ppc, ppc);
              continue;
            }
            if (showFrame) {
              ctx.strokeStyle = FRAME_NO_BUILD;
              ctx.lineWidth = lw;
              ctx.beginPath();
              ctx.moveTo(left + inset + arm, top + inset);
              ctx.lineTo(left + inset, top + inset);
              ctx.lineTo(left + inset, top + inset + arm);
              ctx.moveTo(right - inset - arm, top + inset);
              ctx.lineTo(right - inset, top + inset);
              ctx.lineTo(right - inset, top + inset + arm);
              ctx.moveTo(left + inset + arm, bottom - inset);
              ctx.lineTo(left + inset, bottom - inset);
              ctx.lineTo(left + inset, bottom - inset - arm);
              ctx.moveTo(right - inset - arm, bottom - inset);
              ctx.lineTo(right - inset, bottom - inset);
              ctx.lineTo(right - inset, bottom - inset - arm);
              ctx.stroke();
            }
            if (xColor) {
              ctx.strokeStyle = xColor;
              ctx.lineWidth = lw;
              ctx.beginPath();
              ctx.moveTo(left + inset, top + inset);
              ctx.lineTo(right - inset, bottom - inset);
              ctx.moveTo(right - inset, top + inset);
              ctx.lineTo(left + inset, bottom - inset);
              ctx.stroke();
            }
          }
        }
      }
    }
  }, [doc, mapW, mapH, size, viewport, ppc, terrainAt, iconTick, selected]);

  useEffect(() => {
    rebuildStatic();
    setStaticTick((tick) => tick + 1);
  }, [rebuildStatic]);

  // —— 合成层：静态层位图 + 悬停/拖拽动态层（每次 setState 只做一次 drawImage）——
  useEffect(() => {
    const canvas = canvasRef.current;
    const off = offscreenRef.current;
    if (!canvas || mapW === 0 || mapH === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    if (canvas.width !== size.w || canvas.height !== size.h) {
      canvas.width = size.w;
      canvas.height = size.h;
    }
    ctx.clearRect(0, 0, size.w, size.h);
    if (off) ctx.drawImage(off, 0, 0);
    const sx = (cx: number) => (cx - viewport.ox) * ppc;
    const sy = (cy: number) => (cy - viewport.oy) * ppc;
    if (hover) {
      // 建筑工具：悬停幽灵 = 放置占地（footprintW×H，越界红、可放绿白）
      if (tool.tool === "building") {
        const fw = Math.max(1, Math.floor(tool.footprintW));
        const fh = Math.max(1, Math.floor(tool.footprintH));
        const fits = hover.x + fw <= mapW && hover.y + fh <= mapH;
        ctx.fillStyle = fits ? "rgba(90, 191, 239, 0.25)" : "rgba(229, 72, 77, 0.3)";
        ctx.fillRect(sx(hover.x), sy(hover.y), fw * ppc, fh * ppc);
        ctx.strokeStyle = fits ? "#5abfef" : "#e5484d";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(sx(hover.x) + 0.75, sy(hover.y) + 0.75, fw * ppc - 1.5, fh * ppc - 1.5);
        ctx.fillStyle = "#ffffff";
        ctx.font = "11px sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.fillText(`${fw}×${fh}${fits ? "" : " · 越界"}`, sx(hover.x) + 3, sy(hover.y) + 3);
      } else {
        ctx.strokeStyle = "rgba(255,255,255,0.95)";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(sx(hover.x) + 0.75, sy(hover.y) + 0.75, ppc - 1.5, ppc - 1.5);
      }
    }
    if (objectGhost) {
      // R22：移动幽灵——半透明填充 + 光圈描边（松手生效前预览新位置）
      ctx.fillStyle = "rgba(90, 171, 255, 0.22)";
      ctx.fillRect(sx(objectGhost.x), sy(objectGhost.y), objectGhost.w * ppc, objectGhost.h * ppc);
      ctx.strokeStyle = "#5aabff";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(sx(objectGhost.x) + 1, sy(objectGhost.y) + 1, objectGhost.w * ppc - 2, objectGhost.h * ppc - 2);
      ctx.setLineDash([]);
    }
    if (dragPreview) {
      const left = Math.min(dragPreview.x0, dragPreview.x1);
      const top = Math.min(dragPreview.y0, dragPreview.y1);
      const right = Math.max(dragPreview.x0, dragPreview.x1) + 1;
      const bottom = Math.max(dragPreview.y0, dragPreview.y1) + 1;
      ctx.fillStyle = tool.tool === "box" ? "rgba(229,72,77,0.18)" : "rgba(255,255,255,0.25)";
      ctx.fillRect(sx(left), sy(top), (right - left) * ppc, (bottom - top) * ppc);
      ctx.strokeStyle = tool.tool === "box" ? FRAME_NO_BUILD : "rgba(255,255,255,0.9)";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(sx(left) + 0.75, sy(top) + 0.75, (right - left) * ppc - 1.5, (bottom - top) * ppc - 1.5);
    }
  }, [staticTick, hover, dragPreview, objectGhost, tool, size, mapW, mapH, viewport, ppc]);

  // 滚轮缩放（非被动，锚定光标）
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (mapW === 0 || mapH === 0) return;
      const rect = canvas.getBoundingClientRect();
      const localX = event.clientX - rect.left;
      const localY = event.clientY - rect.top;
      setViewport((prev) => {
        const prevPpc = Math.max(3, Math.min(96, baseCell * (Number.isFinite(prev.zoom) ? prev.zoom : 1)));
        const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
        const nextZoom = Math.max(0.35, Math.min(14, prev.zoom * factor));
        const nextPpc = Math.max(3, Math.min(96, baseCell * nextZoom));
        const cellX = prev.ox + localX / prevPpc;
        const cellY = prev.oy + localY / prevPpc;
        return {
          ox: clampView(cellX - localX / nextPpc, mapW, size.w / nextPpc),
          oy: clampView(cellY - localY / nextPpc, mapH, size.h / nextPpc),
          zoom: nextZoom,
        };
      });
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [mapW, mapH, baseCell, size]);

  if (!doc || mapW === 0 || mapH === 0) {
    return <div className="map-canvas empty">（缺 width/height，无法预览）</div>;
  }

  const localCell = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor(viewport.ox + (clientX - rect.left) / ppc);
    const y = Math.floor(viewport.oy + (clientY - rect.top) / ppc);
    if (x >= 0 && y >= 0 && x < mapW && y < mapH) return { x, y };
    return null;
  };

  /** 原始格坐标（不钳界，R17：拖拽超界跟随光标，落点在 endInteraction 钳制） */
  const rawCell = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor(viewport.ox + (clientX - rect.left) / ppc);
    const y = Math.floor(viewport.oy + (clientY - rect.top) / ppc);
    if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
    return null;
  };

  /** R28：格命中可移动对象（按子模式决定类别优先级） */
  const hitMovable = (cell: { x: number; y: number }): { kind: "building" | "spawn" | "patch" | "box" | "decor"; index: number; x: number; y: number; w: number; h: number } | null => {
    if (!doc) return null;
    if (tool.tool === "move-shape") {
      // 地形模式：先补丁后 box（补丁在上层绘制）
      if (Array.isArray(doc.terrain_patches)) {
        for (let i = (doc.terrain_patches as Array<Record<string, JsonValue>>).length - 1; i >= 0; i -= 1) {
          const raw = (doc.terrain_patches as Array<Record<string, JsonValue>>)[i];
          if (!raw || typeof raw !== "object") continue;
          const x = Number(raw.x);
          const y = Number(raw.y);
          const w = Math.max(1, Number(raw.w ?? 1));
          const h = Math.max(1, Number(raw.h ?? 1));
          if (cell.x >= x && cell.y >= y && cell.x < x + w && cell.y < y + h) {
            return { kind: "patch", index: i, x, y, w, h };
          }
        }
      }
      if (Array.isArray(doc.box_mode)) {
        for (let i = (doc.box_mode as Array<Record<string, JsonValue>>).length - 1; i >= 0; i -= 1) {
          const raw = (doc.box_mode as Array<Record<string, JsonValue>>)[i];
          if (!raw || typeof raw !== "object") continue;
          const st = raw.start as Record<string, JsonValue> | undefined;
          const en = raw.end as Record<string, JsonValue> | undefined;
          if (!st || !en) continue;
          const x = Number(st.w ?? 0);
          const y = Number(st.h ?? 0);
          const w = Number(en.w ?? x) - x + 1;
          const h = Number(en.h ?? y) - y + 1;
          if (cell.x >= x && cell.y >= y && cell.x < x + w && cell.y < y + h) {
            return { kind: "box", index: i, x, y, w, h };
          }
        }
      }
      return null;
    }
    if (tool.tool === "move-render") {
      if (Array.isArray(doc.decor)) {
        for (let i = (doc.decor as Array<Record<string, JsonValue>>).length - 1; i >= 0; i -= 1) {
          const raw = (doc.decor as Array<Record<string, JsonValue>>)[i];
          if (!raw || typeof raw !== "object") continue;
          if (Number(raw.x) === cell.x && Number(raw.y) === cell.y) {
            return { kind: "decor", index: i, x: cell.x, y: cell.y, w: 1, h: 1 };
          }
        }
      }
      return null;
    }
    // move-unit / none：建筑 → 出生点
    return hitObject(cell);
  };

  /** R22：格命中已放置对象（建筑优先于出生点），返回 kind/index/锚点/尺寸 */
  const hitObject = (cell: { x: number; y: number }): { kind: "building" | "spawn"; index: number; x: number; y: number; w: number; h: number } | null => {
    if (!doc) return null;
    if (Array.isArray(doc.buildings)) {
      for (let i = doc.buildings.length - 1; i >= 0; i -= 1) {
        const raw = doc.buildings[i];
        if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
        const b = raw as Record<string, JsonValue>;
        const x = Number(b.x);
        const y = Number(b.y);
        const w = Math.max(1, Number(b.w ?? 1));
        const h = Math.max(1, Number(b.h ?? 1));
        if (Number.isFinite(x) && Number.isFinite(y) && cell.x >= x && cell.y >= y && cell.x < x + w && cell.y < y + h) {
          return { kind: "building", index: i, x, y, w, h };
        }
      }
    }
    if (Array.isArray(doc.spawns)) {
      for (let i = doc.spawns.length - 1; i >= 0; i -= 1) {
        const raw = doc.spawns[i];
        if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
        const sp = raw as Record<string, JsonValue>;
        if (Number(sp.x) === cell.x && Number(sp.y) === cell.y) {
          return { kind: "spawn", index: i, x: cell.x, y: cell.y, w: 1, h: 1 };
        }
      }
    }
    return null;
  };

  /** R22：开始对象拖动（抓取偏移保留） */
  const beginObjectDrag = (hit: { kind: "building" | "spawn" | "patch" | "box" | "decor"; index: number; x: number; y: number; w: number; h: number }, cell: { x: number; y: number }) => {
    objectDragRef.current = { kind: hit.kind, index: hit.index, grabDX: cell.x - hit.x, grabDY: cell.y - hit.y, x: hit.x, y: hit.y, w: hit.w, h: hit.h };
    setObjectGhost({ x: hit.x, y: hit.y, w: hit.w, h: hit.h });
  };

  const onDown = (event: React.MouseEvent<HTMLCanvasElement>) => {
    // 指针捕获（R11）：拖刷/平移期间事件钉在画布上——鼠标冲出画布边缘松手不再
    // 静默丢弃编辑（此前 mouseup 落在画布外时拖刷不生效，手感即"笔刷切了没用"）
    try {
      const pid = (event.nativeEvent as PointerEvent).pointerId;
      if (pid !== undefined && event.currentTarget.hasPointerCapture?.(pid) === false) {
        event.currentTarget.setPointerCapture(pid);
      }
    } catch {
      /* 指针捕获不可用时退化为画布内生效 */
    }
    // R28：移动模式三子类——按下可移动对象开始拖动；预览(none)点击只选中**不切工具**
    // 不进入对象拖动（防"切到建筑模式+幽灵跟随"误触，移动须显式切移动模式）
    if (event.button === 0 && MOVE_TOOLS.has(tool.tool)) {
      const cell = localCell(event.clientX, event.clientY);
      const hit = cell ? hitMovable(cell) : null;
      if (hit && cell) {
        onSelectObject?.(hit.kind === "building" || hit.kind === "spawn" ? { kind: hit.kind, index: hit.index } : null);
        beginObjectDrag(hit, cell);
        event.preventDefault();
        return;
      }
    }
    if (event.button === 0 && tool.tool === "none") {
      const cell = localCell(event.clientX, event.clientY);
      const hit = cell ? hitObject(cell) : null;
      if (hit && cell) {
        onSelectObject?.({ kind: hit.kind, index: hit.index });
        // R28 裁定：预览点击仅选中+高亮，不再切 building/spawn 也不进拖动
        event.preventDefault();
        return;
      }
    }
    if (event.button === 1 || (event.button === 0 && tool.tool === "none")) {
      panRef.current = { x: event.clientX, y: event.clientY, ox: viewport.ox, oy: viewport.oy };
      event.preventDefault();
      return;
    }
    if (event.button !== 0) return;
    if (!DRAG_TOOLS.has(tool.tool)) return;
    const cell2 = localCell(event.clientX, event.clientY);
    if (!cell2) return;
    dragRef.current = { x0: cell2.x, y0: cell2.y, x1: cell2.x, y1: cell2.y };
    setDragPreview(dragRef.current);
  };

  const onMove = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (panRef.current) {
      // 原点先拷局部：setState 更新器必须纯——批处理下其执行可能晚于 mouseup（panRef
      // 已置空），在更新器里读 ref 即 "Cannot read properties of null (reading 'ox')"
      const pan = panRef.current;
      const dx = (event.clientX - pan.x) / ppc;
      const dy = (event.clientY - pan.y) / ppc;
      setViewport((prev) => ({
        ...prev,
        ox: clampView(pan.ox - dx, mapW, size.w / ppc),
        oy: clampView(pan.oy - dy, mapH, size.h / ppc),
      }));
      return;
    }
    const cell = localCell(event.clientX, event.clientY);
    // R22：对象移动拖动——目标锚点 = 原始格 - 抓取偏移，钳制到图界（越界红幽灵）
    if (objectDragRef.current) {
      const raw0 = rawCell(event.clientX, event.clientY);
      if (raw0) {
        const drag = objectDragRef.current;
        const tx = Math.max(0, Math.min(mapW - drag.w, raw0.x - drag.grabDX));
        const ty = Math.max(0, Math.min(mapH - drag.h, raw0.y - drag.grabDY));
        if (drag.x !== tx || drag.y !== ty) {
          objectDragRef.current = { ...drag, x: tx, y: ty };
          setObjectGhost({ x: tx, y: ty, w: drag.w, h: drag.h });
        }
      }
      return;
    }
    // R17：拖拽中即使光标已出地图，选框仍跟随（原始坐标），不再冻结/消失在边缘
    const raw = rawCell(event.clientX, event.clientY);
    if (dragRef.current && raw) {
      if (dragRef.current.x1 !== raw.x || dragRef.current.y1 !== raw.y) {
        dragRef.current = { ...dragRef.current, x1: raw.x, y1: raw.y };
        setDragPreview(dragRef.current);
      }
    }
    if (cell) {
      const terrain = terrainAt[cell.y * mapW + cell.x];
      // 同格去抖：格内移动不重绘；但地形变化（笔刷刷到脚下）须刷新读数
      if (!hover || hover.x !== cell.x || hover.y !== cell.y || hover.terrain !== terrain) {
        setHover({ x: cell.x, y: cell.y, terrain });
      }
    } else {
      setHover(null);
    }
  };

  const endInteraction = (event: React.MouseEvent<HTMLCanvasElement>) => {
    // 仅左键结算（R16 修：此前任何键位的 mouseup 都会触发放置/删除——右键/中键误触）；
    // 中键平移的收尾只清引用
    if (event.button !== 0) {
      panRef.current = null;
      return;
    }
    if (panRef.current) {
      panRef.current = null;
      return;
    }
    if (objectDragRef.current) {
      const drag = objectDragRef.current;
      objectDragRef.current = null;
      setObjectGhost(null);
      onMoveObject?.(drag.kind, drag.index, drag.x, drag.y);
      return;
    }
    const cell = localCell(event.clientX, event.clientY);
    if (DRAG_TOOLS.has(tool.tool)) {
      const drag = dragRef.current;
      dragRef.current = null;
      setDragPreview(null);
      if (!drag) return;
      // 松手点出图时以最后跟随格收尾（指针捕获下画布外释放同样生效），并钳制到图界
      const clampCell = (v: number, max: number) => Math.max(0, Math.min(max, Math.round(v)));
      const endX = clampCell(cell ? cell.x : drag.x1, mapW - 1);
      const endY = clampCell(cell ? cell.y : drag.y1, mapH - 1);
      const x = Math.min(drag.x0, endX);
      const y = Math.min(drag.y0, endY);
      const w = Math.abs(endX - drag.x0) + 1;
      const h = Math.abs(endY - drag.y0) + 1;
      if (tool.tool === "box") onBoxAdd?.(x, y, x + w - 1, y + h - 1);
      else onTerrainRect?.({ x, y, w, h });
      return;
    }
    if (!cell) return;
    if (CLICK_TOOLS.has(tool.tool)) {
      if (tool.tool === "delete") onDeleteAt?.(cell.x, cell.y);
      else onPlaceAt?.(cell.x, cell.y);
    }
  };

  const editable = tool.tool !== "none";

  return (
    <div className="map-canvas-wrap" data-testid="map-canvas">
      <div className="map-canvas-viewport" ref={wrapRef}>
        {overlayBar ? <div className="map-quickbar">{overlayBar}</div> : null}
        <canvas
          ref={canvasRef}
          className={`map-canvas${editable ? " editing" : ""}`}
          style={{ width: size.w, height: size.h }}
          data-zoom={viewport.zoom.toFixed(2)}
          data-ox={viewport.ox.toFixed(2)}
          data-oy={viewport.oy.toFixed(2)}
          data-ppc={ppc.toFixed(2)}
          onMouseMove={onMove}
          onMouseLeave={() => {
            setHover(null);
            dragRef.current = null;
            setDragPreview(null);
            panRef.current = null;
            objectDragRef.current = null;
            setObjectGhost(null);
          }}
          onMouseDown={onDown}
          onMouseUp={endInteraction}
          onContextMenu={(event) => {
            event.preventDefault();
            // R16 用户裁定：右键≠左键——工具激活时右键=放弃当前工具回预览光标；
            // 预览态右键命中建筑/出生点 → 调参菜单（R20 扩展到单位出生点）
            if (tool.tool !== "none") {
              dragRef.current = null;
              setDragPreview(null);
              onToolCancel?.();
              return;
            }
            if (!onEntityContext) return;
            const cell = localCell(event.clientX, event.clientY);
            if (!cell || !doc) return;
            if (Array.isArray(doc.buildings)) {
              for (let i = doc.buildings.length - 1; i >= 0; i -= 1) {
                const raw = doc.buildings[i];
                if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
                const b = raw as Record<string, JsonValue>;
                const x = Number(b.x);
                const y = Number(b.y);
                const w = Number(b.w);
                const h = Number(b.h);
                if (
                  Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(w) && Number.isFinite(h) &&
                  cell.x >= x && cell.y >= y && cell.x < x + w && cell.y < y + h
                ) {
                  onEntityContext({ kind: "building", index: i, cell }, { x: event.clientX, y: event.clientY });
                  return;
                }
              }
            }
            if (Array.isArray(doc.spawns)) {
              for (let i = doc.spawns.length - 1; i >= 0; i -= 1) {
                const raw = doc.spawns[i];
                if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
                const sp = raw as Record<string, JsonValue>;
                if (Number(sp.x) === cell.x && Number(sp.y) === cell.y) {
                  onEntityContext({ kind: "spawn", index: i, cell }, { x: event.clientX, y: event.clientY });
                  return;
                }
              }
            }
          }}
        />
      </div>
      <div className="map-canvas-legend">
        {[0, 1, 2, 3, 4].map((code) => (
          <span key={code} className="legend-item">
            <span className="legend-swatch" style={{ background: TERRAIN_COLORS[code] }} />
            {code}
          </span>
        ))}
        <span className="legend-item">┃ 括号=禁建 · X=通行（逐格，与游戏 L2 一致）· 方块=建筑 · ◇=出生点</span>
        {hover ? (
          <span className="legend-item" data-testid="map-hover">
            ({hover.x},{hover.y}) 地形 {hover.terrain}
          </span>
        ) : null}
        <button
          className="btn slim"
          data-testid="map-view-reset"
          title="重置视图（缩放 100%、回到原点）"
          onClick={() => setViewport({ ox: 0, oy: 0, zoom: 1 })}
        >
          重置视图
        </button>
      </div>
    </div>
  );
}
