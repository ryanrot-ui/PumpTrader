extends CanvasLayer
## Two-stage post-process: pixel-snap retro pass → horror film grade.
##
## The retro pass (retro_post.gdshader) snaps the screen onto a coarser
## pixel grid and adds time-shifting grain weighted toward dark areas.
## This is the FIRST child so it draws first, before the grade reads the
## screen.
##
## The grade pass (horror_grade.gdshader) reads the already-pixelated
## screen and applies vignette, mild desaturation, and the sanity-driven
## contrast crush. Its grain amount is intentionally low because the
## retro pass already provides most of the grit.

var _retro_mat: ShaderMaterial
var _grade_mat: ShaderMaterial
var _retro_overlay: ColorRect
var _grade_overlay: ColorRect
var _enabled: bool = true

func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	layer = 127

	# Pass 1 — pixelation + dark-area grain. Draws first.
	_retro_overlay = ColorRect.new()
	_retro_overlay.set_anchors_preset(Control.PRESET_FULL_RECT)
	_retro_overlay.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(_retro_overlay)
	_retro_mat = ShaderMaterial.new()
	_retro_mat.shader = load("res://shaders/retro_post.gdshader")
	_retro_overlay.material = _retro_mat

	# Pass 2 — horror film grade (vignette / desat / sanity crush). Draws
	# on top of the pixelated image because it's the second child.
	_grade_overlay = ColorRect.new()
	_grade_overlay.set_anchors_preset(Control.PRESET_FULL_RECT)
	_grade_overlay.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(_grade_overlay)
	_grade_mat = ShaderMaterial.new()
	_grade_mat.shader = load("res://shaders/horror_grade.gdshader")
	_grade_overlay.material = _grade_mat

	apply_quality_preset(GameManager.graphics_quality, true)

func apply_quality_preset(quality: int, enabled: bool = true) -> void:
	_enabled = enabled
	if not _retro_mat or not _grade_mat:
		return
	_retro_overlay.visible = enabled
	_grade_overlay.visible = enabled
	if not enabled:
		return
	# Grade pass — grain dialed down because the retro pass adds its own.
	# Vignette/desat scale with quality.
	var grade_grain := 0.005
	var vig := 0.42
	var desat := 0.12
	# Retro pass — pixelation gets a touch chunkier at higher quality so
	# the player sees the effect even on high-res monitors.
	var retro_pixel: int = 2
	var retro_grain := 0.04
	match quality:
		GameManager.GraphicsQuality.LOW:
			grade_grain = 0.003
			vig = 0.38
			desat = 0.10
			retro_pixel = 2
			retro_grain = 0.035
		GameManager.GraphicsQuality.MEDIUM:
			grade_grain = 0.005
			vig = 0.44
			desat = 0.12
			retro_pixel = 2
			retro_grain = 0.045
		GameManager.GraphicsQuality.HIGH:
			grade_grain = 0.008
			vig = 0.52
			desat = 0.18
			retro_pixel = 3
			retro_grain = 0.055
	_grade_mat.set_shader_parameter("grain_amount", grade_grain)
	_grade_mat.set_shader_parameter("vignette_power", vig)
	_grade_mat.set_shader_parameter("desaturate", desat)
	_retro_mat.set_shader_parameter("pixel_size", retro_pixel)
	_retro_mat.set_shader_parameter("grain_amount", retro_grain)
	_retro_mat.set_shader_parameter("dark_boost", 0.65)
	_retro_mat.set_shader_parameter("grain_speed", 60.0)

func _process(_delta: float) -> void:
	if not _grade_mat or not _enabled:
		return
	var san := 100.0
	if GameManager.sanity_ref:
		san = GameManager.sanity_ref.sanity
	_grade_mat.set_shader_parameter("sanity_drain", clamp(1.0 - san / 100.0, 0.0, 1.0))
