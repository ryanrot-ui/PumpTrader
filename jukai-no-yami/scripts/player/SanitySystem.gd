extends Node

# ─── Sanity System v2 ─────────────────────────────────────────────────────────
# Graduated crying + whispering audio that gets clearer as sanity drops.
# Drives the sanity vignette shader in real-time.
# Triggers hallucination flashes at critical sanity.

signal sanity_updated(value: float)
signal sanity_critical

const MAX_SANITY        = 100.0
const PASSIVE_DRAIN     = 0.35
const DARKNESS_DRAIN    = 1.4   # extra when flashlight is off
const GHOST_SIGHT_DRAIN = 7.0   # per second when staring at ghost
const REGEN_RATE        = 5.5   # at shrine

var sanity: float = MAX_SANITY
var is_near_shrine: bool  = false
var is_seeing_ghost: bool = false

# Vignette shader + hallucination overlay (set by UIManager)
var vignette_mat:  ShaderMaterial = null
var overlay_node:  ColorRect      = null

var _whisper_t:        float = 0.0
var _halluc_t:         float = 0.0
var _cry_t:            float = 0.0
var _critical_emitted: bool  = false
var _current_cry_tier: int   = -1  # -1=none, 0..3 = escalating

# Crying tiers — [sanity_threshold, volume_db, audio_key]
# Keys map to GHOST_PATHS in AudioManager (cry_distant, cry_closer, etc.)
const CRY_TIERS = [
	[70.0, -24.0, "cry_distant"],   # tier 0: barely audible sobbing
	[50.0, -14.0, "cry_closer"],    # tier 1: closer, name becoming audible
	[30.0, -5.0,  "cry_clear"],     # tier 2: "tasukete" clearly heard
	[15.0,  2.0,  "cry_intense"],   # tier 3: overlapping voices, very close
]

func _ready() -> void:
	GameManager.sanity_ref = self

func _process(delta: float) -> void:
	if GameManager.state != GameManager.GameState.PLAYING:
		return
	_update_drain(delta)
	_update_visual_effects()
	_tick_crying(delta)
	_tick_whispers(delta)
	_tick_hallucinations(delta)

# ─── Drain & Regen ────────────────────────────────────────────────────────────

func _update_drain(delta: float) -> void:
	var drain_rate = PASSIVE_DRAIN
	var flashlight = GameManager.player_ref.get_node_or_null("Camera3D/HandPivot/Flashlight") if GameManager.player_ref else null
	if flashlight and not flashlight.is_on:
		drain_rate += DARKNESS_DRAIN
	if is_seeing_ghost:
		drain_rate += GHOST_SIGHT_DRAIN
	if is_near_shrine:
		drain_rate -= REGEN_RATE

	sanity = clamp(sanity - drain_rate * delta, 0.0, MAX_SANITY)
	sanity_updated.emit(sanity)

	if sanity <= 0.0 and GameManager.player_ref:
		GameManager.player_ref.die()
	elif sanity <= 35.0 and not _critical_emitted:
		_critical_emitted = true
		sanity_critical.emit()

func drain(amount: float) -> void:
	sanity = max(0.0, sanity - amount)
	sanity_updated.emit(sanity)
	if sanity <= 0.0 and GameManager.player_ref:
		GameManager.player_ref.die()

func restore(amount: float) -> void:
	sanity = min(MAX_SANITY, sanity + amount)
	_critical_emitted = sanity <= 35.0
	sanity_updated.emit(sanity)

func set_ghost_visible(is_visible: bool) -> void:
	is_seeing_ghost = is_visible

# ─── Visual Effects ───────────────────────────────────────────────────────────

func _update_visual_effects() -> void:
	if vignette_mat == null:
		return
	var t = 1.0 - (sanity / MAX_SANITY)
	vignette_mat.set_shader_parameter("vignette_strength", lerpf(0.0, 0.85, t))
	vignette_mat.set_shader_parameter("desaturate",        lerpf(0.0, 0.55, t))
	vignette_mat.set_shader_parameter("aberration",        lerpf(0.0, 0.008, t))
	vignette_mat.set_shader_parameter("noise_strength",    lerpf(0.0, 0.04,  t))
	# Pulse effect at very low sanity
	if sanity < 25.0:
		var pulse = abs(sin(Time.get_ticks_msec() * 0.002)) * (0.25 - sanity / 100.0)
		vignette_mat.set_shader_parameter("vignette_strength",
			lerpf(0.0, 1.4, t) + pulse)

# ─── Graduated Crying Audio ───────────────────────────────────────────────────
# Four tiers. Each tier: cry gets louder, whispers become more distinct.

func _tick_crying(delta: float) -> void:
	var tier = _get_cry_tier()
	if tier != _current_cry_tier:
		_switch_cry_tier(tier)
	if tier < 0:
		return
	_cry_t += delta
	# Interval between cries shortens at lower sanity
	var interval = lerpf(35.0, 8.0, float(tier) / 3.0)
	if _cry_t >= interval:
		_cry_t = 0.0
		_play_cry(tier)

func _get_cry_tier() -> int:
	for i in range(CRY_TIERS.size() - 1, -1, -1):
		if sanity <= CRY_TIERS[i][0]:
			return i
	return -1

func _switch_cry_tier(new_tier: int) -> void:
	_current_cry_tier = new_tier
	_cry_t = 0.0
	if new_tier < 0:
		AudioManager.stop_crying(2.0)
	else:
		var data = CRY_TIERS[new_tier]
		AudioManager.set_cry_stream(data[2], data[1], 2.0)

func _play_cry(_tier: int) -> void:
	AudioManager.play_whisper()

# ─── Whispers (distinct from crying) ─────────────────────────────────────────

func _tick_whispers(delta: float) -> void:
	if sanity > 65.0:
		return
	_whisper_t += delta
	var interval = lerpf(28.0, 5.0, 1.0 - sanity / 65.0)
	if _whisper_t >= interval:
		_whisper_t = 0.0
		AudioManager.play_whisper()

# ─── Hallucinations ───────────────────────────────────────────────────────────

func _tick_hallucinations(delta: float) -> void:
	if sanity > 30.0:
		return
	_halluc_t += delta
	var interval = lerpf(18.0, 5.0, 1.0 - sanity / 30.0)
	if _halluc_t >= interval:
		_halluc_t = 0.0
		_do_hallucination()

func _do_hallucination() -> void:
	if overlay_node == null:
		return
	overlay_node.modulate.a = randf_range(0.3, 0.7)
	overlay_node.visible = true
	await get_tree().create_timer(randf_range(0.05, 0.12)).timeout
	overlay_node.visible = false
