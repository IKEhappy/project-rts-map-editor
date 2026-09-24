# map-editor —— WarOfState-Remake / them-pixel-front 外置数据工具

T-164（2026-09-14 立项）。**JSON 编辑不进游戏内**，本工具用 Electron 开发，方便 AI 在
CDP（内置 Chromium）里做 DOM 级调试与验证。R2 范围：`units.json` / `buildings.json` /
`rules.json` **主从布局 + 字段树**编辑（嵌套数组/对象逐项增删排序）、`labels.json` 字段/枚举
中文化（显示层）。**R7（2026-09-17）地图编辑上线**：dev-2d（project-rts）`data/maps/*.json`
多文件编辑 + 2D 画布预览 + 真实构建链路门禁，详见下文「地图编辑（R7）」。campaign 表单、
effective/impact 视图为 R8+。

## 地图编辑（R7，2026-09-17）

- **数据源**：`project-rts/data/maps/*.json`（env `ME_MAPS_DIR` 可覆盖；`ME_MAP_PROJECT`
  默认 `project-rts`）。工具默认工程按存在性解析：姊妹检出 `war-of-state` 优先（打包/旧
  布局），否则本工作区 `project-rts`（dev-2d）——数据与校验权威同源。
- **编辑面**：左地图列表（含「＋ 新建地图」最小合法骨架模板）· 中字段树（复用嵌套
  增删排序；地形码 0..4 / box_mode access 0..3 / build 0..1 枚举下拉中文化）·
  右画布预览（地形着色 + terrain_patches + **box_mode 范围叠加——框=建造红/X=通行色，
  与游戏 L2 控制层同语义同配色** + 建筑队伍色 + 出生点 + decor；悬停显示格坐标与地形码）。
- **门禁（权威=游戏真实链路）**：`gate/map_gate.gd` 以 `--path project-rts` 运行，候选经
  `Campaign.build_level`（GameMap.from_dict → MatchConfig.layer → SimCore 装配 → 出生/AI）
  + `SimCore` 快照 save/load 往返（snapshot_validation 全量：地形码 0..4 等）+ 空 step 冒烟；
  零独立校验语义，游戏侧拒了就是拒了（实测：地形码 9 / width=0 / 缩图压建筑出界均拒）。
- **写入纪律与三表一致**：哈希守卫（外部改动冲突拒写）→ 无改动不写盘 → 先过门禁 →
  单代 `.bak` → 临时文件原子改名；新图按文档 `name` 字段落盘（重名拒建）。地图删除
  不支持（campaign 关卡引用完整性无法校验，与实体删除同口径）。
- **切换视角不丢编辑**：地图面板常驻挂载，选项卡往返保留工作副本；关闭窗口的保存
  询问覆盖地图脏计数。
- **R8（2026-09-17）画布直编——与字段树双向并存**：画布工具栏「预览 / 地形笔刷 /
  擦除地形 / 画 box 范围 / 放建筑 / 放树 / 放出生点 / 删除」。地形与 box 为**拖矩形**
  （松手整块生效，画布内实时预览拖拽框）；建筑（占位 w×h 取建筑表、队伍可选）/
  树 / 出生点（单位 id 下拉 + 队伍 + 数量）为点击放置；删除工具命中链 建筑 → box
  范围 → 树 → 出生点（后放先删）。地形笔刷采用**矩形差分**更新 patches（保留作者
  手写结构不整表重写；刷默认码=擦除只减不加）。画布与字段树共用同一文档状态，
  两侧编辑互相同步；操作层为纯函数（`src/renderer/map-edit-ops.ts`）。
- **R9（2026-09-17）视口化 + 可用性返修**：
  - **画布视口**：滚轮缩放（光标锚定，0.35×..14×）、中键拖动或「预览」工具左键拖动平移
    （带 8 格越界余量钳制）、「重置视图」；画布随容器自适应（ResizeObserver），只绘可见格。
  - **表现对齐 godot**：格子常显（像元 ≥5px 每格次线 + 任何缩放下每 8 格主线——修
    大图"无格子"）；box_mode 改**逐格**四角括号+中心 X（与游戏 L2 控制层 M6-R2 逐格
    box-type 图标同语义同配色，废弃范围大框/对角线画法）。
  - **门禁玩法级补强**（全部以游戏数据/状态判定，防"装载通过但玩法已坏"）：建筑 key
    必须在建筑表（sim 对未知 key 静默跳过——建筑会凭空消失）；建筑足迹禁越界/互相重叠
    （逐格定位报告）；出生点禁落阻挡格 + 装配存活数兜底（SPAWN 对阻挡格静默拒绝）。
  - **撤销/重做全工具**（`src/renderer/history.ts`）：Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z，
    三表与地图全覆盖；画布操作逐步离散、字段树输入 600ms 合并；顶栏与地图工具栏均有
    ↶↷ 按钮。
  - **关闭三选弹窗**：保存并退出（逐张过门禁，被拒留在工具显示原因）/ **不保存退出** /
    继续编辑——替代原二选 confirm。
  - **地图重新加载**：地图工具栏「重新加载」丢弃未保存编辑从磁盘重读（脏则确认）；
    顶栏「重新加载」在地图页路由到同一入口。
  - 键盘收口：Ctrl+S/Z/Y 由 App 全局监听统一路由（修地图面板隐藏时快捷键误触）。
- **R10（2026-09-17）黑屏崩溃排查与自愈**（用户报"编辑一段时间后界面黑了"）：
  - **画布渲染管线重构**：静态层（地形/网格/建筑/出生点/box 逐格图标）绘入离屏 canvas
    仅随 doc/视口重建，每帧合成=一次 drawImage+悬停/拖拽层；悬停同格去抖——消除鼠标
    移动期间整图逐格重绘的 GPU 风暴（黑屏头号嫌疑）。
  - **循环钳制**：补丁/建筑/出生点坐标全部 Number.isFinite 守卫 + 循环钳到图界——字段树
    误输入巨值（如 w=1e9）不再拖死渲染线程；轻校验补 512 上限告警。
  - **撤销历史副作用出更新器**：commit 移出 setState 更新函数（StrictMode 双调/并发渲染
    下副作用入更新器不安全——历史栈可能错序重录）。
  - **崩溃自愈与留证**：主进程监听 `render-process-gone`/`unresponsive`/`gpu-process-crash`
    → 原因写入 `map-editor/.crash.log` 并自动重载页面（硬崩溃丢渲染层内存未保存编辑，
    重载是止血不是恢复）；渲染层加 ErrorBoundary——React 树异常从黑屏变为可见错误栈 +
    重载按钮。
- **R11（2026-09-18）笔刷交互与 box 覆盖语义**：
  - 工具切换探针（`scripts/tool-probe.mjs`，真实鼠标 31 断言）证明切换逻辑本身正常；
    用户报的"无法切换"实感来自**拖刷冲出画布松手被静默丢弃**——已修：画布按下即
    指针捕获（pointer capture），画布外释放以最后经过格收尾，编辑不再丢。
  - **参数热键**：地形笔刷/擦除 = **数字键 0~4 直切地形码**；box 工具 = **数字键 0~3
    切通行维度、B 键切禁建**（输入框/下拉聚焦或 Ctrl/Cmd/Alt 组合时不接管）。
  - **中键平移崩溃修复**：平移 setState 更新器内读 `panRef.current!`——React 批处理下
    更新器可能晚于 mouseup（panRef 已置空）执行，读 null 即 TypeError（有栈日志实证）。
    原点改拷局部量，更新器纯化。
  - **box_mode 覆盖语义（用户裁定）**：新范围刷过已有范围 = **覆盖**——新矩形先从全部
    既有条目矩形差分减去再追加，被刷格归属唯一；与游戏 L2"首个范围优先"取值口径一致
    （旧条目不再声明这些格），编辑器所见即游戏所得。未重叠部分原样保留。
- **R12（2026-09-18）JSON 入口折叠为悬浮抽屉（用户裁定：JSON 属研发入口）**：
  地图主区改**上下结构**——画布铺满整个工作区，字段树（JSON）**默认折叠**；地图区右下
  **悬浮按钮「⌃ JSON」**点开底层抽屉（覆盖地图下半区约 46%，画布不因开合重排/缩放，
  上半区地图保持可见可操作），再点按钮或抽屉头部「收起」即折叠回去。字段树横向铺满
  抽屉全宽——数值列不再被窄栏挤压。普通地图设计全程用画布工具即可，无需碰 JSON。
- **R13（2026-09-18）数值输入即时生效 + 自绘步进（用户报"改了数值实际没改/步进长按很久"）**：
  根因：数字字段只在 **blur/回车** 才提交——点步进按钮只改草稿不落文档，画布自然
  "没同步"。修复：数字可解析即提交（点步进/逐键即时落文档，非法中间态仍等 blur 丢弃）；
  原生 spinner（步进 1、无加速）替换为**自绘 −/+ 按钮**：单击 ±1，按住 400ms 后自动
  重复并加速（间隔 400→50ms），大跨度不必长按苦等；整个工具（三表 + 地图字段树）统一
  生效；按住一串步进经 600ms 合并算**一步撤销**。
- **R14（2026-09-18）占地裁定 + 建筑调参 + 美化**：
  - **放置占地三级解析**（用户裁定表）：buildings.json 已给 w/h（工具内保存后**实时刷新**
    ——现仅莱德风暴/集束炮塔带 1×2）→ **裁定表**（工厂类小2×2/中3×3/大4×4、超级工厂3×3、
    雷达/金矿/风电站2×2、总部4×4、科研中心3×3）→ sim 口径 3×3 回退。放置悬停有占地
    幽灵预览（越界红/可放蓝，标注 w×h）；`addBuilding` 同链解析（单一事实源）。
    注：现有地图条目自带的 w/h 优先于放置默认（渲染/游戏都读条目值）——encounter_big
    的 HQ 为 3×3 属历史数据，新放置按裁定 4×4。
  - **右键建筑调参（per-map，不动 buildings.json）**：右键已放置建筑 → 菜单（队伍 team /
    等级 level / 血量 hp / 定位 JSON 整条目）→ 缺失字段自动按默认创建（level=1、hp 取
    配置表）→ **JSON 抽屉自动展开并滚动+闪烁定位到对应行**。游戏侧同步支持 `hp` 地图级
    覆盖（`_load_buildings_from_map`，中立半血按覆盖后上限；level 为既有），契约已登记
    AI开发方案 §五.3，测试 `tests/sim/test_map_building_override.gd` 7 断言。
  - **美化**：调色板加深提对比、按钮过渡+主按钮渐变、工具组分段控件（激活高亮）、地图
    列表卡片化（激活左侧光条）、画布内嵌光环、图例芯片化、JSON 抽屉顶部强调条、悬浮
    按钮渐变、右键菜单/定位闪烁动画。
- **R15（2026-09-18）新建图改名/保存修复（用户报"无法重命名和保存"）**：基础链路探针
  证实正常，实因两个缺口——①**默认名撞车**：newCounter 每次启动从 1 起，上个会话存过
  new_map_1.json 后新图保存被"已存在"拒；②**中文名被洗成下划线**（文件名白名单仅
  ASCII，中文图名落盘变 `____.json`，观感即"改名没生效"）。修复：默认名防撞（跳过
  磁盘与在编辑副本）；文件名清洗放宽到**保留中文/CJK**（仅剔路径非法字符，与
  safeMapName 同口径）；JSON 抽屉头对新图**实时显示落盘文件名**（随 name 字段变）。
- **R16（2026-09-18）右键语义（用户裁定：右键≠左键）**：修真 bug——`onMouseUp` 不分键位，
  右键/中键的 mouseup 同样触发放置/删除（观感即"右键和左键一样"）。新语义：
  **工具激活时右键=取消当前工具回预览光标**（顺带清拖拽态）；**预览态右键命中建筑
  → R14 调参菜单保留**；mouseup 仅左键结算（中键只收平移）。工具提示已注明。

- **R17（2026-09-18）列表右键菜单 / 一键边界 / 拖拽超界跟随**：
  - **文件列表右键菜单**：重命名…（真·文件改名含 .bak 跟随；已打开副本换键保留编辑态与
    未保存修改；Electron 无 window.prompt，自建重命名模态）/ 打开文件（系统默认程序）/
    打开所在文件夹（shell.openPath）。文件重命名不过 gate（字节不变语义不变）。
  - **画布悬浮快捷条**（用户截图标注位：画布右上角）——快捷动作按钮区，首个为**一键
    设置地图边界**：在当前地图四边边缘放一圈 禁通行(3)+禁建(1) 的
    box_mode——走覆盖语义（既有 box 未重叠部分保留），单步撤销。
  - **拖拽超界跟随（修"拖出地图边缘选框消失/冻结"）**：拖拽中以原始格坐标追踪光标
    （出图仍跟随），松手落点钳制到图界（box 与地形笔刷同规则）。

- **R18（2026-09-18）Ctrl+S 全 tab 语义确认 + 无改动反馈**：Ctrl+S 保存**当前查看的
  选项卡内容**——配置页存当前表、地图页存**当前打开的地图**（R9 路由既有，本轮补
  E2E 锁死 + 修两处：无改动时地图页此前静默无反应 → 现"无改动，未写盘"横幅；句柄
  `save` 未入依赖且声明序在句柄后（TDZ）→ 已修）。

- **R19（2026-09-18）右侧竖向快捷栏 + box_mode 与游戏同款 SVG**：
  - **右侧竖栏**（画布内右缘、与画布等高，z 低于 JSON 抽屉——抽屉展开覆盖其下半段）：
    「▣ 一键地图边界」从悬浮横条移入竖栏；新增「↺ 一键取消编辑」（丢弃当前地图全部
    未保存修改回到上次保存，脏则确认；未落盘新图禁用）。竖栏 pointer-events 穿透、
    按钮自捕获，不挡画布交互。
  - **JSON 悬浮钮图标化**：文字「⌃ JSON」改为 `{ }` 花括号 SVG 图标（圆钮，tooltip
    保留说明）。
  - **box_mode 与游戏完全一致的标志**：经 IPC 读游戏侧 `assets/ui/icons/box-type.svg`
    （`currentColor`=框 / `currentColor2`=X 双色令牌），按 (build,access) 组合替换成色后
    转位图缓存，画布逐格 drawImage 整格铺满——与游戏 L2 控制层同一文件同一配色
    （框 #E5484D、X 黄 #E5B567/蓝 #3E9BE8/红 #E5484D）；图标不可用时回退程序绘制。

- **R20（2026-09-18）五项返修（下拉失效/右键扩展/图例/防重叠/布局改版）**：
  - **下拉框根治**：工具栏全部原生 `<select>`（地形/通行/禁建/建筑/队伍/出生点单位/
    出生点队伍）替换为自绘 `Dropdown`——Windows 原生 select 弹层"先白后黑"闪烁无 CSS
    解（T-164 R9 已证），自绘即根治（也消掉偶发点不开）。
  - **右键调参扩展**：建筑/炮台（原）+ **出生点单位**（新：单位 kind/队伍/数量/定位
    JSON）；**所有弹出菜单左键点外部即关**（capture 级 pointerdown，Element 守卫）。
  - **备注条颜色图例**：画布下方备注追加框色（红=禁建/无框=可建）与 X 色（黄=仅禁
    地面/蓝=仅禁飞碟/红=禁所有单位/无 X=全通行）色块图例。
  - **占位防重叠**：建筑/单位/炮台任意两者不得重合（放置即时拒绝+横幅；触发召唤物
    点位不占位、天然可覆盖）；已有地图的重叠进轻校验警告（建筑×建筑/出生点×建筑/
    出生点重复格）；保存侧门禁维持 R9 硬拒。
  - **布局改版（用户红框标注）**：左侧文件列表改为**画布左上悬浮地图选择器**（弹出
    文件列表+右键重命名/打开），**画布满幅**占据整个主区；右缘竖向快捷钮；底部备注
    条；JSON 抽屉独立层不受影响。

- **R21（2026-09-18）布局返修（用户裁定：列表保持原样；画布铺满列表右侧红框区域）**：
  - 撤销 R20 的"文件列表改悬浮选择器"——**左侧列表列完全恢复原样**（固定左列 + 右键
    菜单），悬浮选择器删除（grill-me 三问确认）。
  - **"画布框太小"根因**：R12 视口化时 ResizeObserver 的 `effect[]` 在地图未加载
    （doc=null 提前 return empty 分支、viewport 未渲染）时已跑过，wrapRef 为 null 直接
    返回——observer 从未挂上，canvas 永远停在 560×480 初始兜底尺寸。修复：observer
    随 `canvasReady` 重挂。实测：画布 1229×679 = 视口满幅（列表右侧、工具栏下、备注
    上）。`scripts/layout-probe.mjs` 为布局量测探针。

- **R22（2026-09-18）预览点选 + 对象移动**：预览模式**点按已放置建筑/出生点 = 选中
  并自动切换到对应模式**（building/spawn 工具与参数下拉就位，选中对象画布高亮光圈）；
  **按住已放置对象拖动 = 移动**（预览或对应模式均可发起）——抓取偏移保留、拖动期间
  虚线幽灵跟随、目标钳制图界；松手校验（越界/与他建筑/出生点占位冲突→横幅拒绝），
  原地松手仅选中不算修改；单步撤销；Esc 取消选中；文档变更后选中索引越界自动清。
  对应模式下点**空格**仍是放置（点已存对象是移动——放置重叠测试相应改从空白格触发）。

- **R23（2026-09-18）下拉搜索**：`Dropdown` 选项**超过 8 项自动在菜单顶部显示搜索框**
  （ autoFocus、按 label/value 忽略大小写过滤、无匹配提示、清空恢复全量；Escape 关菜单
  不冒泡触发取消选中）。建筑（18 项）/出生点单位等大列表直接受益。附探针
  `scripts/dd-probe.mjs`（下拉态样式/坐标转储 + 搜索过滤验证）。
  **R24+R25 下拉尺寸裁定**：触发器 26px 防拉伸 + 工具栏对齐收口（R24）；
  **R25 用户裁定：默认显示 10 项**——`max-height: min(330px, 48vh)`（搜索框 30px +
  10×30px），**超 10 项滚动**，48vh 上限随窗口缩小自适应收缩；展开方向估算同步。
  探针实测：菜单 330px，18 项首屏 ~10 项可滚动，搜索过滤正常。

- **R26（2026-09-18）下拉折叠根治 + A/B 对比 Case 体系（用户裁定）**：
  - **下拉折叠根因**：JSON 抽屉 `.map-json-tree` 的 `overflow:auto` 会裁剪 absolute
    定位的 `dd-menu`——菜单高度被压缩到容器剩余空间（用户截图实证：抽屉内字段树下拉
    被截）。修复：菜单 **`createPortal` 挂到 `document.body`** + fixed 定位按触发器
    rect 实时计算——彻底脱离任何 overflow 祖先，任意嵌套容器内都完整展开。
  - **A/B 对比 Case 体系**：`tests/cases/<case>/` 三文件制——`A.json`（测试基板地图）、
    `B.json`（期望结果）、`ops.json`（操作序列指令集：tool/select/key/clickCell/
    dragCell/rclickCell/menu/save/sleep，全部走真实 UI 事件）。运行器
    `scripts/case-runner.mjs`：沙盒 maps 目录（不碰真实工程配置）→ 起 Electron →
    按 ops 驱动 → 读回磁盘 C → 与 B 深比对（数组/对象递归 diff）。首批 5 例：
    terrain-brush（笔刷矩形落盘）、box-overwrite（覆盖语义三段拆分）、
    building-place-and-move（放置+拖动移动锚点偏移）、spawn-place（队伍参数）、
    undo-redo（Ctrl+Z/Y 往返）。`node scripts/case-runner.mjs` → CASES_OK。

- **R27（2026-09-18）下拉压缩根因终修（用户截图指认工具栏下拉）**：真凶是
  `dd-menu` 为 **flex column 容器**——子项 `.dd-option` 默认 `flex-shrink: 1`，
  18 项在 330px 高度内被**均分压缩到 16px/行**（实测 optH=16、行距 16px、正常 28px），
  视觉即"被压缩折叠"。修复：`.dd-option { flex-shrink: 0; min-height: 28px;
  line-height: 1.45 }`——选项行高锁定，超出滚动。探针实测修复后 optH=28、菜单 330px
  内 ~12 行可见（+搜索框）。此前 R26 修的是 JSON 抽屉内字段树下拉（另一定位问题），
  本次才是工具栏下拉压缩的真根因。

- **R28（2026-09-18）移动模式三子类 + 右键删除（用户裁定）**：
  - **移动模式**（工具栏三个新按钮，替代"预览点击自动切 building/spawn"——该行为会产生
    建筑放置幽灵跟随，易误触，已废除）：**移动·单位**（建筑/炮台/出生点单位，保留占位/
    边界校验拒绝）、**移动·地形**（terrain 补丁与 box 范围整体平移，钳图界；补丁优先于
    box）、**移动·渲染**（decor 树）。预览模式点击对象**仅选中高亮**不再切工具；
    建筑模式下按下已有建筑仍是移动（放置只在空格触发）。
  - **右键菜单删除项**：建筑/出生点调参菜单在"取消"上方新增**删除此建筑/删除此出生点**
    （红色，进撤销历史，选中态自动清）。
  - 冒烟与 A/B Case 同步更新（building-place-and-move 的 ops 加 `move-unit` 步骤）。

- **R29（2026-09-18）下拉选项点击无反应（用户报）**：R26 Portal 到 body 时留了
  outside-close 竞态——`rootRef` 只挂触发器容器，点菜单选项时 mousedown 判定"外部
  点击"→菜单立即关闭卸载→选项 onClick 丢失（程序化 click 有时不触发 mousedown 故
  测试偶尔过，真实鼠标必现）。修复：菜单节点加 `menuRef`，outside-close 判定
  `触发器.contains ∪ 菜单.contains` 都不含目标才关闭。真实鼠标（CDP Input 域）
  复测：点选项 data-value 4→2 生效。

- **R30（2026-09-18）地图级产线编辑（用户裁定：军规——地图配置优先级高于 buildings.json，
  只改地图不动 buildings/units）**：
  - **右键建筑菜单新增「产线 lines」「解锁线数 unlocked_lines」**：点击自动在地图条目
    创建字段（lines=空数组 / unlocked_lines=1）→ JSON 抽屉展开定位。
  - **字段树「＋ 新增字段」能力（补"初始化没给字段不能追加"的坑）**：任意对象节点可
    新增字段——下拉选常用（lines/unlocked_lines/income/research/speed_up/level/hp/team/
    count）或输入自定义键名，创建后即可编辑。
  - **lines 数组「＋ 添加」行**：新建行克隆末行或用默认 `{unit, tier, ticks}` 模板，
    逐线配置 unit/produce_ticks 等；数组元素支持 ↑↓✕ 排序删除。
  - **游戏侧契约确认**（sim 已支持，补测试锚定 `test_map_lines_override.gd` 7 断言）：
    地图条目 `lines`（全量覆盖 def 默认表，0..5 线）与 `unlocked_lines`（覆盖默认 1）
    在 sim 层以更高优先级生效——地图编辑只写地图 JSON，buildings.json/unit 表不受影响。

- **R31（2026-09-24）性能优化 + UI 美化（用户裁定：精炼工具风 + DPR backing store +
  整数档位缩放吸附）**：
  - **画布静态层真正解耦**（头号性能病灶）：旧版 `rebuildStatic` 的 useCallback 直接喂给
    effect 依赖数组，而该回调依赖整份组件闭包——**鼠标每移动一格都重建整张离屏位图**
    （含重设 `width` 触发的位图重分配），是 R10 黑屏事故同族病灶的残留。改为按字段拆开的
    原始值依赖（指针层 state 一律不入列）+ 尺寸未变不重设 backing store。
    **回归读数**：新增画布 `data-static-builds` 计数器，划过画布 100 次从「≈100」降到「0」
    （实测 2→2，那 2 次来自加载与尺寸自适应）。
  - **地形栅格增量维护**（新模块 `src/renderer/terrain-grid.ts`）：旧版每次 doc 变化都
    `new Int8Array(w*h)` + 遍历全部补丁逐格覆写（128×128 图 = 16384 格）。改为缓存 +
    逐条补丁 diff，只重刷变化点及其后的补丁；补丁语义未变则零工作。抽出纯函数并有单测
    保证与全量重建**逐格等价**（含 100 步随机差分）。
  - **整数档位缩放**（新模块 `src/renderer/zoom-ladder.ts`）：旧版 `zoom *= 1.15` 是连续
    缩放，且存在**单调性缺陷**——baseCell 随图尺寸变化（48 宽=10、64 宽=7、96 宽=5），
    同一 zoom 序列在不同图上 ppc 步长不等，baseCell=16 时 zoom 0.35→0.5 会让 ppc 从
    5.6 **升到** 8（缩小反而变大）。改为以「每格 CSS 像素 ppc」为唯一真相、在整数阶梯上
    前后移动一格、zoom 反推；`wheelDirection` 兼容像素/行/页三种 deltaMode 并吸收触控板惯性。
  - **DPR backing store**：画布内部分辨率改为 CSS 尺寸 × `devicePixelRatio`，两条渲染路径
    统一 `ctx.setTransform(dpr,0,0,dpr,0,0)`——现有坐标计算（CSS 像素语义）与命中测试
    **一行未改**，DPR 影响收敛到一处。新增 `data-css-w/h`、`data-dpr` 读数。
  - **探针尺度修正**：`canvas.width` 此后是物理像素，探针原有的 `rect.width / canvas.width`
    缩放推算会静默算错 dpr 倍（实测导致笔刷/box 三类落盘断言全红）。全部改为读 `data-css-w`
    （`smoke.mjs`/`case-runner.mjs`/`drawer-dd-probe.mjs`/`place-probe.mjs` 共 7 处）。
  - **字段树路径写 + 按行 memo**：`update()` 从「整棵实体 `JSON.parse(JSON.stringify())`」
    改为沿路径浅拷贝父容器（结构共享），成本从 O(实体大小) 降到 O(路径深度)；未变更子树
    引用不变，为后续行级 memo 铺路。数组增删/排序仍用整体克隆（有意为之）。
  - **枚举选项记忆化**：`enumOptions` 加按 (labels 身份, field) 的 WeakMap 缓存——每个字段行
    都调它，一次渲染里同一 field 会被问很多次。
  - **样式收口为单一 token 层**：R1 初版与 R14「美化润色」各定义过一块 `:root`，后写静默
    覆盖前写（同一变量两套数值、`.map-json-fab` 三处、`.map-item.active` 两处……），改样式
    「没生效」多半源于此。现合并为唯一 token 源（底色/边线/文字/强调/语义/尺寸/间距/阴影/
    语义底色九组），21 处硬编码色收编为变量。
  - **交互与观感**：补 `:focus-visible` 键盘焦点环（旧版 `input:focus` 只换边框色，Tab 导航
    看不出焦点）；`@media (prefers-reduced-motion: reduce)` 关动效；工具按钮按
    **查看/绘制/放置** 三段分组插分隔线（不改 testid 与工具语义）；工具栏统计信息与脏标记
    收成圆角芯片（旧版是裸文字 + 裸 `●` 字符）；底图例/提示默认折叠（把垂直空间还给画布）；
    顶栏 brand 改两级（`Them: Pixel Front · 地图编辑器`）。
  - **脏判定缓存**：`LoadState`/`MapDocState` 新增 `original`（读取/保存时一次性解析），
    取代每次渲染的 `JSON.parse(state.text)`（脏判定、`originalRows`、`originalRules`、
    地图面板 `original` 四处共用）。
  - **门禁修复：三处写死的建筑座数断言**。「清空搜索恢复全部 18 项」等 3 处断言把建筑座数
    写死为 18，而 `buildings.json` 已扩到 **32 座**——该断言在**未改动的基线上同样超时**
    （2026-09-24 用 `git stash` A/B 实测确认，非本轮引入）。改为从沙盒建筑表动态推导
    （`buildingCountOf`），建筑表再扩容不会再制造假红。
  - **门禁调整：图例默认折叠的断言跟随**。R31 把底部图例/提示改为默认折叠（还垂直空间给
    画布），原断言直接读 `map-notes` 文本会失败——改为**先点开 `map-notes-toggle` 再断言**，
    颜色含义的覆盖面不变。
  - **新增脚本**：`npm run typecheck`、`npm run test:unit`（`node --test`，19 断言）、
    `npm run gate`（typecheck + 单测 + build + smoke 串跑）、`scripts/r31-shots.mjs`
    （分辨率矩阵与 DPR 截图 + 性能读数）。

- **冒烟**：`npm run smoke` 含地图段 71 断言（……前述全部 + **改名保存全链路：默认名
  防撞 / 中文名保留 / 中文文件经 Godot 门禁落盘**）。
- **冒烟**：`npm run smoke` 含地图段 40 断言（……前述全部 + **放置 hq 占地 4×4（裁定表）/
  右键菜单弹出 / 菜单建字段跳转 JSON level=1**）；沙盒在无 war-of-state 数据的工作区
  补拷贝 units/buildings.json（地图面板依赖）。调试资产：`scripts/tool-probe.mjs`（工具
  切换 31 断言）、`scripts/place-probe.mjs`（放置链路转储）。
- **冒烟**：`npm run smoke` 含地图段 35 断言（列表/JSON 折叠开合/**步进 ±1 即时生效**/
  画布/中文标签/缩放+重置/门禁拒绝+文件不动/合法写盘+`.bak`/Ctrl+Z·Y 撤销重做/
  数字键与 B 键参数热键/笔刷·删除·box 拖框经门禁落盘回读/box 覆盖三断言/重载丢弃/
  关闭三选弹窗/**新建图 48×32 骨架 + width→64 画布即时同步**/截图）；无 war-of-state
  数据的工作区自动跳过配置段（dev-2d 数据形态差异待专项适配）并只跑地图段。


## 四项裁定（grill-me，2026-09-14）

1. **Electron 壳**（用户裁定）：渲染进程保持纯 web、不碰 Electron API——保留撤壳换本地
   web 服务或推玩家版的迁移路径；文件读写全在 main 进程。
2. **配置表单先行**：地图画布二期进 Electron（2D 示意预览 + 一键试玩，不做第三套 3D 渲染）。
3. **校验混合架构**：TS 只做键入时轻校验（UX 层）；**落盘必须过 Godot 无头 gate 且 exit 0**。
4. **纯开发工具**：直写仓库 `data/`，版本靠 git；玩家版（UGC/Workshop）留 W2 复评。

## 硬条件（勿违反）

- **gate exit 0 才写盘**——校验权威单一 = `war-of-state/src/data/match_config.gd`
  （`MatchConfig.validate`），gate 脚本零独立校验逻辑，TS 轻校验禁止扩展语义；
- **git 首提仍是前置债**（仓库未 init）——当前靠单代 `.bak` 兜底，尽快补 git；
- 工具代码全部在本目录（`map-editor/`），**不进 Godot 工程**；`node_modules/` 已忽略；
- R1 不支持实体/规则键增删（gate 会以 "R1 禁止新增/删除" 拒绝；实体增删需 id 分配 +
  资产注册联动，须专项）；
- 工具不做数值建议/自动调参——数值方向是人工独占域。

## 目录

```
map-editor/
  gate/config_gate.gd        # Godot 无头门禁（工程外 --script，探针已验证）
  gate/map_gate.gd           # 地图门禁（--path project-rts 真实构建链路，R7）
  labels.json                # 显示层中文标签（字段/枚举值/规则键；术语以人工审定为准）
  scripts/dev.mjs            # npm run dev：vite(127.0.0.1:5173) + electron + CDP 9222（占用预警）
  scripts/smoke.mjs          # npm run smoke：CDP E2E（沙盒数据，16 项断言 + 截图；9222 占用预检）
  scripts/no-op-check.cjs    # 冒烟辅助：无改动不写盘断言
  src/main/main.cjs          # Electron 主进程：窗口 + IPC
  src/main/store.cjs         # 读/原子写/.bak/哈希守卫/gate 子进程/labels 读取（纯 node，可单测）
  src/preload/preload.cjs    # contextBridge 唯一桥
  src/renderer/              # React + TS + Vite（纯 web）
    components/FieldTree.tsx    # 嵌套字段树（元素 ↑↓✕＋；tiers 锁 3 行）
    components/EntityList.tsx   # 左侧实体列表（搜索：名称/key/id）
    components/RulesTable.tsx   # 规则键值表（键带中文）
    components/MapsPanel.tsx    # 地图面板：列表/字段树/画布三栏（R7）
    components/MapCanvas.tsx    # 地图 2D 预览：地形/box_mode/建筑/出生点（只读）
  .gate/                     # gate 候选文件（运行时生成，已忽略）
```

## 用法

```bash
npm install        # 首次。注意：若 Electron 二进制下载失败（GitHub 网络），
                   # 用镜像手动装：ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm rebuild electron
                   # （npm 11 的 allowScripts 若拦截 postinstall，需手动下载解压 dist 并写 path.txt）
npm run dev        # 开发（vite HMR + electron，自动开 CDP 9222；ME_NO_CDP=1 关闭）
npm run smoke      # E2E 冒烟：vite build → 沙盒数据目录起真窗口 → CDP 断言（专用端口 9223，不干扰 dev）→ 截图
npm run build      # 仅构建渲染层到 dist/
npm run pack       # 打包可移植成品到 release/WosMapEditor-win64/（自动跑成品 CDP 冒烟；--no-verify 跳过）
npm run pack:zip   # 打包 + 产出 zip 分发包（PowerShell Compress-Archive）
```

## 打包与纯净环境运行（T-164 R3）

`npm run pack` 产出 `release/WosMapEditor-win64/`（约 542MB），双击 `WosMapEditor.exe` 即可
在**任意纯净 Windows 10/11 x64** 上运行——无需 Node、npm、Godot、游戏仓库。内置清单：

| 内置物 | 位置 | 说明 |
|---|---|---|
| Electron 44 运行时 | 根目录（exe/dll/pak/locales） | 自带 Chromium+Node，约 368MB |
| 应用代码 | `resources/app/` | 主进程/preload/渲染层 dist/gate 脚本/labels.json，零 npm 运行时依赖 |
| Godot 4.7.2 双 exe | `resources/godot/` | console 启动器 + 主程序（保存门禁用，spawn 输出捕获依赖 console 版），约 173MB |
| gate 工程子集 | `resources/war-of-state/` | 精简 project.godot（剥 autoload/main_scene）+ src + data；打包时 `--import` 生成 class_name 解析缓存并跑 lint 自检 |

注意：打包版编辑的是**包内** `resources/war-of-state/data/`（便携副本），与开发仓库互不影响；
成品为未签名 exe，首次运行 SmartScreen 可能提示"仍要运行"；仅限 Windows x64（跨平台需换对应
Electron dist 重打）；zip 分发包解压后保持目录结构直接运行（.NET ZipFile 产出，自动跳过陈旧
锁定文件并做体积校验）。

### 打包排障（清空输出目录 EPERM）

清理阶段对**逐文件**容忍删除，失败只剩三类原因：

1. 成品还在运行——`taskkill /IM WosMapEditor.exe /T /F` 或任务管理器结束；
2. 杀毒/索引对新写入可执行树的扫描瞬时锁——数分钟内自动释放，稍等重跑（或将 `release/`
   加入杀毒白名单一劳永逸）；
3. `default_app.asar` 被系统侧进程长锁——本包**不复制**该文件（Electron 兜底演示应用，
   `resources/app` 存在时无用），清理时自动跳过，不影响成品。

诊断占用进程：`powershell -File scripts/find-locker.ps1 -Path <被锁文件>`（Restart Manager API）。

数据目录默认 `../war-of-state/data`，可用 `ME_DATA_DIR` 覆盖（冒烟即用沙盒目录）；
Godot 可执行默认 `D:\envir\GodotEngine\Godot_v4.7.2-stable_win64_console.exe`，用 `GODOT_EXE` 覆盖
（打包成品优先使用内置副本）。

### 脏判定与已知格式重排（T-164 R5）

"是否有修改"按**语义**比对（数字归一 `1.0 ≡ 1`、键序无关、忽略空白，与游戏侧
`MatchConfig.canonical` 同口径）——纯打开/切换目录/切换表**不会**出现"未保存修改"弹窗。
真正编辑过才提示。注意：一旦保存，文件会被规范化重写（`1.0`→`1`、tab→2 空格缩进），
语义不变（canonical 一致）。窗口为无框样式：顶栏拖拽移动、双击最大化，右上自绘
最小化/最大化还原/关闭按钮。

### 导入外部数据目录（T-164 R4）

顶栏可随时切换数据目录：粘贴路径 + 「切换目录」、原生「导入文件夹…」对话框、或「默认」回到
`../war-of-state/data`；选择持久化在 localStorage。目录须**同时含** units/buildings/rules.json，
缺文件在切换时即被拒绝。保存门禁对导入目录同样生效：工具会为每个导入目录自动生成独立的
最小 gate 沙盒工程（`map-editor/.gate-projects/<hash>/`：精简 project.godot + src 副本 +
`--import` 类缓存；每次校验前刷新三个 json 副本，src 文件数/字节数变化自动重建）——
保证"候选 vs 同目录其余数据"的校验语义不因目录切换而漂移。

## gate 协议（`gate/config_gate.gd`）

```
<godot> --headless --path ../war-of-state --script gate/config_gate.gd -- lint-project
<godot> --headless --path ../war-of-state --script gate/config_gate.gd -- check --kind <units|buildings|rules> --candidate <abs path>
```

stdout 单行 `GATE_RESULT {json}`（`ok`/`errors`/`mode`）；exit **0**=通过、**2**=拒绝、**3**=用法错误。
候选按整文件传入；gate 提取有效节组装 override 后调 `MatchConfig.validate(override, defaults())`
——候选与当前工程默认表对照（跨文件引用按盘上另一文件现状校验）。

## 数据安全（store.cjs）

- 保存前哈希守卫：盘上文件与加载时不一致 → 拒绝并提示重载（冒烟已验证冲突路径）；
- 序列化（2 空格缩进 + 尾行换行）与当前 `data/*.json` 格式一致；
- **无改动不写盘**；有改动：先 gate，再单代 `.bak`，后临时文件 + 原子改名；
- 已知格式重排：浮点字面量 `1.0` 会写成 `1`（`MatchConfig.canonical` 归一化后语义不变）。

## 验证记录

- **R2.3（2026-09-14，观感）**：字段/规则标签改 markdown 风格——英文原字段 = 行内代码
  胶囊（等宽/浅底/细边框），中文注释 = 普通文本旁注（`LabelBits.tsx`）；截图目检通过。
- **R2.2（2026-09-14，用户改裁定）**：`lines[].unit` 由建议式输入改为**固定下拉**——只能选
  本建筑 role 组内单位（组外现存值保留为带警示的兜底选项，不静默丢失）；冒烟 23/23
  （含组外不可选负向断言 + 选择经 gate 写盘回读）。
- **R2.1（2026-09-14，grill 四答复）**：`lines[].unit` 建议式下拉——解析当前建筑自身引用
  （lines/produce_options）推导 role 组给建议（用户裁定语义：super→超级工厂系、vehicle→战车
  工厂系、summon→雷达）；summon 与 lines 引用集不一致时黄色提示（不联动，仅提示）。
  smoke 专用 CDP 端口 9223（`ME_CDP_PORT` 可配），与 dev 的 9222 并存互不干扰。
- **R2（2026-09-14）**：`npm run smoke` CDP E2E 16/16——实体列表 21 项、中文标签渲染
  （"攻击间隔"）、hp 200→210 写盘 + .bak、**数组元素排序经 gate 写盘**（auto_attack_targets
  [turrets,units,buildings]）并回读、非法保存被拒文件不动、无改动不写盘；截图
  `.smoke-artifacts/smoke-final.png` 已目检（主从布局、双语字段名、↑↓✕＋ 按钮齐全无渲染异常）；
  游戏侧全量 84 文件 5352/5352 + 0 脚本错误、boot 0 ERROR（当日另有并行会话改工程数据，
  +3 断言来自彼处，与本工具无冲突）。
- **R1（2026-09-14）**：gate 无头 8 用例（合法/坏 JSON/负 hp/增删实体/增删规则键/用法错误），
  exit 0/2/3 全对；smoke 13/13；游戏侧 84 文件 5349/5349 + boot 0 ERROR。

## R2 布局与中文化（2026-09-14，grill 面板关闭、按推荐项落地）

- **主从布局**：左侧实体列表（搜索 name_cn/key/id），右侧选中实体的字段树；规则表保持键值表；
- **字段树**：标量行内编辑（数字 Enter/失焦提交）；标量数组逐元素行（↑ ↓ ✕ ＋）；
  对象数组（tiers/lines）嵌套子树；`tiers` 锁 3 行禁增删（校验器锁死）；枚举字段为下拉
  （选项显示 `english（中文）`，存英文原值）；
- **labels.json**：`fields`（字段名）/`values`（枚举值，按字段分组）/`rules`（规则键）三节；
  显示 `attack_period（攻击间隔）` 形式；**缺标签回退纯英文**、文件损坏仅降级显示不阻断保存；
  改完点「重新加载」生效。术语为 AI 起草初稿，**以人工审定为准**；
- **铁律**：中文只存在于显示层，落盘 JSON 永远是英文键与英文值。
