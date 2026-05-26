extends Node
## RetroRenderStabilizer — lock the game into a stylised low-fidelity 3D
## look without paying for a fullscreen shader pass.
##
## Attach this script to:
##   • the root node of any scene that should use the retro look, OR
##   • the project as an autoload (Project Settings → Autoload)
## Both work — the script is idempotent.
##
## What it does in _ready():
##   1. Drops the 3D viewport's internal render resolution to a fraction
##      of the window size (default 0.55 = roughly 1056×594 on a 1080p
##      monitor). The viewport then UPSCALES that buffer back to the
##      screen, giving the geometry a soft, sub-pixel feel.
##   2. Sets the 3D scaling mode to BILINEAR so the upscale interpolates
##      cleanly instead of nearest-neighbouring into harsh blocks.
##   3. Sets the viewport's default texture filter to NEAREST so any
##      generated textures (cookies, AudioStreamGenerator visualisers,
##      synth-image content) stay crisp and unsmoothed.
##   4. Leaves the 2D CanvasLayer chain at native window resolution —
##      Godot 4 renders CanvasLayers at the window size by default, so
##      pause menus, title text, ProgressBars, etc. stay razor-sharp.
##
## Tunables — set BEFORE _ready() runs (i.e. in the editor Inspector if
## attached to a scene root, or via @export overrides):

# Internal 3D resolution scale. 0.55 ≈ 540p on a 1080p window. Bottom
# of the range (0.25) is borderline unreadable; 1.0 is no scaling.
@export_range(0.25, 1.0, 0.05) var resolution_scale: float = 0.55

# Filter mode for canvas-rendered items inside the viewport. NEAREST gives
# the crispest low-fi look. BILINEAR is softer if you prefer.
@export_enum("Nearest", "Linear") var canvas_texture_filter_mode: int = 0

# If true the script also flips MSAA and TAA off for that classic flat
# untextured look. If you want post-AA softness, leave this off.
@export var disable_msaa_taa: bool = true

# Set to false if you want to drive the settings yourself at runtime and
# only want the public helpers exposed.
@export var apply_on_ready: bool = true


func _ready() -> void:
	if not apply_on_ready:
		return
	# Defer one frame so any Window/Viewport in the tree has finished its
	# own _ready() before we override its scaling.
	call_deferred("apply_retro_settings")


# Public — call this any time to re-apply the settings (e.g. after a
# graphics-quality change). Safe to invoke from a settings menu.
func apply_retro_settings() -> void:
	var vp := get_viewport()
	if vp == null:
		push_warning("[RetroRenderStabilizer] get_viewport() returned null; skipping.")
		return

	# ── 3D resolution scaling ────────────────────────────────────────────
	# scaling_3d_scale is the fraction of the window the 3D content renders
	# at. The 2D layer on top is unaffected.
	vp.scaling_3d_scale = resolution_scale
	# BILINEAR upscale — softer than FSR for the stylised look.
	vp.scaling_3d_mode = Viewport.SCALING_3D_MODE_BILINEAR

	# ── Anti-aliasing — off for crisp pixel edges ─────────────────────────
	if disable_msaa_taa:
		vp.msaa_3d = Viewport.MSAA_DISABLED
		vp.use_taa = false
		# FXAA is the cheapest AA — also off for the retro look.
		vp.screen_space_aa = Viewport.SCREEN_SPACE_AA_DISABLED

	# ── Canvas filter mode ───────────────────────────────────────────────
	# Affects how textures sampled by canvas-items (sprites, ColorRects)
	# inside the viewport are filtered. NEAREST keeps the procedural
	# noise patterns I generate (flashlight cookie, static overlay) crisp.
	var ti: Viewport.DefaultCanvasItemTextureFilter = Viewport.DEFAULT_CANVAS_ITEM_TEXTURE_FILTER_NEAREST
	if canvas_texture_filter_mode == 1:
		ti = Viewport.DEFAULT_CANVAS_ITEM_TEXTURE_FILTER_LINEAR
	vp.canvas_item_default_texture_filter = ti


# Public — restores Godot's defaults if the player toggles "retro mode"
# off in a settings menu.
func restore_defaults() -> void:
	var vp := get_viewport()
	if vp == null:
		return
	vp.scaling_3d_scale = 1.0
	vp.scaling_3d_mode = Viewport.SCALING_3D_MODE_BILINEAR
	vp.msaa_3d = Viewport.MSAA_2X
	vp.use_taa = false
	vp.screen_space_aa = Viewport.SCREEN_SPACE_AA_FXAA
	vp.canvas_item_default_texture_filter = Viewport.DEFAULT_CANVAS_ITEM_TEXTURE_FILTER_LINEAR_WITH_MIPMAPS


# Public — set the internal resolution at runtime (e.g. when the player
# changes a slider in the settings menu). Clamped to a safe range.
func set_resolution_scale(scale: float) -> void:
	resolution_scale = clampf(scale, 0.25, 1.0)
	var vp := get_viewport()
	if vp:
		vp.scaling_3d_scale = resolution_scale
