extends "res://scripts/world/LevelManager.gd"

# _WORLD_SPAWN is inherited from LevelManager.
const _CAR_BUILDER := preload("res://scripts/world/JapaneseCompactCarBuilder.gd")
const _LOT_PROPS := preload("res://scripts/world/ParkingLotProps.gd")

# Geometry constants — kept here so spawners can avoid colliding with
# structures (signs, gate, cars) without magic numbers scattered around.
const LOT_HALF_X        := 22.0
const LOT_NORTH_Z       :=  16.0    # asphalt north edge
const LOT_SOUTH_Z       := -16.0    # asphalt south edge (gate is here)
const PATH_HALF_WIDTH   :=  2.3
const PATH_LENGTH       :=  44.0
const PATH_CENTER_Z     := -16.0    # path runs from z=+6 down to z=-38
const GATE_Z            := -12.0
const SIGN_POS          := Vector3(5.6, 0.0, -6.5)
const EXIT_TRIGGER_Z    := -34.0

func _ready() -> void:
	level_ambient_key = "forest_night"
	next_level_path = "res://scenes/levels/ForestEntrance.tscn"

	_make_world_env(
		Color(0.02, 0.018, 0.032),
		Color(0.03, 0.026, 0.048),
		Color(0.04, 0.034, 0.058),
		0.012)
	_make_directional_light(Color(0.18, 0.16, 0.24), 0.12)

	# Base ground — solid 140 x 200 forest floor under EVERYTHING. The asphalt
	# and dirt path are visual overlays on top, so the player has a continuous
	# walkable surface at y=0 and can never fall off the parking lot edge.
	_make_floor(Vector3(140, 0.4, 200))

	# Asphalt overlay — visual only, very thin, sits on the ground floor
	_make_asphalt_overlay(Vector3(LOT_HALF_X * 2.0, 0.04, (LOT_NORTH_Z - LOT_SOUTH_Z)),
		Vector3(0.0, 0.02, (LOT_NORTH_Z + LOT_SOUTH_Z) * 0.5))

	# Worn decor confined to the actual asphalt rectangle, avoiding cars/path
	_LOT_PROPS.spawn_decor(self, 8801)

	# Dirt path overlay — visual only, sits 1 cm above asphalt to read clearly
	# but well below any step height so the player walks straight onto it.
	_make_dirt_path(Vector3(0.0, 0.03, PATH_CENTER_Z), PATH_LENGTH, PATH_HALF_WIDTH * 2.0)

	# Player's car — compact JDM sedan, facing the forest path
	_CAR_BUILDER.build(
		self, Vector3(-6.2, 0, 8.5),
		Color(0.14, 0.16, 0.22),
		-12.0,
		{"name": "PlayerCar", "dirt": 0.28, "headlights_on": true, "front_steer_deg": 4.0})
	_CAR_BUILDER.build(
		self, Vector3(7.5, 0, 10.5),
		Color(0.18, 0.14, 0.12),
		18.0,
		{"name": "AbandonedCar", "abandoned": true, "dirt": 0.55, "rust": 0.22, "headlights_on": false})

	# Lights — more of them, brighter, so the lot reads at night
	_spawn_lot_light(Vector3(-9, 0, 4))
	_spawn_lot_light(Vector3( 9, 0, 4))
	_spawn_lot_light(Vector3(-9, 0, -8))
	_spawn_lot_light(Vector3( 9, 0, -8))

	# Treeline — thicker around the lot to feel enclosed
	_WORLD_SPAWN.add_tree_spawner(self, Vector3(-24, 0, -10), {
		"count": 60, "area_size": Vector2(20, 60), "avoid_center_radius": 12.0,
		"min_scale": 1.2, "max_scale": 2.4, "random_seed": 501,
		"cluster_count": 6, "cluster_density": 0.78})
	_WORLD_SPAWN.add_tree_spawner(self, Vector3( 24, 0, -10), {
		"count": 60, "area_size": Vector2(20, 60), "avoid_center_radius": 12.0,
		"min_scale": 1.2, "max_scale": 2.4, "random_seed": 502,
		"cluster_count": 6, "cluster_density": 0.78})
	# Forest backdrop deeper south (behind exit) so the path leads INTO something
	_WORLD_SPAWN.add_tree_spawner(self, Vector3(0, 0, -55), {
		"count": 70, "area_size": Vector2(80, 30), "avoid_center_radius": 6.0,
		"avoid_path_width": 4.0,
		"min_scale": 1.0, "max_scale": 2.2, "random_seed": 503,
		"cluster_count": 7, "cluster_density": 0.70})

	# A few ribbons along the path edge — far enough from path to not block
	_WORLD_SPAWN.add_ribbon_spawner(self, Vector3(0, 0, -25), {
		"ribbon_count": 12, "area_size": Vector2(18, 22)})

	# Torii-style gate at the forest entrance
	_spawn_gate(Vector3(0, 0, GATE_Z))

	# Information sign — off to the side, clear of the path AND clear of cars
	_spawn_sign(SIGN_POS, -22.0)

	# Exit trigger past the gate, slightly elevated so brushing the ground
	# can't accidentally fire it
	_make_exit_trigger(Vector3(0, 1.5, EXIT_TRIGGER_Z), Vector3(8, 5, 2))

	_spawn_player(Vector3(-4, 1.0, 11.0))
	_spawn_hud()
	_start_common()
	call_deferred("_play_intro")

func _play_intro() -> void:
	await get_tree().create_timer(1.0).timeout
	NarrativeDirector.play_game_opening()

# Asphalt — visual only (collision is the forest floor underneath).
# Mesh top at y = center_y + size.y/2. Place so its TOP sits at y = 0.04.
func _make_asphalt_overlay(size: Vector3, center: Vector3) -> void:
	var mi := MeshInstance3D.new()
	var bm := BoxMesh.new()
	bm.size = size
	mi.mesh = bm
	mi.position = center
	_LOT_PROPS.apply_wet_asphalt(mi)
	mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	add_child(mi)

# Dirt path — visual overlay only, sits flush on the forest floor + asphalt.
# 4 cm thick mesh so it reads as worn dirt without a tripping step.
func _make_dirt_path(center: Vector3, length: float, width: float) -> void:
	var mi := MeshInstance3D.new()
	var bm := BoxMesh.new()
	bm.size = Vector3(width, 0.04, length)
	mi.mesh = bm
	mi.position = center
	var mat := StandardMaterial3D.new()
	mat.albedo_color = Color(0.22, 0.16, 0.10)
	mat.roughness = 0.98
	mat.metallic_specular = 0.02
	mi.material_override = mat
	mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	add_child(mi)

func _spawn_lot_light(pos: Vector3) -> void:
	var pole := StaticBody3D.new()
	pole.position = pos

	var pole_mat := StandardMaterial3D.new()
	pole_mat.albedo_color = Color(0.38, 0.38, 0.40)
	pole_mat.roughness = 0.72

	var pole_m := CylinderMesh.new()
	pole_m.height = 6.0
	pole_m.top_radius = 0.038
	pole_m.bottom_radius = 0.065
	var pole_mi := MeshInstance3D.new()
	pole_mi.mesh = pole_m
	pole_mi.material_override = pole_mat
	pole_mi.position = Vector3(0, 3.0, 0)
	pole.add_child(pole_mi)

	var arm_m := BoxMesh.new()
	arm_m.size = Vector3(1.4, 0.07, 0.07)
	var arm_mi := MeshInstance3D.new()
	arm_mi.mesh = arm_m
	arm_mi.material_override = pole_mat
	arm_mi.position = Vector3(0.7, 6.0, 0)
	pole.add_child(arm_mi)

	var fixture_m := BoxMesh.new()
	fixture_m.size = Vector3(0.42, 0.10, 0.22)
	var fixture_mi := MeshInstance3D.new()
	fixture_mi.mesh = fixture_m
	var fix_mat := StandardMaterial3D.new()
	fix_mat.albedo_color = Color(0.96, 0.86, 0.55)
	fix_mat.emission_enabled = true
	fix_mat.emission = Color(0.95, 0.82, 0.45)
	fix_mat.emission_energy_multiplier = 0.95
	fixture_mi.material_override = fix_mat
	fixture_mi.position = Vector3(1.4, 6.0, 0)
	pole.add_child(fixture_mi)

	var light := OmniLight3D.new()
	light.light_color = Color(0.86, 0.78, 0.55)
	light.light_energy = 10.5
	light.omni_range = 28.0
	light.shadow_enabled = true
	light.position = Vector3(1.4, 5.95, 0)
	pole.add_child(light)

	var ps := CylinderShape3D.new()
	ps.height = 6.0
	ps.radius = 0.065
	var pc := CollisionShape3D.new()
	pc.shape = ps
	pc.position = Vector3(0, 3.0, 0)
	pole.add_child(pc)

	add_child(pole)

# Torii-style gate. Cylinder pillars tilted 5° inward (authentic profile),
# raycast-snapped to the ground so it never floats, custom unlit torii
# shader for the flat sharp colour look. Two crossbeams + shimenawa rope
# with hanging shide streamers.
func _spawn_gate(pos: Vector3) -> void:
	var gate := StaticBody3D.new()
	# Ground-snap via raycast. Defer one frame so the floor StaticBody is in
	# the physics space before we query it. Falls back to pos.y if the
	# raycast misses (e.g. spawned outside the floor extent).
	gate.position = pos
	add_child(gate)
	call_deferred("_snap_to_ground", gate, pos)

	# Torii wood material — unlit dark vermilion with grain flicker
	var torii_mat := ShaderMaterial.new()
	torii_mat.shader = load("res://shaders/torii_gate.gdshader")
	torii_mat.set_shader_parameter("wood_color", Color(0.18, 0.07, 0.05, 1.0))
	torii_mat.set_shader_parameter("grain_color", Color(0.42, 0.12, 0.08, 1.0))
	torii_mat.set_shader_parameter("grain_strength", 0.32)
	torii_mat.set_shader_parameter("flicker_speed", 1.4)
	torii_mat.set_shader_parameter("flicker_amount", 0.06)

	# Vertical cylinder pillars — 4 m tall, leaning 5° toward each other.
	# Tilt direction = sign convention: right post (x=+2.8) tilts left
	# (rotation.z = +5 in Godot's left-handed Y-up means top goes -X).
	for side: float in [-1.0, 1.0]:
		var pillar := MeshInstance3D.new()
		var pm := CylinderMesh.new()
		pm.height = 4.0
		pm.top_radius = 0.12
		pm.bottom_radius = 0.16
		pm.radial_segments = 18
		pillar.mesh = pm
		pillar.material_override = torii_mat
		# Base at y=0, centre at y=2.0. Tilt by 5° toward the centre — for
		# the right pillar (side=+1) we want its top to slide LEFT, which
		# in Godot 3D means negative rotation about Z.
		pillar.position = Vector3(side * 2.8, 2.0, 0)
		pillar.rotation_degrees = Vector3(0.0, 0.0, -side * 5.0)
		gate.add_child(pillar)

	# Top beam — kasagi (slight outward overhang)
	var tb := BoxMesh.new()
	tb.size = Vector3(6.6, 0.26, 0.28)
	var tbi := MeshInstance3D.new()
	tbi.mesh = tb; tbi.material_override = torii_mat
	tbi.position = Vector3(0, 4.0, 0)
	gate.add_child(tbi)

	# Second beam — shimaki, slightly below
	var lb := BoxMesh.new()
	lb.size = Vector3(5.6, 0.18, 0.20)
	var lbi := MeshInstance3D.new()
	lbi.mesh = lb; lbi.material_override = torii_mat
	lbi.position = Vector3(0, 3.55, 0)
	gate.add_child(lbi)

	# Shimenawa — twisted rope spanning the gate, neon-red glowing
	var rope := MeshInstance3D.new()
	var rm := CylinderMesh.new()
	rm.height = 5.4
	rm.top_radius = 0.06
	rm.bottom_radius = 0.06
	rope.mesh = rm
	rope.rotation_degrees.z = 90.0
	rope.position = Vector3(0, 3.30, 0)
	var rope_mat := StandardMaterial3D.new()
	rope_mat.albedo_color = Color(0.78, 0.16, 0.10)
	rope_mat.roughness = 1.0
	rope_mat.emission_enabled = true
	rope_mat.emission = Color(0.95, 0.20, 0.12)
	rope_mat.emission_energy_multiplier = 0.18
	rope.material_override = rope_mat
	gate.add_child(rope)

	# Shide — white paper streamers that ACTUALLY HANG DOWN from the rope.
	# Top of streamer at y=3.25 (just below rope), length 1.8 m so they
	# end at y=1.45 — clearly above head-height, framing the entrance.
	var shide_mat := StandardMaterial3D.new()
	shide_mat.albedo_color = Color(0.92, 0.90, 0.84)
	shide_mat.roughness = 0.95
	shide_mat.cull_mode = BaseMaterial3D.CULL_DISABLED
	for i in 5:
		var sh_top := MeshInstance3D.new()
		var sm := BoxMesh.new()
		sm.size = Vector3(0.10, 1.80, 0.012)
		sh_top.mesh = sm
		sh_top.material_override = shide_mat
		sh_top.position = Vector3(-2.0 + i * 1.0, 2.35, 0)
		gate.add_child(sh_top)

	# Collision — only the posts. Walking under the gate must NOT be blocked.
	# Use the same 5° tilt so collision matches the visible mesh.
	for side: float in [-1.0, 1.0]:
		var ps := CylinderShape3D.new()
		ps.radius = 0.18
		ps.height = 4.0
		var pc := CollisionShape3D.new()
		pc.shape = ps
		pc.position = Vector3(side * 2.8, 2.0, 0)
		pc.rotation_degrees = Vector3(0.0, 0.0, -side * 5.0)
		gate.add_child(pc)
	# Gate is already added to the scene at the top of this function so the
	# deferred raycast can fire — no second add_child needed here.

# Sign — tall cylindrical post + flat board with a clean Label3D face.
# Materials are flat unlit-feel ash-grey so the sign reads as physical world
# geometry, not floating UI text. Raycast-snapped to ground via the deferred
# helper used for the torii.
func _spawn_sign(pos: Vector3, yaw_deg: float = 0.0) -> void:
	var sign_body := StaticBody3D.new()
	sign_body.position = pos
	sign_body.rotation_degrees.y = yaw_deg
	# Add to scene FIRST so the deferred ground snap can query the
	# physics space when it fires next frame.
	add_child(sign_body)
	call_deferred("_snap_to_ground", sign_body, pos)

	var post_m := CylinderMesh.new()
	post_m.height = 2.2; post_m.top_radius = 0.05; post_m.bottom_radius = 0.06
	var post_mi := MeshInstance3D.new()
	post_mi.mesh = post_m
	var post_mat := StandardMaterial3D.new()
	post_mat.albedo_color = Color(0.22, 0.16, 0.10)
	post_mat.roughness = 0.95
	post_mi.material_override = post_mat
	post_mi.position = Vector3(0, 1.1, 0)
	sign_body.add_child(post_mi)

	var board_m := BoxMesh.new()
	board_m.size = Vector3(1.30, 0.70, 0.05)
	var board_mi := MeshInstance3D.new()
	board_mi.mesh = board_m
	# Weathered wood — procedural shader with vertical grain lines and
	# random decay streaks. Replaces the flat StandardMaterial3D so the
	# board reads as warped outdoor lumber even at point-blank distance.
	var board_mat := ShaderMaterial.new()
	board_mat.shader = load("res://shaders/weathered_wood.gdshader")
	board_mat.set_shader_parameter("wood_base", Color(0.20, 0.14, 0.08, 1.0))
	board_mat.set_shader_parameter("wood_dark", Color(0.04, 0.03, 0.02, 1.0))
	board_mat.set_shader_parameter("wood_stain", Color(0.32, 0.10, 0.04, 1.0))
	board_mat.set_shader_parameter("grain_freq", 36.0)
	board_mat.set_shader_parameter("grain_depth", 0.55)
	board_mat.set_shader_parameter("stain_amount", 0.25)
	board_mi.material_override = board_mat
	board_mi.position = Vector3(0, 2.15, 0)
	sign_body.add_child(board_mi)

	# Disable shadow casting on the board's front-face label so the text
	# doesn't self-shadow itself into invisibility.
	board_mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF

	# Painted text — off-white, slightly stained, NOT emissive.
	# Removed the previous "modulate = bright cream" which made the text
	# look like a TV screen. outline_modulate adds a subtle dark border
	# so it reads against the dark wood without needing emission.
	var warn := Label3D.new()
	warn.text = "樹海への立入注意\nSuicide Forest — Enter at your own risk"
	warn.position = Vector3(0.0, 0.0, 0.032)
	warn.pixel_size = 0.0028
	warn.billboard = BaseMaterial3D.BILLBOARD_DISABLED
	warn.font_size = 14
	warn.modulate = Color(0.78, 0.72, 0.58)
	warn.outline_size = 4
	warn.outline_modulate = Color(0.02, 0.02, 0.02, 0.85)
	warn.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	warn.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	board_mi.add_child(warn)

	# Thin post collision — just enough to not be walked through
	var pcs := CylinderShape3D.new()
	pcs.radius = 0.07; pcs.height = 2.2
	var pcoll := CollisionShape3D.new()
	pcoll.shape = pcs
	pcoll.position = Vector3(0, 1.1, 0)
	sign_body.add_child(pcoll)
	# Sign was added to the scene at the top of this function so the deferred
	# raycast can fire — no second add_child needed here.

# Deferred ground-snap helper. Casts a ray straight down from 50 m above the
# desired position, and if it hits a collision body, snaps the node to the
# hit Y. Used by the torii gate and warning sign so they never float when
# the parent terrain is offset. Falls back to the original Y if the ray misses.
func _snap_to_ground(node: Node3D, original_pos: Vector3) -> void:
	if not is_instance_valid(node) or not node.is_inside_tree():
		return
	var space := node.get_world_3d().direct_space_state
	if not space:
		return
	var query := PhysicsRayQueryParameters3D.create(
		Vector3(original_pos.x, original_pos.y + 50.0, original_pos.z),
		Vector3(original_pos.x, original_pos.y - 50.0, original_pos.z))
	query.collision_mask = 1
	query.exclude = [node.get_rid()] if node is CollisionObject3D else []
	var result := space.intersect_ray(query)
	if result and result.has("position"):
		var hit_pos: Vector3 = result["position"]
		node.global_position = Vector3(original_pos.x, hit_pos.y, original_pos.z)
