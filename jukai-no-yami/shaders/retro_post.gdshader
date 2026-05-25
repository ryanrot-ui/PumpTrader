shader_type canvas_item;
// ─── Retro post-process: pixelation + dynamic film grain ──────────────────
// Pixelation snaps SCREEN_UV onto a coarser grid before sampling, killing
// the ultra-sharp digital look of primitive meshes. The grain adds
// time-shifting noise that is stronger in dark areas where banding would
// otherwise show.

uniform sampler2D screen_tex : hint_screen_texture, filter_nearest, repeat_disable;

// How many real pixels collapse into one "fat" pixel. 1 = no crunch,
// 2 = mild (recommended), 3-4 = chunky PS1-ish.
uniform int pixel_size : hint_range(1, 8) = 2;

// Grain strength. 0.05 is the sweet spot — visible without becoming a
// snowstorm. Set to 0 to disable. The existing horror_grade pass adds a
// small amount of additional grain on top, kept low so they don't pile up.
uniform float grain_amount : hint_range(0.0, 0.2) = 0.05;

// How much extra grain piles into dark pixels. 0 = uniform, 1 = pure dark.
uniform float dark_boost : hint_range(0.0, 1.0) = 0.65;

// Time scrub rate for the grain pattern. Higher = wilder shimmer.
uniform float grain_speed : hint_range(1.0, 240.0) = 60.0;

float hash21(vec2 p) {
	return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void fragment() {
	// ── Pixelation step ────────────────────────────────────────────────────
	// SCREEN_PIXEL_SIZE = (1/viewport_w, 1/viewport_h) — turns "snap every
	// Nth pixel" into the correct UV grid regardless of resolution.
	vec2 grid = SCREEN_PIXEL_SIZE * float(pixel_size);
	vec2 pixel_uv = (floor(SCREEN_UV / grid) + 0.5) * grid;
	vec3 col = texture(screen_tex, pixel_uv).rgb;

	// ── Film grain ─────────────────────────────────────────────────────────
	float t_seed = TIME * grain_speed;
	float g1 = hash21(pixel_uv * 800.0 + vec2(t_seed, t_seed * 0.917));
	float g2 = hash21(pixel_uv * 1320.0 + vec2(-t_seed * 0.731, t_seed * 1.123));
	float grain = (g1 * 0.6 + g2 * 0.4) - 0.5;

	// Dark-boost — bright highlights stay clean, shadows get the grit.
	float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
	float dark_mask = mix(1.0, 1.0 - luma, dark_boost);
	col += vec3(grain) * grain_amount * dark_mask;

	col = clamp(col, vec3(0.0), vec3(1.0));
	COLOR = vec4(col, 1.0);
}
