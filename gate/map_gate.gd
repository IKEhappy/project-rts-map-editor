extends SceneTree
## map-editor 地图门禁（T-164 R7，2026-09-17）。工程外脚本——工具代码不进 Godot 工程。
##
## 校验权威 = dev-2d（project-rts）真实构建链路：Campaign.build_level（GameMap.from_dict →
## MatchConfig.layer → SimCore 装配 → 初始金币/出生/集结/AI）+ SimCore 快照 save/load 往返
## （snapshot_validation 全量校验：地形码 0..4、单位键、越界等）+ 空 step 冒烟。
## 本脚本零独立校验语义：结构可解析性之外，游戏侧拒了（build_level 返回空/往返失败）就是拒了。
##
## 用法（Electron 主进程经子进程调用）：
##   <godot> --headless --path project-rts --script map-editor/gate/map_gate.gd -- check --candidate <abs path>
## 协议：stdout 单行 "GATE_RESULT {json}"；exit 0 = 通过，2 = 拒绝，3 = 用法错误。
## 候选以临时名写进工程根（build_level 只认 res:// 路径；.me_gate_candidate.json 为瞬时文件，
## 校验后即删；脚本异常中止残留时可直接手删）。

const USAGE: String = "usage: -- check --candidate <abs path>"
const CANDIDATE_RES: String = "res://.me_gate_candidate.json"

var _campaign: GDScript = null
var _sim_core: GDScript = null


func _initialize() -> void:
	var result: Dictionary = _run(OS.get_cmdline_user_args())
	print("GATE_RESULT " + JSON.stringify(result))
	if bool(result.get("ok", false)):
		quit(0)
	elif String(result.get("code", "")) == "usage":
		quit(3)
	else:
		quit(2)


func _run(args: PackedStringArray) -> Dictionary:
	if args.size() == 0 or String(args[0]) != "check":
		return _usage("expected mode: check")
	var candidate: String = ""
	var index: int = 1
	while index < args.size():
		if String(args[index]) == "--candidate" and index + 1 < args.size():
			candidate = String(args[index + 1])
			index += 2
		else:
			return _usage("unexpected argument: %s" % String(args[index]))
	if candidate.is_empty():
		return _usage("--candidate is required")

	var parse: Dictionary = _read_json(candidate)
	if not bool(parse.get("ok", false)):
		return _rejected([String(parse.get("error", "cannot read candidate"))])
	var data: Dictionary = parse.get("data", {})

	# 结构可解析性预检（防加载器 assert 中止致无协议输出）：数值尺寸缺失/非正不是语义
	# 裁定，是 GameMap.from_dict 的既定硬约束，此处仅翻译成可读拒绝理由。
	for size_key: String in ["width", "height"]:
		var size_value: Variant = data.get(size_key, null)
		if not (size_value is int or size_value is float) or float(size_value) <= 0.0 \
				or not is_finite(float(size_value)):
			return _rejected(["%s 必须为正数（GameMap.from_dict 断言约束）：实际 %s" % [size_key, str(size_value)]])

	# 候选写进工程根 → 走真实 build_level 链路（含地图 JSON 加载、建筑/出生装配、AI 队伍）
	var file: FileAccess = FileAccess.open(CANDIDATE_RES, FileAccess.WRITE)
	if file == null:
		return _rejected(["无法写入候选临时位：%s" % CANDIDATE_RES])
	file.store_string(JSON.stringify(data))
	file.close()
	var cleanup := func() -> void:
		DirAccess.remove_absolute(ProjectSettings.globalize_path(CANDIDATE_RES))

	var errors: Array = []
	var sim: Variant = null
	sim = _campaign_script().build_level({"map": CANDIDATE_RES})
	if sim == null or sim.game_map == null:
		cleanup.call()
		return _rejected(["build_level 构建失败（地图无法装载——字段缺失/引用错误等，详见上方引擎输出）"])

	# —— 玩法级完整性（R9 补强：装载通过≠地图可玩。全部用游戏自身数据/状态判定）——
	# ① 建筑 key 必须在建筑表（sim 装配对未知 key 静默跳过——建筑会凭空消失）
	# ② 建筑足迹不得互相重叠/越界（同格重复占位属数据损坏）
	# ③ 出生点可用 + 装配存活兜底（SPAWN 对阻挡格静默拒绝——出生单位凭空消失）
	var bdefs: Dictionary = (load("res://src/data/building_defs.gd").load_all() as Dictionary).get("by_key", {})
	var occupied: Dictionary = {}
	var overlap_seen: Dictionary = {}
	for bd: Dictionary in sim.game_map.buildings:
		var bkey: String = String(bd.get("key", ""))
		if not bdefs.has(bkey):
			errors.append("建筑 key 未定义：%s（游戏装配会静默跳过，该建筑不会出现）" % bkey)
		var fx: int = int(bd.get("x", 0))
		var fy: int = int(bd.get("y", 0))
		var fw: int = maxi(1, int(bd.get("w", 1)))
		var fh: int = maxi(1, int(bd.get("h", 1)))
		if fx < 0 or fy < 0 or fx + fw > sim.game_map.width or fy + fh > sim.game_map.height:
			errors.append("建筑 %s 足迹越界：(%d,%d) %d×%d（图 %d×%d）" % [bkey, fx, fy, fw, fh, sim.game_map.width, sim.game_map.height])
		for yy: int in range(fy, fy + fh):
			for xx: int in range(fx, fx + fw):
				var cell: Vector2i = Vector2i(xx, yy)
				if occupied.has(cell) and not overlap_seen.has(cell):
					overlap_seen[cell] = true
					errors.append("建筑足迹重叠：%s 与 %s 同占 (%d,%d)" % [bkey, String(occupied[cell]), xx, yy])
				else:
					occupied[cell] = bkey
	for sp: Dictionary in sim.game_map.spawns:
		var sx: int = int(sp.get("x", 0))
		var sy: int = int(sp.get("y", 0))
		if sim.game_map.is_blocked(sx, sy):
			errors.append("出生点 (%d,%d) 在阻挡格（地形/建筑占位——SPAWN 会被静默拒绝，单位不会出现）" % [sx, sy])
	var init_spawns: Array = []
	if (data.get("init", {}) as Dictionary).has("spawns"):
		init_spawns = (data.get("init", {}) as Dictionary).get("spawns", [])
	for sp2: Dictionary in init_spawns:
		var ix: int = int(sp2.get("x", 0))
		var iy: int = int(sp2.get("y", 0))
		if sim.game_map.is_blocked(ix, iy):
			errors.append("init.spawns 出生点 (%d,%d) 在阻挡格（同上，单位不会出现）" % [ix, iy])
	var expected_units: int = 0
	for sp3: Dictionary in sim.game_map.spawns:
		expected_units += maxi(1, int(sp3.get("count", 1)))
	for sp4: Dictionary in init_spawns:
		expected_units += maxi(1, int(sp4.get("count", 1)))
	var alive_units: int = 0
	for uid: int in sim._active_ids:
		if sim.unit_alive[uid] == 1:
			alive_units += 1
	if alive_units < expected_units:
		errors.append("出生装配不足：期望 %d 个单位，实际存活 %d（出生格阻挡/被占/单位上限）" % [expected_units, alive_units])

	# 快照往返：snapshot_validation 全量校验（地形码 0..4、单位 kind、数组长度等）
	var snapshot: Dictionary = sim.save_state()
	var restored: Variant = _sim_core_script().new(1)
	if not restored.load_state(snapshot):
		errors.append("快照往返校验失败（snapshot_validation 拒绝：地形码越界/单位键非法等）")
	# 空 step 冒烟：装配后能推进
	if errors.is_empty():
		for _i: int in 10:
			sim.step([])
	cleanup.call()
	if not errors.is_empty():
		return _rejected(errors)
	return {"ok": true, "mode": "check", "errors": []}


func _read_json(path: String) -> Dictionary:
	var file: FileAccess = FileAccess.open(path, FileAccess.READ)
	if file == null:
		return {"ok": false, "error": "cannot open candidate: %s" % path}
	var raw: Variant = JSON.parse_string(file.get_as_text())
	if raw == null:
		return {"ok": false, "error": "candidate is not valid JSON"}
	if not raw is Dictionary:
		return {"ok": false, "error": "candidate root must be an object"}
	return {"ok": true, "data": raw}


func _campaign_script() -> GDScript:
	if _campaign == null:
		_campaign = load("res://src/data/campaign.gd")
	return _campaign


func _sim_core_script() -> GDScript:
	if _sim_core == null:
		_sim_core = load("res://src/sim/sim_core.gd")
	return _sim_core


func _rejected(errors: Array) -> Dictionary:
	return {"ok": false, "mode": "check", "errors": errors}


func _usage(message: String) -> Dictionary:
	return {"ok": false, "code": "usage", "errors": [USAGE + " — " + message]}
