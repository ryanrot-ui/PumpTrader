shader_type spatial;
// ─── Weathered Wood ─────────────────────────────────────────────────────
// Vertical grain lines + decay streaks generated procedurally from a
// pseudo-random hash, no texture lookups. Designed for sign boards and
// torii beams — produces dark vertical streaking that reads as warped
// outdoor lumber.

render_mode unshaded, cull_back;

uniform vec4  wood_base   : source_color = vec4(0.20, 0.14, 0.08, 1.0);
uniform vec4  wood_dark   : source_color = vec4(0.05, 0.03, 0.02, 1.0);
uniform vec4  wood_stain  : source_color = vec4(0.32, 0.10, 0.04, 1.0);

// Vertical grain frequency — higher = tighter lines.
uniform float grain_freq  : hint_range(2.0, 80.0) = 36.0;
// How dark the grain lines get (0 = invisible, 1 = full wood_dark).
uniform float grain_depth : hint_range(0.0, 1.0) = 0.55;
// How much red-stain streaking appears (0 = pure wood, 1 = heavy stain).
uniform float stain_amount: hint_range(0.0, 1.0) = 0.20;

float hash21(vec2 p) {
	return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float hash11(float x) {
	return fract(sin(x * 91.27) * 47453.531);
}

void fragment() {
	// Two-axis UV — use UV.y as the vertical grain axis. The board's UV
	// runs along the face so vertical grain in UV ≈ vertical on-screen.
	float vy = UV.y;
	float vx = UV.x;
	// Grain — narrow vertical lines via sine wave + per-line hash so the
	// line darkness varies (some grains are heavier than others).
	float grain_phase = vx * grain_freq;
	float line_id = floor(grain_phase);
	float line_local = fract(grain_phase);
	// Per-line hash decides darkness depth + which lines are heavy stain
	float h = hash11(line_id);
	// Soft cosine profile — lines look like inked grooves, not stripes
	float line_intensity = pow(0.5 + 0.5 * cos((line_local - 0.5) * 6.2831), 8.0);
	float line_dark = line_intensity * (0.30 + 0.70 * h) * grain_depth;
	// Decay streak — vertical drip from the top, varies per column
	float drip_seed = hash11(line_id * 7.13);
	float drip_top = 0.10 + 0.55 * drip_seed;
	float drip = smoothstep(drip_top, drip_top + 0.40, vy) * (1.0 - smoothstep(0.90, 1.0, vy));
	float stain_mask = drip * stain_amount * step(0.80, h);
	// Mix base → dark for grain, then base → stain for decay
	vec3 col = mix(wood_base.rgb, wood_dark.rgb, line_dark);
	col = mix(col, wood_stain.rgb, stain_mask);
	// Faint per-pixel noise for damp paper / wood texture
	float n = hash21(floor(UV * 320.0)) * 0.04 - 0.02;
	col += vec3(n);
	ALBEDO = clamp(col, vec3(0.0), vec3(1.0));
}
