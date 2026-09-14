# map-editor —— WarOfState-Remake 外置数据工具

T-164（2026-09-14 立项）。**JSON 编辑不进游戏内**，本工具用 Electron 开发，方便 AI 在
CDP（内置 Chromium）里做 DOM 级调试与验证。R2 范围：`units.json` / `buildings.json` /
`rules.json` **主从布局 + 字段树**编辑（嵌套数组/对象逐项增删排序）、`labels.json` 字段/枚举
中文化（显示层）。地图画布、campaign 表单、effective/impact 视图为 R3+。

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
