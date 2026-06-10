extends Node3D

const _TRAIL_BUILDER := preload("res://scripts/world/TrailPathBuilder.gd")
const _TENSION_CTRL := preload("res://scripts/world/AmbientTensionController.gd")
const _WORLD_SPAWN := preload("res://scripts/world/WorldSpawnUtil.gd")
const _LANDMARK_SPAWN := preload("res://scripts/world/LandmarkSpawner.gd")

var next_level_path: String = ""
var is_final_level: bool = false
var level_ambient_key: String = "forest_night"

func _refresh_env() -> void:
	GameManager.refresh_world_environments()

func _start_common() -> void:
	GameManager.ensure_post_process()
	AudioManager.play_ambient(level_ambient_key)
	# Push the first ambient creepy sting 60-110s out so the player has time
	# to orient before the horror starts. Without this the env-sound timer
	# persists across scene swaps and fires within seconds of level load.
	AudioManager.begin_level_ambience()
	GameManager.state = GameManager.GameState.PLAYING
	_add_rain_overlay()
	_start_tension_controller()

func _add_atmospheric_particles() -> void:
	pass

func _start_tension_controller() -> void:
	var tc := Node.new()
	tc.name = "AmbientTensionController"
	tc.set_script(_TENSION_CTRL)
	add_child(tc)

func _spawn_stalker(spawn_pos: Vector3, activation_sanity: float = 60.0) -> CharacterBody3D:
	# set_script attaches the script and initializes exports synchronously, so
	# we can assign the threshold before add_child — that way _ready already
	# sees the per-level value (and we keep this function synchronous; awaiting
	# made the -> CharacterBody3D return value useless to callers).
	var s = CharacterBody3D.new()
	s.name = "StalkerAI"
	s.set_script(preload("res://scripts/entities/StalkerAI.gd"))
	s.position = spawn_pos
	if "activation_sanity" in s:
		s.activation_sanity = activation_sanity
	add_child(s)
	return s

func _make_path(center: Vector3, length: float, width: float = 4.5) -> void:
	_make_guided_path_mesh(center, length, width)

func _make_guided_path_mesh(center: Vector3, length: float, width: float) -> void:
	# Visual overlay only — _make_floor's static body handles collision at y=0.
	# Giving the path its own raised box created a step the player had to climb.
	var mi := MeshInstance3D.new()
	mi.position = Vector3(center.x, center.y + 0.02, center.z)
	var bm := BoxMesh.new()
	bm.size = Vector3(width, 0.04, length)
	mi.mesh = bm
	var mat := StandardMaterial3D.new()
	mat.albedo_color = Color(0.38, 0.32, 0.22)
	mat.roughness = 0.96
	mat.emission_enabled = true
	mat.emission = Color(0.12, 0.10, 0.06)
	mat.emission_energy_multiplier = 0.48
	mi.material_override = mat
	mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	add_child(mi)

func _add_guided_trail(center: Vector3, length: float, half_width: float, trail_seed: int = 4242) -> void:
	var trail := Node3D.new()
	trail.name = "TrailPath"
	trail.set_script(_TRAIL_BUILDER)
	trail.path_center = center
	trail.path_length = length
	trail.path_half_width = half_width
	trail.path_center_z = center.z
	trail.rand_seed = trail_seed
	add_child(trail)

func _spawn_landmarks(count: int, area: Vector2, rand_seed: int = 777) -> void:
	var lm := Node3D.new()
	lm.set_script(_LANDMARK_SPAWN)
	lm.count = count
	lm.area_size = area
	lm.avoid_center_radius = 10.0
	lm.random_seed = rand_seed
	add_child(lm)

func _make_floor(size: Vector3) -> StaticBody3D:
	var body = StaticBody3D.new()
	var shape = BoxShape3D.new()
	# 20m thick so the player can never tunnel through regardless of speed
	shape.size = Vector3(size.x, 20.0, size.z)
	var col = CollisionShape3D.new()
	col.shape = shape
	col.position = Vector3(0, -10.0, 0)  # top of collision at y=0
	body.add_child(col)
	var mesh_inst = MeshInstance3D.new()
	var box_mesh = BoxMesh.new()
	box_mesh.size = size  # visual stays thin at ground level
	mesh_inst.mesh = box_mesh
	mesh_inst.position = Vector3(0, -size.y * 0.5, 0)
	var mat = ShaderMaterial.new()
	mat.shader = load("res://shaders/forest_floor.gdshader")
	mesh_inst.material_override = mat
	body.add_child(mesh_inst)
	add_child(body)
	return body

func _make_world_env(_top: Color, _horizon: Color, fog_color: Color, fog_density: float) -> void:
	var env = Environment.new()
	# Night-sky shader background (stars + dim moon) instead of flat black.
	# Looking above the treeline used to show pure void; now there's faint
	# celestial depth. Ambient lighting stays AMBIENT_SOURCE_COLOR below,
	# so the sky contributes NO light to the scene — purely visual.
	var sky_mat = ShaderMaterial.new()
	sky_mat.shader = load("res://shaders/night_sky.gdshader")
	var sky = Sky.new()
	sky.sky_material = sky_mat
	sky.radiance_size = Sky.RADIANCE_SIZE_32  # tiny — sky is near-black anyway
	env.background_mode = Environment.BG_SKY
	env.sky = sky

	# Horror night forest — dark but playable. Bumped from 0.28 to 0.42 so
	# the trees and ghosts read against the night sky instead of being
	# pure black silhouettes. Flashlight remains the dominant light source.
	env.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	env.ambient_light_color = Color(0.060, 0.070, 0.105)
	env.ambient_light_energy = 0.42

	env.fog_enabled = true
	env.fog_light_color = fog_color
	env.fog_density = fog_density
	env.fog_aerial_perspective = 0.0

	env.volumetric_fog_enabled = false
	env.ssao_enabled = false
	env.ssil_enabled = false

	# Flashlight bloom halo only
	env.glow_enabled = true
	env.glow_intensity = 0.30
	env.glow_bloom = 0.10
	env.glow_hdr_threshold = 0.82
	env.glow_strength = 0.85
	env.glow_normalized = false

	env.tonemap_mode = Environment.TONE_MAPPER_FILMIC
	env.tonemap_exposure = 1.05

	env.adjustment_enabled = true
	env.adjustment_contrast = 1.12
	env.adjustment_saturation = 0.52
	env.adjustment_brightness = 1.08

	var we = WorldEnvironment.new()
	we.environment = env
	we.add_to_group("world_environment")
	add_child(we)
	call_deferred("_refresh_env")

func _make_directional_light(color: Color, energy: float) -> void:
	var light = DirectionalLight3D.new()
	light.light_color = color
	light.light_energy = energy * 0.5
	light.shadow_enabled = false
	light.rotation_degrees = Vector3(-58, 18, 0)
	add_child(light)

func _make_exit_trigger(pos: Vector3, size: Vector3) -> void:
	var area = Area3D.new()
	area.position = pos
	area.collision_layer = 0
	area.collision_mask = 1
	var shape = BoxShape3D.new()
	shape.size = size
	var col = CollisionShape3D.new()
	col.shape = shape
	area.add_child(col)
	area.body_entered.connect(_on_exit_body_entered)
	add_child(area)

func _make_clearing_area(pos: Vector3, size: Vector3) -> void:
	var area = Area3D.new()
	area.position = pos
	area.collision_layer = 0
	area.collision_mask = 1
	var shape = BoxShape3D.new()
	shape.size = size
	var col = CollisionShape3D.new()
	col.shape = shape
	area.add_child(col)
	area.body_entered.connect(func(b):
		if b.is_in_group("player"):
			var fl = b.get_node_or_null("Camera3D/HandPivot/Flashlight")
			if fl and fl.has_method("set_clearing"): fl.set_clearing(true))
	area.body_exited.connect(func(b):
		if b.is_in_group("player"):
			var fl = b.get_node_or_null("Camera3D/HandPivot/Flashlight")
			if fl and fl.has_method("set_clearing"): fl.set_clearing(false))
	add_child(area)

func _spawn_hud() -> Node:
	var hud_scene = preload("res://scenes/ui/HUD.tscn")
	var hud = hud_scene.instantiate()
	add_child(hud)
	GameManager.ui_ref = hud
	return hud

func _spawn_player(spawn_pos: Vector3) -> CharacterBody3D:
	var scene = preload("res://scenes/entities/Player.tscn")
	var player = scene.instantiate()
	player.position = spawn_pos
	add_child(player)
	GameManager.player_ref = player
	return player

# Disabled — extra omni lights hurt FPS and break Chillas Art darkness
func _add_canopy_dapple(_n: int, _area: Vector2, _rand_seed: int = 0) -> void:
	pass

func _add_rain_overlay() -> void:
	var layer = CanvasLayer.new()
	layer.layer = 10
	var rect = ColorRect.new()
	rect.set_anchors_preset(Control.PRESET_FULL_RECT)
	rect.mouse_filter = Control.MOUSE_FILTER_IGNORE
	var mat = ShaderMaterial.new()
	mat.shader = load("res://shaders/rain_overlay.gdshader")
	mat.set_shader_parameter("rain_intensity", 0.22)
	mat.set_shader_parameter("rain_color", Color(0.65, 0.70, 0.85, 0.05))
	rect.material = mat
	layer.add_child(rect)
	add_child(layer)

func _on_exit_body_entered(body: Node3D) -> void:
	if not body.is_in_group("player"):
		return
	if is_final_level:
		GameManager.reach_exit()
	elif not next_level_path.is_empty():
		GameManager.load_level(next_level_path)
