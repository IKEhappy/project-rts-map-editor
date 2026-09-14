extends SceneTree
## map-editor 配置门禁（2026-09-14 T-164）。工程外脚本——工具代码不进 Godot 工程（用户裁定），
## 探针 probe_outside.gd 已验证 --script 可从工程外加载并访问 res://。
##
## 校验权威 = res://src/data/match_config.gd 的 MatchConfig.validate；本脚本零独立校验逻辑，
## 只负责：候选文件解析 → override 组装 → R1 范围检查（禁增删实体/规则键）→ 调权威校验。
##
## 用法（Electron 主进程经子进程调用）：
##   <godot> --headless --path war-of-state --script map-editor/gate/config_gate.gd -- lint-project
##   <godot> --headless --path war-of-state --script map-editor/gate/config_gate.gd -- check --kind units --candidate <abs path>
## 协议：stdout 单行 "GATE_RESULT {json}"；exit 0 = 通过，2 = 拒绝，3 = 用法错误。
## 注意：候选文件按"整文件"传入（含 version/_note），本脚本只提取有效节组装 override。

const KINDS: PackedStringArray = ["units", "buildings", "rules"]
const USAGE: String = "usage: -- lint-project | -- check --kind units|buildings|rules --candidate <abs path>"

var _match_config: GDScript = null


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
	if args.size() == 0:
		return _usage("no mode given")
	var mode: String = args[0]
	if mode == "lint-project":
		return _lint_project()
	if mode == "check":
		return _check(_parse_options(args))
	return _usage("unknown mode: %s" % mode)


## 解析 check 模式参数：--kind <units|buildings|rules> --candidate <abs path>
func _parse_options(args: PackedStringArray) -> Dictionary:
	var options: Dictionary = {"kind": "", "candidate": ""}
	var index: int = 1
	while index < args.size():
		var arg: String = args[index]
		if arg == "--kind" and index + 1 < args.size():
			options["kind"] = args[index + 1]
			index += 2
		elif arg == "--candidate" and index + 1 < args.size():
			options["candidate"] = args[index + 1]
			index += 2
		else:
			options["error"] = "unexpected argument: %s" % arg
			return options
	return options


func _lint_project() -> Dictionary:
	var defaults: Dictionary = _mc().defaults()
	var errors: Array = []
	for error: String in _mc().validate({}, defaults):
		errors.append(error)
	return {"ok": errors.is_empty(), "mode": "lint-project", "errors": errors}


func _check(options: Dictionary) -> Dictionary:
	if options.has("error"):
		return _usage(String(options["error"]))
	var kind: String = String(options.get("kind", ""))
	var candidate_path: String = String(options.get("candidate", ""))
	if not KINDS.has(kind):
		return _usage("--kind must be one of units|buildings|rules")
	if candidate_path.is_empty():
		return _usage("--candidate is required")

	var parse: Dictionary = _read_json(candidate_path)
	if not bool(parse.get("ok", false)):
		return _rejected(kind, [String(parse.get("error", "cannot read candidate"))])

	var defaults: Dictionary = _mc().defaults()
	var extraction: Dictionary = _extract_override(kind, parse.get("data", {}), defaults)
	if not (extraction.get("errors", []) as Array).is_empty():
		return _rejected(kind, extraction["errors"])

	var errors: Array = []
	for error: String in _mc().validate(extraction["override"], defaults):
		errors.append(error)
	return {"ok": errors.is_empty(), "mode": "check", "kind": kind, "errors": errors}


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


## 候选文件 → override 字典 + R1 范围检查。
## units/buildings：实体键集必须与当前默认表完全一致（增删实体超出 override 语义，须专项）；
## 加载器必填字段（UnitDefs: id/key/hp；BuildingDefs: key/hp）缺失当场拒绝，不留到游戏启动 assert。
func _extract_override(kind: String, candidate: Dictionary, defaults: Dictionary) -> Dictionary:
	var errors: Array = []
	if kind == "rules":
		var rules_override: Dictionary = {}
		for key: String in candidate:
			if key == "version" or key == "_note":
				continue
			rules_override[key] = candidate[key]
		var base_rules: Dictionary = defaults.get("rules", {})
		for key: String in rules_override:
			if not base_rules.has(key):
				errors.append("R1 禁止新增规则键：rules.%s（规则键增删超出本工具范围）" % key)
		for key: String in base_rules:
			if not rules_override.has(key):
				errors.append("R1 禁止删除规则键：rules.%s（缺失键会让运行时 merged.rules 取值失败）" % key)
		return {"override": {"rules": rules_override}, "errors": errors}

	var rows_variant: Variant = candidate.get(kind, null)
	if not rows_variant is Array:
		return {"override": {}, "errors": ["candidate must contain a '%s' array" % kind]}
	var rows: Array = rows_variant
	var by_key: Dictionary = {}
	var seen_ids: Dictionary = {}
	for index: int in rows.size():
		var row_variant: Variant = rows[index]
		if not row_variant is Dictionary:
			errors.append("%s[%d]: expected object" % [kind, index])
			continue
		var row: Dictionary = row_variant
		var key_variant: Variant = row.get("key", null)
		if not key_variant is String or String(key_variant).is_empty():
			errors.append("%s[%d].key: expected non-empty string" % [kind, index])
			continue
		var key: String = key_variant
		if by_key.has(key):
			errors.append("%s[%d]: duplicate key '%s'" % [kind, index, key])
			continue
		if not row.has("hp"):
			errors.append("%s.%s.hp: missing (loader asserts id/key/hp)" % [kind, key])
		if kind == "units":
			var id_variant: Variant = row.get("id", null)
			if not (id_variant is int or id_variant is float) or not is_finite(float(id_variant)):
				errors.append("units.%s.id: expected finite number" % key)
			elif seen_ids.has(int(id_variant)):
				errors.append("units.%s.id=%d: duplicate id" % [key, int(id_variant)])
			else:
				seen_ids[int(id_variant)] = true
		by_key[key] = row
	var base: Dictionary = defaults.get(kind, {})
	for key: String in by_key:
		if not base.has(key):
			errors.append("R1 禁止新增实体：%s.%s（实体增删须专项，见 T-164）" % [kind, key])
	for key: String in base:
		if not by_key.has(key):
			errors.append("R1 禁止删除实体：%s.%s（实体增删须专项，见 T-164）" % [kind, key])
	return {"override": {kind: by_key}, "errors": errors}


func _mc() -> GDScript:
	if _match_config == null:
		_match_config = load("res://src/data/match_config.gd")
	return _match_config


func _rejected(kind: String, errors: Array) -> Dictionary:
	return {"ok": false, "mode": "check", "kind": kind, "errors": errors}


func _usage(message: String) -> Dictionary:
	return {"ok": false, "code": "usage", "errors": [USAGE + " — " + message]}
