shader_type spatial;
// ─── Cell-shaded car body ────────────────────────────────────────────────
// Non-reflective ultra-dark ash-grey that locks faces into discrete
// shade bands instead of smooth gradients. Optional emission lets the
// taillight primitives glow neon crimson without needing a separate
// material setup.

render_mode cull_back;

// Base body colour and the shadow tone it falls to in dark zones.
uniform vec4 body_color   : source_color = vec4(0.16, 0.16, 0.18, 1.0);
uniform vec4 shadow_color : source_color = vec4(0.05, 0.05, 0.06, 1.0);

// Number of discrete light bands. 2 = sharp toon, 4 = soft toon.
uniform int   band_count : hint_range(2, 6) = 3;

// Emission section — set emit_amount > 0 for taillight panels (the
// car-builder code sets this per-mesh via material parameter override).
uniform vec4  emit_color  : source_color = vec4(0.95, 0.08, 0.06, 1.0);
uniform float emit_amount : hint_range(0.0, 4.0) = 0.0;

// Soft directional shading — we don't read the real scene light; we
// hard-bake a fake key light direction so the toon banding stays stable
// across the dark world without depending on the scene's directional.
const vec3 KEY_LIGHT = vec3(0.40, 0.78, 0.48);

void fragment() {
	vec3 n = normalize(NORMAL);
	float ndl = max(dot(n, normalize(KEY_LIGHT)), 0.0);
	// Quantise into discrete bands — classic cell shading
	float bands = float(band_count);
	float lit = floor(ndl * bands) / max(bands - 1.0, 1.0);
	// Mix between shadow tone (band 0) and body tone (band N)
	vec3 col = mix(shadow_color.rgb, body_color.rgb, lit);
	ALBEDO = col;
	ROUGHNESS = 0.92;
	METALLIC = 0.0;
	SPECULAR = 0.05;
	// Emission for the taillight panels — flat bloomable neon
	if (emit_amount > 0.0) {
		EMISSION = emit_color.rgb * emit_amount;
	}
}
