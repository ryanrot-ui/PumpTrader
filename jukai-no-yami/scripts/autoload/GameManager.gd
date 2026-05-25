extends Node

# ─── Global Game State ───────────────────────────────────────────────────────

signal note_collected(note_id: int)
signal game_over(ending_type: String)

enum GameState { MENU, PLAYING, PAUSED, CINEMATIC, GAME_OVER }
enum Ending { NONE, BAD, GOOD, TRUE }

const CONFIG_PATH = "user://settings.cfg"

var state: GameState = GameState.MENU
var collected_notes: Array[int] = []
var notes_total: int = 4
var current_level: String = ""
var player_final_sanity: float = 100.0
var performance_mode: bool = false

enum GraphicsQuality { LOW = 0, MEDIUM = 1, HIGH = 2 }
var graphics_quality: int = GraphicsQuality.MEDIUM
var mouse_sensitivity: float = 0.0025
var vhs_enabled: bool = false

# References updated each level load
var player_ref: CharacterBody3D = null
var sanity_ref: Node = null
var ui_ref: CanvasLayer = null

var _config: ConfigFile
var _loading_overlay: CanvasLayer = null
var _loading_container: Control = null  # CanvasItem child — has modulate
var _checkpoint: Vector3 = Vector3(0, 1.5, 0)
var intro_played: bool = false

# ─── Lifecycle ────────────────────────────────────────────────────────────────

func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	_load_settings()
	_apply_performance_settings()
	_apply_graphics_settings()
	_build_loading_overlay()
	ensure_post_process()

func _load_settings() -> void:
	_config = ConfigFile.new()
	_config.load(CONFIG_PATH)
	performance_mode = _config.get_value("settings", "performance_mode", false)
	graphics_quality = int(_config.get_value("settings", "graphics_quality", GraphicsQuality.MEDIUM))
	mouse_sensitivity = float(_config.get_value("settings", "mouse_sensitivity", 0.0025))
	vhs_enabled = _config.get_value("settings", "vhs_enabled", false)
	var vol: float = _config.get_value("settings", "master_volume", 0.0)
	AudioServer.set_bus_volume_db(AudioServer.get_bus_index("Master"), vol)
	if _config.get_value("settings", "fullscreen", false):
		DisplayServer.window_set_mode(DisplayServer.WINDOW_MODE_FULLSCREEN)

func save_setting(key: String, value) -> void:
	_config.set_value("settings", key, value)
	_config.save(CONFIG_PATH)

func _build_loading_overlay() -> void:
	_loading_overlay = CanvasLayer.new()
	_loading_overlay.layer = 99
	_loading_overlay.process_mode = Node.PROCESS_MODE_ALWAYS
	# Control is a CanvasItem → it has the modulate property CanvasLayer lacks
	_loading_container = Control.new()
	_loading_container.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	_loading_container.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_loading_overlay.add_child(_loading_container)
	var bg = ColorRect.new()
	bg.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	bg.color = Color(0.0, 0.0, 0.0, 1.0)
	bg.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_loading_container.add_child(bg)
	var lbl = Label.new()
	lbl.text = "・・・"
	lbl.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	lbl.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	lbl.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	lbl.add_theme_font_size_override("font_size", 28)
	lbl.add_theme_color_override("font_color", Color(0.65, 0.50, 0.20))
	lbl.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_loading_container.add_child(lbl)
	_loading_container.modulate.a = 0.0  # Control.modulate is valid ✓
	add_child(_loading_overlay)

func _process(_delta: float) -> void:
	if state != GameState.PLAYING:
		return
	# During scene transitions player_ref can point at a freed CharacterBody3D
	# (the autoload outlives levels). is_instance_valid catches the dangle
	# before we touch global_position and crash.
	if not is_instance_valid(player_ref):
		return
	var py = player_ref.global_position.y
	if py > 0.3 and player_ref.is_on_floor():
		_checkpoint = player_ref.global_position
	if py < -10.0:
		push_warning("[GameManager] Fall-through detected — restoring checkpoint")
		player_ref.global_position = _checkpoint
		player_ref.velocity = Vector3.ZERO

func set_checkpoint(pos: Vector3) -> void:
	_checkpoint = pos

func _unhandled_input(event: InputEvent) -> void:
	if event.is_action_pressed("pause") and state == GameState.PLAYING:
		toggle_pause()

# ─── State Management ─────────────────────────────────────────────────────────

func start_game() -> void:
	collected_notes.clear()
	player_final_sanity = 100.0
	intro_played = false
	state = GameState.PLAYING
	load_level("res://scenes/levels/ParkingLot.tscn")

func toggle_pause() -> void:
	if state == GameState.PLAYING:
		state = GameState.PAUSED
		get_tree().paused = true
		Input.set_mouse_mode(Input.MOUSE_MODE_VISIBLE)
		if ui_ref:
			ui_ref.show_pause_menu()
	elif state == GameState.PAUSED:
		resume_game()

func resume_game() -> void:
	state = GameState.PLAYING
	get_tree().paused = false
	Input.set_mouse_mode(Input.MOUSE_MODE_CAPTURED)
	if ui_ref:
		ui_ref.hide_pause_menu()

func load_level(path: String) -> void:
	current_level = path
	get_tree().paused = false
	# Fade to black, change scene, then fade in
	if _loading_container:
		var tw = _loading_container.create_tween()
		tw.tween_property(_loading_container, "modulate:a", 1.0, 0.45)
		await tw.finished
	get_tree().change_scene_to_file(path)
	await get_tree().process_frame
	await get_tree().process_frame
	if _loading_container:
		var tw2 = _loading_container.create_tween()
		tw2.tween_property(_loading_container, "modulate:a", 0.0, 0.9)
		await tw2.finished
	call_deferred("_after_level_loaded", path)

func _after_level_loaded(path: String) -> void:
	NarrativeDirector.on_level_loaded(path)

func collect_note(id: int) -> void:
	if id not in collected_notes:
		collected_notes.append(id)
		note_collected.emit(id)
		AudioManager.play_sfx("note_pickup")
		if ui_ref:
			ui_ref.show_note_notification(id)

func trigger_game_over() -> void:
	state = GameState.GAME_OVER
	if sanity_ref:
		player_final_sanity = sanity_ref.sanity
	Input.set_mouse_mode(Input.MOUSE_MODE_VISIBLE)
	var ending = determine_ending()
	game_over.emit(ending)
	await get_tree().create_timer(1.5).timeout
	load_level("res://scenes/main/EndingScreen.tscn")

func determine_ending() -> String:
	var note_count = collected_notes.size()
	if note_count == 4 and player_final_sanity > 50.0:
		return "true"
	elif note_count >= 2 and player_final_sanity > 20.0:
		return "good"
	else:
		return "bad"

func reach_exit() -> void:
	player_final_sanity = sanity_ref.sanity if sanity_ref else 50.0
	state = GameState.GAME_OVER
	Input.set_mouse_mode(Input.MOUSE_MODE_VISIBLE)
	var ending = determine_ending()
	game_over.emit(ending)
	load_level("res://scenes/main/EndingScreen.tscn")

# ─── Performance ─────────────────────────────────────────────────────────────

func set_performance_mode(enabled: bool) -> void:
	performance_mode = enabled
	save_setting("performance_mode", enabled)
	_apply_performance_settings()
	_apply_graphics_settings()

func set_graphics_quality(quality: int) -> void:
	graphics_quality = clampi(quality, GraphicsQuality.LOW, GraphicsQuality.HIGH)
	if performance_mode:
		graphics_quality = GraphicsQuality.LOW
	save_setting("graphics_quality", graphics_quality)
	_apply_graphics_settings()
	refresh_world_environments()

func use_tree_shadows() -> bool:
	return not performance_mode and graphics_quality >= GraphicsQuality.HIGH

func ensure_post_process() -> void:
	if get_tree().get_first_node_in_group("post_process"):
		return
	var layer = CanvasLayer.new()
	layer.name = "PostProcess"
	layer.set_script(load("res://scripts/ui/RetroFilter.gd"))
	layer.add_to_group("post_process")
	get_tree().root.call_deferred("add_child", layer)

func _apply_performance_settings() -> void:
	var quality = 0 if performance_mode else 1
	ProjectSettings.set_setting(
		"rendering/lights_and_shadows/positional_shadow/soft_shadow_filter_quality", quality)
	ProjectSettings.set_setting(
		"rendering/lights_and_shadows/directional_shadow/soft_shadow_filter_quality", quality)
	var lod_mult = 1.5 if performance_mode else 1.0
	ProjectSettings.set_setting("rendering/mesh_lod/lod_change/threshold_pixels", 1.0 * lod_mult)

func _apply_graphics_settings() -> void:
	var eff_quality = GraphicsQuality.LOW if performance_mode else graphics_quality
	# MSAA — apply to the live viewport, not ProjectSettings (which only
	# reads on engine startup). Persist to ProjectSettings too so a future
	# scene reload still picks it up.
	var msaa := Viewport.MSAA_DISABLED
	match eff_quality:
		GraphicsQuality.MEDIUM:
			msaa = Viewport.MSAA_2X
		GraphicsQuality.HIGH:
			msaa = Viewport.MSAA_4X
	if get_tree() and get_tree().root:
		get_tree().root.msaa_3d = msaa
	ProjectSettings.set_setting("rendering/anti_aliasing/quality/msaa_3d", int(msaa))

	var pp = get_tree().get_first_node_in_group("post_process") if get_tree() else null
	if pp and pp.has_method("apply_quality_preset"):
		pp.apply_quality_preset(eff_quality, not performance_mode)

func refresh_world_environments() -> void:
	for node in get_tree().get_nodes_in_group("world_environment"):
		if node is WorldEnvironment and node.environment:
			_tune_environment(node.environment)

func _tune_environment(env: Environment) -> void:
	var eff = GraphicsQuality.LOW if performance_mode else graphics_quality
	env.volumetric_fog_enabled = false
	env.ssil_enabled = false
	env.ambient_light_energy = maxf(env.ambient_light_energy, 0.24)
	env.tonemap_exposure = 1.08
	env.adjustment_brightness = 1.10
	if performance_mode or eff == GraphicsQuality.LOW:
		env.ssao_enabled = false
		env.glow_enabled = true
		env.glow_intensity = 0.28
	elif eff == GraphicsQuality.MEDIUM:
		env.ssao_enabled = true
		env.ssao_intensity = 1.0
		env.glow_enabled = true
		env.glow_intensity = 0.34
	else:
		env.ssao_enabled = true
		env.ssao_intensity = 1.3
		env.glow_enabled = true
		env.glow_intensity = 0.42
