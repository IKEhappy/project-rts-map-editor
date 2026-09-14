extends SceneTree
## 探针：验证 Godot `--script` 能否加载工程外绝对路径脚本并访问 res:// 资源。
## map-editor 不进 Godot 工程（用户裁定），gate 脚本必须能从工程外运行。

func _initialize() -> void:
	var match_config: GDScript = load("res://src/data/match_config.gd")
	if match_config == null:
		print("PROBE_FAIL cannot load res://src/data/match_config.gd")
		quit(2)
		return
	var defaults: Dictionary = match_config.defaults()
	var units: Dictionary = defaults.get("units", {})
	var buildings: Dictionary = defaults.get("buildings", {})
	var rules: Dictionary = defaults.get("rules", {})
	print("PROBE_OK units=%d buildings=%d rules=%d" % [units.size(), buildings.size(), rules.size()])
	quit(0)
