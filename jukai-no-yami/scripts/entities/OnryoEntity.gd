extends CharacterBody3D

enum State { DORMANT, STALKING, CLOSE_STALK, CHARGING, REPELLED }

const STALK_SPEED    = 1.85
const CHARGE_SPEED   = 7.0
const CHARGE_DIST    = 2.5
const CLOSE_DIST     = 5.0
const LOOK_THRESHOLD = 0.86

@export var ghost_id: int         = 10
@export var spawn_on_sanity: bool = true

var state: State    = State.DORMANT
var _gravity: float = ProjectSettings.get_setting("physics/3d/default_gravity")
var _repel_t: float = 0.0
var _charge_dir: Vector3
var _player: CharacterBody3D = null
var _spawned: bool  = false
var _revealed: bool = false
var anim: AnimationPlayer = null
var audio: AudioStreamPlayer3D = null

func _ready() -> void:
	add_to_group("ghost")
	add_to_group("onryo")

	var cap = CapsuleShape3D.new()
	cap.radius = 0.4
	cap.height = 1.7
	var col = CollisionShape3D.new()
	col.shape = cap
	col.position = Vector3(0, 0.85, 0)
	add_child(col)

	audio = AudioStreamPlayer3D.new()
	audio.bus = "Ghost" if AudioServer.get_bus_index("Ghost") >= 0 else "Master"
	audio.max_distance = 25.0
	add_child(audio)

	_build_ghost_mesh()

	visible = false
	set_physics_process(false)
	# Sanity-critical spawning used to be wired via a signal connection here,
	# but levels add the Onryo before the Player exists, so sanity_ref is
	# null in _ready and the connection silently failed — Onryo_Sanity never
	# fired. Use a poll in _process instead; it doesn't care about init order.

func _process(_delta: float) -> void:
	if _spawned or not spawn_on_sanity:
		return
	if GameManager.state != GameManager.GameState.PLAYING:
		return
	if not GameManager.sanity_ref or not GameManager.player_ref:
		return
	# README documents this as the 35% threshold.
	if GameManager.sanity_ref.sanity <= 35.0:
		_spawned = true
		spawn_behind_player()

func spawn_behind_player() -> void:
	_player = GameManager.player_ref
	if not _player:
		return
	var behind = _player.global_position - _player.get_look_direction() * 9.0
	behind.y = _player.global_position.y
	global_position = behind
	_activate()

func teleport_close_silent() -> void:
	_player = GameManager.player_ref
	if not _player:
		return
	var angle = _player.rotation.y + PI + randf_range(-0.4, 0.4)
	var offset = Vector3(sin(angle) * 3.8, 0.0, cos(angle) * 3.8)
	global_position = _player.global_position + offset
	global_position.y = _player.global_position.y
	visible = true
	state = State.CLOSE_STALK
	set_physics_process(true)

func _activate() -> void:
	state = State.STALKING
	visible = true
	set_physics_process(true)
	AudioManager.play_ghost_sound("onryo_growl")
	if GameManager.sanity_ref:
		GameManager.sanity_ref.drain(14.0)

func _physics_process(delta: float) -> void:
	if GameManager.state != GameManager.GameState.PLAYING:
		return
	_player = GameManager.player_ref
	if not _player:
		return
	if not is_on_floor():
		velocity.y -= _gravity * delta
	match state:
		State.STALKING:    _handle_stalk(delta)
		State.CLOSE_STALK: _handle_close_stalk(delta)
		State.CHARGING:    _handle_charge(delta)
		State.REPELLED:    _handle_repelled(delta)

func _handle_stalk(_delta: float) -> void:
	var fl = _player.get_node_or_null("Camera3D/HandPivot/Flashlight")
	if fl and fl.check_beam_entry(ghost_id, global_position):
		_on_beam_reveal()
	if _is_in_beam_and_looked_at():
		velocity = Vector3.ZERO
		if GameManager.sanity_ref:
			GameManager.sanity_ref.set_ghost_visible(true)
		move_and_slide()
		return
	if GameManager.sanity_ref:
		GameManager.sanity_ref.set_ghost_visible(false)
	var dist = global_position.distance_to(_player.global_position)
	if dist <= CLOSE_DIST:
		state = State.CLOSE_STALK
		return
	var dir = (_player.global_position - global_position)
	dir.y = 0.0
	if dir.length() > 0.1:
		dir = dir.normalized()
		velocity.x = dir.x * STALK_SPEED
		velocity.z = dir.z * STALK_SPEED
		look_at(Vector3(_player.global_position.x, global_position.y, _player.global_position.z), Vector3.UP)
	move_and_slide()

func _handle_close_stalk(delta: float) -> void:
	var fl = _player.get_node_or_null("Camera3D/HandPivot/Flashlight")
	if fl and fl.check_beam_entry(ghost_id, global_position):
		_on_beam_reveal()
	if _is_in_beam_and_looked_at():
		velocity = Vector3.ZERO
		if GameManager.sanity_ref:
			GameManager.sanity_ref.set_ghost_visible(true)
			GameManager.sanity_ref.drain(4.0 * delta)
		move_and_slide()
		return
	if GameManager.sanity_ref:
		GameManager.sanity_ref.set_ghost_visible(false)
	var dist = global_position.distance_to(_player.global_position)
	if dist <= CHARGE_DIST:
		_begin_charge()
		return
	elif dist > CLOSE_DIST * 2.5:
		state = State.STALKING
	var dir = (_player.global_position - global_position)
	dir.y = 0.0
	if dir.length() > 0.1:
		velocity.x = dir.normalized().x * STALK_SPEED * 0.6
		velocity.z = dir.normalized().z * STALK_SPEED * 0.6
	move_and_slide()

func _handle_charge(_delta: float) -> void:
	velocity.x = _charge_dir.x * CHARGE_SPEED
	velocity.z = _charge_dir.z * CHARGE_SPEED
	move_and_slide()
	var dist = global_position.distance_to(_player.global_position)
	if dist <= 0.85:
		if _player.has_method("die"):
			_player.die()
	elif dist > 15.0:
		velocity = Vector3.ZERO
		state = State.STALKING

func _handle_repelled(delta: float) -> void:
	_repel_t += delta
	velocity = velocity.move_toward(Vector3.ZERO, delta * 4.0)
	move_and_slide()
	if _repel_t >= 10.0:
		state = State.STALKING

func _on_beam_reveal() -> void:
	if not _revealed:
		_revealed = true
		JumpscareSystem.trigger_flashlight_reveal("onryo", JumpscareSystem.Intensity.MAX)
		AudioManager.play_ghost_sound("onryo_growl")
		if GameManager.sanity_ref:
			GameManager.sanity_ref.drain(20.0)

func _is_in_beam_and_looked_at() -> bool:
	if not _player:
		return false
	var in_beam = _player.is_ghost_in_flashlight(global_position)
	var looked = _player.get_look_direction().dot((global_position - _player.global_position).normalized()) > LOOK_THRESHOLD
	return in_beam and looked

func _begin_charge() -> void:
	state = State.CHARGING
	_charge_dir = (_player.global_position - global_position).normalized()
	JumpscareSystem.trigger(JumpscareSystem.Intensity.HARD)
	AudioManager.play_ghost_sound("onryo_growl")

func repel() -> void:
	state = State.REPELLED
	_repel_t = 0.0
	var away = (global_position - _player.global_position).normalized()
	velocity = away * 6.0
	AudioManager.play_ghost_sound("onryo_growl")

func _build_ghost_mesh() -> void:
	var body = Node3D.new()
	body.name = "GhostBody"
	add_child(body)

	# Body — reddish vengeful spirit, more solid
	var bm = CapsuleMesh.new()
	bm.radius = 0.37; bm.height = 1.55
	var bmi = MeshInstance3D.new()
	bmi.mesh = bm; bmi.position = Vector3(0, 0.82, 0)
	bmi.material_override = _onryo_mat(Color(0.92, 0.72, 0.72), 0.88)
	body.add_child(bmi)

	# Head
	var hm = SphereMesh.new()
	hm.radius = 0.30; hm.height = 0.60
	var hmi = MeshInstance3D.new()
	hmi.mesh = hm; hmi.position = Vector3(0, 1.64, 0)
	hmi.material_override = _onryo_mat(Color(0.95, 0.78, 0.74), 0.92)
	body.add_child(hmi)

	# Hair (matted, dark red-black)
	var hair_m = CapsuleMesh.new()
	hair_m.radius = 0.22; hair_m.height = 1.10
	var hair_mi = MeshInstance3D.new()
	hair_mi.mesh = hair_m; hair_mi.position = Vector3(0.04, 1.28, -0.10)
	var hair_mat = StandardMaterial3D.new()
	hair_mat.albedo_color = Color(0.10, 0.03, 0.03, 0.96)
	hair_mat.roughness = 0.96; hair_mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	hair_mi.material_override = hair_mat
	body.add_child(hair_mi)

	# Eyes — red-glowing rage
	for side in [-1, 1]:
		var em = SphereMesh.new()
		em.radius = 0.054; em.height = 0.108
		var emi = MeshInstance3D.new()
		emi.mesh = em; emi.position = Vector3(side * 0.096, 1.68, 0.25)
		var eye_mat = StandardMaterial3D.new()
		eye_mat.albedo_color = Color(0.55, 0.02, 0.02)
		eye_mat.emission_enabled = true
		eye_mat.emission = Color(0.9, 0.05, 0.05) * 0.55
		eye_mat.roughness = 0.1
		emi.material_override = eye_mat
		body.add_child(emi)

	# Mouth — wider, open in a silent scream
	for row in range(2):
		var mm = BoxMesh.new()
		mm.size = Vector3(0.17 - row * 0.04, 0.04, 0.02)
		var mmi = MeshInstance3D.new()
		mmi.mesh = mm
		mmi.position = Vector3(0, 1.555 - row * 0.055, 0.27)
		var mouth_mat = StandardMaterial3D.new()
		mouth_mat.albedo_color = Color(0.06, 0.01, 0.01)
		mouth_mat.roughness = 0.9
		mmi.material_override = mouth_mat
		body.add_child(mmi)

func _onryo_mat(col: Color, alpha: float) -> ShaderMaterial:
	var m = ShaderMaterial.new()
	m.shader = load("res://shaders/ghost_material.gdshader")
	col.a = alpha
	m.set_shader_parameter("ghost_color", col)
	m.set_shader_parameter("edge_glow", 2.0)
	m.set_shader_parameter("distort_speed", 1.2)
	m.set_shader_parameter("distort_amount", 0.024)
	m.set_shader_parameter("flicker_speed", 6.5)
	return m
