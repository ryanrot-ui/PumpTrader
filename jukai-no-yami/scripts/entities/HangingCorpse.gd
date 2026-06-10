extends Node3D
## A real hanging corpse — not the existing ghost-shader HangingSpirit. A man
## who killed himself in the forest, suspended by a rope around his neck from
## a tree branch overhead. A suicide note rests on the ground in front of him.
##
## Encounter flow:
##   1. Player approaches → unsettling whispers begin within 10 m.
##   2. Player interacts with the note → it can be read in the standard
##      note-reader UI.
##   3. The MOMENT the note is collected:
##        - An aggressive Yurei materializes RIGHT AT the corpse.
##        - The "走れ！" (RUN) subtitle fires.
##        - A heavy proximity-based sanity drain kicks in (up to 9 sanity/sec
##          at point-blank, scaling down past 18 m).
##   4. Player must put distance between themselves and the corpse. Once
##      they have stayed past SAFE_DISTANCE for ESCAPE_HOLD seconds the
##      encounter resolves: Yurei dissipates, drain stops.
##   5. Failure mode: sanity hits zero and Player.die() fires.

@export var corpse_id: int = 0
@export var hang_height: float = 4.2      # tree branch height above ground

# Sayuri's note foreshadows the yurei's method — she calls to victims in
# the voices of people they love. The player reads this BEFORE finding
# Hanako's diary (note 2: "if you hear my voice, do not follow it").
const NOTE_DATA = {
	"title_jp": "遺書 — さゆり",
	"title_en": "Suicide Note — Sayuri",
	"text_jp": "「三日前から、母の声がする。\nお前は知っているはずだ。母は五年前に死んだ。\nそれでも、木々の間から私を呼ぶ。\n昨日、白い着物の女を見た。\n口が動いていた。母の声で。\n\nもう疲れた。呼ばれたら、行くしかない。」",
	"text_en": "'For three days I have heard my mother's voice.\nYou understand — my mother died five years ago.\nStill, she calls me from between the trees.\nYesterday I saw a woman in a white kimono.\nHer mouth was moving. With my mother's voice.\n\nI am so tired. When you are called, you go.'",
}

const PROXIMITY_RANGE   := 18.0   # within this — heavy sanity drain
const POINT_BLANK_RANGE :=  4.0   # within this — maximum drain
const MAX_DRAIN_PER_SEC := 9.0
const SAFE_DISTANCE     := 28.0   # stay past this for ESCAPE_HOLD to win
const ESCAPE_HOLD       :=  3.0
const ENCOUNTER_TIMEOUT := 90.0   # absolute cap so the ghost doesn't haunt forever
const WHISPER_RANGE     := 14.0   # ambient whispers trigger inside this

const _YUREI_SCENE := preload("res://scenes/entities/YureiEntity.tscn")

var _note_collected: bool = false
var _encounter_active: bool = false
var _encounter_t: float = 0.0
var _escape_t: float = 0.0
var _whisper_t: float = 0.0
var _spawned_yurei: Node = null
var _prompt: Label3D
var _area: Area3D
var _note_collider: StaticBody3D
var _player_in_range: bool = false


func _ready() -> void:
	add_to_group("interactable")
	add_to_group("hanging_corpse")
	_build_corpse()
	_build_note_collider()
	_build_prompt()
	_build_area()
	_build_atmosphere()


# Cold moonlight column + drifting dust motes around the body. Makes the
# corpse visible at a distance through the trees and gives the area a
# distinct "wrong" feeling without needing a unique shader.
func _build_atmosphere() -> void:
	# A SMALL cold spotlight from directly above. The previous version
	# used an OmniLight at energy 1.85 which combined with the bloom
	# post-process turned the whole figure into a blown-out white pillar
	# (visible in playtest screenshots). A tight SpotLight aimed down
	# picks out the body without overexposing it.
	var moonlight := SpotLight3D.new()
	moonlight.position = Vector3(0, hang_height + 0.5, 0)
	moonlight.rotation_degrees = Vector3(-90.0, 0.0, 0.0)
	moonlight.light_color = Color(0.46, 0.58, 0.78)
	moonlight.light_energy = 0.55
	moonlight.spot_range = hang_height + 1.5
	moonlight.spot_angle = 24.0
	moonlight.spot_angle_attenuation = 1.2
	moonlight.shadow_enabled = false
	add_child(moonlight)

	# Drifting dust motes — sparse upward float
	var dust := CPUParticles3D.new()
	dust.amount = 18
	dust.lifetime = 6.5
	dust.emitting = true
	dust.emission_shape = CPUParticles3D.EMISSION_SHAPE_BOX
	dust.emission_box_extents = Vector3(1.0, 1.4, 1.0)
	dust.position = Vector3(0, 1.4, 0)
	dust.direction = Vector3(0, 1, 0)
	dust.spread = 18.0
	dust.initial_velocity_min = 0.04
	dust.initial_velocity_max = 0.10
	dust.gravity = Vector3(0, 0.0, 0)
	dust.scale_amount_min = 0.4
	dust.scale_amount_max = 1.0
	var dust_mat := StandardMaterial3D.new()
	dust_mat.albedo_color = Color(0.78, 0.84, 0.96, 0.18)
	dust_mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	dust_mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	dust_mat.billboard_mode = BaseMaterial3D.BILLBOARD_ENABLED
	var dust_mesh := QuadMesh.new()
	dust_mesh.size = Vector2(0.03, 0.03)
	dust_mesh.material = dust_mat
	dust.mesh = dust_mesh
	add_child(dust)


func _process(delta: float) -> void:
	if GameManager.state != GameManager.GameState.PLAYING:
		return
	if not GameManager.player_ref:
		return

	# Ambient whispers when the player is in proximity (before pickup)
	if not _note_collected:
		var dist_pre := global_position.distance_to(GameManager.player_ref.global_position)
		if dist_pre <= WHISPER_RANGE:
			_whisper_t += delta
			if _whisper_t >= 8.0:
				_whisper_t = 0.0
				AudioManager.play_whisper()
		return

	# Encounter loop — only runs after the note has been collected.
	if not _encounter_active:
		return
	_encounter_t += delta
	var dist := global_position.distance_to(GameManager.player_ref.global_position)

	# Sanity drain — scales from MAX_DRAIN_PER_SEC at point-blank down to 0
	# at PROXIMITY_RANGE. Past PROXIMITY_RANGE, no drain (player is escaping).
	if dist <= PROXIMITY_RANGE and GameManager.sanity_ref:
		var t: float = 1.0 - smoothstep(POINT_BLANK_RANGE, PROXIMITY_RANGE, dist)
		var drain: float = MAX_DRAIN_PER_SEC * t
		GameManager.sanity_ref.drain(drain * delta)

	# Escape detection: stay past SAFE_DISTANCE for ESCAPE_HOLD seconds.
	if dist >= SAFE_DISTANCE:
		_escape_t += delta
		if _escape_t >= ESCAPE_HOLD:
			_resolve_encounter()
			return
	else:
		_escape_t = 0.0

	# Hard timeout — release the player even if they're huddled in range
	if _encounter_t >= ENCOUNTER_TIMEOUT:
		_resolve_encounter()


# Called by the player's interact ray on the note collider.
func interact(_player: CharacterBody3D) -> void:
	if _note_collected:
		return
	_note_collected = true
	_prompt.visible = false
	AudioManager.play_sfx("note_pickup")
	if GameManager.ui_ref and GameManager.ui_ref.has_method("show_note"):
		# show_note awaits — when it returns the player has dismissed the
		# note reader. THAT is the moment the encounter should start, so the
		# yurei doesn't materialize while the reader UI is on screen.
		await GameManager.ui_ref.show_note(NOTE_DATA)
	_start_encounter()


func _start_encounter() -> void:
	if _encounter_active:
		return
	_encounter_active = true
	_encounter_t = 0.0
	_escape_t = 0.0
	# Spawn the yurei right at the corpse position and force it into pursuit.
	_spawned_yurei = _YUREI_SCENE.instantiate()
	_spawned_yurei.name = "Yurei_FromCorpse_%d" % corpse_id
	_spawned_yurei.position = global_position
	get_parent().add_child(_spawned_yurei)
	# Make it visible + chase the player. activate() puts it in IDLE_DISTANT;
	# we then poke it into CRAWLING so it pursues immediately instead of
	# waiting for the player to wander within 6 m.
	if _spawned_yurei.has_method("activate"):
		_spawned_yurei.activate()
		_spawned_yurei.state = _spawned_yurei.State.CRAWLING
	AudioManager.play_ghost_sound("yurei_shriek")
	AudioManager.play_ghost_sound("hair_drag")
	JumpscareSystem.trigger(JumpscareSystem.Intensity.HARD)
	# UI alert — "RUN!"
	if GameManager.ui_ref and GameManager.ui_ref.has_method("show_subtitle"):
		GameManager.ui_ref.show_subtitle("走れ！ / RUN — DON'T LOOK BACK", 4.0)


func _resolve_encounter() -> void:
	_encounter_active = false
	# Dissipate the yurei — bleed it out instead of popping it
	if is_instance_valid(_spawned_yurei):
		if _spawned_yurei.has_method("_vanish"):
			_spawned_yurei._vanish()
		else:
			_spawned_yurei.queue_free()
	_spawned_yurei = null
	if GameManager.ui_ref and GameManager.ui_ref.has_method("show_subtitle"):
		GameManager.ui_ref.show_subtitle(
			"距離が離れた… 心が落ち着く / The presence fades.", 3.0)


# ─── Corpse mesh ──────────────────────────────────────────────────────────────
# Hand-built humanoid out of primitives. Pale dead skin, head tilted, noose
# around the neck, rope running up to the hanging point. Distinct from the
# translucent ghost-shader HangingSpirit — this is a body.

func _build_corpse() -> void:
	# Female hanging victim — proper humanoid anatomy out of primitives.
	# Body is built around an internal skeleton: feet → shins → knees →
	# thighs → hips → waist → chest → shoulders → neck → head, plus arms
	# split into upper arm → elbow → forearm → wrist → hand. Each joint
	# uses a small sphere to soften the cylinder transitions so the body
	# no longer reads as "stacked cylinders".
	#
	# The CORPSE uses StandardMaterial3D (real dead body). The ghost that
	# spawns from it uses the corpse_anomaly shader (see YureiEntity).

	# All visible body parts now use the glitching_anomaly shader so the
	# corpse reads as a matte-black silhouette edged in crimson rim, NOT
	# a stack of pale snowman spheres. Each material instance shares the
	# same shader but configures slightly different jitter frequencies
	# so head / arms / legs don't all twist in lock-step.
	var anomaly := load("res://shaders/glitching_anomaly.gdshader") as Shader

	var skin := ShaderMaterial.new()
	skin.shader = anomaly
	skin.set_shader_parameter("core_color", Color(0.0, 0.0, 0.0, 1.0))
	skin.set_shader_parameter("rim_color", Color(0.95, 0.05, 0.08, 1.0))
	skin.set_shader_parameter("rim_power", 4.8)
	skin.set_shader_parameter("rim_bleed", 2.2)
	skin.set_shader_parameter("jitter_amp", 0.012)
	skin.set_shader_parameter("jitter_freq", 4.0)
	skin.set_shader_parameter("freq_x_mul", 1.0)
	skin.set_shader_parameter("freq_y_mul", 1.6)
	skin.set_shader_parameter("freq_z_mul", 0.7)

	var kimono_mat := ShaderMaterial.new()
	kimono_mat.shader = anomaly
	kimono_mat.set_shader_parameter("core_color", Color(0.02, 0.0, 0.0, 1.0))
	kimono_mat.set_shader_parameter("rim_color", Color(0.85, 0.92, 1.0, 1.0))   # pale white rim
	kimono_mat.set_shader_parameter("rim_power", 5.2)
	kimono_mat.set_shader_parameter("rim_bleed", 1.8)
	kimono_mat.set_shader_parameter("jitter_amp", 0.020)
	kimono_mat.set_shader_parameter("jitter_freq", 3.6)
	kimono_mat.set_shader_parameter("freq_x_mul", 1.3)
	kimono_mat.set_shader_parameter("freq_y_mul", 0.9)
	kimono_mat.set_shader_parameter("freq_z_mul", 1.7)

	var sash_mat := ShaderMaterial.new()
	sash_mat.shader = anomaly
	sash_mat.set_shader_parameter("core_color", Color(0.05, 0.0, 0.0, 1.0))
	sash_mat.set_shader_parameter("rim_color", Color(1.0, 0.20, 0.12, 1.0))
	sash_mat.set_shader_parameter("rim_power", 3.6)
	sash_mat.set_shader_parameter("rim_bleed", 2.6)
	sash_mat.set_shader_parameter("jitter_amp", 0.014)
	sash_mat.set_shader_parameter("jitter_freq", 5.2)
	sash_mat.set_shader_parameter("freq_x_mul", 0.8)
	sash_mat.set_shader_parameter("freq_y_mul", 2.1)
	sash_mat.set_shader_parameter("freq_z_mul", 1.1)

	var rope_mat := StandardMaterial3D.new()
	rope_mat.albedo_color = Color(0.42, 0.32, 0.20)
	rope_mat.roughness = 1.0

	var dark_mat := StandardMaterial3D.new()
	dark_mat.albedo_color = Color(0.04, 0.04, 0.05)
	dark_mat.roughness = 0.95

	# Hair uses the same anomaly shader but with a near-zero rim so it
	# stays pure black — frames the rim-lit face without competing for
	# visual attention.
	var hair_mat := ShaderMaterial.new()
	hair_mat.shader = anomaly
	hair_mat.set_shader_parameter("core_color", Color(0.0, 0.0, 0.0, 1.0))
	hair_mat.set_shader_parameter("rim_color", Color(0.10, 0.02, 0.04, 1.0))
	hair_mat.set_shader_parameter("rim_power", 8.0)
	hair_mat.set_shader_parameter("rim_bleed", 0.6)
	hair_mat.set_shader_parameter("jitter_amp", 0.024)
	hair_mat.set_shader_parameter("jitter_freq", 2.8)
	hair_mat.set_shader_parameter("freq_x_mul", 1.5)
	hair_mat.set_shader_parameter("freq_y_mul", 0.7)
	hair_mat.set_shader_parameter("freq_z_mul", 2.3)

	# ── Anatomical landmark Y-coordinates (metres above origin) ───────────
	# Feet hang above ground (the corpse is suspended). Body is stretched
	# slightly by the hanging — heights are ~5% taller than living.
	var foot_y       := 0.55
	var ankle_y      := 0.65
	var knee_y       := 1.05
	var hip_y        := 1.47
	var waist_y      := 1.66
	var chest_y      := 1.96
	var shoulder_y   := 2.10
	var neck_y       := 2.16
	var head_y       := 2.32

	# ── Hanging rope (branch → noose) ─────────────────────────────────────
	var rope := MeshInstance3D.new()
	var rm := CylinderMesh.new()
	rm.top_radius = 0.022
	rm.bottom_radius = 0.022
	rm.height = hang_height - (neck_y + 0.06)
	rope.mesh = rm
	rope.position = Vector3(0, (hang_height + neck_y + 0.06) * 0.5, 0)
	rope.material_override = rope_mat
	add_child(rope)

	# Noose loop — torus around the throat
	var noose := MeshInstance3D.new()
	var nm := TorusMesh.new()
	nm.inner_radius = 0.075
	nm.outer_radius = 0.115
	nm.ring_segments = 14
	nm.rings = 18
	noose.mesh = nm
	noose.position = Vector3(0, neck_y + 0.04, 0)
	noose.material_override = rope_mat
	add_child(noose)

	# ── HEAD ──────────────────────────────────────────────────────────────
	# Slightly oval head (X squashed) tilted from the broken neck.
	var head_tilt := Vector3(4.0, 12.0, 22.0)
	var head_offset := Vector3(0.06, head_y, 0.02)
	var head := _make_sphere(0.115, head_offset, skin, head_tilt)
	# Squash head slightly along X so it has a face profile instead of
	# being a perfect ball.
	head.scale = Vector3(0.95, 1.05, 1.00)
	add_child(head)

	# Jaw / chin — small extra sphere forward-down from head centre
	add_child(_make_sphere(0.058, head_offset + _rot_offset(Vector3(0.0, -0.075, 0.060), head_tilt),
		skin, head_tilt))

	# Hair cap — covers top + back of head
	var hair_cap := _make_sphere(0.128, head_offset + Vector3(0.0, 0.020, -0.015), hair_mat, head_tilt)
	add_child(hair_cap)

	# Long flowing hair down the back — two stacked capsules for volume
	var hair_back := _make_capsule(0.13, 0.85,
		Vector3(head_offset.x - 0.01, head_y - 0.50, head_offset.z - 0.12),
		hair_mat, Vector3(-4.0, 0.0, 4.0))
	add_child(hair_back)
	var hair_back2 := _make_capsule(0.10, 0.55,
		Vector3(head_offset.x - 0.02, head_y - 1.10, head_offset.z - 0.08),
		hair_mat, Vector3(0.0, 0.0, 2.0))
	add_child(hair_back2)

	# Front face-curtain hair — falls over the right side of the face
	var hair_front := MeshInstance3D.new()
	var hfm := BoxMesh.new()
	hfm.size = Vector3(0.18, 0.28, 0.018)
	hair_front.mesh = hfm
	hair_front.position = head_offset + _rot_offset(Vector3(0.05, -0.05, 0.105), head_tilt)
	hair_front.rotation_degrees = head_tilt
	hair_front.material_override = hair_mat
	add_child(hair_front)

	# Slack open mouth visible under the hair
	var mouth := MeshInstance3D.new()
	var mm := BoxMesh.new()
	mm.size = Vector3(0.040, 0.032, 0.014)
	mouth.mesh = mm
	mouth.position = head_offset + _rot_offset(Vector3(0.005, -0.07, 0.118), head_tilt)
	mouth.rotation_degrees = head_tilt
	mouth.material_override = dark_mat
	add_child(mouth)

	# ── NECK ──────────────────────────────────────────────────────────────
	# Thin slightly-stretched cylinder, with a sphere at the base for the
	# clavicle/throat transition.
	var neck := _make_capsule(0.052, 0.16, Vector3(0.02, neck_y, 0.0), skin, Vector3.ZERO)
	add_child(neck)
	add_child(_make_sphere(0.075, Vector3(0.0, shoulder_y - 0.02, 0.0), skin, Vector3.ZERO))

	# ── TORSO: chest + waist + hips ───────────────────────────────────────
	# Three stacked tapered capsules give a proper female torso silhouette:
	# chest is wider, waist tucks in, hips flare slightly. Kimono cloth
	# wraps the whole thing — built as a slightly larger overlay capsule.
	add_child(_make_capsule(0.165, 0.30, Vector3(0, chest_y, 0), kimono_mat, Vector3.ZERO))   # chest
	add_child(_make_capsule(0.140, 0.22, Vector3(0, waist_y - 0.04, 0), kimono_mat, Vector3.ZERO))  # waist
	add_child(_make_capsule(0.180, 0.18, Vector3(0, hip_y + 0.02, 0), kimono_mat, Vector3.ZERO))   # hips

	# Shoulder spheres — connect chest to upper arms
	for side: float in [-1.0, 1.0]:
		add_child(_make_sphere(0.075, Vector3(side * 0.175, shoulder_y - 0.04, 0.0), kimono_mat, Vector3.ZERO))

	# Dark-red obi sash at waist line
	var obi := MeshInstance3D.new()
	var obim := CylinderMesh.new()
	obim.top_radius = 0.165
	obim.bottom_radius = 0.165
	obim.height = 0.14
	obi.mesh = obim
	obi.position = Vector3(0, waist_y + 0.03, 0)
	obi.material_override = sash_mat
	add_child(obi)

	# Obi bow at the back
	add_child(_make_sphere(0.10, Vector3(0, waist_y + 0.04, -0.16), sash_mat, Vector3(0.0, 0.0, 0.0)))

	# ── ARMS (upper arm → elbow → forearm → wrist → hand) ─────────────────
	for side: float in [-1.0, 1.0]:
		var shoulder_x := side * 0.19
		# Upper arm — slight outward angle from shoulder
		var upper_arm := _make_capsule(0.058, 0.28,
			Vector3(shoulder_x + side * 0.005, 1.78, 0.0), kimono_mat,
			Vector3(0.0, 0.0, -side * 4.0))
		add_child(upper_arm)
		# Elbow joint
		add_child(_make_sphere(0.058, Vector3(shoulder_x + side * 0.015, 1.62, 0.005), skin, Vector3.ZERO))
		# Forearm — bare skin (sleeves end at elbow on this kimono)
		var forearm := _make_capsule(0.048, 0.26,
			Vector3(shoulder_x + side * 0.018, 1.45, 0.012), skin,
			Vector3(0.0, 0.0, -side * 2.0))
		add_child(forearm)
		# Wrist joint
		add_child(_make_sphere(0.045, Vector3(shoulder_x + side * 0.022, 1.30, 0.020), skin, Vector3.ZERO))
		# Hand — small flattened sphere, slightly curled inward
		var hand := MeshInstance3D.new()
		var hand_m := SphereMesh.new()
		hand_m.radius = 0.055
		hand_m.height = 0.110
		hand.mesh = hand_m
		hand.scale = Vector3(0.78, 1.20, 0.95)
		hand.position = Vector3(shoulder_x + side * 0.026, 1.22, 0.025)
		hand.material_override = skin
		add_child(hand)

	# ── LEGS (thigh → knee → shin → ankle → foot) ─────────────────────────
	# Legs dangle straight down with a very slight outward splay. Kimono
	# skirt wraps the thighs; shins are visible bare; feet hang limp.
	for side: float in [-1.0, 1.0]:
		var leg_x := side * 0.085
		# Kimono skirt section wrapping the thigh
		var thigh := _make_capsule(0.105, 0.34,
			Vector3(leg_x + side * 0.008, hip_y - 0.21, 0.0), kimono_mat,
			Vector3(0.0, 0.0, -side * 2.0))
		add_child(thigh)
		# Knee joint
		add_child(_make_sphere(0.078, Vector3(leg_x + side * 0.012, knee_y - 0.02, 0.005), kimono_mat, Vector3.ZERO))
		# Lower shin — bare pale skin showing under the hem
		var shin := _make_capsule(0.062, 0.34,
			Vector3(leg_x + side * 0.014, knee_y - 0.20, 0.010), skin,
			Vector3(0.0, 0.0, -side * 1.0))
		add_child(shin)
		# Ankle joint
		add_child(_make_sphere(0.052, Vector3(leg_x + side * 0.014, ankle_y, 0.015), skin, Vector3.ZERO))
		# Foot — flattened sphere pointing slightly forward
		var foot := MeshInstance3D.new()
		var fm := SphereMesh.new()
		fm.radius = 0.062
		fm.height = 0.124
		foot.mesh = fm
		foot.scale = Vector3(1.0, 0.55, 1.65)
		foot.position = Vector3(leg_x + side * 0.014, foot_y, 0.060)
		foot.material_override = skin
		add_child(foot)

	# Kimono hem at the bottom of the skirt — narrow band of darker fabric
	for side: float in [-1.0, 1.0]:
		var hem_band := MeshInstance3D.new()
		var hbm := CylinderMesh.new()
		hbm.top_radius = 0.116
		hbm.bottom_radius = 0.108
		hbm.height = 0.04
		hem_band.mesh = hbm
		hem_band.position = Vector3(side * 0.090, knee_y + 0.02, 0.0)
		var hem_mat := StandardMaterial3D.new()
		hem_mat.albedo_color = Color(0.30, 0.28, 0.24)
		hem_mat.roughness = 0.98
		hem_band.material_override = hem_mat
		add_child(hem_band)

	# Memorial pebbles at the foot of the body
	var pebble_mat := StandardMaterial3D.new()
	pebble_mat.albedo_color = Color(0.32, 0.32, 0.34)
	pebble_mat.roughness = 0.94
	for i in 5:
		var pebble := MeshInstance3D.new()
		var pem := SphereMesh.new()
		var r := 0.04 + (i % 3) * 0.012
		pem.radius = r
		pem.height = r * 2.0
		pebble.mesh = pem
		var angle := float(i) * 1.35
		pebble.position = Vector3(cos(angle) * 0.45, 0.05, sin(angle) * 0.45 - 0.6)
		pebble.material_override = pebble_mat
		add_child(pebble)

	_start_sway()


# ── Anatomy helpers ──────────────────────────────────────────────────────

# Build a CapsuleMesh — used everywhere a limb segment is needed.
# height is the TOTAL height including the two spherical caps.
func _make_capsule(radius: float, height: float, pos: Vector3,
		mat: Material, rot_deg: Vector3) -> MeshInstance3D:
	var mi := MeshInstance3D.new()
	var cm := CapsuleMesh.new()
	cm.radius = radius
	cm.height = height
	mi.mesh = cm
	mi.position = pos
	mi.rotation_degrees = rot_deg
	mi.material_override = mat
	return mi


# Build a SphereMesh — used for joints (shoulders, elbows, knees, ankles).
func _make_sphere(radius: float, pos: Vector3,
		mat: Material, rot_deg: Vector3) -> MeshInstance3D:
	var mi := MeshInstance3D.new()
	var sm := SphereMesh.new()
	sm.radius = radius
	sm.height = radius * 2.0
	mi.mesh = sm
	mi.position = pos
	mi.rotation_degrees = rot_deg
	mi.material_override = mat
	return mi


# Rotate a local offset by a Euler-degree rotation. Used for placing
# features on the head (eyes, mouth, jaw) that should move with the head's
# tilt rather than staying in world-axis space.
func _rot_offset(local: Vector3, euler_deg: Vector3) -> Vector3:
	var b := Basis.from_euler(Vector3(
		deg_to_rad(euler_deg.x),
		deg_to_rad(euler_deg.y),
		deg_to_rad(euler_deg.z)))
	return b * local


func _start_sway() -> void:
	# Plays forever, paused with the tree. process_mode default is INHERIT so
	# it stops when the scene pauses.
	var tw := create_tween().set_loops()
	tw.tween_property(self, "rotation:z", deg_to_rad( 1.4), 3.2).set_trans(Tween.TRANS_SINE).set_ease(Tween.EASE_IN_OUT)
	tw.tween_property(self, "rotation:z", deg_to_rad(-1.4), 3.2).set_trans(Tween.TRANS_SINE).set_ease(Tween.EASE_IN_OUT)


# ─── Note collider (so the InteractRay can hit the note) ─────────────────────

func _build_note_collider() -> void:
	# The note sits on the ground in front of the body so the player can
	# kneel/look down and press [E]. It uses ITS OWN StaticBody3D on collision
	# layer 4 (the interactable layer the player's ray casts against), but
	# delegates interact() to THIS HangingCorpse so we know when it's read.
	_note_collider = StaticBody3D.new()
	_note_collider.collision_layer = 4
	_note_collider.collision_mask = 0
	_note_collider.position = Vector3(0.6, 0.15, 0.5)
	# Box collider for the InteractRay
	var col := CollisionShape3D.new()
	var box := BoxShape3D.new()
	box.size = Vector3(0.3, 0.3, 0.3)
	col.shape = box
	_note_collider.add_child(col)
	# Visible note — folded paper
	var paper := MeshInstance3D.new()
	var pm := BoxMesh.new()
	pm.size = Vector3(0.22, 0.006, 0.16)
	paper.mesh = pm
	var paper_mat := StandardMaterial3D.new()
	paper_mat.albedo_color = Color(0.78, 0.74, 0.62)
	paper_mat.roughness = 0.95
	paper_mat.emission_enabled = true
	paper_mat.emission = Color(0.45, 0.36, 0.20)
	paper_mat.emission_energy_multiplier = 0.18
	paper.material_override = paper_mat
	paper.rotation_degrees.x = -6.0
	_note_collider.add_child(paper)
	# Soft glow light so the note is visible in dark forest
	var light := OmniLight3D.new()
	light.position = Vector3(0, 0.3, 0)
	light.light_color = Color(0.92, 0.82, 0.55)
	light.light_energy = 0.45
	light.omni_range = 1.8
	light.shadow_enabled = false
	_note_collider.add_child(light)
	# Forward interact() to the corpse so we control the encounter sequence.
	_note_collider.set_script(_make_forwarder_script())
	_note_collider.set("_target", self)
	add_child(_note_collider)


# Generates a tiny inline script for the note's StaticBody3D that forwards
# the player's interact() call to this HangingCorpse.
func _make_forwarder_script() -> GDScript:
	var script := GDScript.new()
	script.source_code = """
extends StaticBody3D
var _target: Node = null
func interact(player: CharacterBody3D) -> void:
	if _target and _target.has_method(\"interact\"):
		_target.interact(player)
"""
	script.reload()
	return script


# ─── Proximity prompt ────────────────────────────────────────────────────────

func _build_prompt() -> void:
	_prompt = Label3D.new()
	_prompt.position = Vector3(0.6, 0.55, 0.5)
	_prompt.pixel_size = 0.0035
	_prompt.billboard = BaseMaterial3D.BILLBOARD_ENABLED
	_prompt.text = "[E] 遺書を拾う — Read note"
	_prompt.font_size = 22
	_prompt.modulate = Color(0.95, 0.88, 0.65)
	_prompt.visible = false
	add_child(_prompt)


func _build_area() -> void:
	# 2.2 m sphere — when the player is close enough to read the note,
	# show the prompt. Doesn't trigger anything itself.
	var area := Area3D.new()
	area.collision_layer = 0
	area.collision_mask = 1
	var sphere := SphereShape3D.new()
	sphere.radius = 2.2
	var col := CollisionShape3D.new()
	col.shape = sphere
	col.position = Vector3(0.6, 0.5, 0.5)
	area.add_child(col)
	area.body_entered.connect(_on_body_entered)
	area.body_exited.connect(_on_body_exited)
	add_child(area)
	_area = area


func _on_body_entered(body: Node3D) -> void:
	if not body.is_in_group("player"):
		return
	_player_in_range = true
	if not _note_collected:
		_prompt.visible = true


func _on_body_exited(body: Node3D) -> void:
	if body.is_in_group("player"):
		_player_in_range = false
		_prompt.visible = false
