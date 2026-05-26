extends Node3D
## AtmosphericSequencer — premium atmospheric manager.
##
## Drop this script onto a Node3D anywhere in the scene tree. It has no
## dependencies on the player's movement loop, the existing AI, the audio
## system, or the UI manager — it's a pure utility node.
##
## Provides:
##   fade_text(label, duration, fade_in)  — smooth Tween-driven alpha fade
##   flashlight_focus(target_angle, target_energy, duration)
##       — narrows the player's SpotLight3D over time (panic / tension)
##   flashlight_reset(duration)           — restore the pre-focus values
##   set_flashlight(spot)                 — explicit override if you want
##                                          to drive a non-player light
##
## All public methods accept null arguments without crashing. If the
## target node is freed mid-tween, the next update detects it via
## is_instance_valid() and bails out cleanly.

# ── Defaults the sequencer uses if it has to auto-discover the flashlight ──
const DEFAULT_SPOT_PATH := "Camera3D/HandPivot/Flashlight"

# ── Cached "rest" values so flashlight_reset() can restore them. Captured
# the first time we touch the SpotLight3D so we don't trample whatever
# the player's Flashlight.gd considers the baseline.
var _flashlight_ref: SpotLight3D = null
var _rest_spot_angle: float = -1.0     # negative = "not captured yet"
var _rest_light_energy: float = -1.0
var _rest_attenuation: float = -1.0

# Active focus tween — kept so a second call cancels the first cleanly
# instead of fighting over the same property.
var _focus_tween: Tween = null
var _reset_tween: Tween = null

# Per-label tweens so repeated fade_text() on the SAME label doesn't run
# two tweens against modulate.a simultaneously. Keyed by the label's
# instance ID (RIDs would also work; using instance_id() keeps it pure GD).
var _fade_tweens: Dictionary = {}


# ─── Public API ──────────────────────────────────────────────────────────

# Smoothly fade a CanvasItem's modulate.a from its current value to
# (1.0 if fade_in else 0.0) over `duration` seconds. Cubic ease so the
# motion accelerates softly. Cancels any in-flight fade on the same label.
func fade_text(label_node: Control, duration: float, fade_in: bool) -> void:
	if not is_instance_valid(label_node):
		push_warning("[AtmosphericSequencer] fade_text: label is not valid; skipping.")
		return
	if duration <= 0.0:
		# Snap instantly if the caller asks for zero / negative time
		label_node.modulate.a = 1.0 if fade_in else 0.0
		return
	# Cancel a previous fade on this label so we don't run two tweens at
	# once against the same alpha channel.
	var id := label_node.get_instance_id()
	var prev_tween = _fade_tweens.get(id, null)
	if prev_tween and prev_tween is Tween and prev_tween.is_running():
		prev_tween.kill()
	# Create a new Tween. Tweens parent to the SceneTree by default, so
	# they survive even if this node moves around.
	var tw := create_tween()
	tw.set_trans(Tween.TRANS_CUBIC)
	tw.set_ease(Tween.EASE_IN_OUT)
	var target_alpha: float = 1.0 if fade_in else 0.0
	tw.tween_property(label_node, "modulate:a", target_alpha, duration)
	_fade_tweens[id] = tw
	# When the tween finishes, remove the cache entry. Bind by id so
	# we don't capture the tween reference itself in a leaky closure.
	tw.finished.connect(_on_fade_finished.bind(id))


# Smoothly narrow the flashlight's cone and crank its energy over `duration`
# seconds. Used to dial the player's torch into a "panic laser" — the cone
# tightens and gets brighter, simulating focused attention. The pre-focus
# values are captured the first time this fires so flashlight_reset() can
# restore them without the caller having to remember them.
#
#   target_angle  — final spot_angle (degrees). Typical: 10-15 for panic.
#   target_energy — final light_energy. Typical: 60-80 (default is ~42).
#   duration      — seconds for the transition.
func flashlight_focus(target_angle: float, target_energy: float, duration: float = 0.6) -> void:
	var spot := _resolve_flashlight()
	if not is_instance_valid(spot):
		push_warning("[AtmosphericSequencer] flashlight_focus: no SpotLight3D found; skipping.")
		return
	_capture_rest_values(spot)
	# Stop any active reset so the focus actually lands at the target
	if _reset_tween and _reset_tween.is_running():
		_reset_tween.kill()
	if _focus_tween and _focus_tween.is_running():
		_focus_tween.kill()
	_focus_tween = create_tween()
	_focus_tween.set_trans(Tween.TRANS_QUART)
	_focus_tween.set_ease(Tween.EASE_OUT)
	_focus_tween.set_parallel(true)
	_focus_tween.tween_property(spot, "spot_angle", target_angle, duration)
	_focus_tween.tween_property(spot, "light_energy", target_energy, duration)
	# Slightly steeper attenuation gives the "piercing laser" feel
	var target_atten: float = clamp(_rest_attenuation + 0.35, 0.0, 4.0)
	_focus_tween.tween_property(spot, "spot_angle_attenuation", target_atten, duration)


# Restore the flashlight to whatever values it had before flashlight_focus()
# was first called. Safe to call repeatedly — does nothing if no rest values
# have been captured yet.
func flashlight_reset(duration: float = 0.8) -> void:
	if _rest_spot_angle < 0.0:
		return  # never focused; nothing to restore
	var spot := _resolve_flashlight()
	if not is_instance_valid(spot):
		return
	if _focus_tween and _focus_tween.is_running():
		_focus_tween.kill()
	if _reset_tween and _reset_tween.is_running():
		_reset_tween.kill()
	_reset_tween = create_tween()
	_reset_tween.set_trans(Tween.TRANS_CUBIC)
	_reset_tween.set_ease(Tween.EASE_IN_OUT)
	_reset_tween.set_parallel(true)
	_reset_tween.tween_property(spot, "spot_angle", _rest_spot_angle, duration)
	_reset_tween.tween_property(spot, "light_energy", _rest_light_energy, duration)
	_reset_tween.tween_property(spot, "spot_angle_attenuation", _rest_attenuation, duration)


# Explicit override — if the caller wants to drive a different SpotLight3D
# (e.g. a cinematic spotlight in a cutscene), they can hand it to the
# sequencer and subsequent focus/reset calls operate on that light.
func set_flashlight(spot: SpotLight3D) -> void:
	if not is_instance_valid(spot):
		_flashlight_ref = null
		return
	_flashlight_ref = spot
	_rest_spot_angle = -1.0   # force re-capture on next focus call
	_rest_light_energy = -1.0
	_rest_attenuation = -1.0


# ─── Internal helpers ────────────────────────────────────────────────────

# Returns a valid SpotLight3D or null. Resolution order:
#   1. Explicit override from set_flashlight()
#   2. Cached pointer from a previous call (if still valid)
#   3. Auto-discovery via GameManager.player_ref + DEFAULT_SPOT_PATH
func _resolve_flashlight() -> SpotLight3D:
	if is_instance_valid(_flashlight_ref):
		return _flashlight_ref
	var gm = get_node_or_null("/root/GameManager")
	if gm and is_instance_valid(gm.player_ref):
		var node: Node = gm.player_ref.get_node_or_null(DEFAULT_SPOT_PATH)
		if node is SpotLight3D:
			_flashlight_ref = node
			return _flashlight_ref
	return null


# Capture the spot's current values ONCE so flashlight_reset() restores
# the right baseline. Called on first focus_flashlight() call.
func _capture_rest_values(spot: SpotLight3D) -> void:
	if _rest_spot_angle >= 0.0:
		return  # already captured
	_rest_spot_angle = spot.spot_angle
	_rest_light_energy = spot.light_energy
	_rest_attenuation = spot.spot_angle_attenuation


# Drop the tween cache entry once its fade finishes — keeps the dict
# from growing unboundedly across many fade calls.
func _on_fade_finished(id: int) -> void:
	_fade_tweens.erase(id)
