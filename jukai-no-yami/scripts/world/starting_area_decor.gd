extends Node3D
## Self-contained minimalist procedural vehicle generator.
##
## Usage:
##   1. Create a Node3D in your scene at the spot you want the car.
##   2. Attach this script.
##   3. Done — _ready() builds the entire car.
##
## Builds a cohesive low-poly abandoned vehicle from primitives only:
##   • Chassis: dark slate-grey BoxMesh
##   • Cabin:   smaller offset BoxMesh
##   • Wheels:  four CylinderMeshes rotated so the axis runs along X
##   • Lights:  two small neon-crimson emissive BoxMeshes at the rear
##
## Uses PhysicsRayQueryParameters3D one frame after spawn to snap the
## chassis bottom to whatever floor collision body sits below.

# Vehicle dimensions (metres). Tweak in the Inspector before play.
@export var length: float = 3.6
@export var width: float = 1.66
@export var chassis_height: float = 0.62
@export var cabin_height: float = 0.66
@export var wheel_radius: float = 0.32
@export var wheel_width: float = 0.20
@export var yaw_deg: float = 0.0

# Materials (assigned procedurally in _ready). Typed as base Material so
# the body / light slots can hold either ShaderMaterial (cell-shaded car)
# or StandardMaterial3D depending on the implementation.
var _body_mat: Material
var _wheel_mat: Material
var _light_mat: Material
var _window_mat: Material

func _ready() -> void:
	rotation_degrees.y = yaw_deg
	_make_materials()
	_build_chassis()
	_build_cabin()
	_build_wheels()
	_build_lights()
	# One-frame deferral so the floor StaticBody is in the physics space
	# before we query it.
	call_deferred("_snap_chassis_to_ground")

func _make_materials() -> void:
	# Body — cell-shaded dark ash grey. The new cell_car shader locks the
	# faces into discrete shade bands instead of smooth gradients, giving
	# the stylised flat look the design brief asks for. Same shader is
	# reused (with emit_amount > 0) for the taillights below.
	var car_shader: Shader = load("res://shaders/cell_car.gdshader")

	var body_shader_mat := ShaderMaterial.new()
	body_shader_mat.shader = car_shader
	body_shader_mat.set_shader_parameter("body_color", Color(0.20, 0.20, 0.22, 1.0))
	body_shader_mat.set_shader_parameter("shadow_color", Color(0.05, 0.05, 0.06, 1.0))
	body_shader_mat.set_shader_parameter("band_count", 3)
	body_shader_mat.set_shader_parameter("emit_amount", 0.0)
	_body_mat = body_shader_mat

	# Wheels — near-black rubber (StandardMaterial3D, simple and matte)
	_wheel_mat = StandardMaterial3D.new()
	_wheel_mat.albedo_color = Color(0.05, 0.05, 0.05)
	_wheel_mat.roughness = 0.96
	_wheel_mat.metallic = 0.0

	# Taillights — same cell shader with emit_amount cranked. Output is
	# flat neon crimson, no PBR specular highlights, ready to bloom.
	var light_shader_mat := ShaderMaterial.new()
	light_shader_mat.shader = car_shader
	light_shader_mat.set_shader_parameter("body_color", Color(0.55, 0.04, 0.04, 1.0))
	light_shader_mat.set_shader_parameter("shadow_color", Color(0.42, 0.02, 0.02, 1.0))
	light_shader_mat.set_shader_parameter("band_count", 2)
	light_shader_mat.set_shader_parameter("emit_color", Color(0.95, 0.08, 0.06, 1.0))
	light_shader_mat.set_shader_parameter("emit_amount", 1.0)
	_light_mat = light_shader_mat

	# Windows — almost-black tinted glass (StandardMaterial3D keeps the
	# slight reflective sheen that makes the windscreen read as glass).
	_window_mat = StandardMaterial3D.new()
	_window_mat.albedo_color = Color(0.04, 0.05, 0.07)
	_window_mat.roughness = 0.18
	_window_mat.metallic = 0.10

func _build_chassis() -> void:
	# Lower hull — main BoxMesh that sets the silhouette
	var hull := MeshInstance3D.new()
	var hm := BoxMesh.new()
	hm.size = Vector3(width, chassis_height, length)
	hull.mesh = hm
	hull.position = Vector3(0, wheel_radius + chassis_height * 0.5, 0)
	hull.material_override = _body_mat
	add_child(hull)

func _build_cabin() -> void:
	# Smaller box on top, offset slightly toward the rear for a hatchback
	# silhouette. Front and rear "glass strips" are separate boxes.
	var cabin_y := wheel_radius + chassis_height + cabin_height * 0.5
	var cabin := MeshInstance3D.new()
	var cm := BoxMesh.new()
	cm.size = Vector3(width * 0.86, cabin_height, length * 0.50)
	cabin.mesh = cm
	cabin.position = Vector3(0, cabin_y, -length * 0.05)
	cabin.material_override = _body_mat
	add_child(cabin)

	# Front windscreen
	var front_w := MeshInstance3D.new()
	var fwm := BoxMesh.new()
	fwm.size = Vector3(width * 0.78, cabin_height * 0.55, 0.04)
	front_w.mesh = fwm
	front_w.position = Vector3(0, cabin_y + 0.05, length * 0.16)
	front_w.rotation_degrees.x = -22.0
	front_w.material_override = _window_mat
	add_child(front_w)

	# Rear windscreen
	var rear_w := MeshInstance3D.new()
	var rwm := BoxMesh.new()
	rwm.size = Vector3(width * 0.74, cabin_height * 0.50, 0.04)
	rear_w.mesh = rwm
	rear_w.position = Vector3(0, cabin_y + 0.05, -length * 0.26)
	rear_w.rotation_degrees.x = 24.0
	rear_w.material_override = _window_mat
	add_child(rear_w)

	# Side windows
	for side: float in [-1.0, 1.0]:
		var sw := MeshInstance3D.new()
		var swm := BoxMesh.new()
		swm.size = Vector3(0.05, cabin_height * 0.55, length * 0.40)
		sw.mesh = swm
		sw.position = Vector3(side * (width * 0.44), cabin_y + 0.05, -length * 0.05)
		sw.material_override = _window_mat
		add_child(sw)

func _build_wheels() -> void:
	# Wheelbase: 30% of length in from each end
	var wheelbase_half := length * 0.35
	var track_half := width * 0.48
	for fz: float in [wheelbase_half, -wheelbase_half]:
		for fx: float in [-track_half, track_half]:
			var w := MeshInstance3D.new()
			var wm := CylinderMesh.new()
			wm.top_radius = wheel_radius
			wm.bottom_radius = wheel_radius
			wm.height = wheel_width
			wm.radial_segments = 18
			w.mesh = wm
			# Rotate so the axis runs along X (the wheel spins forward)
			w.rotation_degrees = Vector3(0.0, 0.0, 90.0)
			w.position = Vector3(fx, wheel_radius, fz)
			w.material_override = _wheel_mat
			add_child(w)

func _build_lights() -> void:
	# Two small neon-crimson taillights, inset into the rear of the chassis
	var light_y := wheel_radius + chassis_height * 0.55
	for side: float in [-1.0, 1.0]:
		var tl := MeshInstance3D.new()
		var tlm := BoxMesh.new()
		tlm.size = Vector3(0.22, 0.10, 0.04)
		tl.mesh = tlm
		tl.position = Vector3(side * (width * 0.34), light_y, -length * 0.50)
		tl.material_override = _light_mat
		add_child(tl)

	# Two small white headlights at the front for visual symmetry
	var hl_mat := StandardMaterial3D.new()
	hl_mat.albedo_color = Color(0.90, 0.88, 0.78)
	hl_mat.emission_enabled = true
	hl_mat.emission = Color(0.95, 0.90, 0.76)
	hl_mat.emission_energy_multiplier = 0.30
	for side: float in [-1.0, 1.0]:
		var hl := MeshInstance3D.new()
		var hlm := BoxMesh.new()
		hlm.size = Vector3(0.22, 0.10, 0.04)
		hl.mesh = hlm
		hl.position = Vector3(side * (width * 0.34), light_y, length * 0.50)
		hl.material_override = hl_mat
		add_child(hl)

# Raycast from 50 m above this node straight down; if the ray hits a
# collider, lower the chassis so the wheels rest on the hit point.
func _snap_chassis_to_ground() -> void:
	if not is_inside_tree():
		return
	var space := get_world_3d().direct_space_state
	if not space:
		return
	var origin := global_position
	var query := PhysicsRayQueryParameters3D.create(
		Vector3(origin.x, origin.y + 50.0, origin.z),
		Vector3(origin.x, origin.y - 50.0, origin.z))
	query.collision_mask = 1
	var result := space.intersect_ray(query)
	if result and result.has("position"):
		var hit: Vector3 = result["position"]
		global_position = Vector3(origin.x, hit.y, origin.z)
