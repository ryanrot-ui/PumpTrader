shader_type sky;
// ─── Night Sky — Aokigahara ─────────────────────────────────────────────
// Very dark night gradient + sparse twinkling stars + a dim, hazy moon.
// Replaces the pure-black BG_COLOR background, which read as "void" the
// moment the player looked above the treeline (parking lot especially).
//
// Deliberately kept close to black: the horror grade depends on darkness.
// The stars are the only element that should consciously register —
// everything else is subliminal depth.

// Gradient — horizon is faintly warmer (distant town light pollution),
// zenith is near-black blue.
uniform vec4 horizon_color : source_color = vec4(0.030, 0.026, 0.044, 1.0);
uniform vec4 zenith_color  : source_color = vec4(0.008, 0.010, 0.022, 1.0);

// Star field controls.
uniform float star_threshold : hint_range(0.990, 0.9999) = 0.9976;
uniform float star_brightness : hint_range(0.0, 2.0) = 0.85;
uniform float twinkle_speed : hint_range(0.0, 8.0) = 2.2;

// Moon — direction is normalized in the shader, so any vector works.
uniform vec3 moon_direction = vec3(0.35, 0.42, -0.60);
uniform vec4 moon_color : source_color = vec4(0.62, 0.66, 0.78, 1.0);
uniform float moon_disc_size : hint_range(0.5, 4.0) = 1.4;   // degrees
uniform float moon_glow : hint_range(0.0, 1.0) = 0.30;

float hash13(vec3 p) {
	p = fract(p * vec3(443.8975, 397.2973, 491.1871));
	p += dot(p, p.yxz + 19.19);
	return fract((p.x + p.y) * p.z);
}

void sky() {
	vec3 dir = EYEDIR;

	// ── Vertical gradient ──────────────────────────────────────────────
	float h = clamp(dir.y, 0.0, 1.0);
	// Bias toward the horizon colour for most of the lower sky — the
	// zenith tone only takes over high up.
	float grad = pow(h, 0.55);
	vec3 col = mix(horizon_color.rgb, zenith_color.rgb, grad);

	// ── Stars ──────────────────────────────────────────────────────────
	// Quantize the view direction into cells; each cell rolls a hash and
	// the rare winners get a star at the cell centre. Only above the
	// horizon — stars below eye level would read as glitches.
	if (dir.y > 0.03) {
		vec3 grid = dir * 180.0;
		vec3 cell = floor(grid);
		vec3 f = fract(grid) - 0.5;
		float roll = hash13(cell);
		if (roll > star_threshold) {
			// Star core: bright only near the cell centre so stars stay
			// point-like instead of lighting the whole cell.
			float core = smoothstep(0.22, 0.02, length(f));
			// Per-star twinkle phase from a second hash so they don't
			// all pulse in sync.
			float phase = hash13(cell + 7.7) * 6.2831;
			float tw = 0.55 + 0.45 * sin(TIME * twinkle_speed + phase);
			// Stars near the horizon dim out (atmospheric extinction).
			float extinction = smoothstep(0.03, 0.30, dir.y);
			col += vec3(0.85, 0.88, 1.0) * core * tw * star_brightness * extinction * 0.30;
		}
	}

	// ── Moon ───────────────────────────────────────────────────────────
	vec3 mdir = normalize(moon_direction);
	float mdot = dot(mdir, dir);
	// Solid disc with a soft limb.
	float disc_cos = cos(radians(moon_disc_size));
	float limb_cos = cos(radians(moon_disc_size * 0.75));
	float disc = smoothstep(disc_cos, limb_cos, mdot);
	// Wide haze glow around the disc — moonlight through thin cloud.
	float glow = pow(max(mdot, 0.0), 220.0) * moon_glow;
	col += moon_color.rgb * (disc * 0.40 + glow);

	COLOR = col;
}
