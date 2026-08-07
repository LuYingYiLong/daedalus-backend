extends SceneTree

const RESULT_PREFIX: String = "DAEDALUS_RESULT:"

func _init() -> void:
	var args: PackedStringArray = OS.get_cmdline_user_args()
	if args.size() < 1:
		_finish({"ok": false, "error": "Missing operation JSON"}, 2)
		return

	var parsed: Variant = JSON.parse_string(args[0])
	if typeof(parsed) != TYPE_DICTIONARY:
		_finish({"ok": false, "error": "Operation JSON must be an object"}, 2)
		return

	var operation: Dictionary = parsed
	var operation_name: String = String(operation.get("operation", ""))
	var result: Dictionary = {}
	match operation_name:
		"get_uid":
			result = _get_uid(operation)
		"resave_resource":
			result = _resave_resource(operation)
		"update_project_uids":
			result = _update_project_uids(operation)
		"save_scene_variant":
			result = _save_scene_variant(operation)
		"load_sprite_texture":
			result = _load_sprite_texture(operation)
		"export_mesh_library":
			result = _export_mesh_library(operation)
		_:
			result = {"ok": false, "operation": operation_name, "error": "Unknown operation"}

	_finish(result, 0 if bool(result.get("ok", false)) else 1)

func _finish(result: Dictionary, exit_code: int) -> void:
	var final_result: Dictionary = result.duplicate(true)
	if not bool(final_result.get("ok", false)) and not final_result.has("failure"):
		var failure_code: String = String(final_result.get("code", "godot_operation_failed"))
		var failure_message: String = String(final_result.get("error", failure_code))
		final_result["failureCode"] = failure_code
		final_result["validationStatus"] = "failed"
		final_result["failure"] = {
			"code": failure_code,
			"category": "business",
			"message": failure_message,
			"retryable": true,
			"artifactRefs": []
		}
	print(RESULT_PREFIX + JSON.stringify(final_result))
	quit(exit_code)

func _require_string(operation: Dictionary, key: String) -> String:
	var value: Variant = operation.get(key, "")
	if typeof(value) != TYPE_STRING or String(value).strip_edges().is_empty():
		push_error("Missing required string: " + key)
		return ""
	return String(value)

func _get_uid(operation: Dictionary) -> Dictionary:
	var resource_path: String = _require_string(operation, "resource_path")
	if resource_path.is_empty():
		return {"ok": false, "operation": "get_uid", "error": "Missing resource_path"}

	var uid: int = ResourceLoader.get_resource_uid(resource_path)
	if uid == -1:
		return {
			"ok": false,
			"operation": "get_uid",
			"resource_path": resource_path,
			"uid": uid,
			"uid_text": "",
			"code": "resource_uid_missing",
			"error": "Godot did not assign a UID to the requested resource."
		}
	return {
		"ok": true,
		"operation": "get_uid",
		"resource_path": resource_path,
		"uid": uid,
		"uid_text": ResourceUID.id_to_text(uid)
	}

func _resave_resource(operation: Dictionary) -> Dictionary:
	var resource_path: String = _require_string(operation, "resource_path")
	if resource_path.is_empty():
		return {"ok": false, "operation": "resave_resource", "error": "Missing resource_path"}

	var resource: Resource = ResourceLoader.load(resource_path)
	if resource == null:
		return {"ok": false, "operation": "resave_resource", "resource_path": resource_path, "error": "Resource load failed"}

	var save_error: Error = ResourceSaver.save(resource, resource_path)
	return {
		"ok": save_error == OK,
		"operation": "resave_resource",
		"resource_path": resource_path,
		"save_error": int(save_error)
	}

func _update_project_uids(operation: Dictionary) -> Dictionary:
	var subdir: String = String(operation.get("subdir", ""))
	var root_path: String = "res://" if subdir.is_empty() else subdir
	var resources: PackedStringArray = PackedStringArray()
	_collect_resources(root_path, resources)

	var saved: Array[Dictionary] = []
	var failed: Array[Dictionary] = []
	for resource_path: String in resources:
		var resource: Resource = ResourceLoader.load(resource_path)
		if resource == null:
			failed.append({"resource_path": resource_path, "error": "Resource load failed"})
			continue
		var save_error: Error = ResourceSaver.save(resource, resource_path)
		if save_error == OK:
			saved.append({"resource_path": resource_path})
		else:
			failed.append({"resource_path": resource_path, "save_error": int(save_error)})

	return {
		"ok": failed.is_empty(),
		"operation": "update_project_uids",
		"root_path": root_path,
		"saved": saved,
		"failed": failed
	}

func _collect_resources(root_path: String, resources: PackedStringArray) -> void:
	var dir: DirAccess = DirAccess.open(root_path)
	if dir == null:
		return

	dir.list_dir_begin()
	var entry_name: String = dir.get_next()
	while not entry_name.is_empty():
		if entry_name.begins_with("."):
			entry_name = dir.get_next()
			continue
		var child_path: String = root_path.path_join(entry_name)
		if dir.current_is_dir():
			_collect_resources(child_path, resources)
		elif entry_name.ends_with(".tscn") or entry_name.ends_with(".tres") or entry_name.ends_with(".res"):
			resources.append(child_path)
		entry_name = dir.get_next()
	dir.list_dir_end()

func _save_scene_variant(operation: Dictionary) -> Dictionary:
	var scene_path: String = _require_string(operation, "scene_path")
	var output_path: String = _require_string(operation, "output_path")
	if scene_path.is_empty() or output_path.is_empty():
		return {"ok": false, "operation": "save_scene_variant", "error": "Missing scene_path or output_path"}

	var packed_scene: PackedScene = ResourceLoader.load(scene_path) as PackedScene
	if packed_scene == null:
		return {"ok": false, "operation": "save_scene_variant", "scene_path": scene_path, "error": "Scene load failed"}

	var root: Node = packed_scene.instantiate()
	var output_scene: PackedScene = PackedScene.new()
	var pack_error: Error = output_scene.pack(root)
	root.free()
	if pack_error != OK:
		return {"ok": false, "operation": "save_scene_variant", "scene_path": scene_path, "pack_error": int(pack_error)}

	var save_error: Error = ResourceSaver.save(output_scene, output_path)
	return {
		"ok": save_error == OK,
		"operation": "save_scene_variant",
		"scene_path": scene_path,
		"output_path": output_path,
		"save_error": int(save_error)
	}

func _load_sprite_texture(operation: Dictionary) -> Dictionary:
	var scene_path: String = _require_string(operation, "scene_path")
	var node_path: String = _require_string(operation, "node_path")
	var texture_path: String = _require_string(operation, "texture_path")
	if scene_path.is_empty() or node_path.is_empty() or texture_path.is_empty():
		return {"ok": false, "operation": "load_sprite_texture", "error": "Missing scene_path, node_path or texture_path"}

	var packed_scene: PackedScene = ResourceLoader.load(scene_path) as PackedScene
	if packed_scene == null:
		return {"ok": false, "operation": "load_sprite_texture", "scene_path": scene_path, "error": "Scene load failed"}

	var texture: Resource = ResourceLoader.load(texture_path)
	if texture == null:
		return {"ok": false, "operation": "load_sprite_texture", "texture_path": texture_path, "error": "Texture load failed"}

	var root: Node = packed_scene.instantiate()
	var target: Node = root.get_node_or_null(NodePath(node_path))
	if target == null:
		root.free()
		return {"ok": false, "operation": "load_sprite_texture", "node_path": node_path, "error": "Node not found"}

	target.set("texture", texture)
	var output_scene: PackedScene = PackedScene.new()
	var pack_error: Error = output_scene.pack(root)
	root.free()
	if pack_error != OK:
		return {"ok": false, "operation": "load_sprite_texture", "scene_path": scene_path, "pack_error": int(pack_error)}

	var save_error: Error = ResourceSaver.save(output_scene, scene_path)
	return {
		"ok": save_error == OK,
		"operation": "load_sprite_texture",
		"scene_path": scene_path,
		"node_path": node_path,
		"texture_path": texture_path,
		"save_error": int(save_error)
	}

func _export_mesh_library(operation: Dictionary) -> Dictionary:
	var scene_path: String = _require_string(operation, "scene_path")
	var output_path: String = _require_string(operation, "output_path")
	var mesh_item_names: Array = operation.get("mesh_item_names", [])
	if scene_path.is_empty() or output_path.is_empty():
		return {"ok": false, "operation": "export_mesh_library", "error": "Missing scene_path or output_path"}

	var packed_scene: PackedScene = ResourceLoader.load(scene_path) as PackedScene
	if packed_scene == null:
		return {"ok": false, "operation": "export_mesh_library", "scene_path": scene_path, "error": "Scene load failed"}

	var root: Node = packed_scene.instantiate()
	var mesh_nodes: Array[MeshInstance3D] = []
	_collect_mesh_nodes(root, mesh_nodes)

	var allowed_names: Dictionary = {}
	for item_name: Variant in mesh_item_names:
		allowed_names[String(item_name)] = true

	var mesh_library: MeshLibrary = MeshLibrary.new()
	var item_id: int = 0
	for mesh_node: MeshInstance3D in mesh_nodes:
		if not allowed_names.is_empty() and not allowed_names.has(mesh_node.name):
			continue
		if mesh_node.mesh == null:
			continue
		mesh_library.create_item(item_id)
		mesh_library.set_item_name(item_id, mesh_node.name)
		mesh_library.set_item_mesh(item_id, mesh_node.mesh)
		mesh_library.set_item_mesh_transform(item_id, mesh_node.transform)
		item_id += 1

	root.free()
	var save_error: Error = ResourceSaver.save(mesh_library, output_path)
	return {
		"ok": save_error == OK,
		"operation": "export_mesh_library",
		"scene_path": scene_path,
		"output_path": output_path,
		"item_count": item_id,
		"save_error": int(save_error)
	}

func _collect_mesh_nodes(node: Node, mesh_nodes: Array[MeshInstance3D]) -> void:
	if node is MeshInstance3D:
		mesh_nodes.append(node as MeshInstance3D)
	for child: Node in node.get_children():
		_collect_mesh_nodes(child, mesh_nodes)
