extends CharacterBody3D

const WALK_SPEED    = 3.8
const SPRINT_SPEED  = 6.0
const MOUSE_SENS_DEFAULT = 0.0025
const BOB_FREQ      = 1.9
const BOB_AMP       = 0.045
const STEP_WALK     = 0.52
const STEP_SPRINT   = 0.33
const INTERACT_DIST = 2.5
const STAMINA_MAX   = 100.0
const STAMINA_DRAIN = 22.0
const STAMINA_REGEN = 14.0

var gravity: float     = ProjectSettings.get_setting("physics/3d/default_gravity")
var stamina: float     = STAMINA_MAX
var cam_pitch: float   = 0.0
var bob_t: float       = 0.0
var step_t: float      = 0.0
var is_sprinting: bool = false
var is_dead: bool      = false
var cam_pitch_smooth: float = 0.0
var _last_safe_pos: Vector3 = Vector3(0, 1.5, 0)
var _safe_pos_timer: float  = 0.0

var camera: Camera3D
var flashlight: Node
var hand_pivot: Node3D
var sanity: Node
var ray: RayCast3D
var _ground_ray: RayCast3D

func _ready() -> void:
	add_to_group("player")

	# Capsule collision — radius 0.35, cylinder 1.8 → total 2.5m, bottom at y=0
	var cap = CapsuleShape3D.new()
	cap.radius = 0.35
	cap.height = 1.8
	var col = CollisionShape3D.new()
	col.shape = cap
	col.position = Vector3(0, 1.25, 0)
	add_child(col)

	# Secondary ground-check ray — catches edge cases is_on_floor() misses
	_ground_ray = RayCast3D.new()
	_ground_ray.name = "GroundRay"
	_ground_ray.target_position = Vector3(0, -0.14, 0)
	_ground_ray.collision_mask = 1
	_ground_ray.enabled = true
	add_child(_ground_ray)

	camera = Camera3D.new()
	camera.name = "Camera3D"
	camera.position = Vector3(0, 1.65, 0)
	camera.fov = 75.0
	camera.near = 0.04  # tightly minimised — prevents geometry intersection artifacts
	camera.far  = 100.0
	add_child(camera)

	hand_pivot = Node3D.new()
	hand_pivot.name = "HandPivot"
	hand_pivot.position = Vector3(0.22, -0.24, -0.32)
	camera.add_child(hand_pivot)

	var torch_mi = MeshInstance3D.new()
	var torch_mesh = CylinderMesh.new()
	torch_mesh.height = 0.22
	torch_mesh.top_radius = 0.020
	torch_mesh.bottom_radius = 0.026
	var torch_mat = StandardMaterial3D.new()
	torch_mat.albedo_color = Color(0.18, 0.18, 0.18)
	torch_mat.roughness = 0.35
	torch_mat.metallic = 0.75
	torch_mat.metallic_specular = 0.6
	torch_mi.mesh = torch_mesh
	torch_mi.material_override = torch_mat
	torch_mi.rotation_degrees.x = -90.0
	torch_mi.position = Vector3(0, 0, 0.08)
	hand_pivot.add_child(torch_mi)

	var fl = SpotLight3D.new()
	fl.name = "Flashlight"
	fl.set_script(preload("res://scripts/player/Flashlight.gd"))
	fl.position = Vector3(0, 0, -0.02)
	fl.spot_range             = 42.0
	fl.spot_angle             = 28.0
	fl.spot_angle_attenuation = 0.85
	fl.light_energy           = 42.0
	fl.light_color            = Color(1.0, 0.96, 0.86)
	fl.light_indirect_energy  = 0.35
	fl.shadow_enabled         = true
	fl.shadow_bias           = 0.025
	fl.shadow_normal_bias    = 1.2
	fl.shadow_blur           = 1.0    # soft shadow edges, less CG
	fl.light_projector       = _make_flashlight_cookie()
	hand_pivot.add_child(fl)
	flashlight = fl

	# Volumetric cone overlay — sits over the SpotLight3D, renders the
	# swirling-dust beam via flashlight_volumetric_vol.gdshader. We use a
	# CylinderMesh with top_radius=0 (i.e. a cone) so the UVs come out
	# along-axis instead of the weird PrismMesh / ConeMesh defaults.
	#
	# Math for sizing: cone length = a visible portion of spot_range
	# (12 m — fog wouldn't realistically be lit much past that), and
	# cone base radius = tan(spot_angle) * length. spot_angle is the
	# HALF-angle in Godot SpotLight3D, so the radius math is direct.
	_build_volumetric_cone(fl, 12.0, 28.0)

	ray = RayCast3D.new()
	ray.name = "InteractRay"
	ray.target_position = Vector3(0, 0, -INTERACT_DIST)
	ray.collision_mask = 4
	camera.add_child(ray)

	var san = Node.new()
	san.name = "SanitySystem"
	san.set_script(preload("res://scripts/player/SanitySystem.gd"))
	add_child(san)
	sanity = san

	GameManager.player_ref = self
	GameManager.sanity_ref = san
	Input.set_mouse_mode(Input.MOUSE_MODE_CAPTURED)
	_spawn_rain()
	# Seed safe position after level has placed us
	await get_tree().process_frame
	_last_safe_pos = global_position
	GameManager.set_checkpoint(global_position)

# Procedural flashlight cookie — irregular blob with lens-dirt streaks
func _make_flashlight_cookie() -> ImageTexture:
	var img = Image.create(64, 64, false, Image.FORMAT_RGB8)
	for y in 64:
		for x in 64:
			var dx = (float(x) - 32.0) / 32.0
			var dy = (float(y) - 32.0) / 32.0
			var d  = sqrt(dx * dx + dy * dy)
			var base = clamp(1.0 - d * 1.12, 0.0, 1.0)
			base = pow(base, 0.60)
			# Concentric lens-dirt rings
			var ring = sin(d * 20.0) * 0.038 * base
			# Radial streak artifacts from lens coating
			var ang    = atan2(dy, dx)
			var streak = sin(ang * 6.0 + d * 4.5) * 0.032 * base
			var val = clamp(base + ring + streak, 0.0, 1.0)
			img.set_pixel(x, y, Color(val, val, val))
	return ImageTexture.create_from_image(img)


# Adds a semi-transparent dust-cone overlay on top of the SpotLight3D so the
# flashlight reads as "light scattering through air" instead of a clinical
# circle on the ground.
#
# length      — cone height in metres (visible portion of the beam)
# half_angle  — degrees; must match the SpotLight3D's spot_angle (which IS
#               the half-angle in Godot 4) so the cone walls line up with
#               the actual light cone.
func _build_volumetric_cone(parent: SpotLight3D, length: float, half_angle: float) -> void:
	var cone := MeshInstance3D.new()
	cone.name = "VolumetricBeam"
	var cm := CylinderMesh.new()
	# CylinderMesh with top_radius=0 produces a cone. Top is at +Y, bottom
	# is at -Y in mesh-local space; we rotate -90° on X so the cone's
	# point ends up at the lens (+Y → -Z) and its base extends forward.
	cm.top_radius = 0.0
	cm.bottom_radius = tan(deg_to_rad(half_angle)) * length
	cm.height = length
	cm.radial_segments = 24
	cm.rings = 1
	cone.mesh = cm
	# Pivot the cone so the TIP sits at the lens (parent position) and the
	# BASE extends forward (-Z). After -90° X rotation, the mesh's +Y axis
	# points to -Z, so we shift the cone forward by length/2.
	cone.rotation_degrees = Vector3(-90.0, 0.0, 0.0)
	cone.position = Vector3(0.0, 0.0, -length * 0.5)
	# Volumetric beam material
	var beam_mat := ShaderMaterial.new()
	beam_mat.shader = load("res://shaders/flashlight_volumetric_vol.gdshader")
	beam_mat.set_shader_parameter("beam_color", Color(0.92, 0.85, 0.70, 1.0))
	beam_mat.set_shader_parameter("density", 0.28)
	beam_mat.set_shader_parameter("dust_speed", 0.45)
	beam_mat.set_shader_parameter("dust_scale", 14.0)
	beam_mat.set_shader_parameter("proximity_fade", 0.35)
	beam_mat.set_shader_parameter("flicker_amount", 0.10)
	cone.material_override = beam_mat
	cone.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	parent.add_child(cone)


func _exit_tree() -> void:
	# Drop autoload references so they don't dangle to a freed CharacterBody3D
	# during scene swaps. Without this, consumers see `is_instance_valid==false`
	# only after the next frame and may try to read .position first.
	if GameManager.player_ref == self:
		GameManager.player_ref = null

func _input(event: InputEvent) -> void:
	if is_dead:
		return
	if event is InputEventMouseMotion and Input.get_mouse_mode() == Input.MOUSE_MODE_CAPTURED:
		var sens = GameManager.mouse_sensitivity if GameManager else MOUSE_SENS_DEFAULT
		rotate_y(-event.relative.x * sens)
		cam_pitch -= event.relative.y * sens
		cam_pitch = clamp(cam_pitch, -1.4, 1.4)
	# Block world-interaction actions while a note/cinematic is on screen
	# (the cinematic UI consumes input separately). Looking is still allowed.
	var playing = GameManager.state == GameManager.GameState.PLAYING
	if playing and event.is_action_pressed("interact"):
		_try_interact()
	if playing and event.is_action_pressed("flashlight_toggle"):
		if flashlight and flashlight.has_method("toggle"):
			flashlight.toggle()

func _is_grounded() -> bool:
	return is_on_floor() or (_ground_ray.is_colliding() and velocity.y <= 0.05)

func _physics_process(delta: float) -> void:
	if is_dead:
		return
	if not _is_grounded():
		velocity.y -= gravity * delta

	var san_val = sanity.sanity if sanity else 100.0
	is_sprinting = Input.is_action_pressed("sprint") and stamina > 5.0 and san_val > 12.0
	var speed = SPRINT_SPEED if is_sprinting else WALK_SPEED
	var input = Input.get_vector("move_left", "move_right", "move_forward", "move_back")
	var dir   = (transform.basis * Vector3(input.x, 0.0, input.y)).normalized()

	if dir.length() > 0.01:
		velocity.x = dir.x * speed
		velocity.z = dir.z * speed
		_tick_footstep(delta, speed)
		_tick_bob(delta, speed)
		if is_sprinting and sanity:
			sanity.drain(0.7 * delta)
	else:
		velocity.x = move_toward(velocity.x, 0.0, speed)
		velocity.z = move_toward(velocity.z, 0.0, speed)
		bob_t = lerpf(bob_t, 0.0, delta * 6.0)

	move_and_slide()

	# Track last safe ground position; teleport back if clipped through floor
	if _is_grounded():
		_safe_pos_timer += delta
		if _safe_pos_timer >= 0.4:
			_safe_pos_timer = 0.0
			_last_safe_pos = global_position
			GameManager.set_checkpoint(global_position)
	else:
		_safe_pos_timer = 0.0
	if global_position.y < -5.0:
		global_position = _last_safe_pos
		velocity = Vector3.ZERO

	_update_stamina(delta)
	_apply_sanity_tilt(delta)
	cam_pitch_smooth = lerpf(cam_pitch_smooth, cam_pitch, delta * 9.0)
	# Layer JumpscareSystem shake on top of pitch/roll so it actually
	# survives the per-frame camera rotation rewrite.
	var shake = JumpscareSystem.get_shake_offset() if JumpscareSystem else Vector2.ZERO
	camera.rotation.x = cam_pitch_smooth + shake.x
	camera.rotation.z += shake.y
	if hand_pivot:
		hand_pivot.position.x = lerpf(hand_pivot.position.x, 0.22 + sin(bob_t * 0.5) * 0.006, delta * 7.0)
		hand_pivot.position.y = lerpf(hand_pivot.position.y, -0.24 + sin(bob_t) * -0.009, delta * 7.0)

func _update_stamina(delta: float) -> void:
	if is_sprinting:
		stamina = max(0.0, stamina - STAMINA_DRAIN * delta)
	else:
		stamina = min(STAMINA_MAX, stamina + STAMINA_REGEN * delta)

func _tick_footstep(delta: float, _speed: float) -> void:
	step_t += delta
	var interval = STEP_SPRINT if is_sprinting else STEP_WALK
	if step_t >= interval:
		step_t = 0.0
		AudioManager.play_footstep()

func _tick_bob(delta: float, speed: float) -> void:
	bob_t += delta * BOB_FREQ * (speed / WALK_SPEED)
	camera.position.y = lerpf(camera.position.y, sin(bob_t) * BOB_AMP + 1.65, delta * 12.0)
	camera.position.x = lerpf(camera.position.x, cos(bob_t * 0.5) * BOB_AMP * 0.4, delta * 8.0)

func _apply_sanity_tilt(delta: float) -> void:
	if not sanity:
		return
	var s = sanity.sanity
	if s < 40.0:
		var intensity = (40.0 - s) / 40.0
		var tilt = sin(Time.get_ticks_msec() * 0.0007) * 0.06 * intensity
		camera.rotation.z = lerpf(camera.rotation.z, tilt, delta * 2.5)
	else:
		camera.rotation.z = lerpf(camera.rotation.z, 0.0, delta * 3.0)

func _spawn_rain() -> void:
	var rain = CPUParticles3D.new()
	rain.name = "Rain"
	rain.amount = 48
	rain.lifetime = 1.2
	rain.emitting = true
	rain.emission_shape = CPUParticles3D.EMISSION_SHAPE_BOX
	rain.emission_box_extents = Vector3(10, 0.1, 10)
	rain.position = Vector3(0, 6, -1)
	rain.direction = Vector3(0, -1, 0)
	rain.spread = 2.0
	rain.initial_velocity_min = 10.0
	rain.initial_velocity_max = 15.0
	rain.gravity = Vector3(0, 0, 0)
	rain.process_mode = Node.PROCESS_MODE_ALWAYS
	rain.scale_amount_min = 0.7
	rain.scale_amount_max = 1.0
	var rain_mat = StandardMaterial3D.new()
	rain_mat.albedo_color = Color(0.60, 0.68, 0.82, 0.22)
	rain_mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	rain_mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	var rain_mesh = CapsuleMesh.new()
	rain_mesh.radius = 0.005
	rain_mesh.height = 0.06
	rain_mesh.material = rain_mat
	rain.mesh = rain_mesh
	add_child(rain)

func _try_interact() -> void:
	if ray and ray.is_colliding():
		var target = ray.get_collider()
		if target and target.has_method("interact"):
			target.interact(self)

func die() -> void:
	if is_dead:
		return
	is_dead = true
	Input.set_mouse_mode(Input.MOUSE_MODE_VISIBLE)
	JumpscareSystem.trigger(JumpscareSystem.Intensity.MAX)
	await get_tree().create_timer(2.0).timeout
	GameManager.trigger_game_over()

func get_look_direction() -> Vector3:
	return -camera.global_transform.basis.z

func get_flashlight() -> Node:
	return flashlight

func is_ghost_in_flashlight(ghost_pos: Vector3) -> bool:
	if not flashlight or not flashlight.is_on or flashlight._dead:
		return false
	return flashlight.is_ghost_in_beam(ghost_pos)
