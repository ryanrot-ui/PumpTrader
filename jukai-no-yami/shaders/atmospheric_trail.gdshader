shader_type spatial;
// ─── Atmospheric Trail ─────────────────────────────────────────────────
// Distance + edge dither fade for the road mesh.

render_mode unshaded, cull_back, shadows_disabled, depth_draw_opaque;

uniform vec4 dirt_color : source_color = vec4(0.36, 0.28, 0.18, 1.0);
uniform float fade_far : hint_range(4.0, 40.0) = 14.0;
uniform float fade_band : hint_range(0.5, 8.0) = 3.0;
uniform float edge_fade : hint_range(0.0, 0.5) = 0.25;
uniform float emission_strength : hint_range(0.0, 1.0) = 0.30;

varying vec3 world_pos;

void vertex() {
	world_pos = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz;
}

// 4×4 Bayer matrix expressed as a hash-style lookup. Avoids GLSL ES
// array literal syntax which some drivers (including Godot's dummy
// headless renderer) refuse to compile.
float bayer4x4_threshold(vec2 frag_xy) {
	int x = int(mod(frag_xy.x, 4.0));
	int y = int(mod(frag_xy.y, 4.0));
	// Manually unrolled lookup of the standard 4×4 ordered-dither matrix.
	float v = 0.0;
	if (y == 0) {
		if (x == 0)      v = 0.0;
		else if (x == 1) v = 8.0;
		else if (x == 2) v = 2.0;
		else             v = 10.0;
	} else if (y == 1) {
		if (x == 0)      v = 12.0;
		else if (x == 1) v = 4.0;
		else if (x == 2) v = 14.0;
		else             v = 6.0;
	} else if (y == 2) {
		if (x == 0)      v = 3.0;
		else if (x == 1) v = 11.0;
		else if (x == 2) v = 1.0;
		else             v = 9.0;
	} else {
		if (x == 0)      v = 15.0;
		else if (x == 1) v = 7.0;
		else if (x == 2) v = 13.0;
		else             v = 5.0;
	}
	return v / 16.0;
}

void fragment() {
	// Distance computed PER-FRAGMENT from the interpolated world position.
	// Computing it per-vertex and interpolating is wrong on a long BoxMesh:
	// the mesh only has corner vertices, and linear interpolation of
	// distance between corners 50+ m apart badly distorts the fade band
	// in the middle of the path. world_pos interpolates correctly
	// (it's affine), so length() here is exact.
	float d = length(CAMERA_POSITION_WORLD - world_pos);
	float fade_start = fade_far - fade_band;
	float dist_fade = clamp((d - fade_start) / fade_band, 0.0, 1.0);
	float thr = bayer4x4_threshold(FRAGCOORD.xy);

	// Dither kill: any pixel whose fade fraction exceeds its Bayer
	// threshold goes black.
	float dith_kill = step(thr, dist_fade);

	// Edge fade: cube of normalized edge distance.
	float edge_dist = min(UV.x, 1.0 - UV.x);
	float edge_factor = clamp(edge_dist / edge_fade, 0.0, 1.0);
	edge_factor = edge_factor * edge_factor * edge_factor;

	// Compose: distance fade scales visibility, edge fade multiplies,
	// dither kill yanks to zero. step() returns 1.0 if dist_fade > thr.
	float visibility = (1.0 - dist_fade) * edge_factor * (1.0 - dith_kill);
	// Hard clip past 95% — guarantees absolute black in the far band.
	visibility *= step(dist_fade, 0.95);

	vec3 col = dirt_color.rgb * visibility;
	ALBEDO = col;
	EMISSION = col * emission_strength;
}
