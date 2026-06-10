extends Node3D
## Guided trail: emissive path mesh, path markers, breadcrumb lights.

const _PATH_MARKERS := preload("res://scripts/world/PathMarkerSpawner.gd")

@export var path_center_z: float = -40.0
@export var path_length: float = 80.0
@export var path_half_width: float = 2.6
@export var path_center: Vector3 = Vector3.ZERO
@export var stake_spacing: float = 7.0
@export var lantern_every: int = 2
# Breadcrumb lights — sparser + dimmer than before so they don't paint
# a regular grid of dots across the forest floor.
@export var light_spacing: float = 22.0
@export var rand_seed: int = 4242


func _ready() -> void:
	build()


func build() -> void:
	if has_meta("_trail_built"):
		return
	set_meta("_trail_built", true)

	var center := path_center
	if center == Vector3.ZERO:
		center = Vector3(0, 0.03, path_center_z)

	var level_root := get_parent() as Node3D
	if not level_root:
		return

	_make_path_mesh(level_root, center, path_length, path_half_width * 2.0)
	_spawn_path_markers(level_root, center)
	_spawn_breadcrumb_lights(level_root, center, path_length, path_half_width)
	# Dense roadside fill — without this the sides of the trail look empty
	# in playtest. Generates short dark trunks, jagged rocks, dead branches,
	# and clumps of underbrush along both edges of the trail.
	_spawn_roadside_fill(level_root, center, path_length, path_half_width)


# Roadside fill — keep the sides of the trail visually busy so the player
# never sees "empty void" past the trail edge. Uses small geometric primitives
# (dark cylinders, small boxes, narrow cones) at random positions in the band
# right next to the trail.
func _spawn_roadside_fill(level_root: Node3D, center: Vector3, length: float, hw: float) -> void:
	var holder := Node3D.new()
	holder.name = "RoadsideFill"
	level_root.add_child(holder)
	var rng := RandomNumberGenerator.new()
	rng.seed = rand_seed * 31 + 17

	# Materials — all dark, matte. Cell-shaded look comes from the post-process.
	var trunk_mat := StandardMaterial3D.new()
	trunk_mat.albedo_color = Color(0.06, 0.05, 0.04)
	trunk_mat.roughness = 1.0
	var rock_mat := StandardMaterial3D.new()
	rock_mat.albedo_color = Color(0.14, 0.13, 0.12)
	rock_mat.roughness = 0.95
	var branch_mat := StandardMaterial3D.new()
	branch_mat.albedo_color = Color(0.08, 0.06, 0.05)
	branch_mat.roughness = 1.0
	var brush_mat := StandardMaterial3D.new()
	brush_mat.albedo_color = Color(0.04, 0.06, 0.03)
	brush_mat.roughness = 1.0

	var z_near := center.z + length * 0.5
	var z_far := center.z - length * 0.5
	# Step along the trail; at each step, place props on BOTH sides.
	var step := 1.6
	var z := z_near
	while z >= z_far:
		for side: float in [-1.0, 1.0]:
			# Skip if the player would walk through this position — keep the
			# edge buffer = path_half_width + 0.4 m clear.
			var base_x := side * (hw + rng.randf_range(0.4, 1.8))
			var local_z := z + rng.randf_range(-0.8, 0.8)
			# Roll for what to place: 50% trunk, 25% rock, 15% branch, 10% brush
			var r := rng.randf()
			if r < 0.50:
				_place_trunk(holder, Vector3(base_x, 0.0, local_z), trunk_mat, rng)
			elif r < 0.75:
				_place_rock(holder, Vector3(base_x, 0.0, local_z), rock_mat, rng)
			elif r < 0.90:
				_place_branch(holder, Vector3(base_x, 0.0, local_z), branch_mat, rng)
			else:
				_place_brush(holder, Vector3(base_x, 0.0, local_z), brush_mat, rng)
		z -= step


func _place_trunk(parent: Node3D, pos: Vector3, mat: Material, rng: RandomNumberGenerator) -> void:
	var height := rng.randf_range(2.6, 4.2)
	var radius := rng.randf_range(0.10, 0.22)
	var trunk := MeshInstance3D.new()
	var cm := CylinderMesh.new()
	cm.top_radius = radius * 0.78
	cm.bottom_radius = radius
	cm.height = height
	cm.radial_segments = 8
	trunk.mesh = cm
	trunk.position = pos + Vector3(0, height * 0.5, 0)
	# Slight random lean so the row of trunks doesn't look like fence posts
	trunk.rotation_degrees = Vector3(
		rng.randf_range(-3.0, 3.0),
		rng.randf_range(0.0, 360.0),
		rng.randf_range(-3.0, 3.0))
	trunk.material_override = mat
	trunk.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	parent.add_child(trunk)


func _place_rock(parent: Node3D, pos: Vector3, mat: Material, rng: RandomNumberGenerator) -> void:
	# Jagged angular rock — single box, randomly rotated to look chiselled
	var rock := MeshInstance3D.new()
	var bm := BoxMesh.new()
	var s := rng.randf_range(0.18, 0.42)
	bm.size = Vector3(s, s * rng.randf_range(0.5, 0.9), s * rng.randf_range(0.7, 1.2))
	rock.mesh = bm
	rock.position = pos + Vector3(0, bm.size.y * 0.5, 0)
	rock.rotation_degrees = Vector3(
		rng.randf_range(-25.0, 25.0),
		rng.randf_range(0.0, 360.0),
		rng.randf_range(-25.0, 25.0))
	rock.material_override = mat
	rock.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	parent.add_child(rock)


func _place_branch(parent: Node3D, pos: Vector3, mat: Material, rng: RandomNumberGenerator) -> void:
	# Fallen branch — thin cylinder lying horizontal
	var branch := MeshInstance3D.new()
	var cm := CylinderMesh.new()
	cm.top_radius = 0.025
	cm.bottom_radius = 0.04
	cm.height = rng.randf_range(0.9, 1.8)
	branch.mesh = cm
	branch.rotation_degrees = Vector3(
		90.0 + rng.randf_range(-12.0, 12.0),
		rng.randf_range(0.0, 360.0),
		rng.randf_range(-8.0, 8.0))
	branch.position = pos + Vector3(0, 0.04, 0)
	branch.material_override = mat
	branch.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	parent.add_child(branch)


func _place_brush(parent: Node3D, pos: Vector3, mat: Material, rng: RandomNumberGenerator) -> void:
	# Low jagged clump — a few small angled boxes for ground vegetation
	var clump := Node3D.new()
	clump.position = pos
	clump.rotation_degrees.y = rng.randf_range(0.0, 360.0)
	for i in 3:
		var blade := MeshInstance3D.new()
		var bm := BoxMesh.new()
		bm.size = Vector3(0.05, rng.randf_range(0.18, 0.32), 0.05)
		blade.mesh = bm
		blade.position = Vector3(
			rng.randf_range(-0.18, 0.18),
			bm.size.y * 0.5,
			rng.randf_range(-0.18, 0.18))
		blade.rotation_degrees = Vector3(
			rng.randf_range(-15.0, 15.0),
			rng.randf_range(0.0, 360.0),
			rng.randf_range(-15.0, 15.0))
		blade.material_override = mat
		blade.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
		clump.add_child(blade)
	parent.add_child(clump)


func _spawn_path_markers(level_root: Node3D, center: Vector3) -> void:
	var pm := Node3D.new()
	pm.name = "PathMarkers"
	pm.set_script(_PATH_MARKERS)
	pm.path_center_z = center.z
	pm.path_length = path_length
	pm.path_hw = path_half_width
	pm.rand_seed = rand_seed
	pm.stake_spacing = stake_spacing
	pm.lantern_every = lantern_every
	level_root.add_child(pm)


func _make_path_mesh(parent: Node3D, center: Vector3, length: float, width: float) -> void:
	# Path is a VISUAL overlay only. The forest floor under it provides
	# collision at y=0, so the player walks on a continuous surface.
	#
	# Trail mesh is extended 28 m PAST the gameplay length on the far side
	# (south end, z direction) so the player never sees the path "end" in
	# a void when they approach the exit trigger. The extension uses a
	# darker, tapered material that visually fades into the forest floor.
	var mi := MeshInstance3D.new()
	mi.name = "GuidedTrailPath"
	mi.position = Vector3(center.x, center.y + 0.02, center.z)
	var bm := BoxMesh.new()
	bm.size = Vector3(width, 0.04, length)
	mi.mesh = bm
	# Atmospheric trail shader — distance + edge dither fade to black so
	# the path doesn't read as a glaring white plastic ramp cutting off
	# into the void. Falls to black past ~14m from the lens and within
	# 25% of each horizontal edge.
	var mat := ShaderMaterial.new()
	mat.shader = load("res://shaders/atmospheric_trail.gdshader")
	mat.set_shader_parameter("dirt_color", Color(0.38, 0.32, 0.22, 1.0))
	mat.set_shader_parameter("fade_far", 14.0)
	mat.set_shader_parameter("fade_band", 3.0)
	mat.set_shader_parameter("edge_fade", 0.22)
	mat.set_shader_parameter("emission_strength", 0.30)
	mi.material_override = mat
	mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	parent.add_child(mi)

	# ── Tapered tail extension ─────────────────────────────────────────────
	# A 28 m strip of darker dirt continuing past the gameplay length on
	# the SOUTH side (the direction the player walks toward). Hides the
	# "path ends in pitch black" effect when approaching the exit trigger.
	# Material is no-emission, slightly darker, so it fades into the
	# forest floor naturally as the player's flashlight loses range.
	var tail_length := 28.0
	var tail := MeshInstance3D.new()
	tail.name = "GuidedTrailPath_Tail"
	# Place it just past the main path on the -Z side
	tail.position = Vector3(
		center.x,
		center.y + 0.018,
		center.z - length * 0.5 - tail_length * 0.5)
	var tail_bm := BoxMesh.new()
	tail_bm.size = Vector3(width * 0.96, 0.04, tail_length)
	tail.mesh = tail_bm
	# Same distance-fade shader as the main path — without it the tail
	# stays lit past the point where the main path has already faded to
	# black, reading as a disconnected floating strip. Darker dirt tone
	# and zero emission so it visually recedes.
	var tail_mat := ShaderMaterial.new()
	tail_mat.shader = load("res://shaders/atmospheric_trail.gdshader")
	tail_mat.set_shader_parameter("dirt_color", Color(0.28, 0.22, 0.14, 1.0))
	tail_mat.set_shader_parameter("fade_far", 14.0)
	tail_mat.set_shader_parameter("fade_band", 3.0)
	tail_mat.set_shader_parameter("edge_fade", 0.22)
	tail_mat.set_shader_parameter("emission_strength", 0.0)
	tail.material_override = tail_mat
	tail.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	parent.add_child(tail)


func _spawn_breadcrumb_lights(level_root: Node3D, center: Vector3, length: float, hw: float) -> void:
	var holder := Node3D.new()
	holder.name = "TrailBreadcrumbs"
	level_root.add_child(holder)
	var z_near := center.z + length * 0.5 - 3.0
	var z_far := center.z - length * 0.5 + 6.0
	var z := z_near
	var n := 0
	while z >= z_far:
		if n % 2 == 0:
			var side: int = 1 if (n % 4 < 2) else -1
			var gl := OmniLight3D.new()
			gl.position = Vector3(side * (hw * 0.35), 0.35, z)
			gl.light_color = Color(0.82, 0.72, 0.48)
			gl.light_energy = 0.32
			gl.omni_range = 8.0
			gl.shadow_enabled = false
			holder.add_child(gl)
		z -= light_spacing
		n += 1
